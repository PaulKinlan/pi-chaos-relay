/**
 * Thin HTTP client for the CHAOS relay server.
 *
 * Implements the Bearer-token subset of the relay API that a polling client
 * needs: register a session, register Telegram/email channels, poll inbound
 * messages, and post replies. ECDSA request signing (the relay's optional
 * enhanced-security mode) is intentionally not used here — we register without
 * a public key, so plain Bearer auth applies to every request.
 *
 * Spec: ~/chaos/docs/relay-api-spec.md and relay-openapi.yaml.
 */

export interface RelayClientOptions {
  /** Base URL of the relay, e.g. https://chaos-relay.deno.dev or http://localhost:8787 */
  relayUrl: string;
  /** Bearer API key obtained from POST /auth/register. */
  apiKey: string;
  /** Optional fetch override (used by tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ChannelMessage {
  id: string;
  channelType: "webhook" | "telegram" | "discord" | "email" | "slack";
  channelId: string;
  from: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface GetMessagesResult {
  messages: ChannelMessage[];
  /** Cursor to pass to the next poll. */
  since: string;
}

export interface RegisterSessionResult {
  userId: string;
  apiKey: string;
  serverPublicKey?: unknown;
}

export interface TelegramRegisterResult {
  channelId: string;
  botUsername: string;
  pairingCode: string;
}

export interface EmailRegisterResult {
  channelId: string;
  inboundAddress: string;
}

export interface ReplyResult {
  ok: boolean;
  /** Present for telegram/discord replies. */
  channelType?: string;
  /** Present for telegram/discord replies. */
  channelId?: string;
  /** Present for webhook-style channels (reply stored for GET /responses). */
  responseId?: string;
}

export class RelayError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.body = body;
  }
}

/** Strip a trailing slash so we can concatenate paths cleanly. */
export function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Register a new relay session and obtain a Bearer API key.
 *
 * This is a static helper (no key required yet). We deliberately omit
 * `publicKey` so that subsequent requests only need the Bearer token.
 */
export async function registerSession(
  relayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisterSessionResult> {
  const base = normalizeRelayUrl(relayUrl);
  const res = await fetchImpl(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await readBody(res);
  if (!res.ok) {
    throw new RelayError(
      `Failed to register relay session: ${describeError(body, res.status)}`,
      res.status,
      body,
    );
  }
  return body as RegisterSessionResult;
}

export class RelayClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RelayClientOptions) {
    this.base = normalizeRelayUrl(opts.relayUrl);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get authHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method, headers: this.authHeaders };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    const parsed = await readBody(res);
    if (!res.ok) {
      throw new RelayError(
        `Relay request failed (${method} ${path}): ${describeError(parsed, res.status)}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  /** Health check — useful for `setup` to confirm the relay is reachable. */
  async health(): Promise<{ status: string; version?: string }> {
    const res = await this.fetchImpl(`${this.base}/health`);
    const body = await readBody(res);
    if (!res.ok) {
      throw new RelayError(`Relay health check failed`, res.status, body);
    }
    return body as { status: string; version?: string };
  }

  /**
   * Poll for inbound messages. Pass the `since` cursor from the previous call
   * to only receive new messages.
   */
  async getMessages(since?: string): Promise<GetMessagesResult> {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<GetMessagesResult>("GET", `/messages${query}`);
  }

  /** Send a reply back to a channel message. */
  async reply(params: {
    channelType: ChannelMessage["channelType"];
    channelId: string;
    content: string;
    replyTo?: string;
  }): Promise<ReplyResult> {
    return this.request<ReplyResult>("POST", "/reply", {
      channelType: params.channelType,
      channelId: params.channelId,
      content: params.content,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
  }

  /** Register a Telegram bot as a bidirectional channel. */
  async registerTelegram(params: {
    botToken: string;
    agentId: string;
  }): Promise<TelegramRegisterResult> {
    return this.request<TelegramRegisterResult>(
      "POST",
      "/channels/telegram/register",
      { botToken: params.botToken, agentId: params.agentId },
    );
  }

  /** Register an email channel (requires CHAOS_EMAIL_DOMAIN on the server). */
  async registerEmail(params: {
    userEmail: string;
    agentId: string;
    channelName?: string;
  }): Promise<EmailRegisterResult> {
    return this.request<EmailRegisterResult>(
      "POST",
      "/channels/email/register",
      {
        userEmail: params.userEmail,
        agentId: params.agentId,
        ...(params.channelName ? { channelName: params.channelName } : {}),
      },
    );
  }

  /** List the user's channels. */
  async listChannels(): Promise<{ channels: unknown[] }> {
    return this.request<{ channels: unknown[] }>("GET", "/channels");
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  if (typeof body === "string" && body) return body;
  return `HTTP ${status}`;
}
