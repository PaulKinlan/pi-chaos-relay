import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagePoller, formatMessagesForAgent } from "../poller.ts";
import type { ChannelMessage, GetMessagesResult, RelayClient } from "../relay-client.ts";

function msg(id: string, content = "hi"): ChannelMessage {
  return {
    id,
    channelType: "telegram",
    channelId: "ch1",
    from: "alice",
    content,
    timestamp: "2026-01-01T00:00:00Z",
  };
}

/** Minimal stub client that returns scripted getMessages results in order. */
function stubClient(results: GetMessagesResult[]): RelayClient {
  let i = 0;
  return {
    async getMessages(_since?: string) {
      return results[Math.min(i++, results.length - 1)];
    },
  } as unknown as RelayClient;
}

test("poller forwards the since cursor and returns messages", async () => {
  let sawSince: string | undefined = "init";
  const client = {
    async getMessages(since?: string) {
      sawSince = since;
      return { messages: [msg("a")], since: "cursor-1" };
    },
  } as unknown as RelayClient;
  const poller = new MessagePoller(client);
  const first = await poller.poll();
  assert.equal(sawSince, undefined); // first poll has no cursor
  assert.equal(first.length, 1);
  await poller.poll();
  // The cursor is driven by delivered message timestamps (so WS pushes advance
  // it too), NOT the server's response cursor — second poll resumes after it.
  assert.equal(sawSince, "2026-01-01T00:00:00Z");
});

test("poller dedupes messages by id across polls", async () => {
  const client = stubClient([
    { messages: [msg("a"), msg("b")], since: "c1" },
    { messages: [msg("b"), msg("c")], since: "c2" },
  ]);
  const poller = new MessagePoller(client);
  const first = await poller.poll();
  assert.deepEqual(first.map((m) => m.id), ["a", "b"]);
  const second = await poller.poll();
  assert.deepEqual(second.map((m) => m.id), ["c"]); // "b" already seen
});

test("pollRaw advances the cursor but does NOT mark messages seen", async () => {
  // Regression: the WS catch-up path calls pollRaw() and then routes the result
  // through onMessage -> accept(). If pollRaw deduped (like poll), accept would
  // drop everything as already-seen and nothing would reach the agent.
  let sawSince: string | undefined = "init";
  const client = {
    async getMessages(since?: string) {
      sawSince = since;
      return { messages: [msg("a"), msg("b")], since: "cursor-1" };
    },
  } as unknown as RelayClient;
  const poller = new MessagePoller(client);

  const raw = await poller.pollRaw();
  assert.equal(sawSince, undefined); // first call has no cursor
  assert.deepEqual(raw.map((m) => m.id), ["a", "b"]);

  // The downstream accept() must still surface them (they were NOT pre-consumed).
  const delivered = poller.accept(raw);
  assert.deepEqual(delivered.map((m) => m.id), ["a", "b"]);

  // accept() advanced the cursor to the delivered message timestamp, so the
  // next pollRaw resumes from there (not the server's response cursor).
  await poller.pollRaw();
  assert.equal(sawSince, "2026-01-01T00:00:00Z");
});

test("reset clears dedup but KEEPS the resume cursor", async () => {
  // Cursor persistence: reset() must not re-expose already-delivered messages,
  // because the cursor (advanced from timestamps) still filters them out.
  const client = stubClient([{ messages: [msg("a")], since: "c1" }]);
  const poller = new MessagePoller(client);
  const first = await poller.poll();
  assert.deepEqual(first.map((m) => m.id), ["a"]);
  assert.equal(poller.cursor, "2026-01-01T00:00:00Z"); // advanced to msg ts
  poller.reset();
  assert.equal(poller.cursor, "2026-01-01T00:00:00Z"); // cursor survives reset
});

test("cursor advances from message timestamps and fires onAdvance", async () => {
  const advances: string[] = [];
  const poller = new MessagePoller({} as never, {
    onAdvance: (s) => advances.push(s),
  });
  // accept() (the single delivery gate) drives the cursor, incl. WS pushes.
  poller.accept([
    { ...msg("a"), timestamp: "2026-01-01T00:00:01Z" },
    { ...msg("b"), timestamp: "2026-01-01T00:00:03Z" },
    { ...msg("c"), timestamp: "2026-01-01T00:00:02Z" },
  ]);
  assert.equal(poller.cursor, "2026-01-01T00:00:03Z"); // max timestamp
  assert.deepEqual(advances, ["2026-01-01T00:00:03Z"]); // latest persisted once
});

test("a poller created with a since cursor resumes from it", async () => {
  let sawSince: string | undefined;
  const client = {
    async getMessages(since?: string) {
      sawSince = since;
      return { messages: [], since: "c1" };
    },
  } as unknown as RelayClient;
  const poller = new MessagePoller(client, { since: "2026-06-01T00:00:00Z" });
  assert.equal(poller.cursor, "2026-06-01T00:00:00Z");
  await poller.pollRaw();
  assert.equal(sawSince, "2026-06-01T00:00:00Z"); // resumed, not from scratch
});

test("formatMessagesForAgent handles empty and non-empty", () => {
  assert.match(formatMessagesForAgent([]), /No new messages/);
  const out = formatMessagesForAgent([msg("x", "hello world")]);
  assert.match(out, /1 new message/);
  assert.match(out, /id=x/);
  assert.match(out, /hello world/);
  assert.match(out, /relay_reply/);
});
