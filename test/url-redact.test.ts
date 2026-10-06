import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCommandSecrets, redactUrlSecretsFromMessage, safeUrlOrigin } from "../url-redact.ts";

test("redactUrlSecretsFromMessage strips userinfo from an embedded http URL", () => {
  const secret = "supersecretpass";
  const out = redactUrlSecretsFromMessage(
    `fetch failed for https://user:${secret}@example.com/health — retrying`,
  );
  assert.ok(!out.includes(secret), `must not leak the password: ${out}`);
  assert.ok(!out.includes("user@example.com"), `must not leak userinfo: ${out}`);
  assert.ok(out.includes("https://example.com"), `keeps the origin: ${out}`);
});

test("redactUrlSecretsFromMessage strips query and fragment from an embedded http URL", () => {
  const secret = "topsecret-token";
  const out = redactUrlSecretsFromMessage(
    `POST failed: https://example.com/webhook/ch_1?token=${secret}#frag`,
  );
  assert.ok(!out.includes(secret), `must not leak the query token: ${out}`);
  assert.ok(!out.includes("token="), `must not leak the query string: ${out}`);
  assert.ok(!out.includes("/webhook"), `must not leak the path: ${out}`);
  assert.ok(!out.includes("frag"), `must not leak the fragment: ${out}`);
  assert.ok(out.includes("https://example.com"), `keeps the origin: ${out}`);
});

test("redactUrlSecretsFromMessage strips ws/wss query secrets too", () => {
  const secret = "ws-api-key";
  const out = redactUrlSecretsFromMessage(
    `WebSocket construct failed: The URL 'wss://example.com/ws?token=${secret}' is invalid`,
  );
  assert.ok(!out.includes(secret), `must not leak the ws token: ${out}`);
  assert.ok(out.includes("wss://example.com"), `keeps the ws origin: ${out}`);
});

test("redactUrlSecretsFromMessage preserves surrounding prose and punctuation", () => {
  const out = redactUrlSecretsFromMessage(
    "see https://example.com/docs, and then continue.",
  );
  assert.equal(out, "see https://example.com, and then continue.");
});

test("redactUrlSecretsFromMessage is a no-op for prose without a URL", () => {
  const prose = "the relay did not respond within 15000ms";
  assert.equal(redactUrlSecretsFromMessage(prose), prose);
});

test("safeUrlOrigin renders origin only and marks non-http values invalid", () => {
  assert.equal(safeUrlOrigin("https://user:pass@example.com:8443/secret?q#f"), "https://example.com:8443");
  assert.equal(safeUrlOrigin("http://127.0.0.1:9"), "http://127.0.0.1:9");
  assert.equal(safeUrlOrigin("not a url"), "<invalid>");
  assert.equal(safeUrlOrigin(""), "<unset>");
});

test("redactUrlSecretsFromMessage strips a URL ending a sentence with a trailing period", () => {
  const secret = "trailing-period-secret";
  const out = redactUrlSecretsFromMessage(
    `see https://example.com/health?token=${secret}.`,
  );
  assert.ok(!out.includes(secret), `must not leak the query token: ${out}`);
  assert.ok(!out.includes("token="), `must not leak the query string: ${out}`);
  assert.ok(!out.includes("/health"), `must not leak the path: ${out}`);
  assert.ok(out.includes("https://example.com."), `keeps the origin and the sentence period: ${out}`);
});

test("redactUrlSecretsFromMessage strips a ws:// URL query secret too", () => {
  const secret = "ws-plain-secret";
  const out = redactUrlSecretsFromMessage(
    `ws socket failed: ws://example.com/socket?token=${secret}`,
  );
  assert.ok(!out.includes(secret), `must not leak the ws token: ${out}`);
  assert.ok(!out.includes("token="), `must not leak the query string: ${out}`);
  assert.ok(!out.includes("/socket"), `must not leak the path: ${out}`);
  assert.ok(out.includes("ws://example.com"), `keeps the ws origin: ${out}`);
});

test("redactUrlSecretsFromMessage redacts every URL in a multi-URL message", () => {
  const first = "first-token-secret";
  const second = "second-token-secret";
  const out = redactUrlSecretsFromMessage(
    `a: https://a.example.com/x?token=${first} b: https://b.example.com/y?token=${second}`,
  );
  assert.ok(!out.includes(first), `must not leak the first token: ${out}`);
  assert.ok(!out.includes(second), `must not leak the second token: ${out}`);
  assert.ok(!out.includes("token="), `must not leak either query string: ${out}`);
  assert.ok(out.includes("https://a.example.com"), `keeps the first origin: ${out}`);
  assert.ok(out.includes("https://b.example.com"), `keeps the second origin: ${out}`);
});

test("redactUrlSecretsFromMessage leaves a bare host without scheme alone", () => {
  const secret = "bare-host-secret";
  const bare = `example.com/health?token=${secret}`;
  assert.equal(redactUrlSecretsFromMessage(bare), bare);
});

test("safeUrlOrigin marks ws:// and ftp:// invalid", () => {
  assert.equal(safeUrlOrigin("ws://example.com/socket?token=s"), "<invalid>");
  assert.equal(safeUrlOrigin("ftp://example.com/file"), "<invalid>");
});

// ── redactCommandSecrets: informed-but-safe bash approval prompts ─────────────

test("redactCommandSecrets keeps the command visible while hiding an embedded secret", () => {
  const secret = "ghp_supersecrettoken1234567890abcdef";
  const out = redactCommandSecrets(`curl -s -H "Authorization: Bearer ${secret}" https://api.example.com/repos`);
  assert.ok(out.includes("curl"), `keeps the command: ${out}`);
  assert.ok(out.includes("api.example.com"), `keeps the target origin: ${out}`);
  assert.ok(!out.includes(secret), `must not leak the token: ${out}`);
});

test("redactCommandSecrets scrubs a secret-named assignment", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const out = redactCommandSecrets(`GH_TOKEN=${secret} npm publish`);
  assert.ok(out.includes("GH_TOKEN=<redacted>"), `keeps the key and hides the value: ${out}`);
  assert.ok(out.includes("npm publish"), `keeps the rest of the command: ${out}`);
  assert.ok(!out.includes(secret), `must not leak the assigned secret: ${out}`);
});

test("redactCommandSecrets strips URL query secrets inside a command", () => {
  const secret = "relay-super-secret";
  const out = redactCommandSecrets(`curl "https://example.com/webhook?token=${secret}"`);
  assert.ok(!out.includes(secret), `must not leak the query token: ${out}`);
  assert.ok(!out.includes("token="), `must not leak the query string: ${out}`);
  assert.ok(out.includes("https://example.com"), `keeps the origin: ${out}`);
});

test("redactCommandSecrets leaves an unrelated word that merely contains 'key' alone", () => {
  const out = redactCommandSecrets("KEYBOARD_LAYOUT=us npm run build");
  assert.equal(out, "KEYBOARD_LAYOUT=us npm run build");
});
