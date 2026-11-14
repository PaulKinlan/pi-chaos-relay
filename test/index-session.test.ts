/**
 * Integration coverage for the extension entry point (index.ts) — session lifecycle, transport and persistence: auth-recovery re-bind, WebSocket auth mode, the state writer's drain-edge flush, and delivery across session replacement.
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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPair } from "../crypto.ts";
import { MessagePoller } from "../poller.ts";
import {
  createSandbox,
  OFFLINE_RELAY_URL,
  makeFakePi,
  makeCtx,
  callHandler,
  FailingWebSocket,
  PushWebSocket,
  socketCarries,
  socketForProfile,
  waitFor,
  makeInflightProbe,
  STALE_RUNTIME_MESSAGE,
  pushMessage,
  windowedClient,
  createStateHelpers,
} from "./integration-harness.ts";

const { PI_DIR } = createSandbox();

const config = await import("../config.ts");
const { default: chaosRelayExtension, log, isStaleRuntimeError } =
  await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];

const { resetState, writeProfileConfig } = createStateHelpers(config, PI_DIR);

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
  const ownSockets = () =>
    FailingWebSocket.instances.filter((ws) => socketCarries(ws, "old-key"));
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

    assert.ok(ownSockets().length >= 1, "this test's WS was constructed for old-key");
    const first = ownSockets()[0];
    first.failHandshake(1006);
    await waitFor(() => ownSockets().length >= 2);
    const second = ownSockets().find((ws) => ws !== first);
    assert.ok(second, "the client under test reconnected with its own apiKey");
    second.failHandshake(1006);

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


// ── pi-chaos-relay-0yj: the forced-new-session channel re-bind runs its
//    independent registrations CONCURRENTLY (one round trip, not N) without
//    losing any record's result.

test("auth recovery re-binds every channel concurrently, in one round-trip window", async () => {
  resetState();
  // Start from an empty durable log so the assertions below cannot match a
  // previous test's re-bind summary.
  rmSync(join(PI_DIR, "agent", "logs"), { recursive: true, force: true });

  const keyPair = await generateKeyPair();
  const createdAt = new Date().toISOString();
  const webhookChannels = ["wh-rebind-a", "wh-rebind-b"];
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({
      relayUrl: OFFLINE_RELAY_URL,
      apiKey: "old-key",
      userId: "old-user",
      keyPair,
      channels: webhookChannels.map((channelId) => ({
        channelId,
        type: "webhook",
        label: channelId,
        createdAt,
        webhookSecret: `secret-${channelId}`,
        channelName: channelId,
      })),
    }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;
  FailingWebSocket.instances = [];

  const BARRIER_TIMEOUT_MS = 1000;
  const probe = makeInflightProbe(webhookChannels.length, BARRIER_TIMEOUT_MS);

  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href = typeof input === "string" ? input : String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (href.endsWith("/auth/register")) {
      return new Response(JSON.stringify({ userId: "recovered-user", apiKey: "new-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && href.endsWith("/channels")) {
      // Hold each registration until EVERY persistent channel is in flight: a
      // serial re-bind never fills the barrier, so it times out (max 1 in
      // flight) and fails the assertion rather than the suite hanging.
      await probe.enter();
      const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")) as {
        id?: string;
      };
      return new Response(
        JSON.stringify({
          channel: { id: body.id ?? "wh-unknown", metadata: {} },
          webhookUrl: `https://webhooks.example.com/webhook/${body.id}?token=t`,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-concurrent-rebind", fake.notifications));

    const ownSockets = () =>
      FailingWebSocket.instances.filter((ws) => socketCarries(ws, "old-key"));
    assert.ok(ownSockets().length >= 1, "this test's WS was constructed for old-key");
    const first = ownSockets()[ownSockets().length - 1];
    first.failHandshake(1006);
    await waitFor(() => ownSockets().some((ws) => ws !== first));
    const second = ownSockets().find((ws) => ws !== first);
    assert.ok(second, "the client reconnected before the handshake failed twice");

    const started = Date.now();
    second.failHandshake(1006);

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    await waitFor(() => {
      const raw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      return raw.includes("Channel re-binding status");
    });
    const elapsedMs = Date.now() - started;

    assert.equal(
      probe.maxInFlight(),
      webhookChannels.length,
      "all persisted channels are registered at once (a serial loop overlaps zero)",
    );
    assert.ok(
      elapsedMs < BARRIER_TIMEOUT_MS,
      `re-bind of ${webhookChannels.length} channels finished in ${elapsedMs}ms — under a single barrier wait, so it is one round trip, not N in series`,
    );

    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-concurrent-rebind", fake.notifications));
  } finally {
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("auth recovery re-bind keeps record order and one failure does not drop the rest", async () => {
  resetState();
  rmSync(join(PI_DIR, "agent", "logs"), { recursive: true, force: true });

  const keyPair = await generateKeyPair();
  const createdAt = new Date().toISOString();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({
      relayUrl: OFFLINE_RELAY_URL,
      apiKey: "old-key",
      userId: "old-user",
      keyPair,
      // Record order: a failing telegram, a SLOW succeeding webhook, and a
      // third record with no re-bind material. Completion order is reversed,
      // so a result-at-completion-time implementation reorders the summary.
      channels: [
        { channelId: "tg-old", type: "telegram", label: "tg", createdAt, botToken: "bot-token" },
        { channelId: "wh-old", type: "webhook", label: "wh", createdAt, webhookSecret: "wh-secret", channelName: "wh" },
        { channelId: "sms-1", type: "sms", label: "sms", createdAt },
      ],
    }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;
  FailingWebSocket.instances = [];

  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href = typeof input === "string" ? input : String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (href.endsWith("/auth/register")) {
      return new Response(JSON.stringify({ userId: "recovered-user", apiKey: "new-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && href.endsWith("/channels/telegram/register")) {
      return new Response(JSON.stringify({ error: "telegram rejected" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && href.endsWith("/channels")) {
      // Slower than the failing telegram above, so it COMPLETES last even
      // though it is second in the persisted order.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(
        JSON.stringify({ channel: { id: "wh-new", metadata: {} }, webhookUrl: "https://webhooks.example.com/webhook/wh-new?token=t" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-ordered-rebind", fake.notifications));

    const ownSockets = () =>
      FailingWebSocket.instances.filter((ws) => socketCarries(ws, "old-key"));
    const first = ownSockets()[ownSockets().length - 1];
    assert.ok(first, "this test's WS was constructed for old-key");
    first.failHandshake(1006);
    await waitFor(() => ownSockets().some((ws) => ws !== first));
    const second = ownSockets().find((ws) => ws !== first);
    assert.ok(second, "the client reconnected before the handshake failed twice");
    second.failHandshake(1006);

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    await waitFor(() => {
      const raw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      return raw.includes("Channel re-binding status");
    });
    const logRaw = readFileSync(logPath, "utf-8");

    const tgNote = logRaw.indexOf("telegram channel could not auto re-bind");
    const whNote = logRaw.indexOf("webhook channel re-registered");
    const smsNote = logRaw.indexOf("sms channel could not auto re-bind");
    assert.ok(tgNote >= 0, `the failed telegram re-bind is still reported: ${logRaw}`);
    assert.ok(whNote >= 0, `the webhook re-bind succeeded despite the telegram failure: ${logRaw}`);
    assert.ok(smsNote >= 0, `the un-rebindable record is still noted: ${logRaw}`);
    assert.ok(tgNote < whNote, "notes follow persisted record order (telegram before webhook)");
    assert.ok(whNote < smsNote, "notes follow persisted record order (webhook before sms)");

    // The persisted records keep their original order too (only the webhook's
    // channelId changed on re-bind).
    const persisted = JSON.parse(readFileSync(join(PI_DIR, "chaos-relay.json"), "utf-8")) as {
      channels: Array<{ channelId: string }>;
    };
    assert.deepEqual(
      persisted.channels.map((c) => c.channelId),
      ["tg-old", "wh-new", "sms-1"],
      "re-bound records are persisted in record order",
    );

    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-ordered-rebind", fake.notifications));
  } finally {
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("isStaleRuntimeError recognises the SDK's replacement error and nothing else", () => {
  assert.equal(isStaleRuntimeError(new Error(STALE_RUNTIME_MESSAGE)), true);
  assert.equal(isStaleRuntimeError(STALE_RUNTIME_MESSAGE), true, "a bare string works too");
  // The image-rejection path must stay on its own branch: that error is a
  // refusal to deliver THIS content, not a dead runtime.
  assert.equal(isStaleRuntimeError(new Error("Agent is already processing")), false);
  assert.equal(isStaleRuntimeError(new Error("active model rejected image input")), false);
  assert.equal(isStaleRuntimeError(undefined), false);
});

test("status and doctor report the WebSocket auth mode and whether the key is in the URL", async () => {
  resetState();
  writeProfileConfig("default", "ak_ws_report");
  const prevAuth = process.env.CHAOS_RELAY_WS_AUTH;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;
  // A stubbed failing health probe keeps the command offline; only the auth line is
  // under test here.
  globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.reject(new DOMException("Timed out", "TimeoutError"))) as unknown as typeof fetch;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  const runStatus = async () => {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    await command.handler("status", makeCtx("sess-ws-report", fake.notifications));
    return fake.notifications.map((n) => n.message).join("\n");
  };
  try {
    // The default carries the key in the URL, and the report says so — without
    // printing anything URL-shaped that could itself be mistaken for a secret.
    const def = await runStatus();
    assert.match(def, /ws auth:\s+query \(the apiKey travels in the URL query string/);
    assert.ok(!def.includes("?token="), `the report describes the exposure: ${def}`);

    resetState();
    writeProfileConfig("default", "ak_ws_report");
    process.env.CHAOS_RELAY_WS_AUTH = "header";
    const hdr = await runStatus();
    assert.match(hdr, /ws auth:\s+header \(Authorization: Bearer/);

    // A transport that was never started must not be reported as a relay/auth
    // problem: the fix line has to point at starting it.
    resetState();
    writeProfileConfig("default", "ak_ws_report");
    const stoppedFake = makeFakePi();
    chaosRelayExtension(stoppedFake.pi as unknown as ExtensionApi);
    const stoppedCmd = stoppedFake.commands.get("chaos-relay");
    assert.ok(stoppedCmd, "extension registers the /chaos-relay command");
    await stoppedCmd.handler("doctor", makeCtx("sess-ws-report-stopped", stoppedFake.notifications));
    const stoppedDoc = stoppedFake.notifications.map((n) => n.message).join("\n");
    assert.match(stoppedDoc, /the WebSocket transport is not running/);
    assert.ok(
      !stoppedDoc.includes("CHAOS_RELAY_WS_AUTH=query"),
      `a transport that never ran is not evidence about the relay: ${stoppedDoc}`,
    );
    // The fix must name a subcommand that EXISTS. The first version of this line
    // sent the operator to `/chaos-relay start`, which the switch answers with
    // "Unknown subcommand" — so the names are checked against the command's own
    // declared subcommand list in the source, not against prose that happens to
    // contain the word.
    const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf-8");
    const declared = /subcommands:\s*([^"\n]*)\)/.exec(source)?.[1] ?? "";
    const known = new Set(
      declared
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0] ?? "")
        .filter(Boolean),
    );
    assert.ok(known.size > 3, `the subcommand list is readable: ${declared}`);
    const named = [...stoppedDoc.matchAll(/\/chaos-relay ([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `the fix names a command: ${stoppedDoc}`);
    for (const name of new Set(named)) {
      assert.ok(
        known.has(name),
        `the fix names "/chaos-relay ${name}", which is not a subcommand (${[...known].join(", ")})`,
      );
    }

    // doctor must carry the same fact, and (with the socket down in header mode)
    // the fix that names the other carrier.
    resetState();
    writeProfileConfig("default", "ak_ws_report");
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const command = fake.commands.get("chaos-relay");
    assert.ok(command, "extension registers the /chaos-relay command");
    // A socket that exists and cannot open is the case the auth advice is for.
    await callHandler(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      makeCtx("sess-ws-report-doc", fake.notifications),
    );
    await command.handler("doctor", makeCtx("sess-ws-report-doc", fake.notifications));
    const doc = fake.notifications.map((n) => n.message).join("\n");
    assert.match(doc, /WebSocket transport[\s\S]{0,120}auth: header \(Authorization: Bearer/);
    assert.match(doc, /CHAOS_RELAY_WS_AUTH=query/);
  } finally {
    if (prevAuth === undefined) delete process.env.CHAOS_RELAY_WS_AUTH;
    else process.env.CHAOS_RELAY_WS_AUTH = prevAuth;
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWs;
  }
});

test("the default WebSocket auth is the relay's ?token= form, so the upgrade still authenticates", async () => {
  // The relay's /ws handler reads the token from the query string and answers 401
  // without it, so this default is what keeps push delivery working against the
  // deployed relay. It is the compatibility half of the 5wq change.
  resetState();
  writeProfileConfig("default", "ak_ws_default");
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      makeCtx("sess-ws-default", fake.notifications),
    );
    const socket = socketForProfile("ak_ws_default");
    assert.equal(socket.url, "ws://127.0.0.1:9/ws?token=ak_ws_default");
    assert.deepEqual(socket.headers, {}, "the deployed relay does not read an upgrade Authorization header");
  } finally {
    globalThis.WebSocket = origWs;
  }
});

test("CHAOS_RELAY_WS_AUTH=header keeps the apiKey out of the WebSocket URL", async () => {
  resetState();
  writeProfileConfig("default", "ak_ws_header");
  const prevAuth = process.env.CHAOS_RELAY_WS_AUTH;
  const origWs = globalThis.WebSocket;
  process.env.CHAOS_RELAY_WS_AUTH = "header";
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  try {
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(
      fake.handlers,
      "session_start",
      { reason: "startup" },
      makeCtx("sess-ws-header", fake.notifications),
    );
    const socket = socketForProfile("ak_ws_header");
    assert.deepEqual(socket.headers, { Authorization: "Bearer ak_ws_header" });
    assert.ok(socket.url.endsWith("/ws"), `the URL is the bare endpoint: ${socket.url}`);
    assert.ok(!socket.url.includes("ak_ws_header"), `no apiKey in ${socket.url}`);
  } finally {
    if (prevAuth === undefined) delete process.env.CHAOS_RELAY_WS_AUTH;
    else process.env.CHAOS_RELAY_WS_AUTH = prevAuth;
    globalThis.WebSocket = origWs;
  }
});

test("a profile switch does not carry deferred state into the other profile's side-car", async () => {
  // bead pi-chaos-relay-7jp, review round 1 P1: the state write is deferred, so
  // resolving the side-car path at FLUSH time sent state staged under profile A
  // into B.json.state whenever the switch happened in between. The writer is now
  // pinned to the path that was active when it was created; this drives the switch
  // with a delivery still held in hydration, which is the flow that has no drain
  // edge to flush it first.
  resetState();
  writeProfileConfig("default", "ak_state_switch_a");
  writeProfileConfig("beta", "ak_state_switch_b");
  const defaultState = config.messageStatePath();
  const betaState = `${config.profilePathForName("beta")}.state`;
  for (const p of [defaultState, betaState]) {
    try {
      unlinkSync(p);
    } catch {
      /* nothing to remove */
    }
  }
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  let openDownloads: (() => void) | undefined;
  let downloadStarted = false;
  const downloadsGate = new Promise<void>((resolve) => {
    openDownloads = resolve;
  });
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).includes("/attachments/")) throw new Error(`unexpected fetch: ${input}`);
    downloadStarted = true;
    await downloadsGate;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;
  const fake = makeFakePi();
  const ctx = makeCtx("sess-state-switch", fake.notifications);
  (ctx as { model: unknown }).model = { input: ["text", "image"] };
  try {
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    const socket = socketForProfile("ak_state_switch_a");
    socket.pushFrame(
      JSON.stringify({
        type: "message",
        message: {
          id: "m-switch-1",
          channelType: "telegram",
          channelId: "chan-switch",
          from: "alice",
          content: "held in hydration",
          timestamp: "2026-10-12T00:10:00.000Z",
          attachments: [
            { id: "att-1", filename: "photo.png", mimeType: "image/png", size: 8, kind: "image" },
          ],
        },
      }),
    );
    await waitFor(() => downloadStarted);

    await fake.commands.get("chaos-relay")!.handler("profile beta", ctx);

    // Read A's side-car BEFORE releasing the held delivery: this is the state the
    // switch itself must have written, not one a later drain edge could have.
    const firstState = existsSync(defaultState) ? readFileSync(defaultState, "utf-8") : "";
    assert.ok(
      firstState.includes("m-switch-1"),
      `the outgoing profile's own state is written to its own file at the switch: ${firstState}`,
    );

    // Now let the held delivery finish. Its drain-edge flush runs after the active
    // path has moved, so it is the write that would land in the wrong file.
    openDownloads?.();
    // Let the released delivery run to completion so its drain-edge flush executes
    // with the active path already moved.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      existsSync(betaState),
      false,
      "the new profile's side-car must not receive the previous profile's state",
    );
  } finally {
    openDownloads?.();
    await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    for (const p of [defaultState, betaState]) {
      try {
        unlinkSync(p);
      } catch {
        /* nothing was written */
      }
    }
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
  }
});

test("auth recovery flushes staged message state before replay so the agent receives it once", async (t) => {
  resetState();
  const keyPair = await generateKeyPair();
  const oldKey = "ak_rss_old";
  const newKey = "ak_rss_recovered";
  const message = {
    id: "m-rss-replay",
    channelType: "telegram",
    channelId: "chan-rss",
    from: "alice",
    content: "recover this once",
    timestamp: "2026-10-12T00:30:00.000Z",
    attachments: [
      { id: "att-rss", filename: "photo.png", mimeType: "image/png", size: 8, kind: "image" },
    ],
  };
  writeFileSync(join(PI_DIR, "chaos-relay.json"), JSON.stringify({
    relayUrl: OFFLINE_RELAY_URL,
    apiKey: oldKey,
    userId: "rss-user",
    keyPair,
    approvalMode: "all",
  }) + "\n");
  const statePath = config.messageStatePath();
  rmSync(statePath, { force: true });
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  const prevApproval = process.env.CHAOS_RELAY_APPROVAL_MODE;
  delete process.env.CHAOS_RELAY_APPROVAL_MODE;
  const prevMaxBackoff = process.env.CHAOS_RELAY_WS_MAX_BACKOFF_MS;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  // State-writer safety interval (setInterval) must not flush the staged
  // state before recovery gets a chance to replace it.
  t.mock.timers.enable({ apis: ["setInterval"] });
  let openDownloads: (() => void) | undefined;
  let downloadStarted = false;
  let catchUpCount = 0;
  const downloadsGate = new Promise<void>((resolve) => { openDownloads = resolve; });
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href = String(input);
    if (href.endsWith("/auth/register")) {
      return Response.json({ userId: "rss-user", apiKey: newKey });
    }
    if (href.includes("/attachments/")) {
      downloadStarted = true;
      await downloadsGate;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        status: 200, headers: { "content-type": "image/png" },
      });
    }
    if (href.includes("/messages")) {
      const auth = (init as { headers?: Record<string, string> })?.headers?.Authorization;
      if (auth === `Bearer ${newKey}`) {
        catchUpCount++;
        return Response.json({ messages: [message], since: message.timestamp });
      }
      return Response.json({ messages: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
  const fake = makeFakePi();
  const sent: string[] = [];
  fake.pi.sendUserMessage = (content: unknown) => {
    sent.push(typeof content === "string" ? content : JSON.stringify(content));
  };
  const ctx = makeCtx("sess-rss-recovery", fake.notifications);
  (ctx as { model: unknown }).model = { input: ["text", "image"] };
  try {
    // Set inside the try: the client reads it at construction, and anything thrown before
    // this point must not leave the variable set for later tests (the restore is in the
    // finally, which only runs once the try is entered).
    process.env.CHAOS_RELAY_WS_MAX_BACKOFF_MS = "200";
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    const first = socketForProfile(oldKey);
    first.open();
    first.pushFrame(JSON.stringify({ type: "message", message }));
    await waitFor(() => downloadStarted);
    const stagedDisk = existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";
    assert.ok(!stagedDisk.includes(message.id), `accepted state is still staged, not persisted: ${stagedDisk}`);
    assert.equal(sent.length, 0, "the original delivery is held in attachment hydration");

    first.drop();
    // In ws-client.ts:
    // 1) When an opened socket closes (openedSinceAttempt === true), failedHandshakes
    //    is NOT incremented and remains 0.
    // 2) Sockets that close without opening (openedSinceAttempt === false) increment
    //    failedHandshakes by 1.
    // 3) scheduleReconnect() triggers auth recovery only when failedHandshakes >= 2.
    // With CHAOS_RELAY_WS_MAX_BACKOFF_MS=200, reconnect backoff takes ~200ms rather
    // than 2s/4s, so two consecutive failed handshake attempts (second and third)
    // cleanly and cheaply reach the failedHandshakes >= 2 auth recovery threshold.
    await waitFor(() => PushWebSocket.instances.some((socket) => socket !== first && socketCarries(socket, oldKey)));
    const second = PushWebSocket.instances.find((socket) => socket !== first && socketCarries(socket, oldKey))!;
    second.drop();
    await waitFor(() =>
      PushWebSocket.instances.some(
        (socket) => socket !== first && socket !== second && socketCarries(socket, oldKey),
      ),
    );
    const third = PushWebSocket.instances.find(
      (socket) => socket !== first && socket !== second && socketCarries(socket, oldKey),
    )!;
    third.drop();
    await waitFor(() => PushWebSocket.instances.some((socket) => socketCarries(socket, newKey)));
    const recovered = socketForProfile(newKey);
    recovered.open(); // on-connect catch-up replays the same relay message.
    await waitFor(() => catchUpCount === 1);
    // Let the catch-up callback finish before releasing hydration, so any
    // duplicate it accepted must queue behind the original held delivery.
    await new Promise((resolve) => setTimeout(resolve, 50));
    openDownloads?.();
    await waitFor(() => sent.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deliveryCount = sent.filter((delivery) => delivery.includes(message.id)).length;
    assert.equal(deliveryCount, 1, `replayed ${message.id} must reach the agent exactly once (got ${deliveryCount})`);
  } finally {
    openDownloads?.();
    await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    rmSync(statePath, { force: true });
    t.mock.timers.reset();
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
    if (prevApproval === undefined) delete process.env.CHAOS_RELAY_APPROVAL_MODE;
    else process.env.CHAOS_RELAY_APPROVAL_MODE = prevApproval;
    if (prevMaxBackoff === undefined) delete process.env.CHAOS_RELAY_WS_MAX_BACKOFF_MS;
    else process.env.CHAOS_RELAY_WS_MAX_BACKOFF_MS = prevMaxBackoff;
  }
});

test("reset all does not resurrect the state file it just deleted", async () => {
  // bead pi-chaos-relay-7jp, review round 1 P2: a live, dirty writer flushed after
  // resetPersisted("all") had deleted the config and the side-car, recreating both
  // with the old identity's cursor and de-dup log. The reset must drop the state,
  // not write it.
  resetState();
  writeProfileConfig("default", "ak_state_reset");
  const statePath = config.messageStatePath();
  const configPath = config.getConfigPath();
  try {
    unlinkSync(statePath);
  } catch {
    /* nothing to remove */
  }
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  PushWebSocket.instances = [];
  // Hold the delivery in hydration: that leaves the accepted state STAGED with no
  // drain edge, which is the dirty-writer condition the reset has to cope with.
  let openDownloads: (() => void) | undefined;
  let downloadStarted = false;
  const downloadsGate = new Promise<void>((resolve) => {
    openDownloads = resolve;
  });
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).includes("/attachments/")) throw new Error(`unexpected fetch: ${input}`);
    downloadStarted = true;
    await downloadsGate;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;
  const fake = makeFakePi();
  const ctx = makeCtx("sess-state-reset", fake.notifications);
  (ctx as { model: unknown }).model = { input: ["text", "image"] };
  try {
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    socketForProfile("ak_state_reset").pushFrame(
      JSON.stringify({
        type: "message",
        message: {
          id: "m-reset-1",
          channelType: "telegram",
          channelId: "chan-reset",
          from: "alice",
          content: "hello",
          timestamp: "2026-10-12T00:20:00.000Z",
          attachments: [
            { id: "att-1", filename: "photo.png", mimeType: "image/png", size: 8, kind: "image" },
          ],
        },
      }),
    );
    await waitFor(() => downloadStarted);
    await fake.commands.get("chaos-relay")!.handler("reset all", ctx);
    // Longer than the writer's 2s safety interval: a live writer would fire here.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(existsSync(statePath), false, "the deleted side-car stays deleted");
    assert.equal(existsSync(configPath), false, "and the deleted config stays deleted");
  } finally {
    openDownloads?.();
    await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
  }
});

test("a burst of messages costs one state write, at the drain edge, not one per message", async () => {
  // bead pi-chaos-relay-7jp: the poller reported state per accepted batch and the
  // writer persisted each report synchronously, so a push burst was one disk write
  // per message. The state must still be correct — this pins BOTH halves: the file
  // lags while the burst is in flight (the debounce is real, not theoretical) and
  // is complete and current once the queue drains.
  resetState();
  writeProfileConfig("default", "ak_state_burst");
  // resetState() intentionally leaves the message-state side-car alone, and the
  // cursor it holds only ever advances — so a leftover from an earlier test would
  // sit above this test's timestamps and the assertions below would be about that
  // test's state instead of this one's. Start from a known-clean side-car.
  try {
    unlinkSync(config.messageStatePath());
  } catch {
    /* nothing to remove */
  }
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  // The first delivery is held inside hydration, so the rest of the burst is
  // accepted (and staged) while it is still in flight — the shape of a burst.
  let openDownloads: (() => void) | undefined;
  let downloadStarted = false;
  // ONE gate for every download: releasing it lets the whole burst drain.
  const downloadsGate = new Promise<void>((resolve) => {
    openDownloads = resolve;
  });
  globalThis.fetch = (async (input: unknown) => {
    const href = String(input);
    if (!href.includes("/attachments/")) throw new Error(`unexpected fetch: ${href}`);
    downloadStarted = true;
    await downloadsGate;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;

  const ids = ["m-burst-1", "m-burst-2", "m-burst-3", "m-burst-4"];
  // Declared outside the try so the finally can end the session (see below).
  const fake = makeFakePi();
  const ctx = makeCtx("sess-state-burst", fake.notifications);
  (ctx as { model: unknown }).model = { input: ["text", "image"] };
  try {
    const sends: string[] = [];
    fake.pi.sendUserMessage = (content: unknown) => {
      sends.push(typeof content === "string" ? content : JSON.stringify(content));
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    const socket = socketForProfile("ak_state_burst");
    const statePath = config.messageStatePath();
    const withAttachment = (id: string, timestamp: string) => ({
      type: "message",
      message: {
        id,
        channelType: "telegram",
        channelId: "chan-state-burst",
        from: "alice",
        content: "burst",
        timestamp,
        attachments: [
          { id: "att-1", filename: "photo.png", mimeType: "image/png", size: 8, kind: "image" },
        ],
      },
    });

    socket.pushFrame(JSON.stringify(withAttachment(ids[0], "2026-10-12T00:00:01.000Z")));
    await waitFor(() => downloadStarted);
    for (const [i, id] of ids.slice(1).entries()) {
      socket.pushFrame(JSON.stringify(withAttachment(id, `2026-10-12T00:00:0${i + 2}.000Z`)));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    // On the pre-debounce build this file was written synchronously inside accept,
    // so it already existed here; now nothing has been flushed at all.
    const midBurst = existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";
    assert.ok(
      !ids.some((id) => midBurst.includes(id)),
      `no per-message write while the burst is in flight: ${midBurst}`,
    );

    openDownloads?.();
    await waitFor(() => sends.length === ids.length);
    const afterDrain = JSON.parse(readFileSync(statePath, "utf-8")) as {
      cursor: string;
      seenIds: string[];
    };
    for (const id of ids) {
      assert.ok(
        afterDrain.seenIds.includes(id),
        `the drained state has ${id}: ${JSON.stringify(afterDrain.seenIds)}`,
      );
    }
    assert.equal(
      afterDrain.cursor,
      "2026-10-12T00:00:04.000Z",
      "and the cursor is the newest message's",
    );
  } finally {
    openDownloads?.();
    // End the session so this instance's writer is flushed and disposed: leaving a
    // live one would let its timer write state during later tests in this file.
    await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    // And remove the side-car this test persisted. resetState() deliberately leaves
    // it alone, so without this the next test's poller would resume from a cursor
    // and de-dup log invented here — the machine-state leak that makes a suite
    // order-dependent.
    try {
      unlinkSync(config.messageStatePath());
    } catch {
      /* nothing was written */
    }
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
  }
});

test("a delivery that hits a replaced runtime stops the instance and returns the batch to the poller", async () => {
  resetState();
  writeProfileConfig("default", "ak_stale");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    let injects = 0;
    fake.pi.sendUserMessage = () => {
      injects += 1;
      throw new Error(STALE_RUNTIME_MESSAGE);
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-stale", fake.notifications));
    const socket = socketForProfile("ak_stale");

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const ts = new Date().toISOString();
    const ts2 = new Date(Date.now() + 1000).toISOString();
    // Two frames in one burst: the second is accepted and QUEUED behind the first
    // before the first delivery has finished, so both are caught by the replaced
    // runtime rather than just the one that was in flight.
    pushMessage(socket, "m-stale-1", ts);
    pushMessage(socket, "m-stale-2", ts2, "second");
    // The second frame may or may not be accepted before the first delivery
    // finishes (both are legitimate: the transport is torn down with the flag), so
    // this waits for the outcome that matters rather than for a schedule.
    const deferred = () => readFileSync(logPath, "utf-8").slice(logBefore.length).split("inbound delivery deferred").length - 1;
    await waitFor(() => deferred() >= 1 && injects === 1);

    // The durable log is shared across this file's tests, so only the lines this
    // test appended are asserted on.
    const raw = readFileSync(logPath, "utf-8").slice(logBefore.length);
    assert.ok(raw.includes("session runtime replaced while"), `the cause is named: ${raw}`);
    assert.ok(
      !raw.includes("attachment delivery failed"),
      `a replaced runtime is not an attachment failure: ${raw}`,
    );

    // The batch was handed back, not eaten: it is out of the persisted de-dup log
    // and the persisted cursor sits before it, so the relay replays it.
    const state = config.loadMessageState();
    assert.ok(!state.seenIds.includes("m-stale-1"), `not marked delivered: ${JSON.stringify(state.seenIds)}`);
    assert.ok(
      !state.cursor || state.cursor < ts,
      `the cursor is rewound before the undelivered message (cursor=${state.cursor}, ts=${ts})`,
    );

    // Prove the window with the relay's own semantics: a poller over this state
    // re-fetches the message, while one over the pre-fix cursor (since = ts, what
    // accept() persisted) does not.
    const fresh = windowedClient([{ id: "m-stale-1", channelType: "telegram", channelId: "ch-stale", from: "alice", content: "hi", timestamp: ts }]);
    const replay = await new MessagePoller(fresh.client, { since: state.cursor, seen: state.seenIds }).poll();
    assert.deepEqual(replay.map((m) => m.id), ["m-stale-1"], "the replacement session re-fetches it");
    const lost = windowedClient([{ id: "m-stale-1", channelType: "telegram", channelId: "ch-stale", from: "alice", content: "hi", timestamp: ts }]);
    const swallowed = await new MessagePoller(lost.client, { since: ts, seen: [] }).poll();
    assert.deepEqual(swallowed, [], "negative control: with the pre-fix cursor (since = the message itself) a strict relay skips it forever");

    assert.equal(injects, 1, "only the first batch was ever offered to the agent");
    assert.ok(deferred() >= 1, "the in-flight batch was handed back");
    assert.deepEqual(
      config.loadMessageState().seenIds.filter((id) => id.startsWith("m-stale-")),
      [],
      "no message of the dead instance is left marked delivered",
    );
    // The transport itself is torn down with the flag, so a LATER frame is never
    // even consumed: accept() would persist the cursor past it, which is exactly
    // how the message would have been lost.
    const consumed = readFileSync(logPath, "utf-8").slice(logBefore.length).split("delivering ").length - 1;
    pushMessage(socket, "m-stale-3", new Date(Date.now() + 2000).toISOString(), "third");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      readFileSync(logPath, "utf-8").slice(logBefore.length).split("delivering ").length - 1,
      consumed,
      "a frame after the teardown is not consumed or announced",
    );
    assert.ok(
      !config.loadMessageState().seenIds.includes("m-stale-3"),
      "a frame after the teardown does not advance the cursor",
    );

    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-stale", fake.notifications));
  } finally {
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("7vk: a hand-back is not undone by legacy in-config state that is still present", async () => {
  resetState();
  const path = writeProfileConfig("default", "ak_legacy_hb");
  // A profile that has not migrated yet: its legacy cursor is LATER than the
  // message that will be handed back, so the old-cursor-wins merge would undo
  // the deliberate rewind and a strict `since` fetch would skip the message.
  const ts = new Date().toISOString();
  const legacyCursor = new Date(Date.now() + 3_600_000).toISOString();
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  writeFileSync(
    path,
    JSON.stringify({ ...cfg, messagesCursor: legacyCursor, seenMessageIds: ["m-legacy-old", "m-legacy-old2"] }) + "\n",
  );
  // And an older side-car, so the poller's de-dup log is the load-side UNION.
  const statePath = `${path}.state`;
  const sidecarCursor = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(statePath, JSON.stringify({ cursor: sidecarCursor, seenIds: ["m-sidecar-old"] }) + "\n");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  const fake = makeFakePi();
  const ctx = makeCtx("sess-legacy-hb", fake.notifications);

  try {
    let injects = 0;
    fake.pi.sendUserMessage = () => {
      injects += 1;
      throw new Error(STALE_RUNTIME_MESSAGE);
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    const socket = socketForProfile("ak_legacy_hb");
    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    // Unrecognised (not in the de-dup log) and at or before the legacy cursor.
    pushMessage(socket, "m-legacy-hb", ts);
    const deferred = () =>
      readFileSync(logPath, "utf-8").slice(logBefore.length).split("inbound delivery deferred").length - 1;
    await waitFor(() => deferred() >= 1 && injects === 1);

    // What the replacement session loads.
    const state = config.loadMessageState();
    assert.ok(!state.seenIds.includes("m-legacy-hb"), `not marked delivered: ${JSON.stringify(state.seenIds)}`);
    assert.ok(
      state.cursor !== undefined && state.cursor < ts,
      `the rewind before the handed-back message stands (cursor=${state.cursor}, ts=${ts}, legacy=${legacyCursor})`,
    );
    // The requeue write completed the migration: the legacy fields are gone and
    // the tombstone is set, so no rival cursor is left to override the rewind...
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal("messagesCursor" in after, false, "legacy cursor stripped");
    assert.equal("seenMessageIds" in after, false, "legacy ids stripped");
    assert.equal(after.messageStateMigrated, true, "tombstone set");
    // ...and bypassing the refusal lost nothing: every id the load-side union
    // contributed (side-car AND legacy) is in the persisted side-car.
    const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
    for (const id of ["m-sidecar-old", "m-legacy-old", "m-legacy-old2"]) {
      assert.ok(persisted.seenIds.includes(id), `${id} survives the requeue write: ${JSON.stringify(persisted.seenIds)}`);
    }
    assert.ok(!persisted.seenIds.includes("m-legacy-hb"), "the handed-back id is not persisted as seen");
    assert.equal(persisted.cursor, state.cursor);
    const fresh = windowedClient([
      { id: "m-legacy-hb", channelType: "telegram", channelId: "ch-stale", from: "alice", content: "hi", timestamp: ts },
    ]);
    const replay = await new MessagePoller(fresh.client, { since: state.cursor, seen: state.seenIds }).poll();
    assert.deepEqual(replay.map((m) => m.id), ["m-legacy-hb"], "the replacement session re-fetches it");
  } finally {
    await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    try {
      unlinkSync(config.messageStatePath());
    } catch {
      /* nothing was written */
    }
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("a live runtime still delivers, and logs no replaced-runtime warning", async () => {
  resetState();
  writeProfileConfig("default", "ak_live");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    const injected: string[] = [];
    fake.pi.sendUserMessage = (content: unknown) => {
      injected.push(typeof content === "string" ? content : JSON.stringify(content));
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-live", fake.notifications));
    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    const before = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";

    pushMessage(socketForProfile("ak_live"), "m-live-1", new Date().toISOString(), "hello live");
    await waitFor(() => injected.length === 1);
    assert.match(injected[0], /hello live/, "the live runtime delivers as before");

    const after = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    assert.ok(
      !after.slice(before.length).includes("session runtime replaced"),
      "the negative control logs no replacement warning",
    );
    assert.ok(
      config.loadMessageState().seenIds.includes("m-live-1"),
      "a delivered message IS marked delivered (the flag must not over-fire)",
    );
    // A DELIVERED batch must never be handed back at shutdown: that would deliver
    // the message twice, which is why the in-flight set is cleared on a successful
    // send.
    const liveLogBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-live", fake.notifications));
    assert.ok(
      !readFileSync(logPath, "utf-8").slice(liveLogBefore).includes("returned to the poller"),
      "a delivered batch is not requeued at shutdown",
    );
    assert.ok(config.loadMessageState().seenIds.includes("m-live-1"), "and it stays delivered");
  } finally {
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("a push arriving after session_shutdown is not delivered and not consumed", async () => {
  resetState();
  writeProfileConfig("default", "ak_after");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    let injects = 0;
    fake.pi.sendUserMessage = () => {
      injects += 1;
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-after", fake.notifications));
    const socket = socketForProfile("ak_after");
    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-after", fake.notifications));

    // pi emits session_shutdown BEFORE invalidating the instance, so a push that
    // is already in flight (or lands in that window) must be dropped rather than
    // delivered into a dead runtime or consumed past the cursor.
    const ts = new Date().toISOString();
    pushMessage(socket, "m-after-1", ts);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(injects, 0, "nothing is injected after shutdown");
    assert.ok(
      !config.loadMessageState().seenIds.includes("m-after-1"),
      "nothing is consumed after shutdown",
    );
  } finally {
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("a delivery in flight across session_shutdown is handed back before the replacement reads state", async () => {
  // The P1 from review round 1: requeueing only when the in-flight delivery FAILS
  // races the replacement instance, which reads the poller state in its own
  // session_start. For a slow attachment download the replacement usually wins, and
  // then the rewound cursor is overwritten by the replacement's next write — the
  // message is lost after all. session_shutdown is awaited by pi before the
  // replacement exists, so the hand-back has to happen THERE.
  resetState();
  writeProfileConfig("default", "ak_inflight");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  let releaseDownload: (() => void) | undefined;
  let downloadStarted = false;
  globalThis.fetch = (async (input: unknown) => {
    const href = String(input);
    if (!href.includes("/attachments/")) throw new Error(`unexpected fetch: ${href}`);
    downloadStarted = true;
    await new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    // Real PNG magic, so the hydration produces an image content part.
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;

  try {
    const fake = makeFakePi();
    let injects = 0;
    fake.pi.sendUserMessage = () => {
      injects += 1;
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    const ctx = makeCtx("sess-inflight", fake.notifications);
    // An image-capable model, so the delivery takes the image content path.
    (ctx as { model: unknown }).model = { input: ["text", "image"] };
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);
    const socket = socketForProfile("ak_inflight");

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const ts = new Date().toISOString();
    socket.pushFrame(
      JSON.stringify({
        type: "message",
        message: {
          id: "m-inflight",
          channelType: "telegram",
          channelId: "ch-inflight",
          from: "alice",
          content: "look at this",
          timestamp: ts,
          attachments: [{ id: "att-1", filename: "photo.png", mimeType: "image/png", size: 8, kind: "image" }],
        },
      }),
    );
    await waitFor(() => downloadStarted);
    assert.equal(injects, 0, "the delivery is still hydrating the attachment");

    // The runtime is replaced while the download is still in flight.
    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-inflight", fake.notifications));

    const raw = readFileSync(logPath, "utf-8").slice(logBefore.length);
    assert.match(
      raw,
      /session shutting down: 1 undelivered batch\(es\), 1 message\(s\) returned to the poller/,
      `the hand-back is logged at shutdown: ${raw}`,
    );

    // A replacement session reading state now must find the message still pending.
    const state = config.loadMessageState();
    assert.ok(!state.seenIds.includes("m-inflight"), `not marked delivered: ${JSON.stringify(state.seenIds)}`);
    const replacement = windowedClient([
      {
        id: "m-inflight",
        channelType: "telegram",
        channelId: "ch-inflight",
        from: "alice",
        content: "look at this",
        timestamp: ts,
      },
    ]);
    const refetched = await new MessagePoller(replacement.client, { since: state.cursor, seen: state.seenIds }).poll();
    assert.deepEqual(refetched.map((m) => m.id), ["m-inflight"], "the replacement session re-fetches it");

    // Now let the dead instance's delivery finish: it must write NOTHING (a late
    // write would race the replacement and could land in another profile's state).
    const statePath = config.messageStatePath();
    const onDisk = readFileSync(statePath, "utf-8");
    assert.ok(releaseDownload, "the download was blocked");
    releaseDownload();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readFileSync(statePath, "utf-8"), onDisk, "the dead instance writes no state after the hand-back");
    assert.equal(injects, 0, "nothing is injected into the replaced runtime");
    assert.ok(
      !readFileSync(logPath, "utf-8").slice(logBefore.length).includes("attachment delivery failed"),
      "and it is not reported as a per-batch delivery failure",
    );
  } finally {
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("a safety poll awaiting the relay when the session is replaced does not consume", (t) => {
  // The WS is down, so the safety poll is the delivery path. poll() is
  // accept(await pollRaw()): the old gate ran before the await, so a swap landing
  // mid-poll still let accept() persist the advanced cursor from a dead instance
  // (and then the delayed delivery requeued, writing again — the round-1 race, on
  // a narrower path).
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeProfileConfig("default", "ak-pollswap");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  const origFetch = globalThis.fetch;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  let releaseGetMessages: (() => void) | undefined;
  let getMessagesStarted = false;
  const url = "http://127.0.0.1:9";
  globalThis.fetch = (async (input: unknown) => {
    const href = String(input);
    if (!href.startsWith(`${url}/messages`)) throw new Error(`unexpected fetch: ${href}`);
    getMessagesStarted = true;
    await new Promise<void>((resolve) => {
      releaseGetMessages = resolve;
    });
    return new Response(
      JSON.stringify({
        messages: [
          {
            id: "m-pollswap",
            channelType: "telegram",
            channelId: "ch-pollswap",
            from: "alice",
            content: "polled while the session was replaced",
            timestamp: new Date().toISOString(),
          },
        ],
        since: "",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return (async () => {
    try {
      const fake = makeFakePi();
      let injects = 0;
      fake.pi.sendUserMessage = () => {
        injects += 1;
      };
      chaosRelayExtension(fake.pi as unknown as ExtensionApi);
      await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-pollswap", fake.notifications));
      const statePath = config.messageStatePath();
      const stateBefore = existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";

      // Fire the safety poll; it blocks awaiting the relay.
      t.mock.timers.tick(120_000);
      await waitFor(() => getMessagesStarted);

      // The session is replaced while that poll is still in flight.
      await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-pollswap", fake.notifications));

      assert.ok(releaseGetMessages, "getMessages was blocked");
      releaseGetMessages();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const state = config.loadMessageState();
      assert.ok(
        !state.seenIds.includes("m-pollswap"),
        `the dead instance must not consume the polled message: ${JSON.stringify(state.seenIds)}`,
      );
      assert.equal(
        existsSync(statePath) ? readFileSync(statePath, "utf-8") : "",
        stateBefore,
        "and it must not write poller state after the swap",
      );
      assert.equal(injects, 0, "nothing is injected into the replaced runtime");
    } finally {
      globalThis.WebSocket = origWs;
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
      else process.env.CHAOS_RELAY_URL = prevUrl;
      t.mock.timers.reset();
    }
  })();
});
