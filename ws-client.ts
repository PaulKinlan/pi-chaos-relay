/**
 * WebSocket transport for the CHAOS relay.
 *
 * The relay pushes inbound messages over a WebSocket (it runs a Deno KV watch
 * per connection and sends `{type:"message", message}` as soon as one arrives),
 * and accepts replies on the same socket (`{type:"reply", ...}` ->
 * `{type:"reply_ack"}`). This replaces 15s HTTP polling with near-instant push.
 *
 * Auth: the relay authenticates the socket from an `Authorization: Bearer <apiKey>`
 * header on the upgrade request — Node's WebSocket sends a `headers` option — so the
 * key can enter the URL at all: `header` sends `Authorization: Bearer <apiKey>` and
 * keeps it out of every log, `query` is the legacy `?token=` form. The default is
 * `query` ONLY because the relay's `/ws` handler still reads the token from the query
 * string and 401s without it (PaulKinlan/chaos, `packages/server/src/main.ts`: the
 * upgrade branch does `url.searchParams.get("token")`); a URL-carried key is warned
 * about once per connection lifecycle, and `header` is the documented migration once
 * the relay accepts an upgrade header. The upgrade handshake is not ECDSA-signed, so
 * the apiKey is the only credential the WS needs. (Registration + HTTP catch-up still
 * use the signed client.)
 *
 * Resilience:
 *  - Auto-reconnect with exponential backoff.
 *  - On every (re)connect, a catch-up callback runs an HTTP GET /messages so
 *    anything that arrived while the socket was down is not missed (the relay's
 *    push only covers from connect time onward). De-dup is handled upstream.
 *  - If the handshake keeps failing without ever opening (e.g. a dead apiKey
 *    after a relay data loss), an optional onAuthFailure callback can mint a
 *    fresh apiKey (re-registering with the stored keypair, which reclaims the
 *    same session) before the next attempt.
 *  - The backoff counter is reset only once a connection has stayed OPEN for
 *    STABLE_UPTIME_MS (see the constant): a socket that opens and immediately
 *    dies — an accept-then-drop relay — keeps the exponential floor instead of
 *    reconnecting at a flat 2s forever.
 */

import type { ChannelMessage } from "./relay-client.ts";
import {
  MAX_INBOUND_FRAME_BYTES,
  frameIssueLimiter,
  parseInboundMessage,
} from "./inbound-message.ts";
import { redactUrlSecretsFromMessage } from "./url-redact.ts";

/**
 * How long a socket must stay OPEN before its (rare) drop is treated as a fresh
 * failure eligible for a fast first retry. A socket that opens and dies inside
 * this window is treated as a failed attempt and keeps the exponential backoff,
 * so an accept-then-drop relay cannot hold the client at the flat 2s floor
 * (~29 reconnects/min). Matches the keepalive ping cadence: a connection that
 * has survived a full ping interval is "established", not flapping.
 */
const STABLE_UPTIME_MS = 30_000;

export interface RelayWebSocketOptions {
  /** Relay base URL (http/https) — converted to ws/wss internally. */
  relayUrl: string;
  /** Bearer API key (the only credential the WS handshake needs). */
  apiKey: string;
  /** Deliver pushed messages (already de-duplicated upstream). */
  onMessage: (messages: ChannelMessage[]) => void;
  /**
   * Called on each (re)connect to fetch messages missed while disconnected.
   * Returns fresh (de-duplicated) messages, which are delivered via onMessage.
   */
  onCatchUp?: () => Promise<ChannelMessage[]>;
  /**
   * Called when the socket repeatedly fails to even open (likely a dead
   * apiKey). Should return a fresh apiKey (e.g. by re-registering with the
   * stored keypair) or null if it can't. The returned key is used for the
   * next attempt.
   */
  onAuthFailure?: () => Promise<string | null>;
  /** Logger. */
  log?: (message: string) => void;
  /**
   * Override the WebSocket constructor (tests). Defaults to global WebSocket.
   * The second argument is the `{ headers }` init, present unless the operator
   * opted into the legacy query-token auth.
   */
  wsFactory?: (url: string, init?: { headers: Record<string, string> }) => WebSocket;
  /** Keepalive ping interval. Default 30s. */
  pingIntervalMs?: number;
  /** Max reconnect backoff. Default 30s. */
  maxBackoffMs?: number;
}

/** The reply-ack the relay answers on the socket (journal-xk4: a refusal
 * carries ok:false + an `error` naming the channel; an acceptance names the
 * resolved `channel`). */
export interface ReplyAck {
  ok: boolean;
  responseId?: string;
  /** Set when the relay refused (e.g. unknown channel — refused by name). */
  error?: string;
  /** The channel the relay actually resolved and dispatched against. */
  channel?: { id: string; type: string; label: string };
}

interface PendingReply {
  resolve: (value: ReplyAck) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Convert an http(s) relay base URL to the ws(s) /ws endpoint.
 *
 * Deliberately takes no credential: the apiKey belongs in the upgrade request's
 * `Authorization` header (see `wsConnectTarget`), not in a URL that gets logged.
 */
export function toWsUrl(relayUrl: string): string {
  const base = relayUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/ws`;
}

/** How the WebSocket upgrade authenticates. */
export type WsAuthMode = "header" | "query" | "both";

/**
 * `query` is the default for one reason: the deployed relay's `/ws` upgrade handler
 * authenticates from `?token=` and answers 401 "Missing token query parameter"
 * without it, so defaulting to `header` would silently stop push delivery (the
 * 120s safety poll would be the only inbound path) for every existing session.
 *
 * This flips to `header` once the relay reads `Authorization` on the upgrade — the
 * server change is a few lines next to `url.searchParams.get("token")` — and
 * `CHAOS_RELAY_WS_AUTH=header` already gives that behaviour today to anyone whose
 * relay supports it.
 */
export const DEFAULT_WS_AUTH_MODE: WsAuthMode = "query";

export interface WsAuthModeResult {
  mode: WsAuthMode;
  /** Set when the configured value was unusable, so the caller can say so. */
  warning?: string;
}

/**
 * The upgrade auth mode, from `CHAOS_RELAY_WS_AUTH`:
 *
 *   query (default)  — the legacy `?token=<apiKey>`, which is what the relay reads
 *                      today (the key then reaches proxy/access logs)
 *   header           — `Authorization: Bearer <apiKey>`; the key stays out of the URL
 *   both             — send both, for a relay mid-migration
 *
 * Anything else falls back to `header` and returns a warning, so a typo cannot
 * silently disable the protection. Pure given an env object.
 */
export function wsAuthMode(env: { CHAOS_RELAY_WS_AUTH?: string } = process.env): WsAuthModeResult {
  const raw = (env.CHAOS_RELAY_WS_AUTH ?? "").trim().toLowerCase();
  if (raw === "") return { mode: DEFAULT_WS_AUTH_MODE };
  if (raw === "header" || raw === "query" || raw === "both") return { mode: raw };
  return {
    mode: DEFAULT_WS_AUTH_MODE,
    warning: `CHAOS_RELAY_WS_AUTH="${raw}" is not one of header|query|both — using header auth`,
  };
}

/**
 * The runtime's WebSocket constructor as Node implements it: undici accepts an
 * `init` with `headers`, which is what carries the apiKey. The DOM lib types on
 * the global only declare `protocols`, hence the cast at the call site.
 */
type WebSocketWithHeaders = new (
  url: string,
  init?: { headers: Record<string, string> },
) => WebSocket;

/**
 * The auth mode plus what to tell an operator about it, for `status` and `doctor`:
 * which credential carrier is in use, whether that puts the apiKey in the URL, and
 * the way to the safer one.
 */
export function wsAuthSummary(
  env: { CHAOS_RELAY_WS_AUTH?: string } = process.env,
): { mode: WsAuthMode; keyInUrl: boolean; detail: string; fix?: string } {
  const { mode, warning } = wsAuthMode(env);
  const keyInUrl = mode !== "header";
  const detail =
    mode === "header"
      ? "header (Authorization: Bearer — the apiKey is not in the URL)"
      : mode === "both"
        ? "both (header plus the URL query string — the apiKey is still in the URL)"
        : "query (the apiKey travels in the URL query string, so it reaches proxy and access logs)";
  const fix = warning
    ? `CHAOS_RELAY_WS_AUTH is not one of header|query|both — using ${mode}; ${warning}`
    : keyInUrl
      ? "set CHAOS_RELAY_WS_AUTH=header once your relay accepts an upgrade Authorization header"
      : undefined;
  return fix ? { mode, keyInUrl, detail, fix } : { mode, keyInUrl, detail };
}

/** What a WebSocket constructor needs for one connect attempt. */
export interface WsConnectTarget {
  url: string;
  init?: { headers: Record<string, string> };
}

/**
 * The URL and constructor options for one connect attempt. `header` mode yields a
 * URL with no secret in it; `query` (and the query half of `both`) is the only
 * thing that can put the apiKey in the URL, and only because it was asked for.
 */
export function wsConnectTarget(relayUrl: string, apiKey: string, mode: WsAuthMode): WsConnectTarget {
  const base = toWsUrl(relayUrl);
  // `both` keeps the query token for a relay that cannot read upgrade headers yet.
  const url = mode === "header" ? base : `${base}?token=${encodeURIComponent(apiKey)}`;
  const init = mode === "query" ? undefined : { headers: { Authorization: `Bearer ${apiKey}` } };
  return init ? { url, init } : { url };
}

export class RelayWebSocket {
  private opts: RelayWebSocketOptions;
  private apiKey: string;
  /** Warnings are once per instance: a reconnect loop must not flood the log. */
  private warnedQueryToken = false;
  private warnedAuthMode = false;
  private socket: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fires STABLE_UPTIME_MS after a successful open; resets the backoff counter. */
  private stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  /** Consecutive failures where the socket never reached OPEN (auth/handshake). */
  private failedHandshakes = 0;
  private openedSinceAttempt = false;
  private closedByUs = false;
  private triedAuthRecovery = false;
  /** Pending reply acks, keyed by a client-side correlation id. */
  private pending = new Map<string, PendingReply>();
  private replySeq = 0;
  private readonly limitFrameIssue = frameIssueLimiter();

  constructor(opts: RelayWebSocketOptions) {
    this.opts = opts;
    this.apiKey = opts.apiKey;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /**
   * Log a refused or repaired inbound frame, at most a few times per distinct
   * reason: the relay replays a frame the client refused (the cursor cannot move
   * past a message that was never delivered), so an unbounded log line per replay
   * would let one broken frame fill the operator's log file.
   */
  private logFrameIssue(code: string, detail: string): void {
    const line = this.limitFrameIssue(code, detail);
    if (line) this.log(`WARN: ${line}`);
  }

  get connected(): boolean {
    return this.socket?.readyState === 1 /* OPEN */;
  }

  /**
   * Open the socket. Idempotent: while a connection attempt is live
   * (CONNECTING / OPEN / CLOSING) or a reconnect is already armed, a repeated
   * call is a no-op, so one transport can never hold two sockets. `stop()`
   * clears both, so start()-stop()-start() still reconnects.
   */
  start(): void {
    this.closedByUs = false;
    // A reconnect is already pending; let it run instead of racing it with a
    // second socket that would orphan the first one's handlers.
    if (this.reconnectTimer !== undefined) return;
    // A live socket is being established, is open, or is closing. If it is
    // going away, its own onclose schedules the next attempt.
    if (this.socket !== undefined && this.socket.readyState !== 3 /* CLOSED */) {
      return;
    }
    this.connect();
  }

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearStabilityTimer();
    this.clearPing();
    this.rejectPending(new Error("WebSocket closed"));
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /**
   * Reject and clear every in-flight reply. Called on stop() and on an
   * unexpected close so a pending reply can only ever be settled by an ack
   * arriving on the SAME socket it was sent on (acks carry no echo id, so the
   * FIFO correlation is only safe when the pending set is per-socket).
   */
  private rejectPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Say once per instance when the key is (or may be) in the URL. The legacy
   * query form is an explicit opt-in and a mistyped value changes nothing, so
   * neither may be silent.
   */
  private warnAboutAuthMode(mode: WsAuthMode, warning?: string): void {
    if (warning && !this.warnedAuthMode) {
      this.warnedAuthMode = true;
      this.log(`WARN: ${warning}`);
    }
    if (mode !== "header" && !this.warnedQueryToken) {
      // Once per connection lifecycle, not per connect: the point is to tell the
      // operator their key is in the URL, and a reconnecting socket would repeat it
      // for as long as the relay is unreachable.
      this.warnedQueryToken = true;
      this.log(
        `WARN: the WebSocket apiKey is sent in the URL query string ` +
          `(CHAOS_RELAY_WS_AUTH=${mode}); URLs are recorded by proxies, access logs and ` +
          `error strings — set CHAOS_RELAY_WS_AUTH=header once your relay accepts an ` +
          `upgrade Authorization header`,
      );
    }
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = undefined;
  }

  private connect(): void {
    this.openedSinceAttempt = false;
    this.clearStabilityTimer();
    const { mode, warning } = wsAuthMode();
    this.warnAboutAuthMode(mode, warning);
    const target = wsConnectTarget(this.opts.relayUrl, this.apiKey, mode);
    let socket: WebSocket;
    try {
      socket = this.opts.wsFactory
        ? this.opts.wsFactory(target.url, target.init)
        : new (WebSocket as unknown as WebSocketWithHeaders)(target.url, target.init);
    } catch (err) {
      const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
      // A runtime whose WebSocket does not accept a `headers` option rejects the
      // second argument (undici then parses it as `protocols`). Name the way out,
      // so this is not mistaken for a dead apiKey and left in a reconnect loop.
      // Any failure here in header mode is worth the way out: a runtime may reject
      // the init as a bad `protocols` argument (TypeError, or a SyntaxError from the
      // WHATWG constructor), and one that accepts it but ignores `headers` shows up
      // as a failing handshake instead. The fallback is the same in every case.
      const hint =
        mode === "header"
          ? " — if this runtime's WebSocket does not accept a headers option, or the" +
            " relay does not read one, set CHAOS_RELAY_WS_AUTH=query (or both) to use" +
            " the legacy ?token= query form"
          : "";
      this.log(`WebSocket construct failed: ${message}${hint}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      // Ignore a superseded socket (stop()-then-start(), or a late event from a
      // socket a reconnect already replaced): its open must not arm a ping on a
      // dead socket nor reset the live socket's backoff state.
      if (this.socket !== socket) return;
      this.openedSinceAttempt = true;
      this.failedHandshakes = 0;
      this.triedAuthRecovery = false;
      this.log("WebSocket connected (push delivery active)");
      this.startPing();
      // Arm the stability timer: the backoff counter resets ONLY if this socket
      // survives STABLE_UPTIME_MS. Resetting here (at open) is exactly what let
      // an accept-then-drop relay hold the client at a flat 2s reconnect floor.
      this.stabilityTimer = setTimeout(() => {
        this.attempts = 0;
        this.stabilityTimer = undefined;
      }, STABLE_UPTIME_MS);
      if (typeof this.stabilityTimer.unref === "function") {
        this.stabilityTimer.unref();
      }
      // Catch up on anything missed while we were disconnected.
      void this.runCatchUp();
    };

    socket.onmessage = (event: MessageEvent) => {
      // Frames off a superseded socket are dropped: delivery must come from the
      // one current socket, or a superseded one becomes a duplicate path in.
      if (this.socket !== socket) return;
      this.handleFrame(typeof event.data === "string" ? event.data : "");
    };

    socket.onerror = () => {
      // Errors are followed by onclose; reconnection is handled there.
      if (this.socket !== socket) return;
      this.log("WebSocket error");
    };

    socket.onclose = (event: CloseEvent) => {
      // A stale close (the socket was already replaced or stopped) must not
      // reject the CURRENT socket's pending replies, clear its timers, or
      // schedule a reconnect that would orphan it.
      if (this.socket !== socket) return;
      this.clearPing();
      this.clearStabilityTimer();
      // Replies sent on this socket can no longer be acked by it; reject them
      // so a later socket's ack can't settle (and mis-attribute) them.
      this.rejectPending(new Error("WebSocket closed"));
      if (!this.openedSinceAttempt) this.failedHandshakes++;
      if (this.closedByUs) return;
      this.log(
        `WebSocket closed (code=${event.code}); reconnecting` +
          (this.openedSinceAttempt ? "" : " [handshake never opened]"),
      );
      this.scheduleReconnect();
    };
  }

  private async runCatchUp(): Promise<void> {
    if (!this.opts.onCatchUp) return;
    try {
      const missed = await this.opts.onCatchUp();
      if (missed.length > 0) {
        this.log(`catch-up: ${missed.length} message(s) missed while offline`);
        // onMessage dedups and injects into the agent (and logs the delivery).
        this.opts.onMessage(missed);
      }
    } catch (err) {
      const message = redactUrlSecretsFromMessage(
        err instanceof Error ? err.message : String(err),
      );
      this.log(`catch-up poll failed: ${message}`);
    }
  }

  private startPing(): void {
    this.clearPing();
    const interval = this.opts.pingIntervalMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        try {
          this.socket!.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore — close handler will reconnect */
        }
      }
    }, interval);
    if (typeof this.pingTimer.unref === "function") this.pingTimer.unref();
  }

  private handleFrame(raw: string): void {
    if (typeof raw !== "string" || !raw) return;
    // The size bound is checked on the raw bytes, before JSON.parse, so a hostile
    // relay cannot make the client allocate a parse tree for a frame that could
    // never be a channel message.
    const frameBytes = Buffer.byteLength(raw, "utf8");
    if (frameBytes > MAX_INBOUND_FRAME_BYTES) {
      this.logFrameIssue(
        "frame-too-large",
        `dropping relay frame: ${frameBytes} bytes exceeds the ${MAX_INBOUND_FRAME_BYTES} byte limit`,
      );
      return;
    }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      // `JSON.parse` can return any JSON value, but a frame must be a JSON
      // object before we can read its `type`. The literal `null` (and any other
      // non-object: a number, a string, a boolean, an array) must be dropped
      // rather than dereferenced — otherwise `data.type` throws an uncaught
      // TypeError out of the onmessage handler.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.log("dropping non-object relay frame");
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (data.type) {
      case "message": {
        // Shape-checked here as well as in the poller (which also covers the HTTP
        // transport): a pushed frame is the only input that reaches `onMessage`
        // without passing a poll, so nothing malformed should be handed to the
        // extension's delivery path at all.
        //
        // The verdict is all this layer uses. The message is forwarded UNCHANGED
        // and repaired in `MessagePoller.accept`, so the repair — and the single
        // log line for it — happens exactly once, with the original byte counts
        // still in front of it. Repairing here as well re-truncated the marker it
        // had just appended and reported the wrong `from <n> bytes` to the agent.
        const verdict = parseInboundMessage(data.message);
        if (!verdict.ok) {
          this.logFrameIssue(verdict.code, `dropping inbound message frame: ${verdict.detail}`);
          break;
        }
        this.opts.onMessage([data.message as ChannelMessage]);
        break;
      }
      case "reply_ack": {
        // Resolve the oldest pending reply. The relay ack carries no echo id,
        // so correlation is FIFO; that is only safe because rejectPending()
        // clears `pending` on every unexpected close, so the oldest entry here
        // is always a reply sent on THIS socket.
        const first = this.pending.keys().next().value as string | undefined;
        if (first) {
          const p = this.pending.get(first)!;
          clearTimeout(p.timer);
          this.pending.delete(first);
          p.resolve({
            ok: data.ok !== false,
            responseId: data.responseId as string | undefined,
            error: data.error as string | undefined,
            channel: data.channel as { id: string; type: string; label: string } | undefined,
          });
        }
        break;
      }
      case "error": {
        const first = this.pending.keys().next().value as string | undefined;
        if (first) {
          const p = this.pending.get(first)!;
          clearTimeout(p.timer);
          this.pending.delete(first);
          p.reject(new Error(String(data.error ?? "relay error")));
        } else {
          this.log(`relay error frame: ${String(data.error ?? "")}`);
        }
        break;
      }
      case "pong":
        break;
      default:
        break;
    }
  }

  /**
   * Send a reply over the socket. Resolves when the relay acks. Rejects (so the
   * caller can fall back to HTTP) if the socket isn't open or the ack times out.
   */
  reply(
    payload: {
      channelType: string;
      channelId: string;
      content: string;
      replyTo?: string;
      attachments?: {
        filename: string;
        mimeType: string;
        dataBase64: string;
      }[];
      metadata?: Record<string, unknown>;
    },
    ackTimeoutMs = 10_000,
  ): Promise<ReplyAck> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      const id = `r${++this.replySeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("reply ack timed out"));
      }, ackTimeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket!.send(JSON.stringify({ type: "reply", ...payload }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    this.attempts++;
    // If the handshake has failed several times without ever opening, the
    // apiKey is probably dead — try to recover a fresh one once.
    if (
      this.failedHandshakes >= 2 &&
      !this.triedAuthRecovery &&
      this.opts.onAuthFailure
    ) {
      this.triedAuthRecovery = true;
      this.log("handshake failing repeatedly — attempting auth recovery (re-register)");
      void this.opts
        .onAuthFailure()
        .then((newKey) => {
          if (newKey) {
            this.apiKey = newKey;
            this.failedHandshakes = 0;
            this.log("auth recovered — reconnecting with refreshed apiKey");
          }
        })
        .catch((err) =>
          this.log(
            `auth recovery failed: ${redactUrlSecretsFromMessage(
              err instanceof Error ? err.message : String(err),
            )}`,
          ),
        )
        .finally(() => this.armReconnectTimer());
      return;
    }
    this.armReconnectTimer();
  }

  private armReconnectTimer(): void {
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, 1000 * 2 ** Math.min(this.attempts, 5));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // The handle has fired: clear it first so start() no longer sees a
      // pending reconnect and a later start() is judged against the socket.
      this.reconnectTimer = undefined;
      // A start() (or an earlier attempt) may have opened a socket while this
      // timer was pending; connecting now would orphan it.
      if (this.socket !== undefined && this.socket.readyState !== 3 /* CLOSED */) {
        return;
      }
      this.connect();
    }, delay);
    if (typeof (this.reconnectTimer as { unref?: () => void }).unref === "function") {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }

  /** Update the apiKey (e.g. after an external re-register) for the next connect. */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}
