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
  assert.equal(sawSince, "cursor-1"); // second poll uses returned cursor
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

test("reset clears cursor and dedup state", async () => {
  const client = stubClient([{ messages: [msg("a")], since: "c1" }]);
  const poller = new MessagePoller(client);
  await poller.poll();
  poller.reset();
  const again = await poller.poll();
  assert.deepEqual(again.map((m) => m.id), ["a"]); // re-delivered after reset
});

test("formatMessagesForAgent handles empty and non-empty", () => {
  assert.match(formatMessagesForAgent([]), /No new messages/);
  const out = formatMessagesForAgent([msg("x", "hello world")]);
  assert.match(out, /1 new message/);
  assert.match(out, /id=x/);
  assert.match(out, /hello world/);
  assert.match(out, /relay_reply/);
});
