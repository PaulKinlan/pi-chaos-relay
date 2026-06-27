/**
 * WebSocket transport for the CHAOS relay.
 *
 * The relay pushes inbound messages over a WebSocket (it runs a Deno KV watch
 * per connection and sends `{type:"message", message}` as soon as one arrives),
 * and accepts replies on the same socket (`{type:"reply", ...}` ->
 * `{type:"reply_ack"}`). This replaces 15s HTTP polling with near-instant push.
 *
 * Auth: the relay authenticates the socket from the `token` query param (the
 * Bearer apiKey) — the upgrade handshake is not ECDSA-signed, so the WS only
 * needs the apiKey. (Registration + HTTP catch-up still use the signed client.)
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
 */

import type { ChannelMessage } from "./relay-client.ts";

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
  /** Override the WebSocket constructor (tests). Defaults to global WebSocket. */
  wsFactory?: (url: string) => WebSocket;
  /** Keepalive ping interval. Default 30s. */
  pingIntervalMs?: number;
  /** Max reconnect backoff. Default 30s. */
  maxBackoffMs?: number;
}

interface PendingReply {
  resolve: (value: { ok: boolean; responseId?: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Convert an http(s) relay base URL to the ws(s) /ws endpoint with token. */
export function toWsUrl(relayUrl: string, apiKey: string): string {
  const base = relayUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/ws?token=${encodeURIComponent(apiKey)}`;
}

export class RelayWebSocket {
  private opts: RelayWebSocketOptions;
  private apiKey: string;
  private socket: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  /** Consecutive failures where the socket never reached OPEN (auth/handshake). */
  private failedHandshakes = 0;
  private openedSinceAttempt = false;
  private closedByUs = false;
  private triedAuthRecovery = false;
  /** Pending reply acks, keyed by a client-side correlation id. */
  private pending = new Map<string, PendingReply>();
  private replySeq = 0;

  constructor(opts: RelayWebSocketOptions) {
    this.opts = opts;
    this.apiKey = opts.apiKey;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get connected(): boolean {
    return this.socket?.readyState === 1 /* OPEN */;
  }

  /** Open the socket (idempotent). */
  start(): void {
    this.closedByUs = false;
    this.connect();
  }

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearPing();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();
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

  private connect(): void {
    this.openedSinceAttempt = false;
    const url = toWsUrl(this.opts.relayUrl, this.apiKey);
    let socket: WebSocket;
    try {
      socket = this.opts.wsFactory
        ? this.opts.wsFactory(url)
        : new WebSocket(url);
    } catch (err) {
      this.log(`WebSocket construct failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.openedSinceAttempt = true;
      this.attempts = 0;
      this.failedHandshakes = 0;
      this.triedAuthRecovery = false;
      this.log("WebSocket connected (push delivery active)");
      this.startPing();
      // Catch up on anything missed while we were disconnected.
      void this.runCatchUp();
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleFrame(typeof event.data === "string" ? event.data : "");
    };

    socket.onerror = () => {
      // Errors are followed by onclose; reconnection is handled there.
      this.log("WebSocket error");
    };

    socket.onclose = (event: CloseEvent) => {
      this.clearPing();
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
      this.log(`catch-up poll failed: ${(err as Error).message}`);
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
    if (!raw) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    switch (data.type) {
      case "message": {
        const msg = data.message as ChannelMessage | undefined;
        if (msg && msg.id) this.opts.onMessage([msg]);
        break;
      }
      case "reply_ack": {
        // Resolve the oldest pending reply (the relay ack carries no echo id).
        const first = this.pending.keys().next().value as string | undefined;
        if (first) {
          const p = this.pending.get(first)!;
          clearTimeout(p.timer);
          this.pending.delete(first);
          p.resolve({ ok: data.ok !== false, responseId: data.responseId as string | undefined });
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
      metadata?: Record<string, unknown>;
    },
    ackTimeoutMs = 10_000,
  ): Promise<{ ok: boolean; responseId?: string }> {
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
        .catch((err) => this.log(`auth recovery failed: ${(err as Error).message}`))
        .finally(() => this.armReconnectTimer());
      return;
    }
    this.armReconnectTimer();
  }

  private armReconnectTimer(): void {
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, 1000 * 2 ** Math.min(this.attempts, 5));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (typeof (this.reconnectTimer as { unref?: () => void }).unref === "function") {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }

  /** Update the apiKey (e.g. after an external re-register) for the next connect. */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}
