/**
 * ECDSA P-256 request signing for the CHAOS relay — the relay's real identity
 * model. There is no separate identity management: a session is bound to the
 * keypair it registers with, and every authenticated request after that must
 * carry a signature made by the matching private key.
 *
 * This is a faithful port of the canonical CHAOS implementation
 * (`~/chaos/packages/extension/src/channels/crypto.ts` for signing and
 * `~/chaos/packages/server/src/crypto.ts` for verification). The wire details
 * MUST match the server exactly, so they are pinned here:
 *
 *   - Curve / hash:    ECDSA, namedCurve "P-256", hash "SHA-256" (ES256).
 *   - Keypair:         exported/stored as JWK (kty "EC", crv "P-256").
 *   - Signed payload:  `${timestamp}|${nonce}|${path}|${bodyHash}`
 *                      NOTE the separator is "|" — the prose docs say "\n",
 *                      but the reference code (server crypto.ts verify, line
 *                      ~117) uses "|". The code is authoritative.
 *   - path:            URL pathname ONLY (no query string) — server uses
 *                      `new URL(req.url).pathname`.
 *   - bodyHash:        lowercase hex SHA-256 of the raw request body string.
 *                      For GET/HEAD the body is the empty string "", so the
 *                      hash is SHA-256("") — not omitted.
 *   - signature:       base64 of the raw WebCrypto ECDSA output (IEEE P1363
 *                      r||s, 64 bytes), which is what `crypto.subtle.sign`
 *                      returns and what the server's `crypto.subtle.verify`
 *                      expects.
 *   - X-Nonce:         16 random bytes, lowercase hex (32 chars).
 *   - X-Timestamp:     ISO 8601 (`new Date().toISOString()`).
 *
 * Uses the global WebCrypto (`crypto.subtle`) available in Node 20+, browsers,
 * Deno, and Workers — no Node Buffer, so this stays portable.
 */

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** An ECDSA P-256 keypair exported as JWK (the persisted form). */
export interface KeyPairJwk {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

/** The signature headers added to an authenticated, signed request. */
export interface SignatureHeaders {
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Signature": string;
}

/**
 * Generate a fresh ECDSA P-256 keypair, exported as JWK so it can be persisted
 * to disk (mode 0600) and re-imported later. Keys are marked extractable so we
 * can export them; the private JWK never leaves the local config file.
 */
export async function generateKeyPair(): Promise<KeyPairJwk> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ]);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey, publicKey };
}

/** Import a private JWK as a signing CryptoKey. */
async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALGORITHM, false, ["sign"]);
}

/** Import a public JWK as a verifying CryptoKey (used by tests). */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALGORITHM, false, ["verify"]);
}

/** SHA-256 of a string, lowercase hex — matches the server's `hashBody`. */
export async function hashBody(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

/** A random 16-byte nonce, lowercase hex (32 chars). Unique per request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Build the exact string the relay signs/verifies:
 *   `${timestamp}|${nonce}|${path}|${bodyHash}`
 */
export function buildSigningPayload(
  timestamp: string,
  nonce: string,
  path: string,
  bodyHash: string,
): string {
  return `${timestamp}|${nonce}|${path}|${bodyHash}`;
}

/**
 * Sign a request payload with the private JWK. Returns the base64-encoded
 * raw (IEEE P1363) ECDSA-SHA256 signature.
 *
 * @param body the raw request body string ("" for GET/HEAD).
 */
export async function signRequest(
  privateJwk: JsonWebKey,
  timestamp: string,
  nonce: string,
  path: string,
  body: string,
): Promise<string> {
  const key = await importPrivateKey(privateJwk);
  const bodyHash = await hashBody(body);
  const payload = buildSigningPayload(timestamp, nonce, path, bodyHash);
  const signature = await crypto.subtle.sign(
    SIGN_ALGORITHM,
    key,
    new TextEncoder().encode(payload),
  );
  return bufferToBase64(signature);
}

/**
 * Verify a signature with a public JWK. Used by the unit tests to prove a
 * known input produces a signature the server's scheme would accept. Mirrors
 * the server's `verifyRequestSignature`.
 */
export async function verifyRequest(
  publicJwk: JsonWebKey,
  signature: string,
  timestamp: string,
  nonce: string,
  path: string,
  body: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicJwk);
    const bodyHash = await hashBody(body);
    const payload = buildSigningPayload(timestamp, nonce, path, bodyHash);
    return crypto.subtle.verify(
      SIGN_ALGORITHM,
      key,
      base64ToBuffer(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

/**
 * Produce the full set of signature headers for a request. Convenience wrapper
 * that mints a fresh timestamp + nonce and signs.
 */
export async function buildSignatureHeaders(
  privateJwk: JsonWebKey,
  path: string,
  body: string,
): Promise<SignatureHeaders> {
  const timestamp = new Date().toISOString();
  const nonce = generateNonce();
  const signature = await signRequest(privateJwk, timestamp, nonce, path, body);
  return {
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
  };
}

// ── Utility functions (no Node Buffer — portable across runtimes) ──

function bufferToHex(buffer: ArrayBuffer): string {
  return bytesToHex(new Uint8Array(buffer));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  // Allocate an explicit ArrayBuffer so the view is ArrayBuffer-backed (not
  // SharedArrayBuffer), satisfying the strict BufferSource type for verify().
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}
