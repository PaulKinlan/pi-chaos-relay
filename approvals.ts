/**
 * Approvals — the outstanding-request queue and the payload-safe summary of the
 * tool call a human is being asked to approve.
 *
 * Extracted from index.ts (bead pi-chaos-relay-eg1, ADR pi-chaos-relay-hu4).
 * index.ts keeps the policy and the plumbing (when a turn is gated, how the
 * question is delivered, what an answer does, the session state); this module
 * owns the parts that must be provably correct on their own:
 *
 *   - ApprovalQueue: one entry per request, each with its own id, timer and
 *     resolver, so one request timing out or being answered cannot resolve
 *     another. An answer counts only when it names the request — by nonce or by
 *     `#ref` — AND arrives on the channel and from the sender it was asked on.
 *     A bare `yes` is never consent.
 *   - summarizeToolCall: the one line shown in the approval question, which is
 *     sent TO the channel driving the turn. It must never echo a value that
 *     could be a secret: commands are redacted, values are described by shape,
 *     fingerprint and size, and paths are shown relative or by basename.
 *
 * Neither this module nor profile-lock.ts may import index.ts or register pi
 * hooks: they are leaves, so they can be owned and tested independently.
 */
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { stripInboundRepairNotes } from "./inbound-message.ts";
import { parseConnectInput } from "./connect.ts";
import { redactCommandSecrets } from "./url-redact.ts";

/**
 * Short, non-identifying fingerprint for correlating a channel across durable
 * log lines without recording its raw identifier (which a co-tenant on a
 * shared host could read back out of a world-readable log).
 */
export function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** One outstanding tool-approval request. */
export interface PendingApprovalEntry {
  /** Short human-facing reference, shown to the user as `#<ref>`. */
  ref: number;
  channelId: string;
  /** Sender of the message that triggered the gated turn. Only this sender can
   *  answer; a different participant's message is not consumed. */
  from: string;
  toolName: string;
  /** Unguessable token the user must echo back, shown in the prompt. */
  nonce: string;
}

/**
 * Outstanding tool-approval requests, one entry each.
 *
 * Replaces the single global `pendingApproval` slot, whose failure modes were:
 * a second gated tool call overwrote the first (the first was then un-resolvable),
 * any entry's timeout resolved whichever promise the slot happened to hold and
 * could wipe an unrelated second request (leaving it to hang forever), and a
 * reply resolved whatever entry occupied the slot rather than the one asked
 * about — so two concurrent gated calls could cross-resolve or lose one.
 *
 * Each request now owns its id, timer and resolver. A reply resolves the
 * request it names — by nonce (`yes <nonce>`) or by reference (`#2: yes`) — and
 * only when it comes from the channel AND sender the request was asked on. An
 * unaddressed reply (a bare `yes`/`ok`) is never consent: it is forwarded to the
 * agent like any other message, as is a reference that names no request still
 * outstanding for that sender. Timers are independent: one request timing out
 * denies only itself.
 */
export class ApprovalQueue {
  private readonly pending = new Map<string, {
    entry: PendingApprovalEntry;
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private seq = 0;
  // Declared and assigned explicitly: node runs this file in strip-only
  // TypeScript mode, which does not support constructor parameter properties.
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(timeoutMs: number, log: (message: string) => void = () => {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  /** Number of requests still awaiting an answer. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Register a request and return the promise the tool call awaits, its
   * user-facing `ref`, and a `cancel` for the caller's own failure path (e.g.
   * the question could not be sent).
   */
  add(opts: { channelId: string; from: string; toolName: string }): {
    ref: number;
    nonce: string;
    promise: Promise<boolean>;
    cancel: () => void;
  } {
    const ref = ++this.seq;
    const nonce = randomBytes(6).toString("hex");
    const id = `${opts.channelId}#${ref}`;
    const entry: PendingApprovalEntry = {
      ref,
      channelId: opts.channelId,
      from: opts.from,
      toolName: opts.toolName,
      nonce,
    };
    let settle!: (approved: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      // Time out ONLY this request; another's answer cannot satisfy it, and its
      // timeout cannot touch another request.
      if (!this.pending.delete(id)) return;
      this.log(`approval: request #${ref} (${opts.toolName}) timed out → denied`);
      settle(false);
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    this.pending.set(id, { entry, resolve: settle, timer });
    return {
      ref,
      nonce,
      promise,
      cancel: () => {
        const held = this.pending.get(id);
        if (!held) return;
        clearTimeout(held.timer);
        this.pending.delete(id);
      },
    };
  }

  /**
   * Try to consume `message` as an answer to an outstanding request. Returns
   * true when the message was consumed (so the caller does not forward it to
   * the agent), false when it answers nothing pending here.
   */
  settle(message: { channelId: string; from: string; content: string }): boolean {
    if (this.pending.size === 0) return false;
    // Two accepted answer forms, and both must keep working:
    //  (1) the nonce form — "yes <nonce>" / "no <nonce>" — which binds the answer
    //      to one exact request AND to the channel and sender it was asked on, so
    //      a bare yes/no from anywhere is never consent;
    //  (2) the reference form — "#2: yes", "#2 - yes", "#2, no" — punctuation
    //      tolerated (the original /^\s*#(\d+)\b/ read "#2: yes" as a denial),
    //      resolved against the request that reference names on this channel, and
    //      also bound to the sender who was asked.
    // Match against the SENDER'S text, not against the delivered content: this
    // module's repair notes (bead 4rr) are appended after it, and the nonce form
    // below is end-anchored, so a reply that itself carried an unusable
    // attachment used to stop matching and the request timed out as a denial
    // (bead pi-chaos-relay-cmo).
    const answerText = stripInboundRepairNotes(message.content);
    const answer = /^\s*(yes|no)\s+([0-9a-f]+)[.!]?\s*$/i.exec(answerText);
    if (answer) {
      const nonce = answer[2].toLowerCase();
      for (const [key, held] of this.pending) {
        if (
          held.entry.nonce === nonce &&
          held.entry.channelId === message.channelId &&
          held.entry.from === message.from
        ) {
          clearTimeout(held.timer);
          this.pending.delete(key);
          const approved = answer[1].toLowerCase() === "yes";
          this.log(
            `approval: reply "${message.content.slice(0, 24)}" → #${held.entry.ref} ` +
              `${approved ? "approved" : "denied"}`,
          );
          held.resolve(approved);
          return true;
        }
      }
      // The nonce names no pending request from this sender on this channel
      // (stale, wrong sender, or wrong channel): leave it for the agent — a
      // non-answer never counts as consent.
      return false;
    }
    // The reference may be followed by punctuation rather than a bare space —
    // "#2: yes", "#2 - yes", "#2, no" are all answers. Requiring whitespace
    // only (the original /^\s*#(\d+)\b/) sent the remainder ": yes" to the
    // yes/no test, which read it as a denial: a real footgun for anyone who
    // punctuates naturally.
    const addressed = /^\s*#(\d+)\s*[:\-–—,]?\s*/.exec(message.content);
    let id: string | undefined;
    let body = message.content;
    if (addressed) {
      const ref = Number(addressed[1]);
      // An addressed reply wins only if that request is outstanding on this
      // channel for this sender; otherwise it is consumed (the user meant to
      // answer something) but resolves nothing, and the request keeps waiting
      // for its own answer.
      for (const [key, held] of this.pending) {
        if (
          held.entry.ref === ref &&
          held.entry.channelId === message.channelId &&
          held.entry.from === message.from
        ) {
          id = key;
          break;
        }
      }
      body = answerText.slice(addressed[0].length);
      if (id === undefined) {
        // Names a request that is not outstanding HERE for this sender (stale,
        // another channel, or another sender's request): not an answer, so
        // forward it rather than swallowing somebody else's message.
        this.log(`approval: reply addresses #${ref}, which is not pending for this sender on this channel — forwarded`);
        return false;
      }
    } else {
      // Unaddressed ("yes", "ok", "do it", a stray nonce): NEVER consent. Only an
      // answer that names the request — its nonce or its "#N" reference — is tied
      // to a specific outstanding question, so a bare yes/no is forwarded to the
      // agent like any other message.
      return false;
    }
    const held = this.pending.get(id)!;
    const approved = /^\s*(y|yes|yep|ok|okay|approve|allow|sure|do it)\b/i.test(body);
    clearTimeout(held.timer);
    this.pending.delete(id);
    this.log(
      `approval: reply "${message.content.slice(0, 24)}" → #${held.entry.ref} ` +
        `${approved ? "approved" : "denied"}`,
    );
    held.resolve(approved);
    return true;
  }
}

/** One-line description of a gated tool call for the approval question. The
 * question is sent TO the channel driving the turn, so it must never echo a
 * raw secret value: a gated `relay_reply`/`write`/`edit`/`bash` can carry
 * local file contents (or other secrets) the agent inspected earlier, and
 * echoing them would ship the secret out before anyone approved. Field names
 * (path, content, command, …) are not secret; their VALUES are — so the
 * summary shows enough to judge the call (the command, the target path, the
 * size) while withholding the secret-bearing contents. */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "relay_reply") {
    // Payload-free: channel + body size, plus attachment NAMES and SIZES only.
    // The reply body can carry local file contents, so it is NEVER echoed back
    // to the channel. An attachment path is metadata, not content (write/edit
    // summaries show paths too) — and the operator needs it: `2 attachment(s)`
    // is indistinguishable from shipping ~/.ssh/id_rsa.
    const channelType = typeof input.channelType === "string" ? input.channelType : "?";
    const channelId = typeof input.channelId === "string" ? input.channelId : "";
    const content = typeof input.content === "string" ? input.content : "";
    const files = Array.isArray(input.files)
      ? input.files.filter((f): f is string => typeof f === "string")
      : [];
    const parts: Array<string | null> = [
      `channel ${channelType}`,
      channelId ? `#${shortId(channelId)}` : null,
      `${content.length} chars / ${Buffer.byteLength(content, "utf8")} bytes`,
    ];
    if (files.length > 0) {
      // One entry per file so a sensitive name cannot hide behind a count.
      parts.push(`${files.length} attachment(s): ${files.map(describeAttachment).join(", ")}`);
    }
    return `relay_reply: ${parts.filter((p): p is string => p !== null).join(", ")}`;
  }
  if (toolName === "bash") {
    // Show the command (redacted of secret-shaped values) so the operator can
    // judge benign vs destructive, but never the secrets embedded in it.
    const command = typeof input.command === "string" ? input.command : "";
    const redacted = redactCommandSecrets(command);
    return `bash: ${truncateForDisplay(redacted)}`;
  }
  if (toolName === "write" || toolName === "edit") {
    const path = typeof input.path === "string" ? input.path : "";
    const target = path ? summarizePath(path) : "?";
    if (toolName === "write") {
      const content = typeof input.content === "string" ? input.content : "";
      return `write: ${target} (${Buffer.byteLength(content, "utf8")} bytes)`;
    }
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let bytes = 0;
    for (const e of edits) {
      const edit = e as { oldText?: unknown; newText?: unknown };
      if (typeof edit.oldText === "string") bytes += Buffer.byteLength(edit.oldText, "utf8");
      if (typeof edit.newText === "string") bytes += Buffer.byteLength(edit.newText, "utf8");
    }
    return `edit: ${target} (${edits.length} edit(s), ${bytes} bytes)`;
  }
  if (CONTROL_PLANE_RELAY_TOOLS.has(toolName)) {
    return `${toolName}: ${summarizeControlPlaneInput(input)}`;
  }
  // Any other gated tool: never echo raw values, only shapes.
  const entries = Object.entries(input ?? {});  const parts = entries.map(([key, value]) => {
    if ((key === "path" || key === "file_path") && typeof value === "string") {
      return `${key}=${summarizePath(value)}`;
    }
    if (typeof value === "string") return `${key}:${value.length} chars`;
    if (Array.isArray(value)) return `${key}:${value.length} item(s)`;
    if (value === null || value === undefined) return key;
    return `${key}:object`;
  });
  return `${toolName}${parts.length ? ": " + parts.join(", ") : ""}`;
}

/**
 * Control-plane relay tools (gated in "writes" mode, always gated in "all").
 * The approval question must name the TARGET or the human cannot judge it: an
 * injected `relay_switch_profile` summarised as `name:9 chars` is unanswerable.
 */
const CONTROL_PLANE_RELAY_TOOLS = new Set([
  "relay_connect",
  "relay_register_telegram",
  "relay_register_discord",
  "relay_register_email",
  "relay_register_webhook",
  "relay_switch_profile",
]);

/**
 * The extra paragraph the approval question carries for a control-plane call.
 * A control-plane target is shown as a fingerprint rather than as caller-chosen
 * text (see summarizeTargetShape), so the operator's judgement is "did I ask for
 * this?" rather than "does this name look right?" — say so in the question.
 * Empty for an ordinary tool call.
 */
export function controlPlaneApprovalHint(toolName: string): string {
  return CONTROL_PLANE_RELAY_TOOLS.has(toolName)
    ? "\n\nThis changes where this session connects or who can drive it. " +
        "The target is shown as a fingerprint; deny it if you did not ask for it."
    : "";
}

/** Literal labels for the credential-bearing inputs the relay tools take. Only
 *  these literals are ever printed: an unknown KEY is agent-controlled text too
 *  (a tool schema can be probed with extra properties), so an unrecognised key
 *  is counted, never named. Values of these fields are shown as a length. */
const CREDENTIAL_FIELD_LABELS = new Set([
  "botToken",
  "token",
  "password",
  "secret",
  "apiKey",
  "webhookUrl",
  "signingKey",
]);

/** Channel kinds the relay knows; anything else is shown as a shape, because a
 *  free-text "type" is caller-controlled text like any other. */
const KNOWN_CHANNEL_TYPES = new Set(["telegram", "discord", "email", "webhook"]);

/**
 * A caller-chosen target (profile name, channel name, webhook name) rendered as
 * a SHAPE: an 8-hex fingerprint of the value plus its length.
 *
 * The value is NOT echoed, and redaction is not enough to make echoing it safe:
 * `relay_switch_profile {name: "correct horse battery staple"}` — or a 20-char
 * mixed-case secret — survives every shape-based rule, so a channel-borne "read
 * the credentials file, then switch to a profile named <its contents>" would
 * put those contents in the question sent to that same channel before anyone
 * approved. The fingerprint still lets an operator compare two questions about
 * the same target; the exact value is visible locally (the profile list, the
 * bash/TUI), never over the relay.
 */
function summarizeTargetShape(value: string): string {
  return `fp:${shortId(value)}, ${value.length} chars`;
}

/**
 * A bounded one-line rendering for the few caller-supplied values that ARE the
 * decision (an email address: it is the routing target a verification link goes
 * to, so hiding it hides the register-your-own-mailbox takeover this gate is for)
 * or that the tool's own parser produced (a channel KIND). Whitespace and
 * control characters collapse so a crafted value cannot fake question layout,
 * secret-shaped values are redacted, and the result is capped.
 */
function summarizeShownValue(value: string, max = 60): string {
  const oneLine = value.replace(/[\s\p{C}]+/gu, " ").trim();
  const redacted = redactCommandSecrets(oneLine);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}… (${redacted.length} chars total)`;
}

/** The numeric bot id in a Telegram token (`123456:AA…`) is public and tells the
 *  operator WHICH bot it is; the secret half never is. */
function summarizeTelegramToken(value: string): string {
  const m = value.trim().match(/^(\d{6,12}):/);
  return m ? `${m[1]}:<redacted>` : "<redacted>";
}

/**
 * One line naming what a control-plane call would do, for the approval question.
 * The operator has to be able to judge it (an injected `relay_switch_profile`
 * summarised as `name:9 chars` is unanswerable), but the inputs are
 * caller-controlled, so the rule is: show STRUCTURE (the parsed channel kind, an
 * address that is the routing target, a credential's length) and show a SHAPE —
 * never the text — for free-form names. This function therefore never returns a
 * caller-supplied name verbatim.
 */
function summarizeControlPlaneInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  let unrecognised = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") {
      if (key === "channelId") {
        parts.push(`${key}=${shortId(value)}`);
        continue;
      }
      if (key === "channelType") {
        const kind = value.trim().toLowerCase();
        parts.push(`${key}=${KNOWN_CHANNEL_TYPES.has(kind) ? kind : summarizeTargetShape(value)}`);
        continue;
      }
      if (key === "name" || key === "channelName") {
        parts.push(`${key}=${summarizeTargetShape(value)}`);
        continue;
      }
      if (key === "userEmail") {
        parts.push(`userEmail=${summarizeShownValue(value)}`);
        continue;
      }
      if (key === "input") {
        parts.push(`input=${summarizeConnectInput(value)}`);
        continue;
      }
      if (CREDENTIAL_FIELD_LABELS.has(key)) {
        parts.push(`${key}:${value.length} chars`);
        continue;
      }
      unrecognised++;
      continue;
    }
    // Never drop a field silently, and never print a key we do not own: an
    // object/array target still shows as a shape, an unknown key as a count.
    if (Array.isArray(value)) {
      unrecognised++;
      continue;
    }
    if (value === null || value === undefined) continue;
    unrecognised++;
  }
  if (unrecognised > 0) parts.push(`+${unrecognised} more field(s)`);
  return parts.length ? parts.join(", ") : "no inputs";
}

/**
 * `relay_connect`'s one-shot input, summarised with the SAME parser execution
 * uses (`connect.ts`) so the question cannot describe a different target than
 * the one that would run — including the `webhook:name` colon form. A parsed
 * KIND is structure; a webhook NAME is caller text and becomes a shape; a
 * token/address is handled per kind.
 */
function summarizeConnectInput(value: string): string {
  const plan = parseConnectInput(value);
  switch (plan.kind) {
    case "webhook":
      return plan.name ? `webhook name=${summarizeTargetShape(plan.name)}` : "webhook";
    case "telegram":
      return `telegram ${summarizeTelegramToken(plan.token)}`;
    case "discord":
      return "discord <redacted>";
    case "email":
      return `email ${summarizeShownValue(plan.email)}`;
    default:
      return `<redacted, ${value.length} chars>`;
  }
}

/** Render a file path for DISPLAY: relative to the working directory when
 * possible, otherwise its basename. A path is not a secret, but an absolute
 * path can leak the operator's home/username, so it is not echoed verbatim. */
function summarizePath(raw: string): string {
  const path = raw.replace(/\\/g, "/");
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return path;
  const rel = relative(process.cwd(), path);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel || ".";
  return basename(path);
}

/** One approval-prompt line per relay_reply attachment: display name + on-disk
 * size, stat-ed best-effort. A path and a size are the two facts the operator
 * needs to tell an intended file from a sensitive one — the file's CONTENTS are
 * never shown (and are not read here). */
function describeAttachment(raw: string): string {
  const name = summarizePath(raw);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(raw);
  } catch {
    return `${name} (unreadable)`;
  }
  // A directory or device is not attachable; say so rather than size it.
  if (!stat.isFile()) return `${name} (not a regular file)`;
  return `${name} (${stat.size} bytes)`;
}

/** Keep a command summary readable; very long commands are cut with a length
 * note. Truncation only ever HIDES text, so it cannot leak a secret. */
function truncateForDisplay(text: string): string {
  const max = 400;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length} chars total)`;
}
