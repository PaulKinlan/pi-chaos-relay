/**
 * Inbound message poller.
 *
 * Wraps RelayClient.getMessages, tracking the `since` cursor returned by the
 * relay and de-duplicating by message id so the same message is never surfaced
 * twice. Used both by the background poller (session lifecycle) and the
 * `relay_check_messages` tool — they share one cursor via this instance.
 */

import type { ChannelMessage, RelayClient } from "./relay-client.ts";

export class MessagePoller {
  private since: string | undefined;
  private readonly seen = new Set<string>();
  private readonly client: RelayClient;

  constructor(client: RelayClient) {
    this.client = client;
  }

  /** Reset cursor/dedup state (e.g. between sessions). */
  reset(): void {
    this.since = undefined;
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
    this.since = result.since ?? this.since;
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
    for (const msg of messages) {
      if (!msg?.id || this.seen.has(msg.id)) continue;
      this.seen.add(msg.id);
      fresh.push(msg);
    }
    // Keep the dedup set from growing without bound.
    if (this.seen.size > 1000) {
      const keep = Array.from(this.seen).slice(-500);
      this.seen.clear();
      for (const id of keep) this.seen.add(id);
    }
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
