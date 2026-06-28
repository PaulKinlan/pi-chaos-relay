/**
 * Inbound message poller.
 *
 * Wraps RelayClient.getMessages, tracking the `since` cursor returned by the
 * relay and de-duplicating by message id so the same message is never surfaced
 * twice. Used both by the background poller (session lifecycle) and the
 * `relay_check_messages` tool — they share one cursor via this instance.
 */

import type { ChannelMessage, RelayClient } from "./relay-client.ts";

const SEEN_MAX = 1000; // hard cap before trimming
const SEEN_KEEP = 500; // how many to retain when trimming

export class MessagePoller {
  private since: string | undefined;
  private seen: Set<string>;
  private readonly client: RelayClient;
  private readonly onAdvance?: (since: string) => void;
  private readonly onSeen?: (ids: string[]) => void;

  constructor(
    client: RelayClient,
    opts: {
      since?: string;
      onAdvance?: (since: string) => void;
      /** Previously-seen message ids, persisted so dedup survives a restart. */
      seen?: string[];
      /** Persist the (capped) seen-id list whenever it grows. */
      onSeen?: (ids: string[]) => void;
    } = {},
  ) {
    this.client = client;
    // Resume from a persisted cursor so a restart doesn't re-read the backlog.
    this.since = opts.since;
    this.onAdvance = opts.onAdvance;
    // Restore the persisted de-dup log so the relay's on-connect replay and any
    // catch-up poll don't re-process messages already delivered before restart.
    this.seen = new Set(opts.seen ?? []);
    this.onSeen = opts.onSeen;
  }

  /** The current resume cursor (ISO timestamp), or undefined if none yet. */
  get cursor(): string | undefined {
    return this.since;
  }

  /** Reset the in-memory dedup set. Does NOT clear the persisted cursor or
   * seen-id log — those survive across sessions so old messages aren't
   * re-delivered. (A freshly constructed poller reloads `seen` from disk, so
   * dropping the in-memory copy here is safe.) */
  reset(): void {
    this.seen.clear();
  }

  /**
   * Fetch messages since the cursor and advance it, but do NOT mark them seen.
   * De-duplication is left to a single downstream {@link accept} call so a
   * delivery path never dedups twice. The WebSocket catch-up uses this and then
   * routes the result through `onMessage` (which calls `accept`) — if catch-up
   * used {@link poll} instead, `accept` would run twice and silently drop every
   * caught-up message as an already-seen "duplicate".
   */
  async pollRaw(): Promise<ChannelMessage[]> {
    const result = await this.client.getMessages(this.since);
    // NOTE: the cursor is advanced in accept() from delivered message
    // timestamps, NOT from the server's response cursor — that way messages
    // delivered via WebSocket push (which never hit pollRaw) also advance it,
    // so a restart resumes correctly.
    return result.messages ?? [];
  }

  /**
   * Fetch any new messages since the last poll. Returns only messages not
   * previously returned by this poller instance (dedups + advances the cursor).
   * For callers that deliver the result directly (safety poll, on-demand tool).
   */
  async poll(): Promise<ChannelMessage[]> {
    return this.accept(await this.pollRaw());
  }

  /**
   * Filter a batch of messages (e.g. pushed over the WebSocket) through the
   * same de-dup set, so a message delivered by push and then again by a
   * catch-up poll is only surfaced once. Returns the fresh ones.
   */
  accept(messages: ChannelMessage[]): ChannelMessage[] {
    const fresh: ChannelMessage[] = [];
    let advanced = false;
    for (const msg of messages) {
      if (!msg?.id || this.seen.has(msg.id)) continue;
      this.seen.add(msg.id);
      fresh.push(msg);
      // Advance the resume cursor to the latest delivered timestamp. ISO-8601
      // strings compare chronologically, so a string compare is sufficient.
      if (msg.timestamp && (!this.since || msg.timestamp > this.since)) {
        this.since = msg.timestamp;
        advanced = true;
      }
    }
    // Keep the dedup set from growing without bound.
    if (this.seen.size > SEEN_MAX) {
      const keep = Array.from(this.seen).slice(-SEEN_KEEP);
      this.seen = new Set(keep);
    }
    if (advanced && this.since) this.onAdvance?.(this.since);
    // Persist the de-dup log when it changed, so a restart won't re-process
    // anything the relay replays on the next WebSocket connect.
    if (fresh.length > 0) this.onSeen?.(Array.from(this.seen));
    return fresh;
  }
}

/** Format a batch of channel messages for injection into the pi agent. */
export function formatMessagesForAgent(messages: ChannelMessage[]): string {
  if (messages.length === 0) return "No new messages from chaos-relay.";
  const lines: string[] = [
    `You have ${messages.length} new message(s) from chaos-relay. ` +
      `Reply via the relay_reply tool (pass back channelType, channelId, and the message id as replyTo).`,
    "",
  ];
  for (const m of messages) {
    lines.push(
      `--- message id=${m.id} channel=${m.channelType} channelId=${m.channelId} from="${m.from}" at=${m.timestamp} ---`,
    );
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}
