/**
 * Thin HTTP client for the CHAOS relay server.
 *
 * Identity is ECDSA P-256 request signing — the relay's real identity model.
 * At registration we send the client's public key; the relay binds the session
 * to it and from then on REQUIRES every authenticated request to carry a valid
 * `X-Signature` (plus `X-Timestamp` and `X-Nonce`) made by the matching private
 * key. The Bearer API key still travels on every request, but on its own it is
 * not enough once a public key is registered.
 *
 * Bearer-only is supported as a fallback for legacy sessions that registered
 * without a public key (the relay still accepts unsigned requests for those).
 * When this client has a keypair it always signs.
 *
 * Spec: ~/chaos/docs/relay-api-spec.md, relay-openapi.yaml, security.md, and
 * the canonical impl in ~/chaos/packages/{server,extension}/src.
 */

import { buildSignatureHeaders, generateKeyPair, type KeyPairJwk } from "./crypto.ts";

/**
 * Default per-request timeout. A bare `fetch` has NO timeout, so an unreachable
 * or stalled relay (cold start, dead host, hung proxy) makes the awaiting tool
 * hang forever and never return control to the agent. Every request is given an
 * AbortSignal so it always resolves — with a clear error — within this window.
 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** True for an AbortError raised by our timeout signal. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError" ||
    err instanceof Error && err.name === "AbortError";
}

/**
 * A timeout signal backed by a clearable timer. Unlike `AbortSignal.timeout`,
 * the timer is cleared via `clear()` in a finally block as soon as the request
 * settles, so it never lingers (which would trip Deno's test timer sanitizer
 * and needlessly keep the event loop alive).
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${ms}ms`, "TimeoutError")),
    ms,
  );
  // Don't let a pending timeout keep the process alive (Deno/Node).
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export interface RelayClientOptions {
  /** Base URL of the relay, e.g. https://chaos-relay.com or http://localhost:8787 */
  relayUrl: string;
  /** Bearer API key obtained from POST /auth/register. */
  apiKey: string;
  /**
   * ECDSA P-256 keypair (JWK) bound to this session. When present, every
   * authenticated request is signed. Omit only for legacy Bearer-only sessions.
   */
  keyPair?: KeyPairJwk;
  /** Optional fetch override (used by tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
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
  serverPublicKey?: JsonWebKey;
}

/** Result of registering a session including the locally-generated keypair. */
export interface RegisterWithKeyResult extends RegisterSessionResult {
  /** The keypair that was generated and bound to this session. Persist it. */
  keyPair: KeyPairJwk;
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
  constructor(message: string, status: number, body: unknown = undefined) {
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
 * Register a new relay session WITHOUT a public key (legacy Bearer-only).
 *
 * Prefer {@link registerSessionWithKey} — the relay's real identity model is
 * ECDSA signing. This helper exists for compatibility / explicit opt-out.
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

/**
 * Register a new relay session WITH an ECDSA public key — the default identity
 * path. Generates a P-256 keypair (unless one is supplied for reuse), sends the
 * public JWK to `POST /auth/register`, and returns the credentials plus the
 * keypair so the caller can persist it (mode 0600, never committed).
 *
 * After this, the relay binds the session to the public key and rejects any
 * authenticated request that is missing or has an invalid signature.
 */
export async function registerSessionWithKey(
  relayUrl: string,
  opts: { keyPair?: KeyPairJwk; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RegisterWithKeyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = normalizeRelayUrl(relayUrl);
  const keyPair = opts.keyPair ?? (await generateKeyPair());

  const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = timeoutSignal(ms);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: keyPair.publicKey }),
      signal: t.signal,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new RelayError(
        `Relay did not respond within ${ms}ms (POST ${base}/auth/register) — ` +
          `check the relay URL is correct and reachable.`,
        0,
      );
    }
    throw err;
  } finally {
    t.clear();
  }
  const body = await readBody(res);
  if (!res.ok) {
    throw new RelayError(
      `Failed to register relay session: ${describeError(body, res.status)}`,
      res.status,
      body,
    );
  }
  const result = body as RegisterSessionResult;
  return { ...result, keyPair };
}

export class RelayClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly keyPair?: KeyPairJwk;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RelayClientOptions) {
    this.base = normalizeRelayUrl(opts.relayUrl);
    this.apiKey = opts.apiKey;
    this.keyPair = opts.keyPair;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when this client signs requests (i.e. a keypair is configured). */
  get isSigned(): boolean {
    return Boolean(this.keyPair);
  }

  /**
   * Build the headers for an authenticated request. Always carries the Bearer
   * token; when a keypair is present it ALSO signs over the pathname + body and
   * adds X-Timestamp / X-Nonce / X-Signature.
   *
   * @param path     the request pathname WITHOUT query string — the server
   *                 signs over `new URL(req.url).pathname` only.
   * @param bodyText the exact serialized body string that will be sent
   *                 (must match byte-for-byte what fetch sends), or "" for none.
   */
  private async buildHeaders(
    path: string,
    bodyText: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.keyPair) {
      Object.assign(
        headers,
        await buildSignatureHeaders(this.keyPair.privateKey, path, bodyText),
      );
    }
    return headers;
  }

  /**
   * @param path  full request path, possibly including a query string. The
   *              query is included in the fetch URL but stripped before signing
   *              (the server signs over the pathname only).
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const bodyText = body !== undefined ? JSON.stringify(body) : "";
    const pathname = path.split("?")[0];
    const headers = await this.buildHeaders(pathname, bodyText);
    const t = timeoutSignal(this.timeoutMs);
    const init: RequestInit = { method, headers, signal: t.signal };
    if (body !== undefined) init.body = bodyText;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, init);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new RelayError(
          `Relay did not respond within ${this.timeoutMs}ms (${method} ${path}) — ` +
            `check the relay URL is correct and reachable.`,
          0,
        );
      }
      throw err;
    } finally {
      t.clear();
    }
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
    const t = timeoutSignal(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/health`, { signal: t.signal });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new RelayError(
          `Relay health check timed out after ${this.timeoutMs}ms — ` +
            `the relay at ${this.base} is not responding.`,
          0,
        );
      }
      throw err;
    } finally {
      t.clear();
    }
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
