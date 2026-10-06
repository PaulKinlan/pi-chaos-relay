/**
 * Integration coverage for the extension entry point (index.ts).
 *
 * index.ts is imported by no other test, so the behaviours wired inside the
 * default export — the profile-lock refusal at session_start, the pid-owner
 * guard in removeProfileLock, and the doctor corrupt-config check — were only
 * ever verified by reading the diff. These tests instantiate the real extension
 * with a fake ExtensionAPI, capture the handlers/commands it registers, drive
 * them, and assert on observable effects (files on disk, the notification the
 * user would see, the config path the process is bound to).
 *
 * Every path is inside a throwaway HOME: config.ts resolves CONFIG_DIR from
 * homedir() at import and index.ts resolves lock files from homedir() at call
 * time, so HOME must be redirected *before* the dynamic imports below. No test
 * reads or writes the real ~/.pi/chaos-relay.json.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "../crypto.ts";
import { RelayError } from "../relay-client.ts";

const OFFLINE_RELAY_URL = "http://127.0.0.1:9"; // refused instantly; keeps every connect local

const HOME_DIR = mkdtempSync(join(tmpdir(), "pi-chaos-relay-index-test-"));
const PI_DIR = join(HOME_DIR, ".pi");
mkdirSync(PI_DIR, { recursive: true });

process.env.HOME = HOME_DIR;
delete process.env.CHAOS_RELAY_CONFIG;
delete process.env.CHAOS_RELAY_PROFILE;
delete process.env.CHAOS_RELAY_API_KEY;
// env beats the persisted file in resolveConfig, so this pins the relay URL for
// every connect attempt in this file (including doctor's reachability check).
process.env.CHAOS_RELAY_URL = OFFLINE_RELAY_URL;

const config = await import("../config.ts");
const { default: chaosRelayExtension, toFriendly } = await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];
type Handler = (event: unknown, ctx: unknown) => unknown;

interface Notification {
  message: string;
  level?: string;
}

/**
 * Stub global fetch so any non-loopback request throws instead of reaching a
 * real host. The registration tests point CHAOS_RELAY_URL at a local loopback
 * relay, so a regression that ever ignores the configured URL and POSTs to the
 * production relay fails fast here instead of making a real network call first.
 * Returns the previous fetch for restoration in the test's `after`.
 */
function blockNonLoopbackFetch(): typeof fetch {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    let host = "unparseable";
    try {
      host = new URL(href).hostname;
    } catch {
      /* leave unparseable → blocked below */
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(`blocked non-loopback fetch: ${href}`);
    }
    return (prev as unknown as (i: string, o?: unknown) => Promise<Response>)(href, init);
  }) as unknown as typeof fetch;
  return prev;
}

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const tools: Array<Record<string, unknown>> = [];
  const notifications: Notification[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, def: { handler: Handler }) {
      commands.set(name, def);
    },
    registerTool(def: Record<string, unknown>) {
      tools.push(def);
    },
    sendUserMessage: (_content: unknown, _opts?: unknown) => {},
  };
  return { pi, handlers, commands, tools, notifications };
}

function makeCtx(sessionId: string, notifications: Notification[]) {
  return {
    model: { input: ["text"] },
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
  };
}

/** Run every handler registered for a lifecycle event, like pi would. */
async function callHandler(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<void> {
  const list = handlers.get(name) ?? [];
  assert.ok(list.length > 0, `extension registers a ${name} handler`);
  for (const handler of list) await handler(event, ctx);
}

/** Lock path index.ts uses: ~/.pi/chaos-relay-<profile>.lock (homedir() at call time). */
function lockPath(profile: string): string {
  return join(PI_DIR, `chaos-relay-${profile}.lock`);
}

/** A stand-in WebSocket that can be forced to fail its handshake, so the
 * auth-recovery path (and the channel re-bind it triggers) can be driven. */
class FailingWebSocket {
  static instances: FailingWebSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(_url: string) {
    FailingWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {}
  failHandshake(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SESSIONS_PATH = join(PI_DIR, "chaos-relay-sessions.json");

function readSessionMap(): Record<string, string> {
  if (!existsSync(SESSIONS_PATH)) return {};
  return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8")) as Record<string, string>;
}

/** Relay-owned files directly under ~/.pi (config files, locks, session map). */
function relayStateFiles(): string[] {
  return readdirSync(PI_DIR).filter((f) => f.startsWith("chaos-relay")).sort();
}

/** Clear per-test state and re-point the process at the default config. */
function resetState(): void {
  for (const f of relayStateFiles()) {
    if (f.endsWith(".lock") || f.startsWith("chaos-relay-sessions.json")) {
      try {
        unlinkSync(join(PI_DIR, f));
      } catch {
        /* already gone */
      }
    }
  }
  delete process.env.CHAOS_RELAY_PROFILE;
  delete process.env.CHAOS_RELAY_CONFIG;
  config.setActiveConfigPath(join(PI_DIR, "chaos-relay.json"));
}

/**
 * Write an already-provisioned config file for a profile. Only the persistence
 * shape matters here (an apiKey makes the profile "configured" so no session is
 * ever registered against a relay); the tests never speak to a server.
 */
function writeProfileConfig(profile: string, apiKey: string): string {
  const path =
    profile === "default"
      ? join(PI_DIR, "chaos-relay.json")
      : join(PI_DIR, `chaos-relay.${profile}.json`);
  writeFileSync(path, JSON.stringify({ relayUrl: OFFLINE_RELAY_URL, apiKey }) + "\n");
  return path;
}

/**
 * A real, live process standing in for another pi session holding a profile
 * lock (checkProfileLock ignores a pid that is dead, so the holder must be
 * alive). Killed when the test ends.
 */
function startOtherLiveSession(t: TestContext): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0, "spawned a stand-in session");
  assert.notEqual(pid, process.pid);
  return pid;
}

test("session_start refuses a held profile lock: no connect, no lock write, warning raised, prior binding kept", async (t) => {
  resetState();
  // Both profiles are already provisioned: if the refusal ever stops returning,
  // the fall-through connect stays on the refused loopback URL instead of
  // registering a session against the real relay.
  const defaultFile = writeProfileConfig("default", "ak_default_offline");
  const workFile = writeProfileConfig("work", "ak_work_offline");
  const defaultConfigBefore = readFileSync(defaultFile, "utf-8");
  // Pin the chosen profile so the refusal is a no-op for the *previous* binding:
  // the process starts on the default config and must stay there.
  process.env.CHAOS_RELAY_PROFILE = "work";
  const otherPid = startOtherLiveSession(t);
  const lock = lockPath("work");
  writeFileSync(lock, String(otherPid));
  // The refusing session stays on the default profile, so shutdown releases the
  // *default* lock: hold that one too, so "never unlock someone else" is
  // actually exercised rather than trivially true for an absent file.
  const previousLock = lockPath("default");
  writeFileSync(previousLock, String(otherPid));
  const boundBefore = config.getConfigPath();
  assert.equal(boundBefore, defaultFile);
  assert.equal(config.activeProfileName(), "default", "bound to the default profile before the refusal");
  const filesBefore = relayStateFiles();

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const sid = "sess-refuse-held-lock";
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx(sid, fake.notifications),
  );

  // The user is told, by name, why the session refused.
  assert.equal(fake.notifications.length, 1, "exactly one notification");
  const [note] = fake.notifications;
  assert.equal(note.level, "warning");
  assert.match(note.message, /Relay profile "work" is already held/);
  assert.ok(
    note.message.includes(lock),
    `warning names the lock file (${lock}): ${note.message}`,
  );

  // (a) no connect attempt: the process was not re-pointed at the chosen profile.
  assert.equal(config.getConfigPath(), boundBefore, "stays on the previous config");
  assert.notEqual(
    config.getConfigPath(),
    workFile,
    "did not switch identity to the locked profile",
  );
  assert.equal(
    readFileSync(defaultFile, "utf-8"),
    defaultConfigBefore,
    "the previous profile's config was not rewritten",
  );

  // (b) no lock file written: the holder's pid is untouched.
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid), "holder's lock intact");

  // (c) no new binding/identity was created for this session.
  assert.equal(readSessionMap()[sid], undefined, "session was not bound to a profile");
  assert.deepEqual(relayStateFiles(), filesBefore, "no new config/identity files");

  // Shutdown must not release a lock this process never owned — neither the
  // chosen profile's (it never connected) nor the previous profile's.
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx(sid, fake.notifications));
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(otherPid),
    "refusing session leaves the held profile's lock alone on shutdown",
  );
  assert.equal(
    readFileSync(previousLock, "utf-8"),
    String(otherPid),
    "refusing session does not release the previous profile's lock either",
  );
});

test("session_start connects as the session's recorded profile when its lock is free (negative control)", async () => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  const profileFile = writeProfileConfig("work", "ak_negative_control");
  const sid = "sess-connect-free-lock";
  writeFileSync(SESSIONS_PATH, JSON.stringify({ [sid]: "work" }) + "\n");
  const boundBefore = config.getConfigPath();
  assert.equal(boundBefore, join(PI_DIR, "chaos-relay.json"), "starts on the default config");
  const lock = lockPath("work");
  assert.equal(existsSync(lock), false);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "resume" },
    makeCtx(sid, fake.notifications),
  );

  assert.equal(fake.notifications.length, 0, "no refusal warning when the lock is free");
  assert.equal(config.getConfigPath(), profileFile, "connected as the chosen profile");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "lock claimed by this process");
  assert.equal(readSessionMap()[sid], "work", "session bound to the chosen profile");

  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx(sid, fake.notifications));
  assert.equal(existsSync(lock), false, "own lock released on shutdown");
});

test("session_start refusal leaves an unbound session unbound and mints no identity", async (t) => {
  resetState();
  const defaultFile = writeProfileConfig("default", "ak_default_offline");
  const defaultConfigBefore = readFileSync(defaultFile, "utf-8");
  const sid = "sess-unbound";
  const otherPid = startOtherLiveSession(t);
  const lock = lockPath("default");
  writeFileSync(lock, String(otherPid));
  const filesBefore = relayStateFiles();

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx(sid, fake.notifications),
  );

  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /Relay profile "default" is already held/);
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid), "holder's lock intact");
  assert.equal(
    readFileSync(defaultFile, "utf-8"),
    defaultConfigBefore,
    "no keypair/identity was minted into the config",
  );
  assert.deepEqual(relayStateFiles(), filesBefore, "no config/keypair minted for the refusal");
  assert.equal(existsSync(SESSIONS_PATH), false, "no new session→profile binding");
});

test("doctor reports the config-parses check as FAILED for a corrupt config file", async () => {
  resetState();
  const corruptPath = join(PI_DIR, "chaos-relay-broken.json");
  writeFileSync(corruptPath, '{ "relayUrl": "http://127.0.0.1:9", ');
  config.setActiveConfigPath(corruptPath);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const command = fake.commands.get("chaos-relay");
  assert.ok(command, "extension registers the /chaos-relay command");

  await command.handler("doctor", makeCtx("sess-doctor", fake.notifications));

  assert.equal(fake.notifications.length, 1);
  const note = fake.notifications[0];
  assert.equal(note.level, "warning");
  assert.ok(
    note.message.includes(`✗ config file parses — Failed to parse ${corruptPath}`),
    `doctor failed the corrupt-config check with the reason: ${note.message}`,
  );
  assert.match(note.message, /chaos-relay doctor: \d+ issue\(s\) found above\./);
});

test("removeProfileLock refuses a lock owned by another pid and unlinks its own", async (t) => {
  resetState();
  // currentProfile is bound from the active config path at extension load.
  config.setActiveConfigPath(config.profilePathForName("guard"));
  const lock = lockPath("guard");

  const otherPid = startOtherLiveSession(t);
  writeFileSync(lock, String(otherPid));
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-guard", fake.notifications));
  assert.equal(existsSync(lock), true, "another process's lock is left in place");
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid));

  writeFileSync(lock, String(process.pid));
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-guard", fake.notifications));
  assert.equal(existsSync(lock), false, "this process's own lock is released");
});

test("auto-provision registers against CHAOS_RELAY_URL, not the production default", async (t) => {
  // Baseline: env-governs-registration for a clean value (not a pin for the trim/secret-echo fixes).
  resetState();
  // Fresh profile: no persisted config at all, so ensureConfigured must decide
  // the registration URL from env (CHAOS_RELAY_URL) — never the default relay.
  const configPath = join(PI_DIR, "chaos-relay.json");
  if (existsSync(configPath)) unlinkSync(configPath);

  // A local stand-in relay records every request path. If registration ever
  // ignores CHAOS_RELAY_URL and POSTs to the production relay instead, this
  // server sees nothing and the assertion below fails — deterministically, with
  // no dependency on (or traffic to) the real relay.
  const seenPaths: string[] = [];
  const server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/auth/register") {
        res.end(JSON.stringify({ userId: "u_local", apiKey: "ak_local" }));
      } else if (req.url === "/channels/telegram/register") {
        res.end(
          JSON.stringify({ channelId: "ch_local", botUsername: "localbot", pairingCode: "1234" }),
        );
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const localUrl = `http://127.0.0.1:${port}`;

  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = localUrl;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  // Stop the background poller/WebSocket this auto-provision path starts, so the
  // test leaves no reconnect timer behind.
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-verify", fake.notifications)));
  // Fail fast if registration ever targets a non-loopback (production) host.
  const prevFetch = blockNonLoopbackFetch();
  t.after(() => {
    globalThis.fetch = prevFetch;
  });
  const tg = fake.tools.find((tool) => tool.name === "relay_register_telegram");
  assert.ok(tg, "extension registers relay_register_telegram");
  const execute = tg.execute as (
    id: string,
    params: { botToken: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  await execute("t1", { botToken: "123:ABC" }, undefined, undefined, {
    ui: { notify: () => {} },
  });

  // The registration POST reached the env-configured relay, not chaos-relay.com.
  assert.ok(
    seenPaths.includes("/auth/register"),
    `registration reached the env-configured relay (saw ${JSON.stringify(seenPaths)})`,
  );
  // …and the credentials persisted came from that relay.
  const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as {
    relayUrl?: string;
    apiKey?: string;
  };
  assert.equal(persisted.relayUrl, localUrl, "persisted the env-configured relayUrl");
  assert.equal(persisted.apiKey, "ak_local", "persisted the local relay's apiKey");
});

test("auto-provision falls through to persisted relayUrl when CHAOS_RELAY_URL is invalid", async (t) => {
  resetState();
  const seenPaths: string[] = [];
  const server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/auth/register") {
        res.end(JSON.stringify({ userId: "u_persisted", apiKey: "ak_persisted" }));
      } else if (req.url === "/channels/telegram/register") {
        res.end(JSON.stringify({ channelId: "ch_persisted", botUsername: "pbot", pairingCode: "9" }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const localUrl = `http://127.0.0.1:${port}`;

  // A valid persisted self-hosted URL with NO apiKey yet, plus a malformed env.
  const configPath = join(PI_DIR, "chaos-relay.json");
  writeFileSync(configPath, JSON.stringify({ relayUrl: localUrl }) + "\n");

  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = "not a url";
  const prevFetch = blockNonLoopbackFetch();
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = prevFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-invalid-env", fake.notifications)));
  const tg = fake.tools.find((tool) => tool.name === "relay_register_telegram");
  assert.ok(tg, "extension registers relay_register_telegram");
  const notifications: Notification[] = [];
  const execute = tg.execute as (
    id: string,
    params: { botToken: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  await execute("t1", { botToken: "123:ABC" }, undefined, undefined, {
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  });

  // Registration reached the persisted relay — never the production default.
  assert.ok(
    seenPaths.includes("/auth/register"),
    `registered against the persisted relay (saw ${JSON.stringify(seenPaths)})`,
  );
  // The persisted relayUrl is UNCHANGED (still the operator's self-hosted URL).
  const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as {
    relayUrl?: string;
    apiKey?: string;
  };
  assert.equal(persisted.relayUrl, localUrl, "persisted relayUrl unchanged");
  assert.equal(persisted.apiKey, "ak_persisted", "persisted the local relay's apiKey");
  // The invalid-env state is called out (reason + persisted fallback), without
  // echoing the malformed value itself.
  const warned = notifications.some(
    (n) =>
      n.level === "warning" &&
      /not an absolute http\(s\):\/\/ URL/.test(n.message) &&
      n.message.includes("persisted relay"),
  );
  assert.ok(warned, `warning named the invalid-env state (${JSON.stringify(notifications)})`);
  assert.ok(
    !notifications.some((n) => n.message.includes("not a url")),
    `the malformed value was not echoed (${JSON.stringify(notifications)})`,
  );
});

test("a configured profile never re-registers (no POST /auth/register)", async (t) => {
  // Baseline: identity-safety invariant (does not exercise the trim/secret-echo fixes).
  resetState();
  const seenPaths: string[] = [];
  const server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/auth/register") {
        res.end(JSON.stringify({ userId: "u_new", apiKey: "ak_new" }));
      } else if (req.url === "/channels/telegram/register") {
        res.end(JSON.stringify({ channelId: "ch_existing", botUsername: "bot", pairingCode: "1" }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const localUrl = `http://127.0.0.1:${port}`;

  // Already-provisioned profile: relayUrl + apiKey present.
  const configPath = join(PI_DIR, "chaos-relay.json");
  writeFileSync(configPath, JSON.stringify({ relayUrl: localUrl, apiKey: "ak_existing" }) + "\n");

  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = localUrl;
  const prevFetch = blockNonLoopbackFetch();
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = prevFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-identity", fake.notifications)));
  const tg = fake.tools.find((tool) => tool.name === "relay_register_telegram");
  assert.ok(tg, "extension registers relay_register_telegram");
  const execute = tg.execute as (
    id: string,
    params: { botToken: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  await execute("t1", { botToken: "123:ABC" }, undefined, undefined, {
    ui: { notify: () => {} },
  });

  // The profile already has an apiKey, so ensureConfigured returned early and
  // never POSTed /auth/register. Channel registration may still run.
  assert.ok(
    !seenPaths.includes("/auth/register"),
    `no registration POST for an already-configured profile (saw ${JSON.stringify(seenPaths)})`,
  );
  assert.ok(
    seenPaths.includes("/channels/telegram/register"),
    `channel registration still ran against the configured relay (saw ${JSON.stringify(seenPaths)})`,
  );
});

test("status reports the persisted relay URL when CHAOS_RELAY_URL is invalid", async () => {
  // Baseline: first-valid-candidate resolution via the shared status consumer.
  resetState();
  // Valid persisted URL, no apiKey (so status skips the live reachability calls).
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9999" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = "not a url";

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const command = fake.commands.get("chaos-relay");
  assert.ok(command, "extension registers the /chaos-relay command");
  await command.handler("status", makeCtx("sess-status", fake.notifications));

  if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
  else process.env.CHAOS_RELAY_URL = prevUrl;

  // The shared resolveConfig path (used by status/transport/doctor) now yields
  // to the valid persisted URL when the env value is malformed — it must not
  // silently fall back to the production default.
  const status = fake.notifications.map((n) => n.message).join("\n");
  assert.ok(status.includes("http://127.0.0.1:9999"), `status reports the persisted URL (${status})`);
  assert.ok(!status.includes("chaos-relay.com"), `status does not fall back to production (${status})`);
});

test("auto-provision warns loudly when no relay URL is configured anywhere", async (t) => {
  resetState();
  const configPath = join(PI_DIR, "chaos-relay.json");
  if (existsSync(configPath)) unlinkSync(configPath);

  // Neither env nor persisted config names a relay, so the effective URL is the
  // production default. Stub fetch so the registration attempt fails instantly
  // instead of ever reaching the real relay — this test only asserts the warning
  // that fires BEFORE registration is attempted.
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx("sess-warn", fake.notifications),
  );
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-warn", fake.notifications)));

  const warned = fake.notifications.some(
    (n) => n.level === "warning" && /No relay URL configured/.test(n.message),
  );
  assert.ok(warned, `warning surfaced to the user (${JSON.stringify(fake.notifications)})`);
  // Nothing was registered: the fetch stub threw, so no config file was written.
  assert.equal(existsSync(configPath), false, "no config/identity was persisted");
});

test("a malformed CHAOS_RELAY_URL is never echoed and refuses without a fetch", async (t) => {
  resetState();
  const configPath = join(PI_DIR, "chaos-relay.json");
  if (existsSync(configPath)) unlinkSync(configPath);

  // A secret-shaped, malformed value: the warning must name the VARIABLE and
  // the reason, never the value — it reaches both the TUI and the durable log.
  const secret = "sk-secret-pasted-token-1234567890";
  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = secret;
  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((..._a: unknown[]) => {
    fetchCalls++;
    return Promise.reject(new Error("should not be called"));
  }) as unknown as typeof fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx("sess-secret", fake.notifications),
  );
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-secret", fake.notifications)));

  const warned = fake.notifications.some(
    (n) => n.level === "warning" && /not an absolute http\(s\):\/\/ URL/.test(n.message),
  );
  assert.ok(warned, `warning fired (${JSON.stringify(fake.notifications)})`);
  // The malformed value never appears in any notification…
  for (const n of fake.notifications) {
    assert.ok(!n.message.includes(secret), `notification must not echo the env value: ${n.message}`);
  }
  // …nor in the durable log file.
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  assert.ok(!logRaw.includes(secret), "log file must not echo the env value");
  // The refusal returns before any registration, so fetch was never called.
  assert.equal(fetchCalls, 0, "no fetch attempt on the refusal path");
  assert.equal(existsSync(configPath), false, "no config/identity was persisted");
});

test("doctor never echoes a secret-shaped CHAOS_RELAY_URL", async () => {
  resetState();
  // Valid persisted loopback URL so the doctor's reachability probe stays local.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9" }) + "\n",
  );
  const secret = "sk-doctor-secret-token-9876543210";
  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = secret;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((..._a: unknown[]) =>
    Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("doctor", makeCtx("sess-doctor-secret", fake.notifications));

    const output = fake.notifications.map((n) => n.message).join("\n");
    assert.ok(
      !output.includes(secret),
      `doctor output must not echo the env value: ${output}`,
    );
    // The interesting fact survives: env is set but not a valid URL.
    assert.ok(output.includes("env=<invalid>"), `doctor reports the invalid env state (${output})`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("doctor strips credentials from a valid CHAOS_RELAY_URL (origin only)", async () => {
  resetState();
  const password = "supersecretpass";
  const querySecret = "doctor-origin-query-secret";
  const credUrl = `https://user:${password}@example.com/health?token=${querySecret}#part2`;
  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = credUrl;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((..._a: unknown[]) =>
    Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("doctor", makeCtx("sess-doctor-cred", fake.notifications));

    const output = fake.notifications.map((n) => n.message).join("\n");
    assert.ok(!output.includes(password), `doctor output must not leak the password: ${output}`);
    assert.ok(!output.includes("user@example.com"), `doctor output must not leak userinfo: ${output}`);
    assert.ok(!output.includes(querySecret), `doctor output must not leak the query token: ${output}`);
    assert.ok(!output.includes("token="), `doctor output must not leak the query string: ${output}`);
    assert.ok(!output.includes("/health"), `doctor output must not leak the path: ${output}`);
    assert.ok(!output.includes("part2"), `doctor output must not leak the fragment: ${output}`);
    // The origin is still shown so the operator can see which host is in effect.
    assert.ok(output.includes("https://example.com"), `doctor shows the redacted origin (${output})`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("status strips credentials from the relayUrl (origin only)", async () => {
  resetState();
  const password = "supersecretpass";
  const querySecret = "status-origin-query-secret";
  // An apiKey makes the profile "configured", so status runs the live health
  // probe. The probe is stubbed to time out, exercising the health() error path
  // (which would otherwise leak `this.base` raw on the pre-fix build).
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: `https://user:${password}@example.com/health?token=${querySecret}#part2`, apiKey: "ak" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new DOMException("Timed out", "TimeoutError"))) as unknown as typeof fetch;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("status", makeCtx("sess-status-cred", fake.notifications));

    const status = fake.notifications.map((n) => n.message).join("\n");
    assert.ok(!status.includes(password), `status must not leak the password: ${status}`);
    assert.ok(!status.includes("user@example.com"), `status must not leak userinfo: ${status}`);
    assert.ok(!status.includes(querySecret), `status must not leak the query token: ${status}`);
    assert.ok(!status.includes("token="), `status must not leak the query string: ${status}`);
    assert.ok(!status.includes("/health"), `status must not leak the path: ${status}`);
    assert.ok(!status.includes("part2"), `status must not leak the fragment: ${status}`);
    assert.ok(status.includes("https://example.com"), `status shows the redacted origin (${status})`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("status redacts query/fragment URL secrets from the health error", async () => {
  resetState();
  const secret = "status-query-secret";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new Error(`fetch failed: https://example.com/health?token=${secret}#frag`))) as unknown as typeof fetch;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("status", makeCtx("sess-status-query", fake.notifications));

    const status = fake.notifications.map((n) => n.message).join("\n");
    assert.ok(!status.includes(secret), `status must not leak the query token: ${status}`);
    assert.ok(!status.includes("token="), `status must not leak the query string: ${status}`);
    assert.ok(!status.includes("/health"), `status must not leak the path: ${status}`);
    assert.ok(status.includes("https://example.com"), `status keeps the origin: ${status}`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("reset strips credentials from the cleared relayUrl (origin only)", async () => {
  resetState();
  const password = "supersecretpass";
  const querySecret = "reset-origin-query-secret";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: `https://user:${password}@example.com/health?token=${querySecret}#part2`, apiKey: "ak" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const command = fake.commands.get("chaos-relay");
  assert.ok(command, "extension registers the /chaos-relay command");
  await command.handler("reset", makeCtx("sess-reset-cred", fake.notifications));

  if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
  else process.env.CHAOS_RELAY_URL = prevUrl;

  const output = fake.notifications.map((n) => n.message).join("\n");
  assert.ok(!output.includes(password), `reset must not leak the password: ${output}`);
  assert.ok(!output.includes("user@example.com"), `reset must not leak userinfo: ${output}`);
  assert.ok(!output.includes(querySecret), `reset must not leak the query token: ${output}`);
  assert.ok(!output.includes("token="), `reset must not leak the query string: ${output}`);
  assert.ok(!output.includes("/health"), `reset must not leak the path: ${output}`);
  assert.ok(!output.includes("part2"), `reset must not leak the fragment: ${output}`);
});

test("the invalid-env warning and auto-provision log strip credentials from the persisted URL", async (t) => {
  resetState();
  const password = "supersecretpass";
  const seenPaths: string[] = [];
  const server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/auth/register") res.end(JSON.stringify({ userId: "u_warn", apiKey: "ak_warn" }));
      else if (req.url === "/channels/telegram/register") res.end(JSON.stringify({ channelId: "ch_warn", botUsername: "wbot", pairingCode: "3" }));
      else res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const credUrl = `http://user:${password}@127.0.0.1:${port}`;

  writeFileSync(join(PI_DIR, "chaos-relay.json"), JSON.stringify({ relayUrl: credUrl }) + "\n");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = "not a url"; // malformed → invalidEnvIgnoredWarning
  const prevFetch = blockNonLoopbackFetch();
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = prevFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-warn-cred", fake.notifications)));
  const tg = fake.tools.find((tool) => tool.name === "relay_register_telegram");
  assert.ok(tg);
  const notifications: Notification[] = [];
  const execute = tg.execute as (...a: unknown[]) => Promise<unknown>;
  await execute("t1", { botToken: "123:ABC" }, undefined, undefined, {
    ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) },
  });

  const text = notifications.map((n) => n.message).join("\n");
  assert.ok(!text.includes(password), `warning must not leak the password: ${text}`);
  assert.ok(!text.includes("user@127.0.0.1"), `warning must not leak userinfo: ${text}`);
  assert.ok(text.includes(`127.0.0.1:${port}`), `warning shows the redacted origin: ${text}`);
  // The auto-provision durable-log line is redacted too.
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  assert.ok(!logRaw.includes(password), `log must not leak the password: ${logRaw}`);
  assert.ok(!logRaw.includes("user@127.0.0.1"), `log must not leak userinfo: ${logRaw}`);
});

test("connection log lines strip credentials from the relayUrl", async (t) => {
  resetState();
  const password = "supersecretpass";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: `http://user:${password}@127.0.0.1:9`, apiKey: "ak" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-log-cred", fake.notifications));
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-log-cred", fake.notifications));

  if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
  else process.env.CHAOS_RELAY_URL = prevUrl;

  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  assert.ok(logRaw.includes("connecting to relay"), `log has the connect line: ${logRaw}`);
  assert.ok(!logRaw.includes(password), `log must not leak the password: ${logRaw}`);
  assert.ok(!logRaw.includes("user@127.0.0.1"), `log must not leak userinfo: ${logRaw}`);
});

test("auto-provision trims surrounding whitespace from CHAOS_RELAY_URL", async (t) => {
  resetState();
  const configPath = join(PI_DIR, "chaos-relay.json");
  if (existsSync(configPath)) unlinkSync(configPath);

  const seenPaths: string[] = [];
  const server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/auth/register") res.end(JSON.stringify({ userId: "u_ws", apiKey: "ak_ws" }));
      else if (req.url === "/channels/telegram/register") res.end(JSON.stringify({ channelId: "ch_ws", botUsername: "wsbot", pairingCode: "7" }));
      else res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const trimmedUrl = `http://127.0.0.1:${port}`;

  const prevUrl = process.env.CHAOS_RELAY_URL;
  process.env.CHAOS_RELAY_URL = `  ${trimmedUrl}  `; // surrounding whitespace
  const prevFetch = blockNonLoopbackFetch();
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = prevFetch;
  });

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-ws", fake.notifications)));
  const tg = fake.tools.find((tool) => tool.name === "relay_register_telegram");
  assert.ok(tg, "extension registers relay_register_telegram");
  const execute = tg.execute as (
    id: string,
    params: { botToken: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  await execute("t1", { botToken: "123:ABC" }, undefined, undefined, {
    ui: { notify: () => {} },
  });

  assert.ok(
    seenPaths.includes("/auth/register"),
    `registration reached the trimmed relay URL (saw ${JSON.stringify(seenPaths)})`,
  );
  const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as {
    relayUrl?: string;
    apiKey?: string;
  };
  assert.equal(persisted.relayUrl, trimmedUrl, "persisted the TRIMMED relay URL (no surrounding spaces)");
});

test("doctor redacts query/fragment URL secrets from the reachability error", async () => {
  resetState();
  const secret = "doctor-reach-secret";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new Error(`fetch failed: https://example.com/health?token=${secret}#frag`))) as unknown as typeof fetch;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("doctor", makeCtx("sess-doctor-reach", fake.notifications));

    const output = fake.notifications.map((n) => n.message).join("\n");
    assert.ok(!output.includes(secret), `doctor must not leak the query token: ${output}`);
    assert.ok(!output.includes("token="), `doctor must not leak the query string: ${output}`);
    assert.ok(!output.includes("/health"), `doctor must not leak the path: ${output}`);
    assert.ok(output.includes("relay reachable"), `doctor reports the reachability check: ${output}`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("the top-level command catch redacts URL secrets from bubble-up errors", async () => {
  resetState();
  const secret = "setup-timeout-secret";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: `https://user:${secret}@example.com` }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new DOMException("Timed out", "TimeoutError"))) as unknown as typeof fetch;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    const notifications: Notification[] = [];
    const ctx = {
      hasUI: true,
      model: { input: ["text"] },
      sessionManager: { getSessionId: () => "sess-catch" },
      ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) },
    };
    await command.handler("setup", ctx);

    const output = notifications.map((n) => n.message).join("\n");
    assert.ok(output.includes("chaos-relay error:"), `bubbles to the command catch: ${output}`);
    assert.ok(!output.includes(secret), `must not leak the URL secret: ${output}`);
    assert.ok(!output.includes("user@example.com"), `must not leak userinfo: ${output}`);
    assert.ok(output.includes("https://example.com"), `keeps the origin: ${output}`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
});

test("toFriendly redacts URL secrets from RelayError and generic Error messages", () => {
  const secret = "friendly-query-secret";
  const relayErr = new RelayError(
    `fetch failed: https://user:pw@example.com/health?token=${secret}#part2`,
    0,
  );
  const friendlyRelay = toFriendly(relayErr);
  assert.ok(friendlyRelay instanceof Error, "returns an Error for a RelayError");
  assert.ok(!friendlyRelay.message.includes(secret), `must not leak the query token: ${friendlyRelay.message}`);
  assert.ok(!friendlyRelay.message.includes("token="), `must not leak the query string: ${friendlyRelay.message}`);
  assert.ok(!friendlyRelay.message.includes("/health"), `must not leak the path: ${friendlyRelay.message}`);
  assert.ok(!friendlyRelay.message.includes("part2"), `must not leak the fragment: ${friendlyRelay.message}`);
  assert.ok(friendlyRelay.message.includes("https://example.com"), `keeps the origin: ${friendlyRelay.message}`);

  const genericErr = new Error(`fetch failed: https://example.com/health?token=${secret}#part2`);
  const friendlyGeneric = toFriendly(genericErr);
  assert.ok(friendlyGeneric instanceof Error, "returns an Error for a generic Error");
  assert.ok(friendlyGeneric !== genericErr, "returns a NEW Error, not the original");
  assert.ok(!friendlyGeneric.message.includes(secret), `must not leak the query token: ${friendlyGeneric.message}`);
  assert.ok(!friendlyGeneric.message.includes("token="), `must not leak the query string: ${friendlyGeneric.message}`);
  assert.ok(!friendlyGeneric.message.includes("/health"), `must not leak the path: ${friendlyGeneric.message}`);
  assert.ok(!friendlyGeneric.message.includes("part2"), `must not leak the fragment: ${friendlyGeneric.message}`);
  assert.ok(friendlyGeneric.message.includes("https://example.com"), `keeps the origin: ${friendlyGeneric.message}`);
});

test("auth recovery re-bind logs the webhook origin, not the secret URL", async () => {
  resetState();
  const keyPair = await generateKeyPair();
  const webhookSecret = "wh-secret-token-123";
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({
      relayUrl: "http://127.0.0.1:9",
      apiKey: "old-key",
      userId: "old-user",
      keyPair,
      channels: [{
        channelId: "wh-1",
        type: "webhook",
        label: "my-webhook",
        createdAt: new Date().toISOString(),
        webhookSecret,
        channelName: "my-webhook",
      }],
    }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;
  FailingWebSocket.instances = [];
  globalThis.fetch = (async (input: unknown, _init?: unknown) => {
    const href = typeof input === "string" ? input : String(input);
    if (href.endsWith("/auth/register")) {
      return new Response(JSON.stringify({ userId: "recovered-user", apiKey: "new-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.endsWith("/channels")) {
      return new Response(JSON.stringify({
        channel: { id: "wh-1", metadata: {} },
        webhookUrl: `https://webhooks.example.com/webhook/wh-1?token=${webhookSecret}`,
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-rebind", fake.notifications));

    assert.ok(FailingWebSocket.instances.length >= 1, "WS constructed");
    FailingWebSocket.instances[0].failHandshake(1006);
    await waitFor(() => FailingWebSocket.instances.length >= 2);
    FailingWebSocket.instances[1].failHandshake(1006);

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    await waitFor(() => {
      const raw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      return raw.includes("URL unchanged");
    });

    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-rebind", fake.notifications));

    const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    assert.ok(!logRaw.includes(webhookSecret), `durable log must not leak the webhook secret: ${logRaw}`);
    assert.ok(logRaw.includes("https://webhooks.example.com"), `log keeps the webhook origin: ${logRaw}`);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});
