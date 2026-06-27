import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnectInput } from "../connect.ts";

test("auto-detects a Telegram bot token", () => {
  const r = parseConnectInput("123456789:AAElwfDbbkalYv0s3CgMhwRNXEXC8eikR4Q");
  assert.deepEqual(r, {
    kind: "telegram",
    token: "123456789:AAElwfDbbkalYv0s3CgMhwRNXEXC8eikR4Q",
  });
});

test("auto-detects a Discord bot token (three dotted segments)", () => {
  // Obviously-fake placeholder shaped like a Discord token (three base64url-ish
  // dot-separated segments) — kept low-entropy so secret scanners don't flag it.
  const token = "discord-token-placeholder.test.this-is-not-a-secret-value";
  const r = parseConnectInput(token);
  assert.deepEqual(r, { kind: "discord", token });
});

test("auto-detects an email address", () => {
  const r = parseConnectInput("ade@example.com");
  assert.deepEqual(r, { kind: "email", email: "ade@example.com" });
});

test('"webhook" with no value creates an unnamed webhook', () => {
  assert.deepEqual(parseConnectInput("webhook"), { kind: "webhook" });
});

test("explicit type prefix wins and disambiguates", () => {
  assert.deepEqual(parseConnectInput("discord some-weird-token"), {
    kind: "discord",
    token: "some-weird-token",
  });
  assert.deepEqual(parseConnectInput("webhook github"), {
    kind: "webhook",
    name: "github",
  });
  assert.deepEqual(parseConnectInput("email me@you.dev"), {
    kind: "email",
    email: "me@you.dev",
  });
});

test("trims surrounding whitespace", () => {
  const r = parseConnectInput("  ade@example.com  ");
  assert.deepEqual(r, { kind: "email", email: "ade@example.com" });
});

test("unrecognised input returns a helpful unknown", () => {
  const r = parseConnectInput("hello there");
  assert.equal(r.kind, "unknown");
  assert.match((r as { reason: string }).reason, /prefix it with the type/i);
});

test("empty input is unknown", () => {
  assert.equal(parseConnectInput("").kind, "unknown");
  assert.equal(parseConnectInput("   ").kind, "unknown");
});
