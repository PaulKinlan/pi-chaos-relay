/**
 * URL redaction helpers shared by the relay client, the WebSocket transport and
 * the TUI/log entry point. A relay URL can be a pasted secret or carry
 * credentials in userinfo / query / fragment, so any URL that reaches a log
 * line or a notification must be reduced to scheme://host[:port] — never
 * userinfo, path, query or fragment.
 */

/**
 * Render a relay URL for DISPLAY without leaking credentials: origin only
 * (scheme+host+port), never userinfo, path, query or fragment. Returns
 * "<unset>" for a missing/empty value and "<invalid>" for a value that does
 * not parse as an http(s) URL.
 */
export function safeUrlOrigin(url: unknown): string {
  if (typeof url !== "string" || url.trim() === "") return "<unset>";
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "<invalid>";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "<invalid>";
  return parsed.origin === "null" ? "<invalid>" : parsed.origin;
}

/** Rendered when a URL-shaped match cannot be reduced to a host at all. */
const INVALID_ORIGIN = "<invalid>";

/**
 * Reduce an absolute URL string to scheme://host[:port], dropping userinfo,
 * path, query and fragment.
 *
 * `new URL()` rejects a URL whose port is out of range (e.g.
 * `https://user:pass@host:99999/`) or whose authority is malformed (an
 * unclosed IPv6 literal, empty host). Those inputs MUST still be reduced:
 * echoing the input — the pre-fix behaviour — returns the very userinfo and
 * query secrets this function exists to hide, and they reach logs, the TUI and
 * approval prompts. So the fallback reduces by hand: it cuts the authority at
 * the first path/query/fragment separator, keeps only what follows the last
 * `@` (userinfo), drops a non-numeric "port", and returns `<invalid>` rather
 * than ever echoing a value it cannot reduce. A percent-encoded authority
 * (`alice%3Apw%40host`, which hides its userinfo from the last-`@` rule) and a
 * bracketed IPv6 authority (which this code will not hand-validate) also fail
 * closed — as does anything past the authority: for a URL the parser rejected,
 * the authority tail cannot be told apart from a mistyped secret, so it is
 * withheld even when it looks like prose (`…:99999,then` → host only).
 */
function originOnly(raw: string): string {
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${u.hostname}${port}`;
  } catch {
    return fallbackOrigin(raw);
  }
}

/** WHATWG treats `\` as a path separator for special schemes; the authority
 * ends at the first of these. */
const AUTHORITY_END_RE = /[/?#\\]/;
/** A plain domain-shaped host, plus an optional numeric port. `%` is
 * deliberately absent (the host parser percent-decodes, so any `%XX` here is an
 * encoded delimiter, not part of a host) and so are brackets: a bracketed IPv6
 * literal is validated by the real parser in the try-branch, and reaching the
 * fallback with one means the parser rejected it — hand-validating an address
 * here is exactly how `[::deadbeefdeadbeef]` (hextet > 4 hex digits) and
 * `[1:2:3:4:5:6:7:8:9]` rode through. */
const SAFE_HOST_RE = /^[A-Za-z0-9._~\-]+(?::\d+)?$/;

/** Fail-closed reduction for a URL `new URL()` refused. Never echoes `raw`. */
function fallbackOrigin(raw: string): string {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd <= 0) return INVALID_ORIGIN;
  const scheme = raw.slice(0, schemeEnd + 3);
  const rest = raw.slice(schemeEnd + 3);
  const end = rest.search(AUTHORITY_END_RE);
  const authority = end === -1 ? rest : rest.slice(0, end);
  // Only the part after the LAST `@` is host/port; everything before it is
  // userinfo (and may be the credential).
  const at = authority.lastIndexOf("@");
  let host = at === -1 ? authority : authority.slice(at + 1);
  // A `%XX` in the authority is invisible to the last-`@` rule (that is how
  // `alice%3Apw%40host` hides its userinfo from it) and a host never carries a
  // literal `%` — the parser decodes it and rejects it as a forbidden domain
  // code point. So any `%` fails closed rather than riding out as a "host".
  if (host.includes("%")) return INVALID_ORIGIN;
  // A bracketed literal means the parser rejected this URL (a valid literal on
  // a parseable URL never reaches the fallback). Refuse it rather than echo an
  // address this code cannot verify.
  if (host.startsWith("[")) return INVALID_ORIGIN;
  // A non-numeric tail after `:` is not a port — it could be a mistyped secret
  // sitting in the port position, so drop it rather than echo it.
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && !/^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  return host !== "" && SAFE_HOST_RE.test(host) ? `${scheme}${host}` : INVALID_ORIGIN;
}

// http(s) relay URLs and the ws(s) socket URL derived from them.
const EMBEDDED_URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
// Trailing punctuation that belongs to surrounding prose, not the URL.
const TRAILING_PUNCTUATION = ".,;:!?)]}";

/**
 * Strip secrets from any embedded http(s)/ws(s) URL in a message: userinfo,
 * query string and fragment are removed, leaving only scheme://host[:port].
 * Ordinary prose (including trailing punctuation) is preserved. A URL that
 * cannot be parsed is reduced by hand rather than echoed, and becomes
 * `<invalid>` when not even a host survives (see `originOnly`).
 */
export function redactUrlSecretsFromMessage(message: string): string {
  return message.replace(EMBEDDED_URL_RE, (match) => {
    let end = match.length;
    while (end > 0 && TRAILING_PUNCTUATION.includes(match[end - 1])) end--;
    return originOnly(match.slice(0, end)) + match.slice(end);
  });
}

// Secret-signalling key-name components, matched case-insensitively. A value
// is scrubbed when its `NAME=value` assignment's NAME contains one of these as
// a whole `_`/`-`-delimited part (so `key`, `token`, `password`, … are caught,
// but an unrelated word that merely CONTAINS "key" is not).
const SECRET_VALUE_KEYS = new Set([
  "token",
  "secret",
  "key",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "credential",
  "apikey",
  "api-key",
  "api_key",
  "privatekey",
  "private-key",
  "private_key",
]);

/** `NAME=value` where NAME looks like it names a secret (value is replaced). */
const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;|&]+)/gi;

/** A standalone high-entropy token: 24+ chars of the base64/hex token alphabet.
 * Length is the entropy heuristic — enough to redact a pasted key/credential
 * without hiding ordinary prose. */
const LONG_SECRET_TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;

function looksSecretName(name: string): boolean {
  return name.split(/[_-]/).some((part) => SECRET_VALUE_KEYS.has(part.toLowerCase()));
}

/**
 * Scrub secret-shaped values from a shell command for DISPLAY (an approval
 * prompt). The operator still sees WHAT the command does, but any value that
 * could BE a secret is withheld:
 *   - URL userinfo / query / fragment (via redactUrlSecretsFromMessage);
 *   - `NAME=value` assignments whose NAME signals a secret;
 *   - standalone high-entropy tokens (≥ 24 base64/hex chars).
 * Over-redaction is intentional: a value that merely LOOKS secret is safer to
 * hide than to ship.
 */
export function redactCommandSecrets(command: string): string {
  let out = redactUrlSecretsFromMessage(command);
  out = out.replace(SECRET_ASSIGNMENT_RE, (match, name: string) =>
    looksSecretName(name) ? `${name}=<redacted>` : match,
  );
  out = out.replace(LONG_SECRET_TOKEN_RE, "<redacted>");
  return out;
}
