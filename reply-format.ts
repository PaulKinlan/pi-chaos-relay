// reply-format.ts — the honesty layer for relay_reply confirmations.
//
// A confirmation must say what the relay OBSERVED, not replay what the agent
// REQUESTED. The server (journal-xk4) resolves the reply against the
// session's registered channels and returns `channel: {id, type, label}`;
// when it does, we quote that. When an older relay returns nothing we can
// verify against, the confirmation must SAY SO rather than echo the requested
// id as if it were a delivery receipt — a mechanism that cannot do its job
// has to announce it (the weaker version of a guard is more dangerous than
// its absence, because its absence is visible).

export interface ReplyAckLike {
  ok?: boolean;
  responseId?: string;
  /** Set on a refusal (ok:false): the relay's reason, naming the channel. */
  error?: string;
  /** The channel the relay resolved and dispatched against (newer servers). */
  channel?: { id: string; type: string; label: string };
  /** Legacy echo fields some older servers returned for push channels. */
  channelType?: string;
  channelId?: string;
}

/**
 * Build the user-facing confirmation for a reply the relay ACCEPTED.
 * `transport` names the path the ack arrived on ("WebSocket" | "HTTP").
 */
export function formatReplyConfirmation(
  ack: ReplyAckLike,
  requested: { channelType: string; channelId: string },
  transport: string,
): string {
  if (ack.channel) {
    const stored = ack.responseId ? ` Stored as response ${ack.responseId}.` : "";
    return (
      `Reply dispatched by relay to ${ack.channel.type} channel ` +
      `"${ack.channel.label}" (${ack.channel.id}) via ${transport}.` +
      ` Delivery to the channel itself (Telegram API, SMTP, ...)` +
      ` happens server-side and is logged there.${stored}`
    );
  }
  if (ack.channelType || ack.channelId) {
    // Fields came from the relay, but without the resolved-channel shape;
    // still the relay's own words, so quote them and flag the gap.
    const stored = ack.responseId ? ` Stored as response ${ack.responseId}.` : "";
    return (
      `Reply accepted by relay for ${ack.channelType ?? requested.channelType} channel ` +
      `${ack.channelId ?? requested.channelId} via ${transport}.` +
      ` NOTE: this relay did not return the resolved channel identity —` +
      ` the confirmation uses the channel fields the relay echoed.${stored}`
    );
  }
  const stored = ack.responseId ? ` Stored as response ${ack.responseId}.` : "";
  return (
    `Reply accepted by relay for ${requested.channelType} channel ` +
    `${requested.channelId} via ${transport}.` +
    ` WARNING: this relay named no dispatched channel — this confirmation` +
    ` only echoes the requested id and is NOT proof of delivery.${stored}`
  );
}

/**
 * Build the user-facing text for a reply the relay REFUSED (ok:false).
 * The relay's reason names the offending channel; carry it verbatim.
 */
export function formatReplyRefusal(ack: ReplyAckLike): string {
  return (
    `relay_reply: REFUSED by relay — ${ack.error ?? "no reason given"}.` +
    ` Nothing was sent.`
  );
}
