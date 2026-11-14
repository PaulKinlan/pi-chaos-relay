/**
 * Integration coverage for the extension entry point (index.ts) — auto-provisioning and credential hygiene: which relay a profile registers against, and the redaction of relay URLs/secrets in doctor, status, reset, connection logs and the durable log.
 *
 * Partitioned from the monolithic test/index.test.ts (bead pi-chaos-relay-h1t,
 * ADR pi-chaos-relay-mpf): every index-* suite is behavior-owned, runs in its
 * own node --test child process, and redirects into its own throwaway HOME/XDG
 * sandbox via createSandbox() BEFORE the dynamic imports below, because
 * config.ts resolves CONFIG_DIR from homedir() at import. Changing THIS file
 * selects only this suite in the implementer fast gate; the shared harness and
 * index.ts itself stay full-tier triggers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RelayError } from "../relay-client.ts";
import {
  createSandbox,
  blockNonLoopbackFetch,
  makeFakePi,
  makeCtx,
  callHandler,
  type Notification,
  createStateHelpers,
} from "./integration-harness.ts";

const { PI_DIR } = createSandbox();

const config = await import("../config.ts");
const { default: chaosRelayExtension, toFriendly, log, rebindLogSummary } =
  await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];

const { resetState } = createStateHelpers(config, PI_DIR);

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
