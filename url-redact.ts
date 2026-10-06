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
