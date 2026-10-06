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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
const { default: chaosRelayExtension, claimProfileLock, ApprovalQueue, log, rebindLogSummary } =
  await import("../index.ts");

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

/** Is `pid` a live process? (Matches index.ts's isProcessAlive.) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Lock path index.ts uses: ~/.pi/chaos-relay-<profile>.lock (homedir() at call time). */
function lockPath(profile: string): string {
  return join(PI_DIR, `chaos-relay-${profile}.lock`);
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
  const credUrl = `https://user:${password}@example.com`;
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
    // The origin is still shown so the operator can see which host is in effect.
    assert.ok(output.includes("https://example.com"), `doctor shows the redacted origin (${output})`);
  } finally {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  }
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

// ── pi-chaos-relay-bxa: the profile lock is claimed atomically, pre-connect ──
//
// The old flow read the lock, awaited connectAsProfile() (which can register a
// live relay session), and only then wrote the lock with a plain writeFileSync.
// Two processes starting together could both observe "unlocked", both connect,
// and both write. The claim is now an exclusive create (flag "wx") made BEFORE
// any connect, so a race has exactly one winner and a live holder is never
// overwritten.

test("claimProfileLock refuses a live holder without touching its file", () => {
  resetState();
  const lock = lockPath("race-held");
  // A pid that is alive and is not us: this test process's own parent chain is
  // fine, but the simplest always-alive foreign pid is 1 (init).
  writeFileSync(lock, "1");
  const before = readFileSync(lock, "utf-8");

  const result = claimProfileLock("race-held");

  assert.equal(result.claimed, false, "must not claim a profile a live process holds");
  assert.equal(result.pid, 1, "reports the live holder's pid for the refusal message");
  assert.equal(readFileSync(lock, "utf-8"), before, "the holder's lock file is untouched");
  assert.equal(result.path, lock, "names the lock file");
});

test("claimProfileLock cleans a stale holder and claims the profile", () => {
  resetState();
  const lock = lockPath("race-stale");
  // A pid that no longer exists (spawned and reaped), so the lock is genuinely
  // stale rather than "unparseable by accident".
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, "2147483646"); // beyond any real pid: not alive
  assert.equal(isAlive(2147483646), false, "test premise: the recorded pid is dead");

  const result = claimProfileLock("race-stale");

  assert.equal(result.claimed, true, "a dead holder's lock is stale and reclaimable");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "the lock now names this process");
});

test("claimProfileLock: two processes racing the same profile — exactly one wins", async (t) => {
  resetState();
  const profile = "race-atomic";
  const lock = lockPath(profile);
  const extUrl = new URL("../index.ts", import.meta.url).href;
  const HOLD_MS = 4_000;
  // All children attempt at the same wall-clock instant so the exclusive
  // creates genuinely overlap. Crucially, the winner HOLDS the lock (sleeps)
  // while the losers attempt: a winner that exited instantly would leave a
  // genuinely stale lock, and then a second claim is CORRECT, not a race
  // failure. So the results are read while every child is still alive.
  const startAt = Date.now() + 700;
  const child = `
    const { claimProfileLock } = await import(${JSON.stringify(extUrl)});
    while (Date.now() < Number(process.env.START_AT)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = claimProfileLock(process.env.LOCK_PROFILE);
    // console.log appends the newline the parent's line reader needs.
    console.log(JSON.stringify({ pid: process.pid, claimed: result.claimed, holder: result.pid }));
    // Stay alive so the losers must see a LIVE holder (not a stale file).
    await new Promise((r) => setTimeout(r, ${HOLD_MS}));
  `;

  /** Resolve with the child's first stdout line (its claim result). */
  function startRacer(): { firstLine: Promise<string>; exited: Promise<void> } {
    const p = spawn(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, START_AT: String(startAt), LOCK_PROFILE: profile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let err = "";
    let resolveFirst!: (line: string) => void;
    const firstLine = new Promise<string>((resolve) => (resolveFirst = resolve));
    p.stdout.on("data", (c) => {
      buffer += String(c);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolveFirst(buffer.slice(0, nl));
    });
    p.stderr.on("data", (c) => (err += String(c)));
    const exited = new Promise<void>((resolve, reject) =>
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`racer exited ${code}: ${err}`)),
      ),
    );
    return { firstLine, exited };
  }

  const racers = [startRacer(), startRacer(), startRacer()];
  const results = (await Promise.all(racers.map((r) => r.firstLine))).map(
    (line) => JSON.parse(line) as { pid: number; claimed: boolean; holder: number | null },
  );
  const winners = results.filter((r) => r.claimed);
  assert.equal(
    winners.length,
    1,
    `exactly one process may claim the profile while the others are live: ${JSON.stringify(results)}`,
  );
  // Every loser saw the live winner (not a stale file it was entitled to clean).
  for (const loser of results.filter((r) => !r.claimed)) {
    assert.equal(loser.holder, winners[0].pid, "a loser must report the live holder's pid");
  }
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(winners[0].pid),
    "the lock names the single winner, not the last writer",
  );

  // While the winner is still alive, a further claim is refused and cannot
  // overwrite it.
  const after = claimProfileLock(profile);
  assert.equal(after.claimed, false, "a live holder is never reclaimed");
  assert.equal(after.pid, winners[0].pid, "refusal names the live winner");
  assert.equal(readFileSync(lock, "utf-8"), String(winners[0].pid), "still the winner's pid");

  await Promise.all(racers.map((r) => r.exited));
  t.diagnostic(`race result: ${JSON.stringify(results)}`);
});

// ── pi-chaos-relay-abl: concurrent approvals each get their own decision ─────

test("two concurrent approval requests resolve separately (no cross-resolve, no loss)", async () => {
  const logs: string[] = [];
  const q = new ApprovalQueue(60_000, (m) => logs.push(m));
  const first = q.add({ channelId: "c1", toolName: "bash" });
  const second = q.add({ channelId: "c1", toolName: "edit" });
  assert.equal(q.size, 2, "both requests are outstanding");
  assert.notEqual(first.ref, second.ref, "each request has its own reference");

  // Unaddressed reply → the OLDEST outstanding request on that channel.
  assert.equal(q.settle({ channelId: "c1", content: "yes" }), true, "message consumed");
  assert.equal(await first.promise, true, "the first call got the approval");
  assert.equal(q.size, 1, "only the answered request was settled");

  // Addressed reply → the request it names, even though it is not the oldest.
  assert.equal(q.settle({ channelId: "c1", content: `#${second.ref} no` }), true);
  assert.equal(await second.promise, false, "the second call got its own (denied) decision");
  assert.equal(q.size, 0, "no request left behind");
});

test("each approval request times out independently", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  const q = new ApprovalQueue(60_000, (m) => logs.push(m));
  const first = q.add({ channelId: "c1", toolName: "bash" });
  t.mock.timers.tick(30_000);
  const second = q.add({ channelId: "c1", toolName: "edit" });

  t.mock.timers.tick(30_000); // first reaches 60s; second is only 30s old
  assert.equal(await first.promise, false, "the older request auto-denied on its own timeout");
  assert.equal(q.size, 1, "the younger request was NOT wiped by the older one's timeout");

  // …and the younger one is still answerable afterwards.
  assert.equal(q.settle({ channelId: "c1", content: "yes" }), true);
  assert.equal(await second.promise, true, "the surviving request still gets its answer");
  assert.equal(q.size, 0);
});

test("approval replies are routed by channel and by reference", async () => {
  const q = new ApprovalQueue(60_000);
  const a = q.add({ channelId: "c1", toolName: "bash" });
  const b = q.add({ channelId: "c2", toolName: "bash" });

  // Another channel's message answers nothing here and must be forwarded.
  assert.equal(q.settle({ channelId: "c3", content: "yes" }), false, "not consumed");
  assert.equal(q.size, 2, "no request resolved by an unrelated channel");

  // An explicit reference resolves that request, not the oldest.
  assert.equal(q.settle({ channelId: "c2", content: `#${b.ref} yes` }), true);
  assert.equal(await b.promise, true);
  assert.equal(q.size, 1, "the c1 request is still waiting");

  // A reference to nothing pending is consumed but resolves nothing.
  assert.equal(q.settle({ channelId: "c1", content: "#999 yes" }), true, "consumed");
  assert.equal(q.size, 1, "an unknown reference must not settle a real request");
  assert.equal(q.settle({ channelId: "c1", content: "yes" }), true);
  assert.equal(await a.promise, true, "the real request still settles normally");
});

test("cancel() drops a request that never reached the user", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const q = new ApprovalQueue(60_000);
  const dropped = q.add({ channelId: "c1", toolName: "bash" });
  dropped.cancel();
  assert.equal(q.size, 0, "the entry is gone");
  assert.equal(
    q.settle({ channelId: "c1", content: "yes" }),
    false,
    "a message no longer answers a cancelled request (it is forwarded to the agent)",
  );
  // Its timer cannot fire later and deny a different request.
  const live = q.add({ channelId: "c1", toolName: "edit" });
  t.mock.timers.tick(120_000);
  assert.equal(q.size, 0);
  assert.equal(await live.promise, false, "the live request timed out on its own timer");
});

test("loadSessionMap ignores an orphan temp file beside the session map (reader tolerance)", () => {
  resetState();
  config.setSessionProfile("sess-atomic", "work");
  assert.deepEqual(config.loadSessionMap(), { "sess-atomic": "work" });
  const previousRaw = readFileSync(SESSIONS_PATH, "utf-8");

  // Simulate a crash between the temp write and the rename: an orphan temp file
  // beside the target holds a partial NEXT map, but the target was never renamed,
  // so the previous complete map must still be what the reader sees — and the
  // orphan must be ignored (it is not the target path).
  const orphan = `${SESSIONS_PATH}.tmp.simulated`;
  writeFileSync(orphan, '{"sess-atomic":"home"');
  try {
    assert.deepEqual(config.loadSessionMap(), { "sess-atomic": "work" });
    assert.equal(readFileSync(SESSIONS_PATH, "utf-8"), previousRaw, "target map byte-identical");
  } finally {
    unlinkSync(orphan);
  }
});

test("loadSessionMap tolerates a corrupt session map without crashing", () => {
  resetState();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    writeFileSync(SESSIONS_PATH, "{ not json");
    assert.deepEqual(config.loadSessionMap(), {});
    writeFileSync(SESSIONS_PATH, "[]");
    assert.deepEqual(config.loadSessionMap(), {});
    // A non-string value is a corrupt entry: it is dropped rather than leaking
    // a non-string profile name into profile resolution (which would crash).
    writeFileSync(
      SESSIONS_PATH,
      JSON.stringify({ "sess-ok": "work", "sess-bad": 123 }) + "\n",
    );
    assert.deepEqual(config.loadSessionMap(), { "sess-ok": "work" });
  } finally {
    console.warn = originalWarn;
  }
});

test("relay_switch_profile refuses a new profile beyond the cap without writing a file", async () => {
  resetState();
  // Remove any profile configs left by earlier tests so the count is deterministic.
  for (const f of relayStateFiles()) {
    if (/^chaos-relay(?:\.(.+))?\.json$/.test(f)) {
      try {
        unlinkSync(join(PI_DIR, f));
      } catch {
        /* already gone */
      }
    }
  }
  const cap = config.MAX_PROFILE_CONFIGS;
  for (let i = 0; i < cap; i++) {
    writeProfileConfig(i === 0 ? "default" : `fill-${i}`, `ak_fill_${i}`);
  }
  assert.equal(config.countProfileConfigs(), cap);

  const overflowPath = config.profilePathForName("overflow");
  assert.equal(existsSync(overflowPath), false);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const tool = fake.tools.find((t) => t.name === "relay_switch_profile");
  assert.ok(tool, "extension registers relay_switch_profile");
  const execute = tool.execute as (
    id: string,
    params: { name: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  const result = await execute("t1", { name: "overflow" }, undefined, undefined, {
    ui: {
      notify: (message: string, level?: string) => fake.notifications.push({ message, level }),
    },
  });

  const text =
    (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? String(result);
  assert.match(
    text,
    /profile cap of 100 is already reached \(100 profile files on disk\)/,
  );
  assert.equal(existsSync(overflowPath), false, "no profile config file was written beyond the cap");
  assert.equal(config.countProfileConfigs(), cap, "profile count unchanged after the refusal");
  assert.ok(
    fake.notifications.some(
      (n) => n.level === "warning" && n.message.includes("profile cap of 100"),
    ),
    `refusal was surfaced as a warning notification (${JSON.stringify(fake.notifications)})`,
  );
});

// ── pi-chaos-relay-bw5: /chaos-relay profile claims the lock before connect ──

test("switchProfile claims the lock, refuses a live holder, and reclaims a stale one", async (t) => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  writeProfileConfig("beta", "ak_beta_offline");
  const lock = lockPath("beta");

  // (a) a live holder: refused, named, and its file untouched.
  const holderPid = startOtherLiveSession(t);
  writeFileSync(lock, String(holderPid));
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const cmd = fake.commands.get("chaos-relay")!;
  const ctx = makeCtx("sess-switch-a", fake.notifications);
  await cmd.handler("profile beta", ctx);

  const refusal = fake.notifications.map((n) => n.message).join("\n");
  assert.match(refusal, /Relay profile "beta" is already held/, `refusal: ${refusal}`);
  assert.ok(refusal.includes(String(holderPid)), "refusal names the live holder's pid");
  assert.equal(readFileSync(lock, "utf-8"), String(holderPid), "holder's lock untouched");
  assert.notEqual(
    config.getConfigPath(),
    config.profilePathForName("beta"),
    "a refused switch does not move the session onto the held profile",
  );

  // (b) a stale holder (dead pid): reclaimed and the switch proceeds.
  writeFileSync(lock, "2147483646");
  assert.equal(isAlive(2147483646), false, "test premise: the recorded pid is dead");
  const fake2 = makeFakePi();
  chaosRelayExtension(fake2.pi as unknown as ExtensionApi);
  await fake2.commands.get("chaos-relay")!.handler(
    "profile beta",
    makeCtx("sess-switch-b", fake2.notifications),
  );
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "stale lock reclaimed by us");
  assert.equal(
    config.getConfigPath(),
    config.profilePathForName("beta"),
    "the switch completed onto the reclaimed profile",
  );
  const switched = fake2.notifications.map((n) => n.message).join("\n");
  assert.match(switched, /Switched to profile "beta"/, `switch outcome: ${switched}`);
});

test("an empty lock file is only reclaimed after the create grace (a racer may be mid-create)", () => {
  resetState();
  const lock = lockPath("grace");
  // Fresh empty file: indistinguishable from another process's in-flight
  // exclusive create, so it must be treated as held, not stolen.
  writeFileSync(lock, "");
  const fresh = claimProfileLock("grace");
  assert.equal(fresh.claimed, false, "a just-created empty lock is treated as held");
  assert.equal(readFileSync(lock, "utf-8"), "", "and is not deleted");

  // Old empty file: a crashed leftover, so it is reclaimed.
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lock, old, old);
  const reclaimed = claimProfileLock("grace");
  assert.equal(reclaimed.claimed, true, "an old empty lock is a stale leftover");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "now names this process");
});

test("two concurrent switches to the same profile: exactly one connects, the other is refused", async (t) => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  const target = writeProfileConfig("shared", "ak_shared_offline");
  const lock = lockPath("shared");
  const extUrl = new URL("../index.ts", import.meta.url).href;
  const HOLD_MS = 4_000;
  // Inter-process on purpose: the lock records a pid, so two sessions in ONE
  // process are indistinguishable to it. The threat the bead describes is two
  // pi processes switching to one profile, which is what this drives.
  const startAt = Date.now() + 900;
  const child = `
    const { default: chaosRelayExtension } = await import(${JSON.stringify(extUrl)});
    const commands = new Map();
    const notifications = [];
    const pi = {
      on() {},
      registerCommand(name, def) { commands.set(name, def); },
      registerTool() {},
      sendUserMessage() {},
    };
    chaosRelayExtension(pi);
    const ctx = {
      model: { input: ["text"] },
      sessionManager: { getSessionId: () => "child-" + process.pid },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    };
    while (Date.now() < Number(process.env.START_AT)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await commands.get("chaos-relay").handler("profile shared", ctx);
    console.log(JSON.stringify({
      pid: process.pid,
      notifications: notifications.map((n) => n.message),
    }));
    // Hold the lock (if won) so the loser must see a LIVE holder.
    await new Promise((r) => setTimeout(r, ${HOLD_MS}));
  `;

  function startSwitcher(): { firstLine: Promise<string>; exited: Promise<void> } {
    const p = spawn(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, START_AT: String(startAt) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let err = "";
    let resolveFirst!: (line: string) => void;
    const firstLine = new Promise<string>((resolve) => (resolveFirst = resolve));
    p.stdout.on("data", (c) => {
      buffer += String(c);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolveFirst(buffer.slice(0, nl));
    });
    p.stderr.on("data", (c) => (err += String(c)));
    const exited = new Promise<void>((resolve, reject) =>
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`switcher exited ${code}: ${err}`)),
      ),
    );
    return { firstLine, exited };
  }

  const switchers = [startSwitcher(), startSwitcher()];
  const results = (await Promise.all(switchers.map((s) => s.firstLine))).map(
    (line) => JSON.parse(line) as { pid: number; notifications: string[] },
  );
  const connected = results.filter((r) => r.notifications.some((m) => /Switched to profile "shared"/.test(m)));
  const refused = results.filter((r) => !connected.includes(r));
  assert.equal(
    connected.length,
    1,
    `exactly one concurrent switch may connect: ${JSON.stringify(results)}`,
  );
  assert.equal(refused.length, 1, "the other switch is refused");
  assert.ok(
    refused[0].notifications.some((m) => /already held/.test(m)),
    `the refused switch explains itself: ${JSON.stringify(refused[0].notifications)}`,
  );
  assert.ok(
    refused[0].notifications.some((m) => m.includes(String(connected[0].pid))),
    "the refusal names the winning process's pid",
  );
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(connected[0].pid),
    "the lock names the process that actually connected",
  );
  assert.equal(readFileSync(target, "utf-8").length > 0, true, "target profile config exists");

  await Promise.all(switchers.map((s) => s.exited));
  t.diagnostic(`concurrent switch result: ${JSON.stringify(results)}`);
});

// ── pi-chaos-relay-hp2: the atomic-write test must DISCRIMINATE ──────────────
//
// The test above pins a reader property (an orphan temp file is ignored), which
// passed against the pre-atomic implementation too: nothing read that file
// either way, so it never proved the WRITE was atomic. This one does — a
// temp-file + rename replaces the directory entry, so the inode CHANGES, while
// an in-place writeFileSync keeps the same inode.

test("setSessionProfile replaces the session map via rename, not an in-place write", () => {
  resetState();
  config.setSessionProfile("sess-ino", "work");
  const firstRaw = readFileSync(SESSIONS_PATH, "utf-8");
  const inoBefore = statSync(SESSIONS_PATH).ino;

  config.setSessionProfile("sess-ino", "home");

  assert.notEqual(
    statSync(SESSIONS_PATH).ino,
    inoBefore,
    "the target was replaced by a rename; an in-place write would keep the same inode",
  );
  assert.notEqual(readFileSync(SESSIONS_PATH, "utf-8"), firstRaw, "the map actually changed");
  assert.deepEqual(config.loadSessionMap(), { "sess-ino": "home" });
  const leftovers = readdirSync(PI_DIR).filter((f) => f.startsWith(`${basename(SESSIONS_PATH)}.tmp.`));
  assert.deepEqual(leftovers, [], "no temp residue after a completed write");
});

// ── pi-chaos-relay-odf: an approval reference may carry punctuation ──────────

test("an approval reference followed by punctuation still counts as an answer", async () => {
  const q = new ApprovalQueue(60_000);
  // '#1: yes' and '#1 - yes' used to be read as DENIALS: the ref regex left
  // ': yes' / ' - yes' for the yes/no test, which does not match.
  const a = q.add({ channelId: "c1", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", content: `#${a.ref}: yes` }), true);
  assert.equal(await a.promise, true, "'#N: yes' approves");

  const b = q.add({ channelId: "c1", toolName: "edit" });
  assert.equal(q.settle({ channelId: "c1", content: `#${b.ref} - yes` }), true);
  assert.equal(await b.promise, true, "'#N - yes' approves");

  const c = q.add({ channelId: "c1", toolName: "write" });
  assert.equal(q.settle({ channelId: "c1", content: `#${c.ref}, no` }), true);
  assert.equal(await c.promise, false, "'#N, no' denies");

  const d = q.add({ channelId: "c1", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", content: `#${d.ref} yes` }), true);
  assert.equal(await d.promise, true, "the documented '#N yes' still works");

  const e = q.add({ channelId: "c1", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", content: `#${e.ref}    yes` }), true);
  assert.equal(await e.promise, true, "extra whitespace still works");
});

// ── pi-chaos-relay-8ni: pid 0, and a future mtime, are not "held by a live peer"

test("a lock file containing '0' is not a live holder and is reclaimable", () => {
  resetState();
  const lock = lockPath("pid-zero");
  // process.kill(0, 0) signals the caller's own process group and succeeds, so
  // '0' previously looked like a live holder that could never be reclaimed.
  writeFileSync(lock, "0");
  const claimed = claimProfileLock("pid-zero");
  assert.equal(claimed.claimed, true, "pid 0 must not block the claim");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

test("an empty lock whose mtime is in the FUTURE is reclaimed, not held in grace", () => {
  resetState();
  const lock = lockPath("future-mtime");
  writeFileSync(lock, "");
  // A clock step / NTP correction can leave mtime ahead of now. The grace window
  // only applies to a non-negative age, otherwise such a file would stay "just
  // created" until the wall clock caught up and block the profile indefinitely.
  const future = Date.now() / 1000 + 3600;
  utimesSync(lock, future, future);
  const claimed = claimProfileLock("future-mtime");
  assert.equal(claimed.claimed, true, "a future-dated empty lock is stale, not in grace");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

test("a fresh empty lock (age inside the grace window) is still treated as held", () => {
  resetState();
  const lock = lockPath("fresh-empty");
  writeFileSync(lock, "");
  const claimed = claimProfileLock("fresh-empty");
  assert.equal(claimed.claimed, false, "the grace window still protects a mid-create lock");
  assert.equal(readFileSync(lock, "utf-8"), "");
});

// ── pi-chaos-relay-9oi: a FAILED switch still releases the profile left behind

test("a switch whose connect fails releases the previous profile's lock", async (t) => {
  resetState();
  // Session starts on "alpha" (pre-provisioned, so it connects offline and
  // claims alpha's lock), then switches to a profile that EXISTS but is
  // unconfigured, so connectAsProfile() attempts a live registration and fails
  // against the offline relay. The target exists on purpose: a brand-new name
  // would trip the profile cap in this shared test HOME (which accumulates
  // config files), testing the wrong refusal.
  const alpha = writeProfileConfig("alpha", "ak_alpha_offline");
  writeProfileConfig("default", "ak_default_offline");
  const targetConfig = config.profilePathForName("brandnew");
  writeFileSync(targetConfig, "{}\n");
  const sid = "sess-failed-switch";
  writeFileSync(SESSIONS_PATH, JSON.stringify({ [sid]: "alpha" }) + "\n");
  const alphaLock = lockPath("alpha");
  const targetLock = lockPath("brandnew");

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "resume" },
    makeCtx(sid, fake.notifications),
  );
  assert.equal(readFileSync(alphaLock, "utf-8"), String(process.pid), "alpha claimed at session start");
  assert.equal(config.getConfigPath(), alpha);

  await fake.commands.get("chaos-relay")!.handler(
    "profile brandnew",
    makeCtx(sid, fake.notifications),
  );

  const out = fake.notifications.map((n) => n.message).join("\n");
  assert.match(out, /couldn't reach the relay to connect/, `switch outcome: ${out}`);
  assert.equal(
    existsSync(alphaLock),
    false,
    "the profile the session LEFT is released even though the new connect failed",
  );
  assert.equal(
    readFileSync(targetLock, "utf-8"),
    String(process.pid),
    "the target stays claimed for the retrying poller",
  );
  t.diagnostic(`notifications: ${JSON.stringify(fake.notifications.map((n) => n.message))}`);
});

// ── pi-chaos-relay-vut: same-millisecond mtime skew must not unlink a fresh lock

test("an empty lock read in the same millisecond it was created is still held", () => {
  resetState();
  const lock = lockPath("same-ms");
  writeFileSync(lock, "");
  // Deterministically reproduce the skew the reviewer found: Date.now() is
  // integer ms while mtimeMs is fractional, so a lock created and read inside
  // one millisecond yields ageMs ≈ -0.8. The old `ageMs >= 0` test treated that
  // as a future mtime and UNLINKED a mid-create lock — the window the grace
  // exists to protect (and it made the sibling test pass only by timing luck).
  // 20ms ahead: inside the 50ms tolerance with room for the few ms of drift
  // between setting the mtime and reading it (a 1ms probe drifts to ~0 and
  // stops discriminating). The real skew is sub-millisecond; this pins the
  // tolerance band itself.
  const slightlyAhead = Date.now() / 1000 + 0.02;
  utimesSync(lock, slightlyAhead, slightlyAhead);
  const claimed = claimProfileLock("same-ms");
  assert.equal(claimed.claimed, false, "same-millisecond skew is inside the grace window");
  assert.equal(readFileSync(lock, "utf-8"), "", "and the file was not unlinked");

  // The tolerance is bounded: a REAL future mtime stays stale and reclaimable.
  const future = Date.now() / 1000 + 5;
  utimesSync(lock, future, future);
  const reclaimed = claimProfileLock("same-ms");
  assert.equal(reclaimed.claimed, true, "a genuinely future-dated lock is stale, not in grace");
});

// ── pi-chaos-relay-nz5: the em dash iOS QuickType inserts for '--'

test("an approval reference followed by an em dash still counts as an answer", async () => {
  const q = new ApprovalQueue(60_000);
  // iOS QuickType turns a typed '--' into U+2014 (em dash); the reference class
  // covered ':' '-' en-dash and ',' but not the em dash, so this denied.
  const a = q.add({ channelId: "c1", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", content: `#${a.ref} — yes` }), true);
  assert.equal(await a.promise, true, "'#N — yes' (em dash U+2014) approves");

  const b = q.add({ channelId: "c1", toolName: "edit" });
  assert.equal(q.settle({ channelId: "c1", content: `#${b.ref}\u2014no` }), true, "no space needed either");
  assert.equal(await b.promise, false, "'#N—no' denies");
});

// ── Durable log hardening: owner-only permissions and no pairing codes /
//    channel identifiers in the durable log.

test("durable log writes with owner-only directory and file modes", () => {
  const logDir = join(PI_DIR, "agent", "logs");
  const logPath = join(logDir, "chaos-relay.log");
  rmSync(logDir, { recursive: true, force: true });

  log("permission test");

  assert.equal(statSync(logDir).mode & 0o777, 0o700, "log directory is owner-only (0700)");
  assert.equal(statSync(logPath).mode & 0o777, 0o600, "log file is owner-only (0600)");
});

test("existing loose log directory and file are tightened on write", () => {
  const logDir = join(PI_DIR, "agent", "logs");
  const logPath = join(logDir, "chaos-relay.log");
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(logPath, "old permissive entry\n");
  chmodSync(logDir, 0o755);
  chmodSync(logPath, 0o644);
  assert.equal(statSync(logDir).mode & 0o777, 0o755, "precondition: dir is loose");
  assert.equal(statSync(logPath).mode & 0o777, 0o644, "precondition: file is loose");

  log("tighten test");

  assert.equal(statSync(logDir).mode & 0o777, 0o700, "existing loose dir is tightened to 0700");
  assert.equal(statSync(logPath).mode & 0o777, 0o600, "existing loose file is tightened to 0600");
});

test("durable log never records pairing codes or channel identifiers", () => {
  const logDir = join(PI_DIR, "agent", "logs");
  const logPath = join(logDir, "chaos-relay.log");
  const pairingCode = "PAIR-WRITTEN-987654";
  const channelId = "ch-written-secret";
  const botUsername = "writtenbot";

  // rebindLogSummary is exactly what rebindChannels() passes to log(); give it
  // a real registration result carrying a pairing code + identifiers and assert
  // none survive into the summary or the written file.
  const summary = rebindLogSummary([
    {
      type: "telegram",
      ok: true,
      pairingCode,
      channelId,
      botUsername,
    },
    {
      type: "email",
      ok: true,
      channelId: "ch-email-secret",
      inboundAddress: "ch-email-secret@relay.example",
      userEmail: "operator@example.com",
    },
    {
      type: "webhook",
      ok: true,
      channelId: "ch-webhook-secret",
      webhookUrl: "https://relay.example/webhook/ch-webhook-secret?token=topsecret",
    },
  ]);

  const secrets = [
    pairingCode,
    channelId,
    botUsername,
    "ch-email-secret",
    "ch-email-secret@relay.example",
    "operator@example.com",
    "ch-webhook-secret",
    "topsecret",
  ];
  for (const secret of secrets) {
    assert.ok(!summary.includes(secret), `summary must not leak "${secret}": ${summary}`);
  }
  // Still diagnostic: names the channel type and the manual re-link step.
  assert.match(summary, /telegram channel re-registered/);
  assert.match(summary, /pairing code/);
  assert.match(summary, /verification link/);

  log(summary);
  const logRaw = readFileSync(logPath, "utf-8");
  for (const secret of secrets) {
    assert.ok(!logRaw.includes(secret), `written log must not leak "${secret}": ${logRaw}`);
  }
});
