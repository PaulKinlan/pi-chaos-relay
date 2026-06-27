/**
 * One-shot "connect" input parsing for chaos-relay.
 *
 * Realises the "give the agent a single thing and it handles the rest" flow:
 * from one pasted string (a bot token, an email address, or the word
 * "webhook") work out which channel the user wants to connect. An explicit
 * "type value" prefix always wins (to disambiguate look-alike tokens); failing
 * that, the value's shape is sniffed.
 */
export type ConnectPlan =
  | { kind: "telegram"; token: string }
  | { kind: "discord"; token: string }
  | { kind: "email"; email: string }
  | { kind: "webhook"; name?: string }
  | { kind: "unknown"; reason: string };

const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
// Discord bot token: three dot-separated base64url-ish segments.
const DISCORD_TOKEN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseConnectInput(raw: string): ConnectPlan {
  const input = (raw ?? "").trim();
  if (!input) return { kind: "unknown", reason: "nothing was provided" };

  // Explicit "telegram <token>" / "discord <token>" / "email <addr>" / "webhook <name>".
  // Require a separator after the keyword so a value that merely *starts* with a
  // type word (e.g. a token "discord-like…") isn't mis-parsed — that falls
  // through to shape detection below. ("webhook" with no value is handled there.)
  const prefixed = input.match(/^(telegram|discord|email|webhook)[:\s]+(.*)$/is);
  if (prefixed) {
    const type = prefixed[1].toLowerCase();
    const rest = prefixed[2].trim();
    if (type === "telegram" && rest) return { kind: "telegram", token: rest };
    if (type === "discord" && rest) return { kind: "discord", token: rest };
    if (type === "email" && rest) return { kind: "email", email: rest };
    if (type === "webhook") return rest ? { kind: "webhook", name: rest } : { kind: "webhook" };
  }

  // Auto-detect from the value's shape.
  if (TELEGRAM_TOKEN.test(input)) return { kind: "telegram", token: input };
  if (DISCORD_TOKEN.test(input)) return { kind: "discord", token: input };
  if (EMAIL.test(input)) return { kind: "email", email: input };
  if (/^webhook$/i.test(input)) return { kind: "webhook" };

  return {
    kind: "unknown",
    reason:
      'I couldn\'t tell what that is. Prefix it with the type — e.g. ' +
      '"telegram 123456:ABC…", "discord <token>", "email you@example.com", or "webhook <name>".',
  };
}
