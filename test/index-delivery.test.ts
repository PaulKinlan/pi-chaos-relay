/**
 * Integration coverage for the extension entry point (index.ts) — inbound delivery and turn provenance: origin binding on message_start, batches, typing, attachment hydration, reply threading, the safety poll's shape gate, and emailed images.
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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  makeFakePi,
  makeCtx,
  fireLifecycle,
  startTurn,
  callHandler,
  PushWebSocket,
  socketForProfile,
  waitFor,
  ONE_PIXEL_PNG_B64,
  startImageRelay,
  pushEmailImage,
  imagePartsOf,
  createStateHelpers,
} from "./integration-harness.ts";

const { PI_DIR, RUNTIME_DIR } = createSandbox();

const config = await import("../config.ts");
const { default: chaosRelayExtension, log } =
  await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];

const { resetState, writeProfileConfig } = createStateHelpers(config, PI_DIR);

test("attachment-delivery failure log redacts URL secrets from the injected message error", async () => {
  resetState();
  writeProfileConfig("default", "ak_attach");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;

  try {
    const fake = makeFakePi();
    // Simulate the real failure this catch guards: the agent refuses the
    // delivered message (e.g. mid-turn) with a URL-shaped secret in the error.
    const secret = "att-deliv-secret";
    fake.pi.sendUserMessage = () => {
      throw new Error(`Agent is already processing https://user:${secret}@example.com/inbox?token=leakme#frag`);
    };
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-attach-deliv", fake.notifications));

    assert.ok(PushWebSocket.instances.length >= 1, "WS constructed");
    PushWebSocket.instances[0].pushFrame(JSON.stringify({
      type: "message",
      message: {
        id: "m-attach-deliv",
        channelType: "telegram",
        channelId: "ch-attach",
        from: "someone",
        content: "hello with an attachment",
        timestamp: new Date().toISOString(),
      },
    }));

    const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
    await waitFor(() => {
      const raw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      return raw.includes("attachment delivery failed");
    });

    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-attach-deliv", fake.notifications));

    const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    assert.ok(!logRaw.includes(secret), `log must not leak the password: ${logRaw}`);
    assert.ok(!logRaw.includes("user@example.com"), `log must not leak userinfo: ${logRaw}`);
    assert.ok(!logRaw.includes("/inbox"), `log must not leak the path: ${logRaw}`);
    assert.ok(!logRaw.includes("token=leakme"), `log must not leak the query string: ${logRaw}`);
    assert.ok(!logRaw.includes("#frag"), `log must not leak the fragment: ${logRaw}`);
    assert.ok(logRaw.includes("https://example.com"), `log keeps the redacted origin: ${logRaw}`);
  } finally {
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});


// pi-chaos-relay-lv9: a reply-threaded inbound message must reach the agent with
// the message it answered, otherwise a one-word answer like "Drop" arrives with
// nothing to resolve it against.

test("a reply-threaded push is injected with its quoted context before the content", async () => {
  resetState();
  writeProfileConfig("default", "ak_replyto");
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
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-replyto", fake.notifications));
    assert.ok(PushWebSocket.instances.length >= 1, "WS constructed");

    PushWebSocket.instances[0].pushFrame(JSON.stringify({
      type: "message",
      message: {
        id: "m2",
        channelType: "telegram",
        channelId: "ch-reply",
        from: "paul",
        content: "Drop",
        timestamp: new Date().toISOString(),
        metadata: { replyTo: { id: "m1", text: "Should I drop the booking?", from: "hub" } },
      },
    }));

    await waitFor(() => injected.length > 0);
    assert.match(
      injected[0],
      /\[In reply to message id="m1" from "hub": "Should I drop the booking\?"\]\nDrop/,
      `the quoted question must precede the terse answer:\n${injected[0]}`,
    );
    await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-replyto", fake.notifications));
  } finally {
    globalThis.WebSocket = origWs;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  }
});

test("a message delivered mid-turn produces a gated follow-up turn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  let messagesServed = 0;
  const replyDests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/messages")) {
      messagesServed++;
      const msg =
        messagesServed === 1
          ? { id: "f1", channelType: "telegram", channelId: "chanA", from: "alice", content: "hello A", timestamp: "2026-01-01T00:00:01Z" }
          : { id: "f2", channelType: "telegram", channelId: "chanB", from: "bob", content: "hello B", timestamp: "2026-01-01T00:00:02Z" };
      return new Response(JSON.stringify({ messages: [msg], since: "2026-01-01T00:00:02Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  // setTimeout is NOT mocked here, so this is a real delay that lets the async
  // delivery chain (fetch -> poll -> deliver) settle.
  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-follow", fake.notifications));
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-follow", fake.notifications)));

  // Turn A: message A arrives and the turn starts.
  t.mock.timers.tick(120_000);
  await flushAsync();
  await startTurn(fake, makeCtx("sess-follow", fake.notifications));
  // Mid-turn A: message B arrives (its origin is queued, not dropped).
  t.mock.timers.tick(120_000);
  await flushAsync();
  // Turn A ends, then the queued follow-up (B) becomes turn B.
  await callHandler(fake.handlers, "agent_end", {}, makeCtx("sess-follow", fake.notifications));
  // The follow-up turn is the QUEUED path — the one no before_agent_start fires for, and
  // the case a harness that fires it for every turn would hide.
  await startTurn(fake, makeCtx("sess-follow", fake.notifications));

  // Turn B's gated tool call must be asked over B's channel. Fire it without
  // awaiting the approval answer; the prompt send happens before the wait.
  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  toolHandlers![0]({ toolName: "bash", input: { command: "x" } }, makeCtx("sess-follow", fake.notifications));
  await flushAsync();

  assert.deepEqual(
    replyDests,
    ["chanB"],
    "the follow-up turn was gated and asked over its own message's channel",
  );
});

test("a batch mixing senders is attributed to the earliest message's origin", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  let messagesServed = 0;
  const replyDests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/messages")) {
      messagesServed++;
      // ONE poll returns a MIXED batch: alice on chanA (earliest) then bob on chanB.
      return new Response(
        JSON.stringify({
          messages: [
            { id: "mix1", channelType: "telegram", channelId: "chanA", from: "alice", content: "hello A", timestamp: "2026-01-01T00:00:01Z" },
            { id: "mix2", channelType: "telegram", channelId: "chanB", from: "bob", content: "hello B", timestamp: "2026-01-01T00:00:02Z" },
          ],
          since: "2026-01-01T00:00:02Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-mixed", fake.notifications));
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-mixed", fake.notifications)));

  t.mock.timers.tick(120_000); // mixed batch delivered
  await flushAsync();
  await startTurn(fake, makeCtx("sess-mixed", fake.notifications));

  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  toolHandlers![0]({ toolName: "bash", input: { command: "x" } }, makeCtx("sess-mixed", fake.notifications));
  await flushAsync();

  assert.deepEqual(
    replyDests,
    ["chanA"],
    "a mixed batch is attributed to the earliest message's origin (first-wins, documented)",
  );
});

test("typing starts only for a bound turn, and stops when the binding is cleared", async (t) => {
  // Review round 3, P2. The SDK emits agent_start BEFORE message_start, so a run that
  // never reached agent_end (aborted) has a live 4s typing refresh pointed at its
  // channel when the next user message arrives. If clearing the binding does not stop
  // that timer, the extension keeps pinging a channel for a turn that is over.
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });
  let typingPings = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/typing")) {
      typingPings++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "typing1",
              channelType: "telegram",
              channelId: "chanT",
              from: "alice",
              content: "a relay message whose turn will be abandoned",
              timestamp: "2026-01-01T00:00:01Z",
            },
          ],
          since: "2026-01-01T00:00:01Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-typing", fake.notifications));
  t.after(() =>
    callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-typing", fake.notifications)),
  );

  t.mock.timers.tick(120_000);
  await flushAsync();
  // The relay turn starts and binds chanT: typing begins, and no tool call pauses it.
  await startTurn(fake, makeCtx("sess-typing", fake.notifications));
  await flushAsync();
  const bound = typingPings;
  assert.ok(bound > 0, `typing started for the bound relay turn (${bound} pings)`);

  // That run is abandoned (no agent_end). Two things must hold for the next turn.
  // (a) bead pi-chaos-relay-a1j: agent_start alone must send NO ping. It used to call
  // startTyping() there, whose immediate ping went to the abandoned run's channel before
  // this turn's provenance existed. Drive the two events separately so the assertion can
  // see the moment between them.
  const beforeAgentStart = typingPings;
  await fireLifecycle(fake, "agent_start", {}, makeCtx("sess-typing", fake.notifications));
  await flushAsync();
  assert.equal(
    typingPings,
    beforeAgentStart,
    "agent_start alone sends no typing ping: nothing is known about this turn yet",
  );
  // (b) An unattributable user message then clears the binding — and must take the typing
  // timer with it (review round 3's P2).
  await callHandler(
    fake.handlers,
    "message_start",
    {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "typed after an abandoned run" }] },
    },
    makeCtx("sess-typing", fake.notifications),
  );
  await flushAsync();
  const afterClear = typingPings;
  t.mock.timers.tick(20_000); // five typing refreshes, if the timer were still alive
  await flushAsync();
  assert.equal(
    typingPings,
    afterClear,
    `no typing ping after an unattributable turn cleared the binding (was ${afterClear})`,
  );
  t.mock.timers.reset();
});

test("a turn the relay did not drive does not consume a queued origin, and an ambiguous one is gated conservatively", async (t) => {
  // bead pi-chaos-relay-pl2: `agent_start` fires per agent run (not once per queued
  // follow-up turn), so binding the origin by shifting the queue there let a terminal/local
  // turn take the origin of
  // a relay message that was still queued behind it. The turn after that then ran
  // ungated (or gated over the wrong channel). Binding matches the turn's prompt
  // instead, so a turn the relay did not drive consumes nothing.
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  const replyDests: string[] = [];
  let typingPings = 0;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/typing")) {
      typingPings++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "queued1",
              channelType: "telegram",
              channelId: "chanQ",
              from: "alice",
              content: "relay message waiting behind a terminal turn",
              timestamp: "2026-01-01T00:00:01Z",
            },
          ],
          since: "2026-01-01T00:00:01Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx("sess-queued-origin", fake.notifications),
  );
  t.after(() =>
    callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-queued-origin", fake.notifications)),
  );

  // The relay message is delivered (its origin is queued) but its turn has not run.
  t.mock.timers.tick(120_000);
  await flushAsync();
  assert.equal(fake.sent.length, 1, "the relay message was delivered and is waiting for its turn");

  // A turn typed in the terminal runs FIRST. It must not be gated (it is not a
  // channel turn) and must not consume the queued relay origin.
  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  await startTurn(fake, makeCtx("sess-queued-origin", fake.notifications), "a prompt typed in the terminal");
  const ambiguousResult = await toolHandlers![0](
    { toolName: "bash", input: { command: "x" } },
    makeCtx("sess-queued-origin", fake.notifications),
  );
  await flushAsync();
  // Fail closed, and ask nobody: an unrelated channel's recipient must not be handed the
  // authorization decision (or the summary) for a tool call they did not initiate.
  assert.deepEqual(
    replyDests,
    [],
    "an ambiguous turn asks no channel for approval",
  );
  assert.equal(
    (ambiguousResult as { block?: boolean } | undefined)?.block,
    true,
    "an ambiguous turn blocks the gated call outright instead of running it ungated",
  );
  // (The typing half of review round 3's P2 is pinned by its own test below: asserting it
  // here would not bite, because the gated call above already paused typing — so no timer
  // would be running to leak, and the assertion would pass with or without the fix.)
  await callHandler(fake.handlers, "agent_end", {}, makeCtx("sess-queued-origin", fake.notifications));

  // Review round 2: every delivery opens with the same static line, so accepting a
  // PREFIX of a delivery as proof of origin let a message containing just that line
  // consume the pending origin. This is that exact prompt, taken from poller.ts.
  assert.ok(
    ambiguousResult !== undefined,
    "test premise: the ambiguous turn above ran before this case",
  );
  await startTurn(
    fake,
    makeCtx("sess-queued-origin", fake.notifications),
    "You have 1 new message(s) from chaos-relay. Reply via the relay_reply tool (pass back channelType, channelId, and the message id as replyTo).",
  );
  const prefixResult = await toolHandlers![0](
    { toolName: "bash", input: { command: "p" } },
    makeCtx("sess-queued-origin", fake.notifications),
  );
  await flushAsync();
  assert.equal(
    (prefixResult as { block?: boolean } | undefined)?.block,
    true,
    "a turn whose text is only the static opening line of a delivery is not that delivery",
  );
  assert.deepEqual(replyDests, [], "and it is not asked over any channel either");

  // Now the relay turn runs, carrying the delivered prompt. It must own chanQ.
  await startTurn(fake, makeCtx("sess-queued-origin", fake.notifications));
  // Not awaited: the gated call is waiting on a human approval that this test never
  // answers (the approval timeout is a real 5-minute setTimeout, so a mock tick cannot
  // release it). Asserting what it ASKED is the point; session_shutdown in t.after
  // settles it.
  void Promise.resolve(
    toolHandlers![0](
      { toolName: "bash", input: { command: "y" } },
      makeCtx("sess-queued-origin", fake.notifications),
    ),
  ).catch(() => {});
  await flushAsync();
  assert.deepEqual(
    replyDests,
    ["chanQ"],
    "the relay turn still owns its origin: the ambiguous turn did not consume it, and the " +
      "only approval asked is the relay turn's own",
  );

  // An aborted turn can end without agent_end, so the next turn must not inherit its
  // binding: the user message in `message_start` clears it whenever its text matches no
  // pending delivery. Without that, a later terminal turn would be gated over the dead turn's
  // channel — the same misattribution this bead is about, one turn later.
  await startTurn(
    fake,
    makeCtx("sess-queued-origin", fake.notifications),
    "typed after a turn that never ended",
  );
  void Promise.resolve(
    toolHandlers![0](
      { toolName: "bash", input: { command: "z" } },
      makeCtx("sess-queued-origin", fake.notifications),
    ),
  ).catch(() => {});
  await flushAsync();
  assert.deepEqual(
    replyDests,
    ["chanQ"],
    "with nothing pending, a non-relay turn is not gated at all: no leaked binding",
  );
});

test("a turn that starts during slow attachment hydration does not consume the not-yet-delivered origin", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  // Hold the attachment download open so hydration stays in-flight while we
  // start another turn.
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });

  const replyDests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/attachments/")) {
      await downloadGate;
      return new Response("attachment-bytes", {
        status: 200,
        headers: { "Content-Type": "text/plain", "Content-Length": "16" },
      });
    }
    if (u.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "slow1",
              channelType: "telegram",
              channelId: "chanA",
              from: "alice",
              content: "hello with an attachment",
              timestamp: "2026-01-01T00:00:01Z",
              attachments: [{ id: "att1", filename: "f.txt", mimeType: "text/plain", size: 16 }],
            },
          ],
          since: "2026-01-01T00:00:01Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const flushAsync = async () => {
    // Poll a few real ticks so a slow hydration (or a congested event loop under
    // the full suite) cannot make the turn-origin timing flaky.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  };

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-slow", fake.notifications));
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-slow", fake.notifications)));

  // The safety poll delivers the attachment-bearing message; hydration blocks on
  // the download gate above.
  t.mock.timers.tick(120_000);
  await flushAsync();

  // Another turn starts and ends while hydration is still pending. It must not
  // consume the origin that has not actually been delivered.
  await startTurn(fake, makeCtx("sess-slow", fake.notifications));
  await callHandler(fake.handlers, "agent_end", {}, makeCtx("sess-slow", fake.notifications));

  // Let hydration finish; the followUp is now actually delivered.
  releaseDownload();
  await flushAsync();

  // The relay message's own turn starts and must carry chanA's origin.
  await startTurn(fake, makeCtx("sess-slow", fake.notifications));

  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  toolHandlers![0]({ toolName: "bash", input: { command: "x" } }, makeCtx("sess-slow", fake.notifications));
  await flushAsync();

  assert.deepEqual(
    replyDests,
    ["chanA"],
    "the slow-hydrated relay turn is gated and asked over its own channel",
  );
});

test("a hydration failure enqueues no origin and leaves the next turn aligned", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  let messagesServed = 0;
  const replyDests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/messages")) {
      messagesServed++;
      const msg =
        messagesServed === 1
          ? {
              id: "bad1",
              channelType: "telegram",
              channelId: "chanA",
              from: "alice",
              content: "broken hydration",
              timestamp: "2026-01-01T00:00:01Z",
              // Force materializeInboundAttachments to throw: `.slice` on a
              // string yields a string, and `attachments.map` is not a function.
              attachments: "not-an-array",
            }
          : {
              id: "ok1",
              channelType: "telegram",
              channelId: "chanB",
              from: "bob",
              content: "clean message",
              timestamp: "2026-01-01T00:00:02Z",
            };
      return new Response(JSON.stringify({ messages: [msg], since: "2026-01-01T00:00:02Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-hydfail", fake.notifications));
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-hydfail", fake.notifications)));

  // First delivery fails during hydration: nothing is sent and nothing enqueued.
  t.mock.timers.tick(120_000);
  await flushAsync();

  // Second delivery succeeds; its origin must be the only one in the queue.
  t.mock.timers.tick(120_000);
  await flushAsync();

  await startTurn(fake, makeCtx("sess-hydfail", fake.notifications));

  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  toolHandlers![0]({ toolName: "bash", input: { command: "x" } }, makeCtx("sess-hydfail", fake.notifications));
  await flushAsync();

  assert.deepEqual(
    replyDests,
    ["chanB"],
    "the clean turn is gated over its own channel, not desynced by the failed hydration",
  );
});

test("session shutdown and start clear pending origins so a new session cannot inherit them", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak", approvalMode: "all" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;
  const origFetch = globalThis.fetch;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.fetch = origFetch;
  });

  const replyDests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "stale1",
              channelType: "telegram",
              channelId: "chanA",
              from: "alice",
              content: "queued then session ends",
              timestamp: "2026-01-01T00:00:01Z",
            },
          ],
          since: "2026-01-01T00:00:01Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/reply")) {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      replyDests.push(body.channelId);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const flushAsync = async () => {
    await new Promise((r) => setTimeout(r, 60));
  };

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, makeCtx("sess-reset", fake.notifications));

  // A relay message arrives and its origin is queued, but the turn never starts
  // before the session ends.
  t.mock.timers.tick(120_000);
  await flushAsync();

  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-reset", fake.notifications));
  await callHandler(fake.handlers, "session_start", { reason: "resume" }, makeCtx("sess-reset2", fake.notifications));
  t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-reset2", fake.notifications)));

  // A terminal/local turn in the new session must be ungated: the stale origin
  // from the previous session must already be gone.
  await startTurn(fake, makeCtx("sess-reset2", fake.notifications));

  const toolHandlers = fake.handlers.get("tool_call");
  assert.ok(toolHandlers && toolHandlers.length > 0, "extension registers a tool_call handler");
  toolHandlers![0]({ toolName: "bash", input: { command: "x" } }, makeCtx("sess-reset2", fake.notifications));
  await flushAsync();

  assert.deepEqual(
    replyDests,
    [],
    "no stale origin leaks across the session boundary into a terminal turn",
  );
});

test("the safety poll refuses a malformed message once and still delivers the valid one", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  resetState();
  writeFileSync(
    join(PI_DIR, "chaos-relay.json"),
    JSON.stringify({ relayUrl: "http://127.0.0.1:9", apiKey: "ak" }) + "\n",
  );
  const prevUrl = process.env.CHAOS_RELAY_URL;
  delete process.env.CHAOS_RELAY_URL;

  // One batch carrying a message the delivery path could not survive (a
  // non-array `attachments` used to reach Array.prototype.slice) next to a
  // perfectly good one.
  const malformed = {
    id: "m-bad",
    channelType: "telegram",
    channelId: "ch-frame",
    from: "alice",
    content: "hello",
    timestamp: "2026-01-01T00:00:01Z",
    attachments: "seven",
  };
  const good = {
    id: "m-good",
    channelType: "telegram",
    channelId: "ch-frame",
    from: "alice",
    content: "deliver me",
    timestamp: "2026-01-01T00:00:02Z",
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/messages")) {
      return new Response(JSON.stringify({ messages: [malformed, good], since: "2026-01-01T00:00:02Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
  });

  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const before = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;
  const flushAsync = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  const fake = makeFakePi();
  const sent: string[] = [];
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  (fake.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = (content: unknown) => {
    sent.push(String(content));
  };
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx("sess-frame-check", fake.notifications),
  );
  t.after(() =>
    callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-frame-check", fake.notifications)),
  );

  // First safety poll: the malformed message is refused with a reason, the valid
  // one is delivered to the agent.
  t.mock.timers.tick(120_000);
  await flushAsync();
  const afterFirst = readFileSync(logPath, "utf-8").slice(before);
  assert.equal(
    afterFirst.match(/dropped an inbound message/g)?.length,
    1,
    `one refusal was reported: ${afterFirst}`,
  );
  assert.match(afterFirst, /message "m-bad": attachments is not an array/);
  assert.equal(sent.length, 1, `only the valid message was delivered: ${JSON.stringify(sent)}`);
  assert.match(sent[0], /deliver me/);
  assert.ok(!sent[0].includes("m-bad"), "the refused message never reached the prompt");

  // The relay replays both until the cursor passes them, so the refusal must not
  // be reported again (the id is remembered), while nothing is delivered twice.
  t.mock.timers.tick(120_000);
  await flushAsync();
  const afterSecond = readFileSync(logPath, "utf-8").slice(before);
  assert.equal(
    afterSecond.match(/dropped an inbound message/g)?.length,
    1,
    `the replay is silent: ${afterSecond}`,
  );
  assert.equal(sent.length, 1, "and nothing was delivered twice");
});

test("an emailed image reaches the agent as image content, not as an attachment note", async (t) => {
  resetState();
  const relay = await startImageRelay();
  t.after(() => relay.close());
  writeProfileConfig("default", "ak_img");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  process.env.CHAOS_RELAY_URL = relay.url;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.WebSocket = origWs;
  });

  const fake = makeFakePi();
  const sends: unknown[] = [];
  fake.pi.sendUserMessage = (content: unknown) => {
    sends.push(content);
  };
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const ctx = makeCtx("sess-image", fake.notifications);
  // An image-capable model: this is the configuration where the agent should get
  // the picture itself rather than a path or a placeholder.
  (ctx as { model: unknown }).model = { input: ["text", "image"] };
  await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);

  pushEmailImage(socketForProfile("ak_img"), "m-img-1", "2026-10-10T00:00:01.000Z");
  await waitFor(() => sends.length === 1);

  const parts = imagePartsOf(sends);
  const image = parts.find((p) => p.type === "image");
  assert.ok(
    image,
    `the agent received image content, not only text: ${JSON.stringify(parts.map((p) => p.type))}`,
  );
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, ONE_PIXEL_PNG_B64, "the delivered bytes are the bytes the relay served");
  const text = parts.find((p) => p.type === "text")?.text ?? "";
  assert.match(text, /Here is the photo you asked for\./, "the email body is still there");
  assert.ok(
    !text.includes("[Received 1 attachment.]"),
    `no attachment placeholder instead of the image: ${text}`,
  );
  assert.equal(relay.attachmentRequests(), 1, "the attachment was fetched from the relay over HTTP");
  assert.ok(
    text.includes(`saved to ${RUNTIME_DIR}/`),
    `the attachment was saved inside the test sandbox, not the real runtime dir: ${text}`,
  );
});

test("a replacement session receives the emailed image after the first session is replaced mid-download", async (t) => {
  resetState();
  const relay = await startImageRelay();
  t.after(() => relay.close());
  relay.blockDownloads(); // the first instance hangs in hydration
  writeProfileConfig("default", "ak_img_replace");
  const prevUrl = process.env.CHAOS_RELAY_URL;
  const origWs = globalThis.WebSocket;
  process.env.CHAOS_RELAY_URL = relay.url;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = prevUrl;
    globalThis.WebSocket = origWs;
  });

  const logPath = join(PI_DIR, "agent", "logs", "chaos-relay.log");
  const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf-8").length : 0;

  // Instance 1: the image frame is accepted and the download starts.
  const fake1 = makeFakePi();
  const sends1: unknown[] = [];
  fake1.pi.sendUserMessage = (content: unknown) => {
    sends1.push(content);
  };
  chaosRelayExtension(fake1.pi as unknown as ExtensionApi);
  const ctx1 = makeCtx("sess-image-1", fake1.notifications);
  (ctx1 as { model: unknown }).model = { input: ["text", "image"] };
  await callHandler(fake1.handlers, "session_start", { reason: "startup" }, ctx1);
  pushEmailImage(socketForProfile("ak_img_replace"), "m-img-replace", "2026-10-10T00:00:02.000Z");
  await relay.waitForDownloadStart();

  // pi awaits session_shutdown before the replacement exists: the batch must be
  // handed back HERE, or the replacement resumes past it and the image is gone.
  await callHandler(fake1.handlers, "session_shutdown", {}, ctx1);
  relay.releaseDownload(); // the first download finishes, too late to be delivered
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Instance 2, the replacement: the relay replays the message on the new socket
  // (the on-connect lookback), and the hand-back left it un-seen.
  const fake2 = makeFakePi();
  const sends2: unknown[] = [];
  fake2.pi.sendUserMessage = (content: unknown) => {
    sends2.push(content);
  };
  chaosRelayExtension(fake2.pi as unknown as ExtensionApi);
  const ctx2 = makeCtx("sess-image-2", fake2.notifications);
  (ctx2 as { model: unknown }).model = { input: ["text", "image"] };
  await callHandler(fake2.handlers, "session_start", { reason: "startup" }, ctx2);
  const socket2 = PushWebSocket.instances.at(-1)!;
  pushEmailImage(socket2, "m-img-replace", "2026-10-10T00:00:02.000Z");
  await waitFor(() => sends2.length === 1);

  const raw = readFileSync(logPath, "utf-8").slice(logBefore);
  assert.equal(sends1.length, 0, `the replaced instance delivered nothing: ${JSON.stringify(sends1)}`);
  assert.match(
    raw,
    /session shutting down: 1 undelivered batch\(es\), 1 message\(s\) returned to the poller/,
    `the batch was handed back: ${raw}`,
  );
  const parts = imagePartsOf(sends2);
  const image = parts.find((p) => p.type === "image");
  assert.ok(image, `the replacement received image content: ${JSON.stringify(parts.map((p) => p.type))}`);
  assert.equal(image.data, ONE_PIXEL_PNG_B64, "with the real bytes, re-downloaded by the replacement");
  assert.equal(
    relay.attachmentRequests(),
    2,
    "the replacement re-fetched the attachment: the image was DELAYED, not dropped",
  );
});
