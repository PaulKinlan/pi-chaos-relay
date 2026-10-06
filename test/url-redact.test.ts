import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrlSecretsFromMessage, safeUrlOrigin } from "../url-redact.ts";

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
