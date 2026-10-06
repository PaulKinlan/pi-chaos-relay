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

/** Reduce an absolute URL string to scheme://host[:port], dropping userinfo,
 * path, query and fragment. Returns the input unchanged when it cannot be
 * parsed, so surrounding prose survives untouched. */
function originOnly(raw: string): string {
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${u.hostname}${port}`;
  } catch {
    return raw;
  }
}

// http(s) relay URLs and the ws(s) socket URL derived from them.
const EMBEDDED_URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
// Trailing punctuation that belongs to surrounding prose, not the URL.
const TRAILING_PUNCTUATION = ".,;:!?)]}";

/**
 * Strip secrets from any embedded http(s)/ws(s) URL in a message: userinfo,
 * query string and fragment are removed, leaving only scheme://host[:port].
 * Ordinary prose (including trailing punctuation) is preserved.
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
