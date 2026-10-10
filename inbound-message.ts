/**
 * Shape and size checks for inbound channel messages.
 *
 * Channel payloads reach the agent over two transports — the WebSocket push
 * (`ws-client.ts`) and the HTTP poll/catch-up (`RelayClient.getMessages`) — and
 * the relay forwards them as-is: a WebSocket frame is not signed and neither
 * transport looked at what it delivered. Everything the agent later reads
 * (`poller.accept`, `consumeApprovalReplies` → `approvals.settle`, the attachment
 * downloader, `formatMessagesForAgent`) assumed its fields were the declared
 * types, so a hostile or broken relay could crash the delivery path (a
 * non-array `attachments` reached `Array.prototype.slice`), poison the persisted
 * resume cursor (a non-ISO `timestamp` is compared as a string), or bury the
 * prompt under an unbounded `content`.
 *
 * Both transports funnel through {@link MessagePoller.accept}, so the field
 * checks live there; `ws-client.ts` additionally bounds the raw frame before it
 * is parsed, because that is the one place the bytes exist as a string.
 *
 * Policy: refuse the whole message when a field would break or corrupt state,
 * and repair-with-a-warning where the message is still deliverable (an oversized
 * body is truncated, extra or malformed attachments are dropped). A refused
 * message is never delivered, and never half-delivered.
 */

import { MAX_CONTROL_PLANE_BYTES } from "./relay-client.ts";
import type { ChannelMessage, InboundAttachment } from "./relay-client.ts";

/** UTF-8 bytes of `content` delivered for one message before it is truncated. */
export const MAX_INBOUND_CONTENT_BYTES = 256 * 1024;

/**
 * Attachments delivered for one message. Shared with the downloader
 * (`inbound-attachments.ts`) so the check here and the slice there cannot drift.
 */
export const MAX_INBOUND_ATTACHMENTS = 3;

/** Longest inbound attachment filename kept; longer ones are truncated for display. */
export const MAX_INBOUND_FILENAME_CHARS = 200;

/**
 * Raw WebSocket frame size. A frame larger than this is dropped before
 * `JSON.parse`, so a hostile relay cannot make the client allocate for a frame
 * that could never be a channel message.
 *
 * Deliberately the SAME number as `MAX_CONTROL_PLANE_BYTES`, the cap the HTTP
 * transport already applies to a whole `/messages` response: a bound the frame
 * path enforced more tightly than the poll path would make the WebSocket refuse
 * (and, once the cursor moves past it, permanently lose) a message the HTTP path
 * would have delivered, truncated by the content cap below.
 */
export const MAX_INBOUND_FRAME_BYTES = MAX_CONTROL_PLANE_BYTES;

/**
 * Channel types this build knows. A field outside the set is accepted (a relay
 * that learns a new channel should not have its messages silently disappear from
 * the agent) but reported, so the log names the case.
 */
export const KNOWN_CHANNEL_TYPES = ["webhook", "telegram", "discord", "email", "slack"] as const;

/**
 * ISO-8601 with an explicit zone — `Z` or an offset, which is what a relay may
 * reason about (`Date.parse` rejects nothing else that would sort by instant).
 *
 * The shape is pinned because the cursor value is handed BACK to the relay as
 * `since` and the relay may compare it as it likes, including as a string against
 * what it stored; a date-like string it never produced is the thing to refuse.
 * On the client side `MessagePoller.accept` compares instants, so fractional
 * seconds and offsets order correctly here.
 */
const ISO_8601_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A parsed problem with an inbound message.
 *
 * `code` is a literal this module owns, so a log limiter can key on it and stay
 * bounded no matter what the relay sends; `detail` is the line to log, which
 * includes clipped (escaped, length-capped) field values for diagnosis.
 */
export interface InboundIssue {
  code: string;
  detail: string;
}

export interface InboundMessageRejection extends InboundIssue {
  ok: false;
}

export interface InboundMessageAcceptance {
  ok: true;
  /** The message to deliver, with repairs applied. */
  message: ChannelMessage;
  /** Repairs and unusual-but-usable fields, each safe to log. */
  warnings: InboundIssue[];
}

/**
 * Echo a value into a log line without control characters and without a length
 * bomb. `JSON.stringify` escapes newlines and quotes, so a relay-chosen id (or
 * channel type) cannot forge a line in the operator's log or push a megabyte of
 * text into it.
 */
function clip(value: unknown): string {
  const json = JSON.stringify(value);
  return (json ?? String(value)).slice(0, 60);
}

/** Refuse, with a stable code and a detail that clips every relay-chosen value. */
function refusal(code: string, detail: string): InboundMessageRejection {
  return { ok: false, code, detail };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Ids arrive as strings, or as numbers for channels that use integer ids. */
function idString(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (text) return text;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The id of a candidate message, if it has a usable one — for callers that must
 * remember a refused message (see `MessagePoller.accept`) without parsing it.
 */
export function inboundMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return idString((value as Record<string, unknown>).id);
}

/**
 * Keep the first `maxBytes` of a UTF-8 string. A code point that straddles the
 * cut is dropped rather than half-rendered, so the delivered text never carries a
 * replacement character where the truncation happened.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk back over continuation bytes (10xxxxxx, at most 3 of them) to the start
  // of the sequence the cut landed in, then drop that sequence if it is short.
  let start = end - 1;
  let steps = 0;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80 && steps < 3) {
    start--;
    steps++;
  }
  if (start >= 0) {
    const lead = bytes[start];
    const expected =
      lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
    if (start + expected > end) end = start;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function parseAttachment(value: unknown): InboundAttachment | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = idString(raw.id);
  const filename = nonEmptyString(raw.filename);
  const mimeType = nonEmptyString(raw.mimeType);
  const declared = raw.size;
  if (!id || !filename || !mimeType) return undefined;
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared < 0) return undefined;
  const kind =
    raw.kind === "image" || raw.kind === "file"
      ? raw.kind
      : mimeType.startsWith("image/")
        ? "image"
        : "file";
  return {
    id,
    filename: filename.slice(0, MAX_INBOUND_FILENAME_CHARS),
    mimeType,
    size: declared,
    kind,
  };
}

/**
 * Validate one inbound message.
 *
 * Refuses (never delivers, `ok: false`): a non-object; an unusable `id`; a
 * missing/non-string `channelId`, `channelType` or `from`; a present but
 * non-string `content`; a present but non-ISO-8601 `timestamp`; `attachments`
 * that is present but not an array; and a message with neither content nor
 * attachments (nothing to deliver).
 *
 * Repairs with a warning (`ok: true`): content over {@link MAX_INBOUND_CONTENT_BYTES}
 * is truncated with a visible marker, extra attachments beyond
 * {@link MAX_INBOUND_ATTACHMENTS} are dropped, malformed attachment entries are
 * dropped, an oversized filename is truncated, a non-object `metadata` is dropped,
 * and an unknown `channelType` is kept.
 */
export function parseInboundMessage(
  value: unknown,
): InboundMessageAcceptance | InboundMessageRejection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refusal("not-an-object", "message is not a JSON object");
  }
  const raw = value as Record<string, unknown>;

  const id = idString(raw.id);
  if (!id) return refusal("id-unusable", "message has no usable id");
  // Every value the relay chose is clipped before it reaches a log line: an id
  // with a newline in it would otherwise forge a line, and an id is unbounded.
  const where = `message ${clip(id)}`;

  const channelId = nonEmptyString(raw.channelId);
  if (!channelId) return refusal("channel-id-missing", `${where} has no channelId`);
  const from = nonEmptyString(raw.from);
  if (!from) return refusal("from-missing", `${where} has no from`);
  const channelType = nonEmptyString(raw.channelType);
  if (!channelType) return refusal("channel-type-missing", `${where} has no channelType`);

  const warnings: InboundIssue[] = [];
  if (!(KNOWN_CHANNEL_TYPES as readonly string[]).includes(channelType)) {
    warnings.push({
      code: "channel-type-unknown",
      detail: `${where}: channelType ${clip(channelType)} is not a known channel type`,
    });
  }

  let content: string;
  if (raw.content === undefined || raw.content === null) content = "";
  else if (typeof raw.content === "string") content = raw.content;
  else return refusal("content-not-string", `${where}: content is not a string`);

  // A MISSING timestamp is delivered: it cannot move the resume cursor (which is
  // only advanced by the ISO-8601 value checked below), so it is safe, and it is
  // the pre-existing behaviour for a channel that does not stamp its messages.
  // A PRESENT timestamp that is not ISO-8601 with a zone is refused, because the
  // value is stored verbatim and sent back to the relay as `since`: a shape the
  // relay never produced could be compared wrongly on its side and skip backlog.
  const rawTimestamp = raw.timestamp;
  const timestampAbsent =
    rawTimestamp === undefined ||
    rawTimestamp === null ||
    (typeof rawTimestamp === "string" && rawTimestamp.trim() === "");
  let timestamp = "";
  if (!timestampAbsent) {
    if (
      typeof rawTimestamp !== "string" ||
      !ISO_8601_WITH_ZONE_RE.test(rawTimestamp) ||
      !Number.isFinite(Date.parse(rawTimestamp))
    ) {
      return refusal(
        "timestamp-not-iso",
        `${where}: timestamp is not an ISO-8601 timestamp`,
      );
    }
    timestamp = rawTimestamp;
  } else {
    warnings.push({
      code: "timestamp-missing",
      detail: `${where} has no timestamp; it is delivered but cannot advance the resume cursor`,
    });
  }

  /** Repair notes for the delivered content (never truncated away: appended last). */
  const notes: string[] = [];
  let attachments: InboundAttachment[] = [];
  if (raw.attachments !== undefined && raw.attachments !== null) {
    if (!Array.isArray(raw.attachments)) {
      return refusal("attachments-not-array", `${where}: attachments is not an array`);
    }
    const usable: InboundAttachment[] = [];
    let unusable = 0;
    for (const entry of raw.attachments) {
      const attachment = parseAttachment(entry);
      if (attachment) usable.push(attachment);
      else unusable++;
    }
    if (unusable > 0) {
      warnings.push({
        code: "attachment-malformed",
        detail: `${where}: dropped ${unusable} malformed attachment entr${unusable === 1 ? "y" : "ies"}`,
      });
      // Say it in the delivered content too: the agent used to get an
      // "Attachment unavailable" note for these, and a repair the agent cannot
      // see is a repair it cannot ask the operator about.
      notes.push(`${unusable} attachment${unusable === 1 ? "" : "s"} not delivered (unusable)`);
    }
    if (usable.length > MAX_INBOUND_ATTACHMENTS) {
      const dropped = usable.length - MAX_INBOUND_ATTACHMENTS;
      warnings.push({
        code: "attachments-truncated",
        detail: `${where}: ${usable.length} attachments, keeping the first ${MAX_INBOUND_ATTACHMENTS}`,
      });
      notes.push(`${dropped} attachment${dropped === 1 ? "" : "s"} not delivered (over the limit)`);
      attachments = usable.slice(0, MAX_INBOUND_ATTACHMENTS);
    } else {
      attachments = usable;
    }
  }

  // Nothing to deliver only when there is genuinely nothing: a message whose sole
  // attachment was unusable still carries a note the operator can act on.
  if (!content && attachments.length === 0 && notes.length === 0) {
    return refusal("empty-message", `${where} carries neither content nor attachments`);
  }

  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_INBOUND_CONTENT_BYTES) {
    warnings.push({
      code: "content-truncated",
      detail: `${where}: content truncated to ${MAX_INBOUND_CONTENT_BYTES} bytes (from ${contentBytes})`,
    });
    content =
      truncateUtf8(content, MAX_INBOUND_CONTENT_BYTES) +
      `\n\n[chaos-relay: content truncated at ${MAX_INBOUND_CONTENT_BYTES} bytes, from ${contentBytes} bytes]`;
  }
  // Delivered last so truncation cannot cut a note away.
  if (notes.length > 0) content = `${content}\n\n[chaos-relay: ${notes.join("; ")}]`;

  const message: ChannelMessage = {
    id,
    // Validated as a non-empty string; the union is narrower on purpose so the
    // type system still describes what the relay is expected to send.
    channelType: channelType as ChannelMessage["channelType"],
    channelId,
    from,
    content,
    timestamp,
  };
  if (attachments.length > 0) message.attachments = attachments;
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
      message.metadata = raw.metadata as Record<string, unknown>;
    } else {
      warnings.push({
        code: "metadata-not-object",
        detail: `${where}: dropped a non-object metadata field`,
      });
    }
  }
  // Reply context is read through `resolveReplyTo`, which accepts several
  // spellings; carry whichever the relay sent without interpreting them here.
  for (const key of ["replyTo", "reply_to", "replyToMessage", "reply_to_message"]) {
    if (raw[key] !== undefined) (message as unknown as Record<string, unknown>)[key] = raw[key];
  }

  return { ok: true, message, warnings };
}

/**
 * Bound how often each KIND of problem is logged.
 *
 * A relay (or a plaintext one being tampered with) can replay one malformed
 * frame forever, and the log is a file on the operator's disk. The first
 * {@link max} occurrences of each {@link InboundIssue.code} are reported, the
 * next says the rest will be silent, and after that the code is suppressed — so
 * the first occurrence is never hidden, and neither the line count nor the size
 * of the counter map can grow with what the relay sends.
 *
 * Keying on the code rather than the message is the point: the detail text
 * carries the relay's id and byte counts, so keying on it would be unbounded
 * (and would make every oversized frame a fresh key). The code set is the finite
 * list of literals this module and `ws-client`/`poller` use, which
 * `test/inbound-message.test.ts` pins.
 */
export function frameIssueLimiter(
  max = 3,
): (code: string, detail: string) => string | undefined {
  const seen = new Map<string, number>();
  return (code, detail) => {
    const count = (seen.get(code) ?? 0) + 1;
    seen.set(code, count);
    if (count <= max) return detail;
    if (count === max + 1) {
      // `code` is a literal slug this module owns, never relay text, so it is
      // safe (and readable) to quote directly.
      return `${detail} (further "${code}" occurrences are not logged)`;
    }
    return undefined;
  };
}
