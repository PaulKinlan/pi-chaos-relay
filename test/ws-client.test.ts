/**
 * Tests for the WebSocket transport (`ws-client.ts`).
 *
 * `ws-client.ts` parses UNTRUSTED frames off the relay socket and correlates
 * reply acks, so most of these tests are about what the transport does with
 * hostile or broken input, not just the happy path.
 *
 * Everything is driven through the `wsFactory` injection hook (ws-client.ts:48)
 * with a scripted fake socket, so no server, no network and no real socket.
 * Timer-driven paths (backoff and keepalive) use `node:test`'s mock timers;
 * ack timeouts and reconnect delays are injected as short values rather than
 * slept through.
 *
 * Untrusted frames are dropped rather than dereferenced, and reply acks
 * correlate FIFO within a single socket: pending replies are cleared on every
 * unexpected close so a later socket's ack can never settle an earlier reply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayWebSocket, toWsUrl } from "../ws-client.ts";
import type { RelayWebSocketOptions } from "../ws-client.ts";
import type { ChannelMessage } from "../relay-client.ts";

/** A scripted stand-in for the WebSocket the transport would get from the host. */
class FakeWebSocket {
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  closeCalls = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  /** Set to reproduce a `send` that throws (a socket closing under a reply). */
  sendError: Error | undefined;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  /** The transport closes the socket when it stops; a real socket fires onclose. */
  close(): void {
    this.closeCalls++;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /** Complete the handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }

  /** Deliver one frame from the relay (`raw` is passed through as `event.data`). */
  deliver(raw: unknown): void {
    this.onmessage?.({ data: raw });
  }

  /** Simulate the relay (or the network) dropping the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface Harness {
  ws: RelayWebSocket;
  sockets: FakeWebSocket[];
  delivered: ChannelMessage[][];
  logs: string[];
  /** The socket the transport constructed most recently. */
  last: () => FakeWebSocket;
}

function harness(opts: Partial<RelayWebSocketOptions> = {}): Harness {
  const sockets: FakeWebSocket[] = [];
  const delivered: ChannelMessage[][] = [];
  const logs: string[] = [];
  const ws = new RelayWebSocket({
    relayUrl: "https://relay.example.com",
    apiKey: "test-key",
    onMessage: (messages) => delivered.push(messages),
    log: (message) => logs.push(message),
    wsFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...opts,
  });
  return {
    ws,
    sockets,
    delivered,
    logs,
    last: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no socket was constructed");
      return socket;
    },
  };
}

function msg(id: string): ChannelMessage {
  return {
    id,
    channelType: "telegram",
    channelId: "chat-1",
    from: "alice",
    content: `content ${id}`,
    timestamp: "2026-01-01T00:00:00Z",
  };
}

const replyPayload = {
  channelType: "telegram",
  channelId: "chat-1",
  content: "hello",
};

/** Resolve a settlement to a string so a test can inspect it without an
 * unhandled rejection, and so a still-pending reply can be raced. */
function outcome<T>(promise: Promise<T>): Promise<string> {
  return promise.then(
    (value) => `resolved ${JSON.stringify(value)}`,
    (err: Error) => `rejected ${err.message}`,
  );
}

/** Let every already-queued promise chain run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Wait for injected 0ms reconnect timers to fire. */
function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "still pending" if `promise` has not settled within `ms`. */
function pendingish(promise: Promise<string>, ms = 15): Promise<string> {
  return Promise.race([promise, flush(ms).then(() => "still pending")]);
}

// --- toWsUrl ---------------------------------------------------------------

test("toWsUrl converts https to wss and appends the token query", () => {
  assert.equal(
    toWsUrl("https://relay.example.com", "test-key"),
    "wss://relay.example.com/ws?token=test-key",
  );
  assert.equal(
    toWsUrl("http://relay.example.com", "test-key"),
    "ws://relay.example.com/ws?token=test-key",
  );
});

test("toWsUrl strips trailing slashes so the path is not doubled", () => {
  assert.equal(
    toWsUrl("https://relay.example.com/", "k"),
    "wss://relay.example.com/ws?token=k",
  );
  assert.equal(
    toWsUrl("https://relay.example.com///", "k"),
    "wss://relay.example.com/ws?token=k",
  );
});

test("toWsUrl keeps a relay path prefix", () => {
  assert.equal(
    toWsUrl("https://relay.example.com/api", "k"),
    "wss://relay.example.com/api/ws?token=k",
  );
});

test("toWsUrl percent-encodes the token so query metacharacters survive", () => {
  assert.equal(
    toWsUrl("https://relay.example.com", "a b+c/d&e=f?g"),
    "wss://relay.example.com/ws?token=a%20b%2Bc%2Fd%26e%3Df%3Fg",
  );
});

test("a WebSocket constructor failure logs the origin, not the URL secret", () => {
  const secret = "supersecret-ws-key";
  const logs: string[] = [];
  const ws = new RelayWebSocket({
    relayUrl: "https://relay.example.com",
    apiKey: secret,
    onMessage: () => {},
    log: (message) => logs.push(message),
    maxBackoffMs: 0,
    wsFactory: () => {
      throw new Error(
        `WebSocket construct failed: wss://relay.example.com/ws?token=${secret}`,
      );
    },
  });
  ws.start();
  ws.stop();

  const text = logs.join("\n");
  assert.ok(text.includes("WebSocket construct failed"), `logs the failure: ${text}`);
  assert.ok(!text.includes(secret), `must not leak the apiKey: ${text}`);
  assert.ok(text.includes("wss://relay.example.com"), `keeps the origin: ${text}`);
});

// --- connecting ------------------------------------------------------------

test("connected tracks the socket lifecycle and connect uses toWsUrl", () => {
  const h = harness();
  assert.equal(h.ws.connected, false, "not connected before start");

  h.ws.start();
  assert.equal(h.sockets.length, 1);
  assert.equal(
    h.last().url,
    "wss://relay.example.com/ws?token=test-key",
  );
  assert.equal(h.ws.connected, false, "still CONNECTING before the handshake");

  h.last().open();
  assert.equal(h.ws.connected, true);

  h.last().drop(1006);
  assert.equal(h.ws.connected, false);
  h.ws.stop();
});

test("setApiKey is used for the next connection attempt", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  h.last().drop(1006);
  h.ws.setApiKey("rotated-key");
  await flush();

  assert.equal(h.sockets.length, 2);
  assert.ok(
    h.last().url.includes("token=rotated-key"),
    `expected the rotated key in ${h.last().url}`,
  );
  h.ws.stop();
});

test("a wsFactory that throws is logged and retried", async () => {
  let calls = 0;
  const h = harness({
    maxBackoffMs: 0,
    wsFactory: (): WebSocket => {
      calls++;
      throw new Error("no socket here");
    },
  });
  h.ws.start();
  assert.equal(calls, 1);
  await flush();
  assert.ok(calls >= 2, `expected a retry, saw ${calls} construct attempt(s)`);
  assert.ok(
    h.logs.some((l) => l.includes("WebSocket construct failed: no socket here")),
    `expected a construct-failure log, saw ${JSON.stringify(h.logs)}`,
  );
  h.ws.stop();
});

// --- catch-up on (re)connect ----------------------------------------------

test("catch-up on open delivers messages missed while offline", async () => {
  const missed = [msg("m-1"), msg("m-2")];
  const h = harness({ onCatchUp: async () => missed });
  h.ws.start();
  h.last().open();
  await settle();
  assert.deepEqual(h.delivered, [missed]);
  h.ws.stop();
});

test("catch-up that finds nothing delivers nothing", async () => {
  const h = harness({ onCatchUp: async () => [] });
  h.ws.start();
  h.last().open();
  await settle();
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("a failing catch-up is logged and leaves the socket usable", async () => {
  const h = harness({
    onCatchUp: async () => {
      throw new Error("relay unreachable");
    },
  });
  h.ws.start();
  h.last().open();
  await settle();
  assert.deepEqual(h.delivered, []);
  assert.equal(h.ws.connected, true);
  assert.ok(
    h.logs.some((l) => l.includes("catch-up poll failed: relay unreachable")),
    `expected a catch-up failure log, saw ${JSON.stringify(h.logs)}`,
  );
});

test("a failing catch-up log is redacted to the origin, not the URL secret", async () => {
  const secret = "catchup-query-secret";
  const h = harness({
    onCatchUp: async () => {
      throw new Error(
        `fetch failed: https://relay.example.com/messages?token=${secret}#part2`,
      );
    },
  });
  h.ws.start();
  h.last().open();
  await settle();

  const text = h.logs.join("\n");
  assert.ok(text.includes("catch-up poll failed"), `logs the failure: ${text}`);
  assert.ok(!text.includes(secret), `must not leak the query token: ${text}`);
  assert.ok(!text.includes("token="), `must not leak the query string: ${text}`);
  assert.ok(!text.includes("/messages"), `must not leak the path: ${text}`);
  assert.ok(!text.includes("part2"), `must not leak the fragment: ${text}`);
  assert.ok(text.includes("https://relay.example.com"), `keeps the origin: ${text}`);
  h.ws.stop();
});

test("no catch-up callback is not an error", async () => {
  const h = harness();
  h.ws.start();
  h.last().open();
  await settle();
  assert.deepEqual(h.delivered, []);
  assert.equal(h.ws.connected, true);
  h.ws.stop();
});

// --- handleFrame: untrusted input -----------------------------------------

test("malformed JSON is dropped and does not throw", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  for (const raw of ["{ not json", "{\"type\":", "not json at all", "{"]) {
    assert.doesNotThrow(() => socket.deliver(raw), `frame ${raw} threw`);
  }
  assert.deepEqual(h.delivered, []);
  assert.equal(h.ws.connected, true, "the socket stayed usable");
  h.ws.stop();
});

test("an empty frame is dropped", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  assert.doesNotThrow(() => socket.deliver(""));
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("a non-string frame (binary push) is dropped and does not throw", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  assert.doesNotThrow(() => socket.deliver(new Uint8Array([1, 2, 3])));
  assert.doesNotThrow(() => socket.deliver(undefined));
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("a valid message frame invokes the message callback", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  socket.deliver(JSON.stringify({ type: "message", message: msg("m-1") }));
  assert.deepEqual(h.delivered, [[msg("m-1")]]);
  h.ws.stop();
});

test("a message frame with no id is dropped", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  socket.deliver(JSON.stringify({ type: "message", message: { content: "no id" } }));
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("a message frame with no message payload is dropped", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  socket.deliver(JSON.stringify({ type: "message" }));
  socket.deliver(JSON.stringify({ type: "message", message: null }));
  socket.deliver(JSON.stringify({ type: "message", message: "not an object" }));
  // `msg && msg.id` is falsy for "" too, so an empty id is dropped.
  socket.deliver(JSON.stringify({ type: "message", message: { id: "" } }));
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("JSON payloads that are not objects are ignored", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  for (const raw of ["null", "123", "\"a string\"", "[]", "true", "[1,2]"]) {
    assert.doesNotThrow(() => socket.deliver(raw), `frame ${raw} threw`);
  }
  assert.deepEqual(h.delivered, []);
  assert.equal(
    h.logs.filter((l) => l.includes("dropping non-object relay frame")).length,
    6,
    `expected one drop log per non-object frame, saw ${JSON.stringify(h.logs)}`,
  );
  h.ws.stop();
});

test("a JSON `null` frame is dropped without throwing", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  assert.doesNotThrow(() => socket.deliver("null"));
  assert.deepEqual(h.delivered, []);
  assert.equal(h.ws.connected, true, "the socket stayed usable");
  assert.ok(
    h.logs.some((l) => l.includes("dropping non-object relay frame")),
    `expected a non-object frame log, saw ${JSON.stringify(h.logs)}`,
  );
  h.ws.stop();
});

test("unknown frame types are ignored", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  socket.deliver(JSON.stringify({ type: "pong" }));
  socket.deliver(JSON.stringify({ type: "something-new", message: msg("m-1") }));
  socket.deliver(JSON.stringify({ noType: true }));
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

// --- reply_ack / error correlation ----------------------------------------

test("reply_ack resolves the oldest pending reply", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const first = outcome(h.ws.reply({ ...replyPayload, content: "first" }, 5_000));
  const second = outcome(h.ws.reply({ ...replyPayload, content: "second" }, 5_000));
  socket.deliver(
    JSON.stringify({ type: "reply_ack", ok: true, responseId: "ack-1" }),
  );

  assert.equal(await first, 'resolved {"ok":true,"responseId":"ack-1"}');
  assert.equal(await pendingish(second), "still pending");
  h.ws.stop();
});

test("an ack that omits ok is treated as success", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = h.ws.reply(replyPayload, 5_000);
  socket.deliver(JSON.stringify({ type: "reply_ack", responseId: "ack-1" }));

  assert.deepEqual(await reply, {
    ok: true,
    responseId: "ack-1",
    error: undefined,
    channel: undefined,
  });
  h.ws.stop();
});

test("a refusal ack (ok:false) resolves with the relay's reason and channel", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = h.ws.reply(replyPayload, 5_000);
  socket.deliver(
    JSON.stringify({
      type: "reply_ack",
      ok: false,
      error: "unknown channel",
      channel: { id: "c-1", type: "telegram", label: "Team" },
    }),
  );

  assert.deepEqual(await reply, {
    ok: false,
    responseId: undefined,
    error: "unknown channel",
    channel: { id: "c-1", type: "telegram", label: "Team" },
  });
  h.ws.stop();
});

test("an ack with no pending reply is ignored", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  assert.doesNotThrow(() =>
    socket.deliver(JSON.stringify({ type: "reply_ack", ok: true })),
  );
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("an error frame rejects the oldest pending reply with the relay's reason", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const first = outcome(h.ws.reply({ ...replyPayload, content: "first" }, 5_000));
  const second = outcome(h.ws.reply({ ...replyPayload, content: "second" }, 5_000));
  socket.deliver(JSON.stringify({ type: "error", error: "channel not permitted" }));

  assert.equal(await first, "rejected channel not permitted");
  assert.equal(await pendingish(second), "still pending");
  h.ws.stop();
});

test("an error frame with no reason rejects with a default message", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = outcome(h.ws.reply(replyPayload, 5_000));
  socket.deliver(JSON.stringify({ type: "error" }));
  assert.equal(await reply, "rejected relay error");
  h.ws.stop();
});

test("an error frame with nothing pending is logged, not thrown", () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();
  assert.doesNotThrow(() =>
    socket.deliver(JSON.stringify({ type: "error", error: "session expired" })),
  );
  assert.ok(
    h.logs.some((l) => l.includes("relay error frame: session expired")),
    `expected an error-frame log, saw ${JSON.stringify(h.logs)}`,
  );
  h.ws.stop();
});

// --- reply() ---------------------------------------------------------------

test("reply rejects when the socket was never opened (HTTP fallback trigger)", async () => {
  const h = harness();
  await assert.rejects(h.ws.reply(replyPayload, 5), /WebSocket not connected/);

  h.ws.start();
  assert.equal(h.last().readyState, 0, "socket is CONNECTING");
  await assert.rejects(h.ws.reply(replyPayload, 5), /WebSocket not connected/);
  assert.deepEqual(h.last().sent, [], "nothing was sent");
  h.ws.stop();
});

test("reply rejects after the socket closed (HTTP fallback trigger)", async () => {
  const h = harness();
  h.ws.start();
  h.last().open();
  h.last().drop(1006);

  await assert.rejects(h.ws.reply(replyPayload, 5), /WebSocket not connected/);
  h.ws.stop();
});

test("reply sends a typed frame and resolves on the ack", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = h.ws.reply(
    {
      ...replyPayload,
      replyTo: "m-1",
      metadata: { transport: "ws" },
    },
    5_000,
  );
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "reply",
    channelType: "telegram",
    channelId: "chat-1",
    content: "hello",
    replyTo: "m-1",
    metadata: { transport: "ws" },
  });

  socket.deliver(JSON.stringify({ type: "reply_ack", ok: true, responseId: "ack-1" }));
  assert.equal((await reply).responseId, "ack-1");
  h.ws.stop();
});

test("reply rejects on ack timeout", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = h.ws.reply(replyPayload, 30);
  assert.equal(socket.sent.length, 1, "the frame went out before the timeout");
  await assert.rejects(reply, /reply ack timed out/);
  h.ws.stop();
});

test("an ack arriving after the timeout does not resolve or throw", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  const timedOut = outcome(h.ws.reply(replyPayload, 30));
  assert.equal(await timedOut, "rejected reply ack timed out");
  // The timed-out entry must be gone, so this ack has nothing to resolve.
  assert.doesNotThrow(() =>
    socket.deliver(JSON.stringify({ type: "reply_ack", ok: true, responseId: "late" })),
  );
  assert.deepEqual(h.delivered, []);
  h.ws.stop();
});

test("reply rejects when send throws and drops the pending entry", async () => {
  const h = harness();
  h.ws.start();
  const socket = h.last();
  socket.open();

  socket.sendError = new Error("socket is closing");
  await assert.rejects(h.ws.reply({ ...replyPayload, content: "a" }, 5_000), /socket is closing/);

  // The failed entry must not linger: the next ack belongs to the next reply.
  socket.sendError = undefined;
  const next = outcome(h.ws.reply({ ...replyPayload, content: "b" }, 5_000));
  socket.deliver(JSON.stringify({ type: "reply_ack", ok: true, responseId: "ack-b" }));
  assert.equal(await next, 'resolved {"ok":true,"responseId":"ack-b"}');
  h.ws.stop();
});

// --- stop() ----------------------------------------------------------------

test("stop rejects in-flight replies and does not reconnect", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const socket = h.last();
  socket.open();

  const first = outcome(h.ws.reply({ ...replyPayload, content: "a" }, 5_000));
  const second = outcome(h.ws.reply({ ...replyPayload, content: "b" }, 5_000));
  h.ws.stop();

  assert.equal(await first, "rejected WebSocket closed");
  assert.equal(await second, "rejected WebSocket closed");
  assert.equal(socket.closeCalls, 1, "the socket was closed");
  assert.equal(h.ws.connected, false);

  await flush(20);
  assert.equal(h.sockets.length, 1, "no reconnect after stop");
  assert.equal(h.ws.connected, false);
});

test("stop cancels a scheduled reconnect", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const socket = h.last();
  socket.drop(1006); // schedules a reconnect
  h.ws.stop(); // ...which stop must cancel

  await flush(20);
  assert.equal(h.sockets.length, 1, "the pending reconnect did not fire");
  assert.equal(h.ws.connected, false);
});

test("stop is safe before start and when called twice", () => {
  const h = harness();
  assert.doesNotThrow(() => h.ws.stop());
  assert.equal(h.sockets.length, 0, "stop did not open a socket");

  h.ws.start();
  h.last().open();
  h.ws.stop();
  assert.doesNotThrow(() => h.ws.stop(), "a second stop threw");
  assert.equal(h.last().closeCalls, 1, "was the socket closed once");
  assert.equal(h.ws.connected, false);
});

test("a socket error is logged and left to the close handler", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const socket = h.last();
  socket.open();

  assert.doesNotThrow(() => socket.onerror?.({ type: "error" }));
  assert.ok(
    h.logs.some((l) => l.includes("WebSocket error")),
    `expected an error log, saw ${JSON.stringify(h.logs)}`,
  );
  // The transport deliberately does not reconnect from onerror — a real socket
  // follows an error with onclose, and that is what schedules the reconnect.
  await flush(20);
  assert.equal(h.sockets.length, 1, "onerror opened a second socket");
  assert.equal(h.ws.connected, true, "onerror did not tear down the socket");
  h.ws.stop();
});

// --- reconnect backoff -----------------------------------------------------

test("backoff doubles per attempt while the handshake keeps failing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.ws.start();
  assert.equal(h.sockets.length, 1);

  // First failed handshake: 1000 * 2^1 = 2000ms.
  h.last().drop(1006);
  t.mock.timers.tick(1_999);
  assert.equal(h.sockets.length, 1, "reconnected before the backoff elapsed");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 2);

  // Second failed handshake: 1000 * 2^2 = 4000ms.
  h.last().drop(1006);
  t.mock.timers.tick(3_999);
  assert.equal(h.sockets.length, 2, "reconnected before the backoff elapsed");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);

  h.ws.stop();
  t.mock.timers.reset();
});

test("backoff is capped at maxBackoffMs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ maxBackoffMs: 3_000 });
  h.ws.start();

  h.last().drop(1006); // attempt 1: 2000ms (under the cap)
  t.mock.timers.tick(2_000);
  assert.equal(h.sockets.length, 2);

  h.last().drop(1006); // attempt 2: 4000ms raw, capped to 3000ms
  t.mock.timers.tick(2_999);
  assert.equal(h.sockets.length, 2, "waited longer than the cap");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);

  h.ws.stop();
  t.mock.timers.reset();
});

test("a socket that opens and immediately dies keeps the exponential backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.ws.start();

  h.last().drop(1006); // attempt 1: 2000ms
  t.mock.timers.tick(2_000);
  assert.equal(h.sockets.length, 2);

  h.last().open(); // opens…
  h.last().drop(1006); // …and dies immediately (inside the stability window)
  // attempt 2 is scheduled at 4000ms — the open-then-die did NOT reset the
  // backoff. Probe INSIDE (2000ms, 4000ms): the pre-fix code reconnected at
  // 2000ms, so ticking only to 1999ms/4000ms would let this test pass against
  // the unfixed code (review finding: the assertion interval must exclude the
  // reset-at-open delay).
  t.mock.timers.tick(3_999);
  assert.equal(h.sockets.length, 2, "reconnected before the doubled backoff elapsed");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);

  h.ws.stop();
  t.mock.timers.reset();
});

test("a socket that stays up long enough resets the backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  h.ws.start();

  h.last().drop(1006); // attempt 1: 2000ms
  t.mock.timers.tick(2_000);
  assert.equal(h.sockets.length, 2);

  h.last().open(); // handshake succeeds
  t.mock.timers.tick(30_000); // survives the stability window → backoff resets
  h.last().drop(1006);
  t.mock.timers.tick(1_999);
  assert.equal(h.sockets.length, 2, "backed off more than the first-attempt delay");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);

  h.ws.stop();
  t.mock.timers.reset();
});

// --- auth recovery ---------------------------------------------------------

test("repeated failed handshakes trigger one auth recovery with the fresh key", async () => {
  let recoveries = 0;
  const h = harness({
    maxBackoffMs: 0,
    onAuthFailure: async () => {
      recoveries++;
      return "fresh-key";
    },
  });
  h.ws.start();
  assert.ok(h.last().url.includes("token=test-key"));

  h.last().drop(1006); // first failed handshake — no recovery yet
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(recoveries, 0, "recovered after a single failure");

  h.last().drop(1006); // second failed handshake — recovery
  await flush();
  assert.equal(recoveries, 1);
  assert.equal(h.sockets.length, 3);
  assert.ok(
    h.last().url.includes("token=fresh-key"),
    `expected the recovered key in ${h.last().url}`,
  );

  // One-shot: further failed handshakes do not call onAuthFailure again.
  h.last().drop(1006);
  await flush();
  h.last().drop(1006);
  await flush();
  assert.equal(recoveries, 1, "auth recovery ran more than once per open");
  h.ws.stop();
});

test("a successful open re-arms auth recovery", async () => {
  let recoveries = 0;
  const h = harness({
    maxBackoffMs: 0,
    onAuthFailure: async () => {
      recoveries++;
      return `key-${recoveries}`;
    },
  });
  h.ws.start(); // socket 1
  h.last().drop(1006); // failed handshake 1
  await flush(); // socket 2
  h.last().open(); // a healthy connection resets the counters
  h.last().drop(1006); // closing a socket that DID open is not a failed handshake
  await flush(); // socket 3
  h.last().drop(1006); // failed handshake 1 after the reset
  await flush(); // socket 4
  assert.equal(recoveries, 0, "recovered before two failures after the reset");

  h.last().drop(1006); // failed handshake 2 after the reset — recovery
  await flush(); // socket 5
  assert.equal(recoveries, 1);
  assert.ok(
    h.last().url.includes("token=key-1"),
    `expected the recovered key in ${h.last().url}`,
  );
  h.ws.stop();
});

test("auth recovery that returns no key keeps the old key and does not retry", async () => {
  let recoveries = 0;
  const h = harness({
    maxBackoffMs: 0,
    onAuthFailure: async () => {
      recoveries++;
      return null;
    },
  });
  h.ws.start();

  h.last().drop(1006);
  await flush();
  h.last().drop(1006);
  await flush();
  assert.equal(recoveries, 1);
  assert.ok(h.last().url.includes("token=test-key"));

  h.last().drop(1006);
  await flush();
  h.last().drop(1006);
  await flush();
  assert.equal(recoveries, 1, "recovery was retried although it can never mint a key");
  h.ws.stop();
});

test("a failing auth recovery is logged and reconnection continues", async () => {
  const h = harness({
    maxBackoffMs: 0,
    onAuthFailure: async () => {
      throw new Error("re-register failed");
    },
  });
  h.ws.start();

  h.last().drop(1006);
  await flush();
  h.last().drop(1006);
  await flush();

  assert.ok(
    h.logs.some((l) => l.includes("auth recovery failed: re-register failed")),
    `expected an auth-recovery failure log, saw ${JSON.stringify(h.logs)}`,
  );
  assert.ok(h.sockets.length >= 3, "kept reconnecting after the failed recovery");
  h.ws.stop();
});

test("a failing auth recovery log is redacted to the origin, not the URL secret", async () => {
  const secret = "authrecovery-query-secret";
  const h = harness({
    maxBackoffMs: 0,
    onAuthFailure: async () => {
      throw new Error(
        `re-register failed: https://relay.example.com/auth/register?token=${secret}#part2`,
      );
    },
  });
  h.ws.start();

  h.last().drop(1006);
  await flush();
  h.last().drop(1006);
  await flush();

  const text = h.logs.join("\n");
  assert.ok(text.includes("auth recovery failed"), `logs the failure: ${text}`);
  assert.ok(!text.includes(secret), `must not leak the query token: ${text}`);
  assert.ok(!text.includes("token="), `must not leak the query string: ${text}`);
  assert.ok(!text.includes("/auth/register"), `must not leak the path: ${text}`);
  assert.ok(!text.includes("part2"), `must not leak the fragment: ${text}`);
  assert.ok(text.includes("https://relay.example.com"), `keeps the origin: ${text}`);
  h.ws.stop();
});

// --- keepalive -------------------------------------------------------------

test("a ping is sent on the keepalive interval while connected", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness({ pingIntervalMs: 1_000 });
  h.ws.start();
  const socket = h.last();
  socket.open();

  t.mock.timers.tick(999);
  assert.deepEqual(socket.sent, [], "pinged before the interval elapsed");
  t.mock.timers.tick(1);
  assert.deepEqual(socket.sent, [JSON.stringify({ type: "ping" })]);
  t.mock.timers.tick(1_000);
  assert.equal(socket.sent.length, 2, "pinged once per interval");

  socket.drop(1006);
  t.mock.timers.tick(10_000);
  assert.equal(socket.sent.length, 2, "kept pinging after the socket closed");

  h.ws.stop();
  t.mock.timers.reset();
});

test("a ping is not sent on a socket that is not open", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness({ pingIntervalMs: 1_000 });
  h.ws.start();
  const socket = h.last();
  socket.open();
  socket.readyState = 3; // e.g. closing between the interval firing and the send

  t.mock.timers.tick(1_000);
  assert.deepEqual(socket.sent, []);
  h.ws.stop();
  t.mock.timers.reset();
});

// --- start() idempotency ---------------------------------------------------

test("start() is idempotent: one socket per transport, restart after stop()", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const first = h.last();

  // While CONNECTING, a repeat call must not race the handshake with a second
  // socket (the reported defect: two sockets, the first orphaned with its
  // handlers still live).
  h.ws.start();
  assert.equal(h.sockets.length, 1, "no second socket while CONNECTING");

  first.open();
  assert.equal(h.ws.connected, true);
  h.ws.start();
  assert.equal(h.sockets.length, 1, "no second socket while OPEN");
  assert.equal(first.closeCalls, 0, "the live socket was left untouched");
  assert.equal(h.ws.connected, true);

  // CLOSED with a reconnect already armed: the armed attempt is the one that
  // runs; start() must not orphan it with a second socket.
  first.drop(1006);
  h.ws.start();
  assert.equal(h.sockets.length, 1, "no second socket while a reconnect is armed");
  await flush();
  assert.equal(h.sockets.length, 2, "the armed reconnect still ran");
  h.last().open();

  // stop() clears both the socket and the reconnect, so an explicit restart
  // still reconnects — idempotence must not become a one-shot latch.
  h.ws.stop();
  h.ws.start();
  assert.equal(h.sockets.length, 3, "start() after stop() reconnects");
  h.ws.stop();
});

test("start() during a pending auth recovery does not orphan the socket it opens", async () => {
  let releaseAuth: () => void = () => {};
  const auth = new Promise<string | null>((resolve) => {
    releaseAuth = () => resolve("refreshed-key");
  });
  const h = harness({ maxBackoffMs: 0, onAuthFailure: () => auth });

  h.ws.start();
  h.last().drop(1006); // handshake never opened → failedHandshakes = 1
  await flush(); // the armed reconnect runs
  assert.equal(h.sockets.length, 2);
  h.last().drop(1006); // failedHandshakes = 2 → auth recovery (still pending)
  await flush();
  assert.equal(h.sockets.length, 2, "no reconnect armed while auth recovery is pending");

  // A caller that trusts start()'s idempotence asks for a socket meanwhile.
  h.ws.start();
  assert.equal(h.sockets.length, 3);

  // Auth resolves and schedules ITS reconnect; the live socket must survive it.
  releaseAuth();
  await flush();
  assert.equal(h.sockets.length, 3, "the late auth reconnect must not add a socket");
  assert.equal(h.ws.connected, false, "the start()ed socket is still the current one");
  h.last().open();
  assert.equal(h.ws.connected, true);
  h.ws.stop();
});

test("a superseded socket cannot deliver frames, reject replies, or reconnect", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const stale = h.last();
  stale.open();

  h.ws.stop();
  h.ws.start();
  const current = h.last();
  assert.equal(h.sockets.length, 2);
  current.open();

  const pending = outcome(h.ws.reply({ ...replyPayload, content: "live" }, 5_000));
  // A superseded socket's handlers are still installed on a real socket whose
  // close event lands late; its events must be ignored rather than becoming a
  // duplicate delivery path, a rejected live reply, and a second reconnect chain.
  stale.onmessage?.({ data: JSON.stringify({ type: "message", message: msg("stale") }) });
  stale.onclose?.({ code: 1006 });
  await flush();

  assert.deepEqual(h.delivered, [], "a superseded socket must not deliver frames");
  assert.equal(await pendingish(pending), "still pending", "a stale close must not reject the live reply");
  assert.equal(h.sockets.length, 2, "a superseded close must not schedule a reconnect");

  // The live socket still works end to end.
  current.deliver(JSON.stringify({ type: "reply_ack", ok: true, responseId: "ack-live" }));
  assert.equal(await pending, 'resolved {"ok":true,"responseId":"ack-live"}');
  current.deliver(JSON.stringify({ type: "message", message: msg("m-live") }));
  assert.deepEqual(h.delivered, [[msg("m-live")]]);
  h.ws.stop();
});

test("pending replies are rejected on reconnect and cannot steal the next ack", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const first = h.last();
  first.open();

  const a = outcome(h.ws.reply({ ...replyPayload, content: "A" }, 5_000));
  first.drop(1006);
  assert.equal(await a, "rejected WebSocket closed");
  await flush();

  const second = h.last();
  second.open();
  const b = outcome(h.ws.reply({ ...replyPayload, content: "B" }, 5_000));
  second.deliver(JSON.stringify({ type: "reply_ack", ok: true, responseId: "ack-b" }));
  assert.equal(await b, 'resolved {"ok":true,"responseId":"ack-b"}');
  h.ws.stop();
});

test("an unexpected close rejects in-flight replies immediately", async () => {
  const h = harness({ maxBackoffMs: 0 });
  h.ws.start();
  const socket = h.last();
  socket.open();

  const reply = outcome(h.ws.reply(replyPayload, 5_000));
  socket.drop(1006);
  assert.equal(await reply, "rejected WebSocket closed");
  h.ws.stop();
});
