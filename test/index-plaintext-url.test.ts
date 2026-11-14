/**
 * Integration coverage for the extension entry point (index.ts) — plaintext external relay URLs (bead 8qv): refused with the real reason unless deliberately opted in, across auto-provision, status, doctor and the saved-config fallback.
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
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  blockNonLoopbackFetch,
  makeCtx,
  callHandler,
  PushWebSocket,
  callTool,
  createStateHelpers,
  createWithRelayEnv,
} from "./integration-harness.ts";

const { PI_DIR } = createSandbox();

const config = await import("../config.ts");
const { default: chaosRelayExtension, log } =
  await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];

const { resetState } = createStateHelpers(config, PI_DIR);

const withRelayEnv = createWithRelayEnv(chaosRelayExtension);

test("a plaintext external CHAOS_RELAY_URL is refused with the real reason and the opt-in", async (t) => {
  resetState();
  // Nothing persisted, so there is no valid URL to fall back to: the refusal path.
  try {
    unlinkSync(join(PI_DIR, "chaos-relay.json"));
  } catch {
    /* not present */
  }
  const text = await withRelayEnv(t, { url: "http://relay.example.com" }, "sess-plaintext-env", async (fake, notifications) => {
    const tool = fake.tools.find((entry) => entry.name === "relay_register_telegram") as
      | { execute: unknown }
      | undefined;
    assert.ok(tool, "extension registers relay_register_telegram");
    await callTool(tool, { botToken: "123:ABC" }, notifications, "sess-plaintext-env");
    return notifications.map((n) => n.message).join("\n");
  });

  assert.match(
    text,
    /it points at http:\/\/relay\.example\.com, and plaintext http:\/\/ sends the bearer API key in the clear/,
    `names the origin and the plaintext transport: ${text}`,
  );
  assert.match(text, /CHAOS_RELAY_ALLOW_INSECURE_HTTP=1/, `names the opt-in: ${text}`);
  assert.ok(
    !/not an absolute http\(s\):\/\/ URL/.test(text),
    `a well-formed plaintext URL must not be reported as malformed: ${text}`,
  );
});

test("the plaintext opt-in lets the URL through and warns on every use", async (t) => {
  resetState();
  try {
    unlinkSync(join(PI_DIR, "chaos-relay.json"));
  } catch {
    /* not present */
  }
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  await withRelayEnv(
    t,
    { url: "http://relay.example.com", allowInsecure: "1" },
    "sess-plaintext-optin",
    async (fake, notifications) => {
      const tool = fake.tools.find((entry) => entry.name === "relay_register_telegram") as
        | { execute: unknown }
        | undefined;
      assert.ok(tool, "extension registers relay_register_telegram");
      // The connect itself cannot succeed (the loopback guard blocks the external
      // fetch); the warning is what this test is about.
      await callTool(tool, { botToken: "123:ABC" }, notifications, "sess-plaintext-optin");
    },
  );
  const raw = readFileSync(logPath, "utf-8").slice(logBefore);
  assert.match(
    raw,
    /reached over plaintext http:\/\/ because CHAOS_RELAY_ALLOW_INSECURE_HTTP is set/,
    `the opt-in is called out in the log: ${raw}`,
  );
});

test("doctor fails a plaintext external relay URL even when the opt-in allows it", async (t) => {
  resetState();
  // A persisted loopback URL and an insecure env URL: the doctor reports the
  // EFFECTIVE url, which is the plaintext one.
  writeFileSync(join(PI_DIR, "chaos-relay.json"), JSON.stringify({ relayUrl: "http://127.0.0.1:9" }) + "\n");
  await withRelayEnv(
    t,
    { url: "http://relay.example.com", allowInsecure: "1" },
    "sess-plaintext-doctor",
    async (fake) => {
      const command = fake.commands.get("chaos-relay");
      assert.ok(command, "extension registers the /chaos-relay command");
      await command.handler("doctor", makeCtx("sess-plaintext-doctor", fake.notifications));
      const output = fake.notifications.map((n) => n.message).join("\n");
      assert.match(
        output,
        /relay transport sends the API key in plaintext/,
        `doctor must not report a green URL line for plaintext: ${output}`,
      );
      assert.match(output, /CHAOS_RELAY_ALLOW_INSECURE_HTTP/, `and must say why it passed: ${output}`);
      // The URL line itself is no longer described as plain http(s).
      assert.match(output, /relay URL is valid https \(or loopback http\)/, output);
    },
  );
});

test("a plaintext SAVED relay URL is refused with the reason, not 'unconfigured'", async (t) => {
  resetState();
  // The pre-8qv upgrade case: the saved config points at a LAN relay over http.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_saved_plaintext" }) + "\n",
  );
  const text = await withRelayEnv(t, {}, "sess-plaintext-saved", async (fake, notifications) => {
    const tool = fake.tools.find((entry) => entry.name === "relay_register_telegram") as
      | { execute: unknown }
      | undefined;
    assert.ok(tool, "extension registers relay_register_telegram");
    // The call must RESOLVE: refusing means no connect is attempted at all, so the
    // loopback fetch guard below can never fire (it would reject the promise).
    await callTool(tool, { botToken: "123:ABC" }, notifications, "sess-plaintext-saved");
    return notifications.map((n) => n.message).join("\n");
  });

  assert.match(
    text,
    /the saved relay URL is refused because it points at http:\/\/192\.168\.1\.5:8787/,
    `the saved URL is named as the reason: ${text}`,
  );
  assert.match(text, /CHAOS_RELAY_ALLOW_INSECURE_HTTP=1/, `and the opt-in is offered: ${text}`);
  assert.ok(
    !/no relay URL is configured/.test(text),
    `must not claim nothing is configured: ${text}`,
  );
  assert.match(text, /refusing to auto-provision an identity against the default relay/, `and refuses rather than following the default: ${text}`);
});

test("a bound session with a plaintext saved relay does not connect at all", async (t) => {
  resetState();
  // An apiKey is present, so this profile is BOUND: without the guard,
  // resolveConfig would hand the client the default relay and send this key there.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_bound_plaintext" }) + "\n",
  );
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  await withRelayEnv(t, {}, "sess-bound-plaintext", async (fake) => {
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-bound-plaintext", fake.notifications));
  });

  assert.equal(PushWebSocket.instances.length, 0, "no WebSocket is opened for a refused saved relay");
  const raw = readFileSync(logPath, "utf-8").slice(logBefore);
  assert.match(raw, /the saved relay URL is refused/, `the refusal is logged: ${raw}`);
  assert.ok(
    !raw.includes("connecting to relay"),
    `and no connect is attempted (the default relay must not take over): ${raw}`,
  );
});

test("a refused env URL still falls through to a valid saved relay", async (t) => {
  resetState();
  // The documented env-ignored path must survive the plaintext refusal.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak_saved_ok" }) + "\n",
  );
  await withRelayEnv(t, { url: "http://192.168.1.5:8787" }, "sess-env-refused-saved-ok", async (fake) => {
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-env-refused-saved-ok", fake.notifications));
  });
  // The refused env value must not be dialed, and must not cost the saved relay
  // either: the session binds to the valid one.
  assert.ok(PushWebSocket.instances.length >= 1, "the saved loopback relay is still connected");
  assert.ok(
    PushWebSocket.instances.every((socket) => !socket.url.includes("192.168.1.5")),
    `the refused env host is never dialed: ${PushWebSocket.instances.map((s) => s.url).join(", ")}`,
  );
});


// --- review round 1 (8qv): the fallback and direct-client paths -------------
//
// isValidRelayUrl refuses a plaintext external URL, but resolveConfig then falls
// back to DEFAULT_RELAY_URL. Every path that could build a client from that
// fallback has to be shut, or a saved bearer key travels to a relay the operator
// never configured.

test("a malformed env URL plus a plaintext saved URL still refuses the fallback relay", async (t) => {
  resetState();
  // The combination the review found: the env value is invalid for an unrelated
  // reason, so it is not itself "insecure" — but the SAVED url is.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_saved_plain" }) + "\n",
  );
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  await withRelayEnv(t, { url: "not-a-url" }, "sess-malformed-env-plain-saved", async (fake) => {
    await callHandler(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      makeCtx("sess-malformed-env-plain-saved", fake.notifications),
    );
  });

  assert.equal(PushWebSocket.instances.length, 0, "no socket is opened");
  const raw = readFileSync(logPath, "utf-8").slice(logBefore);
  assert.match(raw, /the saved relay URL is refused/, `the refusal names the saved URL: ${raw}`);
  assert.ok(
    !raw.includes("connecting to relay") || !raw.includes("chaos-relay.com"),
    `the default relay is never dialed with the saved key: ${raw}`,
  );
});

test("status does not send the saved key to the fallback relay", async (t) => {
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_status_plain" }) + "\n",
  );
  const output = await withRelayEnv(t, {}, "sess-status-refused", async (fake) => {
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    // The reachability + listChannels calls belong to this command, and
    // listChannels() is AUTHENTICATED: a fallback client would send the key to
    // chaos-relay.com. blockNonLoopbackFetch (installed by withRelayEnv) would
    // reject that fetch, so this call resolving at all is part of the assertion.
    await command.handler("status", makeCtx("sess-status-refused", fake.notifications));
    return fake.notifications.map((n) => n.message).join("\n");
  });

  assert.match(output, /refused/, `status reports the refusal: ${output}`);
  assert.match(
    output,
    /http:\/\/192\.168\.1\.5:8787/,
    `and names the refused URL (origin only): ${output}`,
  );
  // No live calls: a fallback client would have produced these from a host that
  // never received the request (or, unguarded, from chaos-relay.com WITH the key).
  assert.ok(!/relay health:/.test(output), `status made no health call: ${output}`);
  assert.ok(!/relay channels:/.test(output), `status made no authenticated channel call: ${output}`);
  assert.match(output, /not contacting https:\/\/chaos-relay\.com/, `and says so: ${output}`);
});

test("a bound opted-in plaintext session still warns on connect", async (t) => {
  resetState();
  // Bound (apiKey present) + opt-in set: the client is cached, so a warning that
  // only lived in the auto-provisioning path would never fire.
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_bound_optin" }) + "\n",
  );
  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  await withRelayEnv(
    t,
    { allowInsecure: "1" },
    "sess-bound-optin",
    async (fake) => {
      await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-bound-optin", fake.notifications));
    },
  );
  const raw = readFileSync(logPath, "utf-8").slice(logBefore);
  assert.match(
    raw,
    /reached over plaintext http:\/\/ because CHAOS_RELAY_ALLOW_INSECURE_HTTP is set/,
    `the opted-in connect is called out: ${raw}`,
  );
  assert.ok(PushWebSocket.instances.length >= 1, "and the opted-in plaintext relay is still connected");
});

test("doctor reports a refused saved URL instead of a green URL line", async (t) => {
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://192.168.1.5:8787", apiKey: "ak_doctor_plain" }) + "\n",
  );
  const output = await withRelayEnv(t, {}, "sess-doctor-refused", async (fake) => {
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("doctor", makeCtx("sess-doctor-refused", fake.notifications));
    return fake.notifications.map((n) => n.message).join("\n");
  });

  assert.match(
    output,
    /refused=http:\/\/192\.168\.1\.5:8787 \(plaintext outside loopback\)/,
    `the refused candidate is reported: ${output}`,
  );
  assert.match(output, /CHAOS_RELAY_ALLOW_INSECURE_HTTP=1/, `with the way out: ${output}`);
  assert.ok(
    !/relay transport sends the API key in plaintext\n[^]*?ok/.test(output),
    `a refused URL is not reported as an in-use plaintext transport: ${output}`,
  );
});
