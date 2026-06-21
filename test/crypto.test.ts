import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignatureHeaders,
  buildSigningPayload,
  generateKeyPair,
  generateNonce,
  hashBody,
  importPublicKey,
  signRequest,
  verifyRequest,
} from "../crypto.ts";

test("generateKeyPair produces an extractable P-256 JWK pair", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  assert.equal(publicKey.kty, "EC");
  assert.equal(publicKey.crv, "P-256");
  assert.equal(privateKey.kty, "EC");
  assert.equal(privateKey.crv, "P-256");
  // Private key carries the secret scalar `d`; public key must NOT.
  assert.ok(typeof privateKey.d === "string" && privateKey.d.length > 0);
  assert.equal(publicKey.d, undefined);
  // Both share the same public point.
  assert.equal(privateKey.x, publicKey.x);
  assert.equal(privateKey.y, publicKey.y);
});

test("hashBody is SHA-256 hex; empty string matches the known digest", async () => {
  // SHA-256("") — the value the relay uses for GET/HEAD requests.
  assert.equal(
    await hashBody(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const h = await hashBody("hello");
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("generateNonce is 16 random bytes as lowercase hex", () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b); // overwhelmingly likely
});

test("buildSigningPayload uses the relay's exact '|' canonical form", () => {
  assert.equal(
    buildSigningPayload("2026-01-01T00:00:00Z", "abc", "/messages", "deadbeef"),
    "2026-01-01T00:00:00Z|abc|/messages|deadbeef",
  );
});

test("a signed request verifies against its own public key", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const ts = "2026-06-21T12:00:00.000Z";
  const nonce = "0123456789abcdef0123456789abcdef";
  const path = "/reply";
  const body = JSON.stringify({ channelType: "telegram", content: "hi" });

  const sig = await signRequest(privateKey, ts, nonce, path, body);
  assert.match(sig, /^[A-Za-z0-9+/]+=*$/); // base64
  assert.equal(await verifyRequest(publicKey, sig, ts, nonce, path, body), true);
});

test("verification fails if any signed field is tampered", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const ts = "2026-06-21T12:00:00.000Z";
  const nonce = "0123456789abcdef0123456789abcdef";
  const sig = await signRequest(privateKey, ts, nonce, "/messages", "");

  // Wrong path
  assert.equal(await verifyRequest(publicKey, sig, ts, nonce, "/reply", ""), false);
  // Wrong body
  assert.equal(await verifyRequest(publicKey, sig, ts, nonce, "/messages", "x"), false);
  // Wrong nonce
  assert.equal(await verifyRequest(publicKey, sig, ts, "deadbeef", "/messages", ""), false);
});

test("a different keypair cannot verify the signature", async () => {
  const signer = await generateKeyPair();
  const attacker = await generateKeyPair();
  const ts = new Date().toISOString();
  const nonce = generateNonce();
  const sig = await signRequest(signer.privateKey, ts, nonce, "/channels", "{}");
  assert.equal(
    await verifyRequest(attacker.publicKey, sig, ts, nonce, "/channels", "{}"),
    false,
  );
});

test("buildSignatureHeaders yields fresh, self-consistent headers", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const path = "/messages";
  const body = "";
  const headers = await buildSignatureHeaders(privateKey, path, body);

  assert.match(headers["X-Nonce"], /^[0-9a-f]{32}$/);
  assert.ok(!Number.isNaN(Date.parse(headers["X-Timestamp"])));
  assert.equal(
    await verifyRequest(
      publicKey,
      headers["X-Signature"],
      headers["X-Timestamp"],
      headers["X-Nonce"],
      path,
      body,
    ),
    true,
  );
});

/**
 * Interop guard: re-implement the SERVER's verification (from
 * ~/chaos/packages/server/src/crypto.ts) inline and prove our client signature
 * passes it. If the canonicalization ever drifts from the server, this fails.
 */
test("signature passes a from-scratch reimplementation of the server verifier", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const ts = "2026-06-21T12:34:56.000Z";
  const nonce = generateNonce();
  const path = "/reply";
  const body = JSON.stringify({ channelType: "email", content: "smoke" });

  const sigB64 = await signRequest(privateKey, ts, nonce, path, body);

  // ---- server-side verification, transcribed from the relay source ----
  const VERIFY_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
  const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    ALGORITHM,
    false,
    ["verify"],
  );
  // server: bodyHash = sha256 hex of the body
  const bodyDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const bodyHash = Array.from(new Uint8Array(bodyDigest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const payload = `${ts}|${nonce}|${path}|${bodyHash}`;
  // server: base64ToBuffer
  const binary = atob(sigB64);
  const sigBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) sigBytes[i] = binary.charCodeAt(i);

  const ok = await crypto.subtle.verify(
    VERIFY_ALGORITHM,
    cryptoKey,
    sigBytes,
    new TextEncoder().encode(payload),
  );
  assert.equal(ok, true);

  // sanity: importPublicKey helper agrees too
  assert.ok(await importPublicKey(publicKey));
});
