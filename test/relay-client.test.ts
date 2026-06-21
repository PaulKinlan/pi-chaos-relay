import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RelayClient,
  RelayError,
  normalizeRelayUrl,
  registerSession,
} from "../relay-client.ts";

/** Build a fake fetch that records calls and returns scripted responses. */
function mockFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    const { status = 200, body } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test("normalizeRelayUrl strips trailing slashes", () => {
  assert.equal(normalizeRelayUrl("http://x/"), "http://x");
  assert.equal(normalizeRelayUrl("http://x///"), "http://x");
  assert.equal(normalizeRelayUrl("http://x"), "http://x");
});

test("registerSession posts to /auth/register and returns credentials", async () => {
  const { fn, calls } = mockFetch(() => ({
    body: { userId: "u1", apiKey: "k1" },
  }));
  const res = await registerSession("http://relay/", fn);
  assert.equal(res.apiKey, "k1");
  assert.equal(res.userId, "u1");
  assert.equal(calls[0].url, "http://relay/auth/register");
  assert.equal(calls[0].init?.method, "POST");
});

test("getMessages sends Bearer auth and since cursor", async () => {
  const { fn, calls } = mockFetch(() => ({
    body: { messages: [], since: "2026-01-01T00:00:00Z" },
  }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "secret", fetchImpl: fn });
  await client.getMessages("2025-12-31T00:00:00Z");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret");
  assert.match(calls[0].url, /\/messages\?since=2025-12-31/);
});

test("reply posts channelType/channelId/content and omits empty replyTo", async () => {
  const { fn, calls } = mockFetch(() => ({
    body: { ok: true, channelType: "telegram", channelId: "ch1" },
  }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "k", fetchImpl: fn });
  const res = await client.reply({ channelType: "telegram", channelId: "ch1", content: "hi" });
  assert.equal(res.ok, true);
  const sent = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(sent, { channelType: "telegram", channelId: "ch1", content: "hi" });
  assert.ok(!("replyTo" in sent));
});

test("reply includes replyTo when provided", async () => {
  const { fn, calls } = mockFetch(() => ({
    body: { ok: true, channelType: "email", channelId: "ch2" },
  }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "k", fetchImpl: fn });
  await client.reply({ channelType: "email", channelId: "ch2", content: "yo", replyTo: "m9" });
  const sent = JSON.parse(calls[0].init?.body as string);
  assert.equal(sent.replyTo, "m9");
});

test("registerTelegram hits the right endpoint with agentId", async () => {
  const { fn, calls } = mockFetch(() => ({
    status: 201,
    body: { channelId: "ch_t", botUsername: "bot", pairingCode: "ABCD" },
  }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "k", fetchImpl: fn });
  const res = await client.registerTelegram({ botToken: "tok", agentId: "pi" });
  assert.equal(res.pairingCode, "ABCD");
  assert.equal(calls[0].url, "http://relay/channels/telegram/register");
  const sent = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(sent, { botToken: "tok", agentId: "pi" });
});

test("registerEmail hits the right endpoint", async () => {
  const { fn, calls } = mockFetch(() => ({
    status: 201,
    body: { channelId: "ch_e", inboundAddress: "ch_e@relay" },
  }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "k", fetchImpl: fn });
  const res = await client.registerEmail({ userEmail: "a@b.com", agentId: "pi" });
  assert.equal(res.inboundAddress, "ch_e@relay");
  assert.equal(calls[0].url, "http://relay/channels/email/register");
});

test("error responses throw RelayError with the server message", async () => {
  const { fn } = mockFetch(() => ({ status: 401, body: { error: "Unauthorized" } }));
  const client = new RelayClient({ relayUrl: "http://relay", apiKey: "bad", fetchImpl: fn });
  await assert.rejects(
    () => client.getMessages(),
    (err: unknown) => {
      assert.ok(err instanceof RelayError);
      assert.equal(err.status, 401);
      assert.match(err.message, /Unauthorized/);
      return true;
    },
  );
});
