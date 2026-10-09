/**
 * pi-chaos-relay — bridges the pi coding agent to a CHAOS relay server so the
 * agent can be driven from, and reply to, Telegram and email.
 *
 * Model: pi plays the polling-client role (the same role the CHAOS Chrome
 * extension plays for full CHAOS agents). External channels (Telegram / email)
 * deliver to the relay; this extension polls GET /messages and answers via
 * POST /reply.
 *
 * Registered with pi via the `pi` field + `pi-package` keyword in package.json.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  RelayClient,
  RelayError,
  registerSession,
  registerSessionWithKey,
  type ChannelMessage,
  base64FromBytes,
  mimeForFile,
  type ReplyAttachment,
} from "./relay-client.ts";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, appendFileSync, chmodSync, mkdirSync, existsSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import {
  cleanupStaleInboundAttachments,
  materializeInboundAttachments,
} from "./inbound-attachments.ts";
import {
  addChannelRecord,
  DEFAULT_RELAY_URL,
  isConfigured,
  isValidRelayUrl,
  APPROVAL_MODES,
  type ApprovalMode,
  loadPersisted,
  readPersisted,
  normalizeApprovalMode,
  resetPersisted,
  resolveConfig,
  savePersisted,
  setApprovalMode,
  setChannelRecords,
  loadMessageState,
  saveMessageState,
  getConfigPath,
  setActiveConfigPath,
  profilePathForName,
  profileNameForPath,
  activeProfileName,
  listProfiles,
  countProfileConfigs,
  resolveProfileCreate,
  envProfileName,
  getSessionProfile,
  setSessionProfile,
  chooseProfile,
  resolveProfileLockCollision,
  resolveServerKeyPin,
  type ResolvedConfig,
  type RegisteredChannelRecord,
} from "./config.ts";
import { MessagePoller, formatMessagesForAgent } from "./poller.ts";
import {
  formatReplyConfirmation,
  formatReplyRefusal,
} from "./reply-format.ts";
import { RelayWebSocket } from "./ws-client.ts";
import { parseConnectInput } from "./connect.ts";
import { safeUrlOrigin, redactUrlSecretsFromMessage, redactCommandSecrets } from "./url-redact.ts";
import { approvalDecision, LOCAL_INSPECTION_TOOLS } from "./approval-policy.ts";

/**
 * Slow safety poll. The WebSocket is the primary transport (instant push);
 * this only runs as a backstop in case a push is missed between reconnects.
 */
const SAFETY_POLL_MS = 120_000;

const PACKAGE_VERSION = (() => {
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

const LOG_PREFIX = "[pi-chaos-relay]";
const RELAY_LOG_DIR = join(homedir(), ".pi", "agent", "logs");
const RELAY_LOG_FILE = join(RELAY_LOG_DIR, "chaos-relay.log");
const RELAY_LOG_DIR_MODE = 0o700;
const RELAY_LOG_FILE_MODE = 0o600;

/** One-line reason for a filesystem/permission problem, for the durable log. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tighten `path` to `mode` when it currently carries bits outside `mode` (e.g.
 * an existing, looser log file left behind by an older release). Returns an
 * error description when the mode could not be inspected or set, or undefined
 * on success — including the no-op case where the mode is already tight.
 */
function tightenMode(path: string, mode: number): string | undefined {
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch (err) {
    return errText(err);
  }
  if ((current & ~mode) !== 0) {
    try {
      chmodSync(path, mode);
    } catch (err) {
      return errText(err);
    }
  }
  return undefined;
}

/**
 * Short, non-identifying fingerprint for correlating a channel across durable
 * log lines without recording its raw identifier (which a co-tenant on a
 * shared host could read back out of a world-readable log).
 */
function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Relay logs are routed to a file ONLY. They must NOT go to stderr, because pi
 *  renders extension stderr into the TUI prompt/input area, which is noisy
 *  (e.g. the "WebSocket connected" banner on every (re)connect). Tail
 *  ~/.pi/agent/logs/chaos-relay.log to see them.
 *
 * The log directory and file are kept owner-only (0700 / 0600) so a co-tenant
 * on a shared host cannot read pairing codes or channel identifiers out of a
 * world-readable log. The file is created with mode 0600, and both the
 * directory and an existing file are tightened on every write. A chmod failure
 * is surfaced as a WARN line in the log (best-effort) — it must not crash the
 * extension, but it must not be silently swallowed either.
 *
 * Exported so tests can write to the hermetic durable log and assert on its
 * permissions and redaction without driving the full extension.
 */
export function log(message: string, ...rest: unknown[]): void {
  const line = `${LOG_PREFIX} ${message}${rest.length ? " " + rest.map((r) => String(r)).join(" ") : ""}`;
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    mkdirSync(RELAY_LOG_DIR, { recursive: true, mode: RELAY_LOG_DIR_MODE });
  } catch {
    // No directory means no log file; logging is best-effort and must never
    // throw into the extension.
    return;
  }

  const warnings: string[] = [];
  const dirError = tightenMode(RELAY_LOG_DIR, RELAY_LOG_DIR_MODE);
  if (dirError) warnings.push(`log directory permissions are not owner-only: ${dirError}`);

  try {
    appendFileSync(RELAY_LOG_FILE, entry, { mode: RELAY_LOG_FILE_MODE });
  } catch {
    return; // unwritable log file — best-effort, never throw
  }

  const fileError = tightenMode(RELAY_LOG_FILE, RELAY_LOG_FILE_MODE);
  if (fileError) warnings.push(`log file permissions are not owner-only: ${fileError}`);

  for (const warning of warnings) {
    try {
      appendFileSync(
        RELAY_LOG_FILE,
        `[${new Date().toISOString()}] ${LOG_PREFIX} WARN: ${warning}\n`,
        { mode: RELAY_LOG_FILE_MODE },
      );
    } catch {
      /* logging is best-effort */
    }
  }
}

/**
 * Non-identifying shape of a single channel re-bind outcome. The secret-bearing
 * fields are carried only so the summary builder can be tested against a real
 * registration result — they must NEVER be written to the durable log.
 */
export interface RebindChannelResult {
  /** Channel type ("telegram" | "email" | "discord" | "webhook" | …). */
  type: string;
  /** false when the re-bind failed or the record lacked re-bind material. */
  ok: boolean;
  pairingCode?: string;
  channelId?: string;
  botUsername?: string;
  inboundAddress?: string;
  webhookUrl?: string;
  userEmail?: string;
  label?: string;
}

/**
 * Build the durable-log summary for a recovered session's channel re-bind.
 * Deliberately non-identifying: pairing codes, channel ids, bot usernames,
 * email addresses, inbound addresses and webhook URLs are withheld so a
 * co-tenant on a shared host cannot read them out of the log file. Exported for
 * tests so the invariant is pinned against a real registration result.
 */
export function rebindLogSummary(results: ReadonlyArray<RebindChannelResult>): string {
  const notes = results.map((r) => {
    if (!r.ok) {
      return `${r.type} channel could not auto re-bind — re-add it with /chaos-relay or the relay_register_* tool.`;
    }
    if (r.type === "telegram" || r.type === "discord") {
      return `${r.type} channel re-registered — a fresh pairing code is required to re-link (code withheld from the durable log).`;
    }
    if (r.type === "email") {
      return `email channel re-registered — a fresh verification link is required to reactivate (identifiers withheld from the durable log).`;
    }
    if (r.type === "webhook") {
      // The origin is not a secret and is what makes the line diagnostic; the
      // path/query can carry the webhook secret, so only the origin is logged.
      return `webhook channel re-registered — URL unchanged at ${safeUrlOrigin(r.webhookUrl)} (full URL withheld from the durable log).`;
    }
    return `${r.type} channel re-registered (identifiers withheld from the durable log).`;
  });
  return (
    "chaos-relay recovered a new session after the relay lost the old one. " +
    "Channel re-binding status (some need a quick manual step):\n- " +
    notes.join("\n- ")
  );
}

// ── Profile lock: detect concurrent pi instances on the same relay profile ──

function lockFilePath(profile: string): string {
  return join(homedir(), ".pi", `chaos-relay-${profile}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but belongs to another user — treating
    // that as "dead" would make the stale-lock cleanup unlink a live holder's
    // lock. Only ESRCH (no such process) is genuinely dead.
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * How long an unparseable/empty lock file must be untouched before it is
 * treated as a crashed leftover rather than another process's in-flight
 * exclusive create (see claimProfileLock).
 */
const LOCK_CREATE_GRACE_MS = 1_000;

/**
 * Tolerance below zero for the create-grace age check: Date.now() is integer
 * milliseconds while statSync().mtimeMs is fractional, so a lock created and
 * read within the SAME millisecond has a legitimately negative age of well
 * under 1 ms. Rejecting that unlinked a mid-create lock — the exact window the
 * grace exists to protect. Anything beyond this tolerance is a real future
 * mtime (a clock step), which stays stale.
 */
const LOCK_CREATE_SKEW_TOLERANCE_MS = 50;

/**
 * What a lock file's contents say:
 *  - "ambiguous": empty, partial or unparseable. Another process's exclusive
 *    create is visible from open(2), before its pid is written, so this may be
 *    a live racer: the create-grace applies.
 *  - "invalid-pid": numeric but unusable as a holder (0 or negative). Never
 *    ambiguous — no process has pid 0, and process.kill(0, 0) signals the
 *    caller's own process group and succeeds, which is exactly why such a file
 *    must NOT look like a live holder.
 *  - "pid": a usable pid.
 */
type LockHolder =
  | { kind: "ambiguous" }
  | { kind: "invalid-pid" }
  | { kind: "pid"; pid: number };

/** Read what a lock file records. Missing/unreadable files read as ambiguous. */
function readLockHolder(path: string): LockHolder {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return { kind: "ambiguous" };
  }
  if (raw === "") return { kind: "ambiguous" };
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid)) return { kind: "ambiguous" };
  if (pid <= 0) return { kind: "invalid-pid" };
  return { kind: "pid", pid };
}

/**
 * Atomically claim `profile` for this process, BEFORE any connect or
 * registration work.
 *
 * Why: the previous flow read the lock, awaited connectAsProfile() (which can
 * perform a live relay registration), and only then wrote the lock with a
 * plain writeFileSync — a TOCTOU window in which two pi processes starting
 * together both observe "unlocked", both connect, and both write, so two live
 * sessions share one relay identity and defeat the collision refusal.
 *
 * `flag: "wx"` is an exclusive create: exactly one of two racers can win, and
 * the loser gets EEXIST instead of clobbering the winner. On EEXIST the holder
 * is inspected — a live holder (a different pid that still exists) means
 * refuse; a stale file (dead pid, unparseable, or our own pid) is removed and
 * the exclusive create retried, bounded. There is NO path that overwrites a
 * live holder's lock.
 *
 * `claimed: true` means this process may proceed (for the exotic case where
 * the lock file cannot be created at all — see `lockError` — it proceeds
 * without holding one, keeping the historical fail-open behaviour rather than
 * breaking every session on an unwritable ~/.pi). `pid` is the holder's pid
 * when the claim was refused, for the collision message.
 */
export function claimProfileLock(profile: string): {
  claimed: boolean;
  pid: number | null;
  path: string;
  lockError?: string;
} {
  const path = lockFilePath(profile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return { claimed: true, pid: process.pid, path };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        // Unexpected FS error (read-only ~/.pi, exotic mount): proceed without
        // the lock, but report it so the caller can warn — never overwrite.
        return {
          claimed: true,
          pid: null,
          path,
          lockError: err instanceof Error ? err.message : String(err),
        };
      }
      const holder = readLockHolder(path);
      if (holder.kind === "pid" && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
        return { claimed: false, pid: holder.pid, path };
      }
      if (holder.kind === "ambiguous") {
        // AMBIGUOUS content: `open(2)` creates the file before the winner
        // writes its pid, so a racer that reads it in that window would see an
        // empty (or partial) file and — treating that as stale — delete a live
        // process's lock from under it, the very double-claim this exists to
        // prevent. Reclaim such a file only once it is older than the grace
        // window; before that, treat it as held and refuse.
        let ageMs = Number.POSITIVE_INFINITY;
        try {
          ageMs = Date.now() - statSync(path).mtimeMs;
        } catch {
          /* vanished between read and stat: fall through to the retry */
        }
        // Only an age inside the window is "possibly still being created".
        // The window extends slightly BELOW zero for same-millisecond skew (see
        // LOCK_CREATE_SKEW_TOLERANCE_MS); a real clock step is far outside it.
        if (ageMs >= -LOCK_CREATE_SKEW_TOLERANCE_MS && ageMs < LOCK_CREATE_GRACE_MS) {
          return { claimed: false, pid: null, path };
        }
      }
      // Stale: a dead holder's pid, our own pid, an invalid pid (0/negative —
      // no process has pid 0), or an ambiguous file past the grace window.
      // Clear it and retry the exclusive create; a racing cleaner just means we
      // see EEXIST again.
      try {
        unlinkSync(path);
      } catch {
        /* already gone / another process cleaned it */
      }
    }
  }
  // Lost the retry loop: a real collision, not a stale file.
  const holder = readLockHolder(path);
  return { claimed: false, pid: holder.kind === "pid" ? holder.pid : null, path };
}

/** Release the profile lock on shutdown — but only a lock this process wrote.
 *  A session that refused a collision stays bound to its previous profile name,
 *  and must not unlock the session that legitimately holds it. */
function removeProfileLock(profile: string): void {
  try {
    const path = lockFilePath(profile);
    if (readFileSync(path, "utf-8").trim() !== String(process.pid)) return;
    unlinkSync(path);
  } catch { /* ignore */ }
}

/** Wrap text content into the AgentToolResult shape pi expects. */
function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
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
    const answer = /^\s*(yes|no)\s+([0-9a-f]+)[.!]?\s*$/i.exec(message.content);
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
      body = message.content.slice(addressed[0].length);
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
    return `${toolName}: ${summarizeControlPlaneInput(toolName, input)}`;
  }
  // Any other gated tool: never echo raw values, only shapes.
  const entries = Object.entries(input ?? {});
  const parts = entries.map(([key, value]) => {
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

/** Input fields that name a target rather than carrying a credential. */
const SAFE_TARGET_FIELDS = new Set(["name", "channelName", "channelType", "channelId"]);

/**
 * A target the caller chose (profile name, channel name, address, webhook name)
 * rendered for the approval question. The value is AGENT-CONTROLLED, so it is
 * squashed onto ONE line, secret-shaped values are redacted and it is capped.
 * Without that, `read ~/.aws/credentials` followed by
 * `relay_switch_profile {name: <secret>}` would ship the secret to the driving
 * channel inside the question — before anyone approved anything — which is the
 * very egress the session taint exists to close. Same rule the `bash` summary
 * follows (redaction plus a cap), for the same reason.
 */
function summarizeFreeTextTarget(value: string, max = 60): string {
  const oneLine = value.replace(/[\s\p{C}]+/gu, " ").trim();
  const redacted = redactCommandSecrets(oneLine);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}… (${redacted.length} chars total)`;
}

/** The numeric bot id in a Telegram token (`123456:AA…`) is public and tells the
 *  operator WHICH bot it is; the secret half never is. */
function summarizeTelegramToken(value: string): string {
  const m = value.trim().match(/^(\d+):/);
  return m ? `${m[1]}:<redacted>` : "<redacted>";
}

/**
 * One line naming what a control-plane call would do, for the approval
 * question. The TARGET is echoed so the operator can judge it (an injected
 * `relay_switch_profile` summarised as `name:9 chars` is unanswerable), while
 * credential-bearing values never are: `botToken`, `password`, `secret` and a
 * connect token render as a length, and an email address is shown in full
 * because it is a ROUTING TARGET — the verification link goes to whatever
 * address is approved, so hiding its local part hides the takeover this gate
 * exists to stop. Every echoed value goes through summarizeFreeTextTarget
 * (one line, redacted, capped), because the caller controls it.
 */
function summarizeControlPlaneInput(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") {
      if (key === "channelId") {
        parts.push(`${key}=${shortId(value)}`);
        continue;
      }
      if (key === "name" && toolName === "relay_switch_profile") {
        // Show the profile name that will ACTUALLY be used (the slug), not the
        // raw string: its [a-z0-9._-] charset cannot fake the question layout.
        parts.push(`${key}=${summarizeFreeTextTarget(profileNameForPath(profilePathForName(value)))}`);
        continue;
      }
      if (SAFE_TARGET_FIELDS.has(key)) {
        parts.push(`${key}=${summarizeFreeTextTarget(value)}`);
        continue;
      }
      if (key === "userEmail") {
        parts.push(`userEmail=${summarizeFreeTextTarget(value)}`);
        continue;
      }
      if (key === "input") {
        parts.push(`input=${summarizeConnectInput(value)}`);
        continue;
      }
      parts.push(`${key}:${value.length} chars`);
      continue;
    }
    // Never drop a field silently: an object/array target must still be visible
    // as a shape rather than rendering the call as "no inputs".
    if (Array.isArray(value)) {
      parts.push(`${key}:${value.length} item(s)`);
      continue;
    }
    if (value === null || value === undefined) {
      parts.push(key);
      continue;
    }
    parts.push(`${key}:object`);
  }
  return parts.length ? parts.join(", ") : "no inputs";
}

/**
 * `relay_connect`'s one-shot input: a channel kind plus one identifying thing.
 * A KIND and a webhook NAME are targets; a bot token, and the secret half of a
 * Telegram token, are credentials. A bare address is a routing target.
 */
function summarizeConnectInput(value: string): string {
  const [kindRaw = "", ...rest] = value.trim().split(/\s+/);
  const kind = kindRaw.toLowerCase();
  const remainder = rest.join(" ").trim();
  if (kind === "webhook") {
    return remainder ? `webhook ${summarizeFreeTextTarget(remainder)}` : "webhook";
  }
  if (kind === "telegram") return `telegram ${summarizeTelegramToken(remainder)}`;
  if (kind === "discord") return "discord <redacted>";
  if (kind === "email") {
    return remainder ? `email ${summarizeFreeTextTarget(remainder)}` : "email <redacted>";
  }
  if (rest.length === 0 && /^[^\s@]+@[^\s@]+$/.test(kindRaw)) {
    return summarizeFreeTextTarget(value.trim());
  }
  return `<redacted, ${value.length} chars>`;
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

export default function chaosRelayExtension(pi: ExtensionAPI): void {
  let client: RelayClient | undefined;
  let poller: MessagePoller | undefined;
  let ws: RelayWebSocket | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let attachmentCleanupTimer: ReturnType<typeof setInterval> | undefined;
  let deliveryQueue: Promise<void> = Promise.resolve();
  let activeModelAcceptsImages = false;
  let cfg: ResolvedConfig = resolveConfig();

  // Profile/session binding. `currentProfile` is the profile this process is
  // connected as right now; `currentSessionId` is pi's id for the active session
  // (so switches/connects can be recorded against the right session).
  let currentProfile: string = activeProfileName();
  let currentSessionId: string | undefined;

  // Typing indicator state: the channel of the most recent inbound message, and
  // whether the current/next agent run was triggered by a relay message (so we
  // only show "typing" in the channel when the agent is actually working on a
  // message from it, not on terminal-driven turns).
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  /** FIFO of relay turn origins, one per delivered relay turn. The agent can be
   *  busy when a message arrives — its followUp becomes a LATER turn that must
   *  still carry the origin — so a boolean "relay input since idle" cannot
   *  represent queued turns. */
  let pendingOrigins: {
    channelType: ChannelMessage["channelType"];
    channelId: string;
    from: string;
  }[] = [];
  /** The CURRENT turn's origin, shifted from the queue at turn start and dropped
   *  at turn end. A gated tool call asks — and is answered by — this. */
  let activeTurn:
    | { channelType: ChannelMessage["channelType"]; channelId: string; from: string }
    | undefined;
  /** True once THIS SESSION has inspected local content (read/grep/bash) — from
   *  any turn, channel-driven or terminal/local. Cleared only at session start
   *  and shutdown, never at turn boundaries, so a channel turn cannot text-reply
   *  a secret inspected in an earlier turn without approval. Used by the
   *  approval gate. */
  let sessionReadLocalFile = false;

  /**
   * Re-register with the persisted keypair to recover a working apiKey after a
   * relay data loss (the relay reclaims the SAME session for the same key, so
   * the userId/channels are preserved when its store still has the index; a
   * fresh session is created otherwise). Persists and returns the new apiKey,
   * or null if there's no keypair to recover with.
   */
  async function recoverApiKey(): Promise<string | null> {
    const persisted = loadPersisted();
    if (!persisted.keyPair) {
      log("auth recovery skipped: no keypair persisted (run /chaos-relay setup)");
      return null;
    }
    const oldUserId = persisted.userId;
    try {
      const reg = await registerSessionWithKey(cfg.relayUrl, { keyPair: persisted.keyPair });
      const pin = resolveServerKeyPin({
        pinned: persisted.serverPublicKey,
        fresh: reg.serverPublicKey,
      });
      if (pin.action === "refuse") {
        log(`auth recovery aborted: ${pin.message}`);
        return null;
      }
      savePersisted({
        apiKey: reg.apiKey,
        userId: reg.userId,
        keyPair: reg.keyPair,
        serverPublicKey: pin.serverPublicKey,
      });
      cfg = resolveConfig();
      // Rebuild the HTTP client so catch-up polls use the new key too.
      client = new RelayClient({ relayUrl: cfg.relayUrl, apiKey: reg.apiKey, keyPair: reg.keyPair });
      if (poller) poller = makePoller(client);
      if (oldUserId && reg.userId === oldUserId) {
        // Same session reclaimed by keypair — channels are intact, nothing to do.
        log(`auth recovered: reclaimed session userId=${reg.userId} (channels intact)`);
      } else {
        // Forced-new session — the relay lost our channels. Auto re-register them.
        log(`auth recovered: NEW session userId=${reg.userId} (was ${oldUserId ?? "none"}); re-binding channels`);
        await rebindChannels();
      }
      return reg.apiKey;
    } catch (err) {
      log(`auth recovery failed: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
      return null;
    }
  }

  /**
   * Re-register persisted channels against the current (new) session and update
   * their stored channelIds. Telegram/email re-registration is automatic, but
   * the relay issues a fresh pairing code / verification step for security. The
   * durable log only records a NON-IDENTIFYING summary (see rebindLogSummary);
   * the operator completes the manual re-link by re-running the relay_register_*
   * tool (which shows the fresh pairing code / verification link in the TUI).
   */
  async function rebindChannels(): Promise<void> {
    const c = client;
    if (!c) return;
    const records = loadPersisted().channels ?? [];
    if (records.length === 0) return;
    // The channels re-bind INDEPENDENTLY, so run them concurrently: in a serial
    // loop the forced-new-session path paid one control-plane round trip per
    // channel (N × RTT). Each record still catches its own failure, so one bad
    // channel can never abort the re-bind or drop the others' outcomes — and the
    // results are reassembled in RECORD ORDER below, so the persisted records and
    // the log summary stay deterministic regardless of completion order.
    const outcomes = await Promise.all(
      records.map(async (rec): Promise<{ record: RegisteredChannelRecord; result: RebindChannelResult }> => {
        try {
          if (rec.type === "telegram" && rec.botToken) {
            const res = await c.registerTelegram({ botToken: rec.botToken, agentId: cfg.agentId });
            return {
              record: { ...rec, channelId: res.channelId, label: res.botUsername },
              result: {
                type: "telegram",
                ok: true,
                pairingCode: res.pairingCode,
                channelId: res.channelId,
                botUsername: res.botUsername,
              },
            };
          }
          if (rec.type === "email" && rec.userEmail) {
            const res = await c.registerEmail({
              userEmail: rec.userEmail,
              agentId: cfg.agentId,
              channelName: rec.channelName,
            });
            return {
              record: { ...rec, channelId: res.channelId },
              result: {
                type: "email",
                ok: true,
                channelId: res.channelId,
                inboundAddress: res.inboundAddress,
                userEmail: rec.userEmail,
              },
            };
          }
          if (rec.type === "discord" && rec.botToken) {
            const res = await c.registerDiscord({ botToken: rec.botToken, agentId: cfg.agentId });
            return {
              record: { ...rec, channelId: res.channelId, label: res.botUsername },
              result: {
                type: "discord",
                ok: true,
                pairingCode: res.pairingCode,
                channelId: res.channelId,
                botUsername: res.botUsername,
              },
            };
          }
          if (rec.type === "webhook") {
            // Recreate with the same id + secret so the public URL is unchanged.
            const res = await c.registerWebhook({
              id: rec.channelId,
              webhookSecret: rec.webhookSecret,
              channelName: rec.channelName,
            });
            return {
              record: { ...rec, channelId: res.channelId },
              result: {
                type: "webhook",
                ok: true,
                channelId: res.channelId,
                webhookUrl: res.webhookUrl,
                label: rec.label,
              },
            };
          }
          // no re-bind material — keep the record, note it
          return { record: rec, result: { type: rec.type, ok: false } };
        } catch {
          return { record: rec, result: { type: rec.type, ok: false } };
        }
      }),
    );
    const updated = outcomes.map((o) => o.record);
    const results = outcomes.map((o) => o.result);
    setChannelRecords(updated);
    cfg = resolveConfig();
    if (results.length > 0) {
      // The summary is deliberately non-identifying (see rebindLogSummary):
      // pairing codes and raw channel identifiers are withheld from the durable
      // log, so a co-tenant on a shared host cannot read them back out.
      log(rebindLogSummary(results));
    }
  }

  /** (Re)build the relay client from current config. Returns undefined if no API key. */
  // Create a poller that resumes from the persisted cursor and writes the
  // cursor back as it advances, so a restart doesn't re-read the relay backlog.
  function makePoller(c: RelayClient): MessagePoller {
    // Cursor + de-dup log come from the side-car state file (falling back to
    // the legacy in-config fields on first run after upgrade), so the delivery
    // hot path never rewrites the profile config at all.
    const state = loadMessageState();
    return new MessagePoller(c, {
      since: state.cursor,
      // ONE small atomic flush per delivery batch persists the resume cursor
      // and the de-dup log together to the side-car (previously two whole-file
      // config rewrites per batch — the dominant per-message CPU cost; see
      // bead pi-chaos-relay-mlq). Persisting is best-effort and runs on the
      // WebSocket message-delivery path — never let a disk error here become
      // an uncaughtException that kills pi. Losing an update at worst re-reads
      // a little backlog; the de-dup log filters the rest.
      onPersist: ({ since, seen }) => {
        try {
          saveMessageState({ cursor: since, seenIds: seen });
        } catch (err) {
          log(`WARN: failed to persist message cursor/seen log: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      // Restore the persisted de-dup log so restarts don't re-process the
      // relay's on-connect message replay.
      seen: state.seenIds,
    });
  }

  function ensureClient(): RelayClient | undefined {
    cfg = resolveConfig();
    if (!isConfigured(cfg)) {
      client = undefined;
      poller = undefined;
      return undefined;
    }
    if (!client) {
      const identity = cfg.keyPair ? "ECDSA-signed" : "Bearer-only (legacy)";
      log(
        `connecting to relay ${safeUrlOrigin(cfg.relayUrl)} as agentId="${cfg.agentId}" (${identity})`,
      );
      client = new RelayClient({
        relayUrl: cfg.relayUrl,
        apiKey: cfg.apiKey!,
        keyPair: cfg.keyPair,
      });
      poller = makePoller(client);
    }
    return client;
  }

  /**
   * The loud warning emitted when auto-provisioning is about to mint an identity
   * against a URL the operator never configured (no CHAOS_RELAY_URL, no
   * persisted relayUrl → the production default). This is the silent-asymmetric
   * failure mode the transport path masked: the WebSocket honoured env, so a
   * self-hoster saw connection errors and assumed their relay was unreachable
   * while registration quietly minted an identity against chaos-relay.com.
   */
  function unconfiguredRelayWarning(relayUrl: string): string {
    return (
      `No relay URL configured — auto-provisioning an identity against the ` +
      `default relay ${safeUrlOrigin(relayUrl)}. Set CHAOS_RELAY_URL (or run /chaos-relay setup) ` +
      `to point this instance at your own relay and keep its identity isolated.`
    );
  }

  /** Warning when CHAOS_RELAY_URL is set but malformed and a valid persisted URL
   *  exists — resolveConfig uses the persisted URL, but the operator should know
   *  their env value is being ignored. Echoes NEITHER the env value NOR the
   *  persisted URL verbatim: both are shown origin-only (safeUrlOrigin), since
   *  either can carry a pasted secret or userinfo, and this text reaches both
   *  the durable log and the TUI. */
  function invalidEnvIgnoredWarning(used: string): string {
    return (
      `CHAOS_RELAY_URL is set but is not an absolute http(s):// URL — ignoring it ` +
      `and using the persisted relay ${safeUrlOrigin(used)}. Fix CHAOS_RELAY_URL to make it take effect.`
    );
  }

  /** Warning + refusal when CHAOS_RELAY_URL is malformed and no persisted URL
   *  exists: auto-provisioning would otherwise mint an identity against the
   *  production default, which the operator clearly did not intend. The malformed
   *  value itself is never echoed (see invalidEnvIgnoredWarning). */
  function invalidEnvRefusal(): string {
    return (
      `CHAOS_RELAY_URL is set but is not an absolute http(s):// URL, and no relay ` +
      `URL is configured — refusing to auto-provision an identity against the ` +
      `default relay. Fix CHAOS_RELAY_URL or run /chaos-relay setup.`
    );
  }

  /**
   * Like {@link ensureClient}, but if the relay isn't configured yet it
   * auto-provisions a session (ECDSA keypair at the default relay URL) WITHOUT
   * any interactive setup. This lets the agent fulfil requests like "register my
   * telegram bot 123:ABC" directly — the user never has to run /chaos-relay setup
   * or know what a relay URL is. Returns undefined only if provisioning fails
   * (e.g. the relay is unreachable).
   *
   * `notify` (when provided) surfaces {@link unconfiguredRelayWarning} to the
   * user; the warning is also always written to the durable log.
   */
  async function ensureConfigured(
    notify?: (message: string) => void,
  ): Promise<RelayClient | undefined> {
    const existing = ensureClient();
    if (existing) return existing;

    const persisted = loadPersisted();
    // Prefer the env-resolved URL (env > persisted > default) so CHAOS_RELAY_URL
    // governs registration exactly as it governs transport. The old persisted-only
    // lookup ignored CHAOS_RELAY_URL on this path: a fresh profile would fall
    // through to DEFAULT_RELAY_URL and mint an identity + apiKey against the
    // production relay even when the operator had pointed this instance at their
    // own relay.
    const relayUrl = resolveConfig(persisted).relayUrl;

    // Loud warnings around the registration URL. Three distinct states:
    //  - env set but INVALID + no valid persisted URL → refuse (auto-provisioning
    //    would silently mint against the production default the operator did not
    //    intend, so never register on a malformed env value);
    //  - env set but INVALID + valid persisted URL → warn, then use the persisted
    //    URL (resolveConfig already picked it over the malformed env);
    //  - nothing configured anywhere → warn, then use the documented default.
    const envRaw = process.env.CHAOS_RELAY_URL ?? "";
    const envSet = envRaw.trim() !== "";
    const envValid = isValidRelayUrl(envRaw);
    const persistedValid = isValidRelayUrl(persisted.relayUrl ?? "");
    if (envSet && !envValid) {
      if (!persistedValid) {
        const warning = invalidEnvRefusal();
        log(`WARN: ${warning}`);
        notify?.(warning);
        return undefined;
      }
      const warning = invalidEnvIgnoredWarning(relayUrl);
      log(`WARN: ${warning}`);
      notify?.(warning);
    } else if (!envSet && !persistedValid) {
      const warning = unconfiguredRelayWarning(relayUrl);
      log(`WARN: ${warning}`);
      notify?.(warning);
    }
    try {
      // Reuse any existing keypair so the identity (and its channels) stay stable.
      const reg = await registerSessionWithKey(relayUrl, { keyPair: persisted.keyPair });
      const pin = resolveServerKeyPin({
        pinned: persisted.serverPublicKey,
        fresh: reg.serverPublicKey,
      });
      if (pin.action === "refuse") {
        const warning = pin.message;
        log(`WARN: ${warning}`);
        notify?.(warning);
        return undefined;
      }
      savePersisted({
        relayUrl,
        agentId: persisted.agentId ?? "pi",
        apiKey: reg.apiKey,
        userId: reg.userId,
        keyPair: reg.keyPair,
        serverPublicKey: pin.serverPublicKey,
      });
      cfg = resolveConfig();
      client = undefined;
      startPolling();
      log(`auto-provisioned relay session userId=${reg.userId} at ${safeUrlOrigin(relayUrl)}`);
      return ensureClient();
    } catch (err) {
      log(`auto-provision failed: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
      return undefined;
    }
  }

  /**
   * Connect this process as the named profile: re-point config at its file,
   * reconnect as that identity (auto-provisioning if new), restart polling, and
   * bind the current pi session to it (so a resume reconnects the same way).
   * Returns whether the profile was freshly created.
   */
  async function connectAsProfile(
    name: string,
    notify?: (message: string) => void,
  ): Promise<{ isNew: boolean; connected: boolean }> {
    const profilePath = profilePathForName(name);
    const existedBefore = existsSync(profilePath);
    // Enforce the profile cap at the single creation chokepoint. This covers
    // both relay_switch_profile and a session_start that lands on a brand-new
    // (env-pinned) name — an existing-but-unconfigured profile is a switch, not
    // a creation, so only a NEW file beyond the cap is refused.
    const creation = resolveProfileCreate({
      profile: profileNameForPath(profilePath),
      exists: existedBefore,
      existingCount: countProfileConfigs(),
    });
    if (creation.action === "refuse") {
      log(`WARN: ${creation.message}`);
      notify?.(creation.message);
      return { isNew: false, connected: false };
    }

    stopPolling();
    client = undefined;
    poller = undefined;
    setActiveConfigPath(profilePath);
    cfg = resolveConfig();
    currentProfile = activeProfileName();
    // Bind the active session → this profile so resume/reload restore it.
    setSessionProfile(currentSessionId, currentProfile);

    const isNew = !isConfigured(cfg);
    const c = await ensureConfigured(notify); // provisions a fresh identity if new
    if (!c) return { isNew, connected: false };
    startPolling(); // ensure the poller runs for an already-provisioned profile too
    cfg = resolveConfig();
    if (!existedBefore) {
      // A brand-new profile config was just written: make the creation loud in
      // the durable log and to the user, and record the resulting file count.
      log(
        `created relay profile "${currentProfile}" (new identity; ${countProfileConfigs()} profile file(s) on disk)`,
      );
      notify?.(`Created relay profile "${currentProfile}" (fresh identity).`);
    }
    return { isNew, connected: true };
  }

  /**
   * Decide which profile a starting/resuming session should use. Precedence:
   * explicit env (pins) → this session's recorded profile → inherit on new/fork
   * → default. See the launch/use matrix in the README.
   */
  function chooseProfileForSession(
    reason: "startup" | "reload" | "new" | "resume" | "fork",
    sessionId: string | undefined,
  ): string {
    return chooseProfile({
      reason,
      envProfile: envProfileName(), // CHAOS_RELAY_CONFIG/PROFILE — pins
      recordedProfile: getSessionProfile(sessionId), // resume / reload
      inheritedProfile: currentProfile, // inherit on new / fork
    });
  }

  /**
   * User-facing profile switch (command/tool). Connects as the profile and binds
   * it to the current session. Returns a human-readable status line.
   */
  async function switchProfile(
    name: string,
    notify?: (message: string) => void,
  ): Promise<string> {
    const slug = profileNameForPath(profilePathForName(name));
    if (profilePathForName(name) === getConfigPath()) {
      return `Already on profile "${slug}".`;
    }
    // Surface the cap refusal as the tool/command result (connectAsProfile also
    // guards this, for the session_start path — but here we need the clear
    // message returned directly rather than the generic could-not-connect line).
    const creation = resolveProfileCreate({
      profile: slug,
      exists: existsSync(profilePathForName(name)),
      existingCount: countProfileConfigs(),
    });
    if (creation.action === "refuse") {
      log(`WARN: ${creation.message}`);
      notify?.(creation.message);
      return creation.message;
    }
    // Claim the target profile ATOMICALLY and BEFORE connectAsProfile() — the
    // same TOCTOU the session_start path had. connectAsProfile() can perform a
    // live relay registration, so checking (or writing) the lock after it
    // would let two sessions switching to one profile concurrently both
    // connect and share the identity.
    const claim = claimProfileLock(slug);
    if (claim.lockError) {
      log(
        `profile switch: could not create the lock for "${slug}" (${claim.lockError}) — ` +
          `continuing without one; concurrent sessions on this profile cannot be detected`,
      );
    }
    const decision = resolveProfileLockCollision({
      profile: slug,
      locked: !claim.claimed,
      pid: claim.pid,
      lockPath: claim.path,
    });
    if (decision.action === "refuse") {
      log(`profile switch: ${decision.message}`);
      return decision.message;
    }
    const previousProfile = currentProfile;
    const { isNew, connected } = await connectAsProfile(name, notify);
    if (!connected) {
      // Release the profile we just left even though the switch FAILED:
      // connectAsProfile() already re-pointed this session at the target, so
      // holding the old profile's lock would block another session from a
      // profile nobody is using until this process exits. Keep the new claim
      // (the poller keeps retrying the target).
      if (previousProfile && previousProfile !== slug) removeProfileLock(previousProfile);
      return `Switched config to profile "${slug}" but couldn't reach the relay to connect — check your network, then /chaos-relay status.`;
    }
    // Released only after the switch succeeded: this session no longer uses the
    // previous profile, and holding its lock would block another session from
    // taking it for as long as we live. removeProfileLock is pid-guarded, so a
    // profile that is not ours (or not locked) is left alone.
    if (previousProfile && previousProfile !== slug) removeProfileLock(previousProfile);
    const channelCount = cfg.channels.length;
    return isNew
      ? `Created and connected new profile "${slug}" (fresh identity). ` +
        `No channels yet — add one with /chaos-relay add or by pasting a token.`
      : `Switched to profile "${slug}" (${channelCount} channel${channelCount === 1 ? "" : "s"}).`;
  }

  function stopPolling(): void {
    if (ws) {
      ws.stop();
      ws = undefined;
      log("relay WebSocket stopped");
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      log("safety poller stopped");
    }
  }

  /**
   * Inject inbound channel messages into the agent. When the agent is mid-turn,
   * a bare sendUserMessage() throws ("Agent is already processing"), so we pass
   * deliverAs:"followUp" — that queues the message after the current turn when
   * streaming and delivers immediately when idle. Matches pi's own extension
   * examples (reload-runtime, git-merge-and-resolve).
   */
  async function deliverToAgent(messages: ChannelMessage[]): Promise<void> {
    const c = ensureClient();
    const hydrated = c
      ? await materializeInboundAttachments(c, messages)
      : { messages, images: [], files: [] };
    const text = formatMessagesForAgent(hydrated.messages);
    const includesImages = hydrated.images.length > 0 && activeModelAcceptsImages;
    const content = includesImages
      ? [{ type: "text" as const, text }, ...hydrated.images]
      : text;

    // Enqueue this turn's origin only now that hydration has succeeded and the
    // followUp is about to be delivered. A batch can mix channels/senders;
    // attribute it to the FIRST (earliest) message — the one that initiated the
    // turn — and warn so a mixed batch is never silently attributed to the last
    // message. (Pre-1.0 decision: earliest-origin + warning; the per-origin
    // delivery follow-up is deferred.) Enqueueing here, not before the await,
    // keeps one queue entry per delivered turn: a hydration failure (or a turn
    // that starts during a slow hydration) can never consume or shift an origin
    // that was never actually delivered.
    const first = messages[0];
    if (first) {
      pendingOrigins.push({
        channelType: first.channelType,
        channelId: first.channelId,
        from: first.from,
      });
      const distinct = new Set(messages.map((m) => `${m.channelId}\u0000${m.from}`));
      if (distinct.size > 1) {
        log(
          `WARN: a delivery batch mixes ${distinct.size} channel/sender origins — ` +
            `attributing the turn to the earliest (${first.from} on ${first.channelId})`,
        );
      }
    }

    try {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    } catch (err) {
      // A text-only model/runtime may reject image content. Never let that drop
      // the channel message: retry as text with the private file paths intact.
      if (!includesImages) throw err;
      log("active model rejected inbound image content; delivering paths as text");
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  /** Serialize downloads/injection so WS push and catch-up cannot race. */
  function queueDelivery(messages: ChannelMessage[]): Promise<void> {
    deliveryQueue = deliveryQueue
      .then(() => deliverToAgent(messages))
      .catch((err) => {
        log(`attachment delivery failed: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
      });
    return deliveryQueue;
  }

  /** Repeatedly send a "typing" indicator to the active channel until stopped. */
  function startTyping(): void {
    stopTyping();
    if (!activeTurn) return;
    const c = ensureClient();
    if (!c) return;
    const ch = activeTurn;
    const ping = () => void c.sendTyping(ch.channelType, ch.channelId);
    ping(); // immediate, then refresh before Telegram's ~5s expiry
    typingTimer = setInterval(ping, 4000);
    if (typeof typingTimer.unref === "function") typingTimer.unref();
  }

  function stopTyping(): void {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  }

  // ── Tool approval over the channel ─────────────────────────────────────────
  // When approvalMode != "off", risky tool calls are paused and an approval
  // request is sent to the active channel; the NEXT message from that channel
  // is consumed as the yes/no answer (it is not forwarded to the agent).
  const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
  // One entry per outstanding request, each with its own timer and resolver.
  // (A single global slot let a second gated call overwrite the first, let any
  // entry's timeout resolve the wrong promise, and could leave one request
  // hanging forever — see the ApprovalQueue doc comment.)
  const approvals = new ApprovalQueue(APPROVAL_TIMEOUT_MS, (m) => log(m));

  function approvalNeeded(toolName: string, input?: Record<string, unknown>): boolean {
    // Delegate to the pure per-tool policy (approval-policy.ts) — the single
    // source of truth for the mode x tool matrix, unit-tested in full. The
    // session state carries whether this session has read local files, so a
    // text-only reply after a read (in this or an earlier turn) is gated under
    // the default "writes" mode.
    return approvalDecision(cfg.approvalMode, toolName, input, {
      hasReadLocalFile: sessionReadLocalFile,
    });
  }

  /** Ask the channel to approve a tool call; resolves true=allow, false=deny. */
  async function requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    ch: { channelType: ChannelMessage["channelType"]; channelId: string; from: string },
  ): Promise<boolean> {
    const c = ensureClient();
    if (!c) {
      // Fail CLOSED: if the relay client can't even be built to ask, deny. This
      // is only reached on channel-driven turns, so a missing client means the
      // relay is genuinely unavailable — never silently allow a gated tool.
      log("approval: relay client unavailable — denying tool call");
      return false;
    }
    // Register the request FIRST so the question can carry its nonce and so a
    // reply can never arrive for a request the queue does not know about.
    const { ref, nonce, promise, cancel } = approvals.add({
      channelId: ch.channelId,
      from: ch.from,
      toolName,
    });
    const other = approvals.size - 1;
    const question = `⚠️ Approval needed — the agent wants to run:\n` +
      `${summarizeToolCall(toolName, input)}\n\n` +
      `Reply "yes ${nonce}" to allow or "no ${nonce}" to deny (auto-denies in 5 min).` +
      (other > 0
        ? `\n\n(${approvals.size} approval requests are waiting — each shows its own code; answer the one you mean.)`
        : "");
    try {
      if (ws?.connected) {
        try {
          await ws.reply({ channelType: ch.channelType, channelId: ch.channelId, content: question });
        } catch {
          // WS ack timeout / dropped socket: one HTTP retry before denying.
          await c.reply({ channelType: ch.channelType, channelId: ch.channelId, content: question });
        }
      } else {
        await c.reply({ channelType: ch.channelType, channelId: ch.channelId, content: question });
      }
    } catch (err) {
      // Fail CLOSED: the question never reached anyone. Drop the entry and deny
      // rather than silently allowing a gated tool with no human answer.
      cancel();
      log(`approval: failed to send request, denying: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
      return false;
    }
    log(`approval: requested for ${toolName} via ${ch.channelType} (#${ref}); waiting for reply`);
    return await promise;
  }

  /** If an approval is pending, consume the answering message from `fresh`
   * (so it is not forwarded to the agent) and resolve that approval. */
  function consumeApprovalReplies(fresh: ChannelMessage[]): ChannelMessage[] {
    if (approvals.size === 0) return fresh;
    const out: ChannelMessage[] = [];
    for (const m of fresh) {
      // settle() consumes only messages answering an outstanding request on
      // that channel; everything else is forwarded to the agent as before.
      if (approvals.settle({ channelId: m.channelId, from: m.from, content: m.content ?? "" })) continue;
      out.push(m);
    }
    return out;
  }

  /** Poll once and, if there are new messages, inject them into the agent. */
  async function pollAndDeliver(): Promise<void> {
    if (!poller) return;
    try {
      const messages = consumeApprovalReplies(await poller.poll());
      if (messages.length === 0) return;
      log(`delivering ${messages.length} new message(s) to the agent`);
      await queueDelivery(messages);
    } catch (err) {
      const msg = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
      log(`poll failed: ${msg}`);
    }
  }

  function startPolling(): void {
    stopPolling();
    if (!ensureClient()) {
      log("not configured — relay transport idle (run `/chaos-relay setup`)");
      return;
    }
    // Primary transport: WebSocket push. The relay sends inbound messages the
    // instant they arrive (no 15s lag), and we reply over the same socket.
    log(`connecting relay WebSocket to ${safeUrlOrigin(cfg.relayUrl)}`);
    ws = new RelayWebSocket({
      relayUrl: cfg.relayUrl,
      apiKey: cfg.apiKey!,
      log: (m) => log(m),
      onMessage: (messages) => {
        if (!poller) return;
        const fresh = consumeApprovalReplies(poller.accept(messages));
        if (fresh.length === 0) return;
        log(`delivering ${fresh.length} message(s) to the agent`);
        void queueDelivery(fresh);
      },
      // Return RAW messages (cursor advanced, NOT deduped) so the single dedup
      // happens in onMessage below. Using poller.poll() here would dedup first,
      // then onMessage's accept() would drop them all as already-seen.
      onCatchUp: async () => (poller ? await poller.pollRaw() : []),
      onAuthFailure: () => recoverApiKey(),
    });
    ws.start();
    // Safety net only: a slow poll in case a push is missed between reconnects.
    pollTimer = setInterval(() => void pollAndDeliver(), SAFETY_POLL_MS);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  // --- Lifecycle: start/stop the background poller with the session ----------

  pi.on("session_start", async (event, ctx) => {
    // A new session must never inherit turn-origin state from a previous one:
    // clear pending origins and the active turn before any async work, so a
    // concurrent turn cannot shift a stale origin into a fresh session.
    pendingOrigins = [];
    activeTurn = undefined;
    sessionReadLocalFile = false;
    if (poller) poller.reset();
    if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
    await cleanupStaleInboundAttachments();
    attachmentCleanupTimer = setInterval(
      () => void cleanupStaleInboundAttachments(),
      60 * 60 * 1000,
    );
    if (typeof attachmentCleanupTimer.unref === "function") {
      attachmentCleanupTimer.unref();
    }
    activeModelAcceptsImages = ctx.model?.input?.includes("image") ?? false;
    currentSessionId = ctx.sessionManager.getSessionId();
    const chosenProfile = chooseProfileForSession(event.reason, currentSessionId);

    // Detect concurrent pi instances on the same relay profile. Two live
    // sessions on one profile fight over the WebSocket push, but auto-creating a
    // fresh identity to dodge the collision mints a config file, keypair and
    // relay session the operator never chose — and one per collision, unbounded.
    // Refuse instead: name the profile and its lock file, and stay on the
    // previous profile (or unbound) rather than silently switching identity.
    // Claim the profile ATOMICALLY, before any connect or registration. The
    // exclusive create means exactly one of two racing processes can win, so
    // the collision refusal can no longer be defeated by the TOCTOU that
    // existed when the lock was written only after an awaited connect.
    const claim = claimProfileLock(chosenProfile);
    if (claim.lockError) {
      log(
        `session ${event.reason}: could not create the profile lock (${claim.lockError}) — ` +
          `continuing without one; concurrent sessions on this profile cannot be detected`,
      );
    }
    const decision = resolveProfileLockCollision({
      profile: chosenProfile,
      locked: !claim.claimed,
      pid: claim.pid,
      lockPath: claim.path,
    });
    if (decision.action === "refuse") {
      log(`session ${event.reason}: ${decision.message}`);
      ctx.ui.notify(decision.message, "warning");
      return;
    }
    const profile = decision.profile;

    const result = await connectAsProfile(profile, (m) => ctx.ui.notify(m, "warning"));
    if (!result.connected) {
      // The profile stays claimed: this session selected the identity, and the
      // poller keeps retrying. Releasing it here would reopen the race.
      log(`session ${event.reason}: selected profile "${profile}" but couldn't connect (will retry on next poll)`);
    } else {
      log(`session ${event.reason}: connected as profile "${profile}"`);
    }
  });

  pi.on("session_shutdown", () => {
    stopPolling();
    stopTyping();
    // Drop any undelivered turn origins and the session read taint so the
    // next session starts clean.
    pendingOrigins = [];
    activeTurn = undefined;
    sessionReadLocalFile = false;
    if (attachmentCleanupTimer) {
      clearInterval(attachmentCleanupTimer);
      attachmentCleanupTimer = undefined;
    }
    removeProfileLock(currentProfile);
  });

  pi.on("model_select", (event) => {
    activeModelAcceptsImages = event.model.input?.includes("image") ?? false;
  });

  // Show a "typing" indicator in the active channel while the agent works on a
  // relay-delivered message, and clear it when the run finishes.
  pi.on("agent_start", () => {
    // Shift this turn's origin off the queue (a terminal/local turn has none).
    // The session read taint is intentionally NOT cleared here: the LLM
    // conversation context persists across turns, so a file read in turn 1 can
    // still be text-replied out in turn 2 and must stay gated until the session
    // ends.
    activeTurn = pendingOrigins.shift() ?? undefined;
    startTyping();
  });
  pi.on("agent_end", () => {
    stopTyping();
    activeTurn = undefined;
  });

  // Tool approval: when enabled and the turn came from a channel, pause risky
  // tools and ask the user over that channel before they run.
  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown> | undefined;
    const gated = approvalNeeded(event.toolName, input);
    if (!gated) {
      // Runs ungated. A local-inspection tool (read/grep/bash) — from a channel
      // turn OR a terminal/local turn — taints the session so a later
      // channel-driven text-only relay_reply is gated (inspect -> plain-text
      // reply would otherwise exfiltrate the contents across turns).
      if (LOCAL_INSPECTION_TOOLS.has(event.toolName)) {
        sessionReadLocalFile = true;
      }
      return;
    }
    // Only turns driven from a channel require approval. A terminal/local turn
    // still runs the gated tool (no channel to ask), but an inspection tool
    // (read/grep/bash) there must also taint the session for later channel
    // turns.
    if (!activeTurn) {
      if (LOCAL_INSPECTION_TOOLS.has(event.toolName)) {
        sessionReadLocalFile = true;
      }
      return;
    }
    // Pause the typing indicator while we wait on the human.
    stopTyping();
    const approved = await requestApproval(
      event.toolName,
      input ?? {},
      activeTurn,
    );
    if (!approved) {
      return {
        block: true,
        reason:
          `The user denied this ${event.toolName} call over ${activeTurn.channelType}. ` +
          `Do not retry it; ask them what to do instead.`,
      };
    }
    // The gated tool was approved and will run: taint the session if it can
    // inspect local content (read/grep/bash), so a later channel turn still
    // cannot text-reply it out freely.
    if (LOCAL_INSPECTION_TOOLS.has(event.toolName)) {
      sessionReadLocalFile = true;
    }
  });

  // --- Tools the LLM can call ------------------------------------------------

  // relay_check_messages — pull pending inbound messages on demand.
  const checkParams = Type.Object({});
  pi.registerTool({
    name: "relay_check_messages",
    label: "CHAOS Relay: check messages",
    description:
      "Poll the chaos-relay server for new inbound Telegram/email messages. " +
      "Returns any messages received since the last check. Each message includes " +
      "an id, channelType, channelId, sender, content, and private local paths for " +
      "downloaded attachments; supported images are returned as image content. " +
      "A message sent as a reply also carries an [In reply to ...] line naming the " +
      "message it answered. Use relay_reply to respond.",
    promptSnippet: "relay_check_messages: fetch pending Telegram/email messages from chaos-relay",
    parameters: checkParams,
    async execute(_id: string, _params: Static<typeof checkParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      const c = ensureClient();
      if (!c || !poller) {
        return textResult(
          "chaos-relay is not configured. Run `/chaos-relay setup` (or set CHAOS_RELAY_API_KEY).",
        );
      }
      try {
        const messages = consumeApprovalReplies(await poller.poll());
        const hydrated = await materializeInboundAttachments(c, messages);
        const modelAcceptsImages = ctx.model?.input?.includes("image") ?? false;
        return {
          content: [
            { type: "text" as const, text: formatMessagesForAgent(hydrated.messages) },
            ...(modelAcceptsImages ? hydrated.images : []),
          ],
          details: { count: messages.length, files: hydrated.files },
        };
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_reply — send a reply back to a channel message.
  const replyParams = Type.Object({
    channelType: Type.Union(
      [
        Type.Literal("telegram"),
        Type.Literal("email"),
        Type.Literal("webhook"),
        Type.Literal("discord"),
        Type.Literal("slack"),
      ],
      { description: "Channel type from the inbound message (e.g. 'telegram' or 'email')." },
    ),
    channelId: Type.String({ description: "channelId from the inbound message. Must name a channel registered on the relay — an unknown id is REFUSED by name before anything is sent (typo-proof)." }),
    content: Type.String({ description: "The reply text to send back to the channel." }),
    replyTo: Type.Optional(
      Type.String({ description: "Optional id of the message being replied to." }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional absolute file paths to attach (images render inline on Telegram; " +
          "email gets real attachments). Max 3 files, 5MB each.",
      }),
    ),
  });
  pi.registerTool({
    name: "relay_reply",
    label: "CHAOS Relay: reply",
    description:
      "Send a reply through the chaos-relay server to a Telegram/email (or other) " +
      "channel. Pass the channelType and channelId from the inbound message, and " +
      "optionally replyTo (the inbound message id). Attach images/files with " +
      "files: [absolute paths] — Telegram shows images inline, email gets real " +
      "attachments (max 3 files, 5MB each). A channelId that names no registered " +
      "channel is REFUSED by name (nothing is stored or sent); an accepted reply " +
      "names the channel the relay actually resolved.",
    promptSnippet:
      "relay_reply: send a reply (optionally with image/file attachments) to a Telegram/email channel via chaos-relay",
    parameters: replyParams,
    async execute(_id: string, params: Static<typeof replyParams>, _signal, _onUpdate, _ctx: ExtensionContext) {
      const c = ensureClient();
      if (!c) {
        return textResult(
          "chaos-relay is not configured. Run `/chaos-relay setup` (or set CHAOS_RELAY_API_KEY).",
        );
      }
      // Read any attachments up front so path errors surface as a friendly
      // tool result instead of a mid-send failure. Pass-through: the relay
      // forwards bytes to the channel and never stores them.
      let attachments: ReplyAttachment[] | undefined;
      if (params.files?.length) {
        if (params.files.length > 3) {
          return textResult("relay_reply: too many attachments (max 3 files).");
        }
        attachments = [];
        for (const p of params.files) {
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(readFileSync(p));
          } catch (err) {
            return textResult(
              `relay_reply: cannot read attachment ${p}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (bytes.length > 5 * 1024 * 1024) {
            return textResult(
              `relay_reply: attachment ${p} is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB (max 5MB).`,
            );
          }
          attachments.push({
            filename: basename(p),
            mimeType: mimeForFile(p),
            dataBase64: base64FromBytes(bytes),
          });
        }
      }

      const transport = ws?.connected ? "WebSocket" : "HTTP";
      log(
        `relay_reply: sending to ${params.channelType}/${shortId(params.channelId)} ` +
          `replyTo=${params.replyTo ?? "none"} via ${transport} (${params.content.length} chars` +
          `${attachments?.length ? `, ${attachments.length} attachment(s)` : ""})`,
      );
      // Prefer the WebSocket (same socket the message arrived on) for instant
      // delivery; fall back to a signed HTTP POST /reply if it isn't connected
      // or the ack times out.
      if (ws?.connected) {
        try {
          const res = await ws.reply({
            channelType: params.channelType,
            channelId: params.channelId,
            content: params.content,
            replyTo: params.replyTo,
            attachments,
          });
          // A refusal (ok:false) is deterministic — the channel check failed
          // by name. Do NOT fall through to HTTP: replaying the same bad
          // target just fails again, and a fallback error would bury the
          // relay's reason. Surface it verbatim.
          if (res.ok === false) {
            // The relay's reason names the offending channel — keep the full text
            // in the tool result (TUI), but withhold it from the durable log.
            log(`relay_reply: WS ack refused (channel not accepted); see the tool result for the relay's reason`);
            return textResult(formatReplyRefusal(res), res);
          }
          log(
            `relay_reply: WS ack ok responseId=${res.responseId ?? "?"}. ` +
              `NOTE: ack means the relay RESOLVED + STORED the reply — actual ` +
              `Telegram/email delivery happens server-side and is logged there.`,
          );
          return textResult(
            formatReplyConfirmation(res, params, "WebSocket"),
            res,
          );
        } catch (err) {
          log(`relay_reply: WS reply failed, falling back to HTTP: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
        }
      }
      try {
        const res = await c.reply({
          channelType: params.channelType,
          channelId: params.channelId,
          content: params.content,
          replyTo: params.replyTo,
          attachments,
        });
        log(`relay_reply: HTTP ack ok=${(res as { ok?: boolean }).ok ?? "?"}`);
        // A non-2xx refusal arrives as a thrown RelayError (carrying the
        // relay's reason) and is handled by the catch below; a 2xx here is an
        // acceptance — confirm against what the relay named, never against
        // the request echo.
        return textResult(formatReplyConfirmation(res, params, "HTTP"), res);
      } catch (err) {
        // A 400 from the relay is a refusal by name (unknown channel, type
        // mismatch, bad content) — the relay's reason is the answer; present
        // it as a clean refusal rather than a plumbing exception. Other
        // statuses (401/429/5xx) stay thrown so auth/transport problems
        // surface as errors.
        if (err instanceof RelayError && err.status === 400) {
          // The relay's reason names the offending channel — keep the full text
          // in the tool result (TUI), but withhold it from the durable log.
          const refusal = redactUrlSecretsFromMessage(err.message);
          log(`relay_reply: HTTP refused (channel not accepted); see the tool result for the relay's reason`);
          return textResult(
            `relay_reply: REFUSED by relay — ${refusal}. Nothing was sent.`,
            { ok: false, error: refusal },
          );
        }
        log(`relay_reply: HTTP reply failed: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`);
        throw toFriendly(err);
      }
    },
  });

  // ── Channel registration helpers ──────────────────────────────────────────
  // Each registers + persists a channel and returns a human-facing summary with
  // next steps. Shared by the LLM tools AND the interactive `/chaos-relay add`
  // command so both stay in sync.
  async function addTelegram(c: RelayClient, botToken: string) {
    const res = await c.registerTelegram({ botToken, agentId: cfg.agentId });
    addChannelRecord({
      channelId: res.channelId,
      type: "telegram",
      label: res.botUsername,
      createdAt: new Date().toISOString(),
      botToken,
    });
    return {
      res,
      summary: `Telegram channel registered.\n` +
        `  channelId:   ${res.channelId}\n` +
        `  bot:         @${res.botUsername}\n` +
        `  pairingCode: ${res.pairingCode}\n\n` +
        `Next: open Telegram, message @${res.botUsername}, and send the pairing ` +
        `code "${res.pairingCode}" to finish linking.`,
    };
  }

  async function addDiscord(c: RelayClient, botToken: string) {
    const res = await c.registerDiscord({ botToken, agentId: cfg.agentId });
    addChannelRecord({
      channelId: res.channelId,
      type: "discord",
      label: res.botUsername,
      createdAt: new Date().toISOString(),
      botToken,
    });
    return {
      res,
      summary: `Discord channel registered.\n` +
        `  channelId:   ${res.channelId}\n` +
        `  bot:         ${res.botUsername}\n` +
        `  pairingCode: ${res.pairingCode}\n\n` +
        `Next: in Discord, message the bot and send the pairing code ` +
        `"${res.pairingCode}". Make sure the bot forwards events to the relay's ` +
        `/discord/${res.channelId} endpoint.`,
    };
  }

  async function addEmail(c: RelayClient, userEmail: string, channelName?: string) {
    // The relay requires a channelName (it seeds the inbound address slug);
    // default it from the email's local part.
    const name = channelName ||
      userEmail.split("@")[0].replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "").toLowerCase() ||
      cfg.agentId || "agent";
    const res = await c.registerEmail({ userEmail, agentId: cfg.agentId, channelName: name });
    addChannelRecord({
      channelId: res.channelId,
      type: "email",
      label: name,
      createdAt: new Date().toISOString(),
      userEmail,
      channelName: name,
    });
    return {
      res,
      summary: `Email channel registered (pending verification).\n` +
        `  channelId:      ${res.channelId}\n` +
        `  inboundAddress: ${res.inboundAddress}\n\n` +
        `Next: check ${userEmail} for a verification link and click it. Once ` +
        `active, email ${res.inboundAddress} to reach the agent.`,
    };
  }

  async function addWebhook(c: RelayClient, channelName?: string) {
    const res = await c.registerWebhook({ channelName });
    addChannelRecord({
      channelId: res.channelId,
      type: "webhook",
      label: channelName ?? "webhook",
      createdAt: new Date().toISOString(),
      channelName,
      webhookSecret: res.webhookSecret,
    });
    return {
      res,
      summary: `Inbound webhook channel registered.\n` +
        `  channelId: ${res.channelId}\n` +
        `  POST to:   ${res.webhookUrl}\n\n` +
        `Any service that POSTs JSON, form data, or text to that URL delivers a ` +
        `message to the agent. It is one-way (inbound) — nothing to reply to.`,
    };
  }

  /** Interactive "add a channel" wizard for the /chaos-relay command. */
  async function runAddChannel(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        'Adding a channel needs interactive UI. Either run this in interactive ' +
          'mode, or just ask the agent — e.g. "register a telegram bot, token is 123:ABC".',
        "warning",
      );
      return;
    }
    const c = await ensureConfigured((m) => ctx.ui.notify(m, "warning"));
    if (!c) {
      ctx.ui.notify(
        "Couldn't reach the chaos relay to set up your connection. Check your network and try again.",
        "warning",
      );
      return;
    }
    const kind = await ctx.ui.select(
      "Add which channel?",
      ["Telegram", "Discord", "Email", "Webhook (inbound only)"],
    );
    try {
      if (kind === "Telegram") {
        ctx.ui.notify(
          "To get a Telegram bot token: open Telegram, message @BotFather, send " +
            "/newbot, pick a name, and it replies with a token like 123456:ABC-DEF. " +
            "Paste that token next.",
          "info",
        );
        const token = await ctx.ui.input("Telegram bot token (from @BotFather)", "");
        if (!token?.trim()) return ctx.ui.notify("No token entered — cancelled.", "warning");
        ctx.ui.notify("Registering Telegram bot…", "info");
        const { summary } = await addTelegram(c, token.trim());
        ctx.ui.notify(summary, "info");
      } else if (kind === "Discord") {
        ctx.ui.notify(
          "To get a Discord bot token: go to discord.com/developers/applications, " +
            "click New Application, open the Bot tab, click Reset Token, and copy it. " +
            "Then paste it next. (After this you'll send a pairing code to the bot, " +
            "and point the bot's events at the relay — I'll show the exact URL.)",
          "info",
        );
        const token = await ctx.ui.input("Discord bot token (Developer Portal → Bot → Token)", "");
        if (!token?.trim()) return ctx.ui.notify("No token entered — cancelled.", "warning");
        ctx.ui.notify("Registering Discord bot…", "info");
        const { summary } = await addDiscord(c, token.trim());
        ctx.ui.notify(summary, "info");
      } else if (kind === "Email") {
        ctx.ui.notify(
          "Enter the email address you'll send from. I'll give you a private inbound " +
            "address and email you a verification link — click it to activate, then " +
            "anything you send to that inbound address reaches the agent.",
          "info",
        );
        const email = await ctx.ui.input("Your email address to link", "");
        if (!email?.trim()) return ctx.ui.notify("No email entered — cancelled.", "warning");
        ctx.ui.notify("Registering email channel…", "info");
        const { summary } = await addEmail(c, email.trim());
        ctx.ui.notify(summary, "info");
      } else if (kind?.startsWith("Webhook")) {
        ctx.ui.notify(
          "A webhook is a one-way inbound URL: any service that POSTs to it (GitHub, " +
            "Zapier, a cron job, your own script…) delivers a message to the agent. " +
            "You'll get the URL to paste into that service next. Give it a name so you " +
            "can recognise it later.",
          "info",
        );
        const name = await ctx.ui.input("Name for this webhook (e.g. github, cron)", "");
        ctx.ui.notify("Registering webhook…", "info");
        const { summary } = await addWebhook(c, name?.trim() || undefined);
        ctx.ui.notify(summary, "info");
      } else {
        ctx.ui.notify("Cancelled.", "info");
      }
    } catch (err) {
      ctx.ui.notify(
        `Channel registration failed: ${redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err))}`,
        "error",
      );
    }
  }

  // relay_register_telegram — register a Telegram bot channel.
  const tgParams = Type.Object({
    botToken: Type.String({
      description: "Telegram bot token from @BotFather (e.g. 123456:ABC-DEF...).",
    }),
  });
  pi.registerTool({
    name: "relay_register_telegram",
    label: "CHAOS Relay: register Telegram",
    description:
      "Register a Telegram bot as a bidirectional channel on chaos-relay. Returns " +
      "the channelId, bot username, and a pairing code. Send the pairing code to " +
      "the bot in Telegram to finish linking. Requires the relay to be configured.",
    parameters: tgParams,
    async execute(_id: string, params: Static<typeof tgParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      const c = await ensureConfigured((m) => ctx.ui.notify(m, "warning"));
      if (!c) {
        return textResult(
          "Couldn't reach the chaos relay to set up your connection. Check your network and try again.",
        );
      }
      try {
        const { res, summary } = await addTelegram(c, params.botToken);
        return textResult(summary, res);
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_register_discord — register a Discord bot channel.
  const dcParams = Type.Object({
    botToken: Type.String({
      description: "Discord bot token from the Discord Developer Portal (Bot → Token).",
    }),
  });
  pi.registerTool({
    name: "relay_register_discord",
    label: "CHAOS Relay: register Discord",
    description:
      "Register a Discord bot as a bidirectional channel on chaos-relay. Returns " +
      "the channelId, bot username, and a pairing code; send the pairing code to " +
      "the bot in Discord to finish linking. Note: Discord has no setWebhook — you " +
      "must point the bot's interaction endpoint (or a gateway relay) at the " +
      "relay's /discord/<channelId> URL. Requires the relay to be configured.",
    parameters: dcParams,
    async execute(_id: string, params: Static<typeof dcParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      const c = await ensureConfigured((m) => ctx.ui.notify(m, "warning"));
      if (!c) {
        return textResult(
          "Couldn't reach the chaos relay to set up your connection. Check your network and try again.",
        );
      }
      try {
        const { res, summary } = await addDiscord(c, params.botToken);
        return textResult(summary, res);
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_register_email — register an email channel.
  const emailParams = Type.Object({
    userEmail: Type.String({ description: "Your email address to link to this channel." }),
    channelName: Type.Optional(Type.String({ description: "Optional friendly name." })),
  });
  pi.registerTool({
    name: "relay_register_email",
    label: "CHAOS Relay: register email",
    description:
      "Register an email channel on chaos-relay. Returns the channelId and the " +
      "inbound address to email. A verification link is sent to your address; click " +
      "it to activate the channel. Requires CHAOS_EMAIL_DOMAIN on the relay server.",
    parameters: emailParams,
    async execute(_id: string, params: Static<typeof emailParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      const c = await ensureConfigured((m) => ctx.ui.notify(m, "warning"));
      if (!c) {
        return textResult(
          "Couldn't reach the chaos relay to set up your connection. Check your network and try again.",
        );
      }
      try {
        const { res, summary } = await addEmail(c, params.userEmail, params.channelName);
        return textResult(summary, res);
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_register_webhook — register an inbound (one-way) webhook channel.
  const webhookParams = Type.Object({
    channelName: Type.Optional(
      Type.String({ description: "Optional friendly name for this webhook channel." }),
    ),
  });
  pi.registerTool({
    name: "relay_register_webhook",
    label: "CHAOS Relay: register webhook",
    description:
      "Register an INBOUND (one-way) webhook channel on chaos-relay. Returns a " +
      "URL; any external service that POSTs JSON, form data, or plain text to it " +
      "delivers a message to the agent. Webhooks are inbound only — there is no " +
      "reply (don't call relay_reply for them). Requires the relay to be configured.",
    promptSnippet: "relay_register_webhook: create an inbound webhook URL that delivers messages to the agent",
    parameters: webhookParams,
    async execute(_id: string, params: Static<typeof webhookParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      const c = await ensureConfigured((m) => ctx.ui.notify(m, "warning"));
      if (!c) {
        return textResult(
          "Couldn't reach the chaos relay to set up your connection. Check your network and try again.",
        );
      }
      try {
        const { res, summary } = await addWebhook(c, params.channelName);
        return textResult(summary, res);
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_connect — one-shot: paste a token / email / "webhook" and it does it all.
  /** Provision the relay (if needed) and register whatever the input describes. */
  async function runConnect(
    input: string,
    notify?: (message: string) => void,
  ): Promise<string> {
    const plan = parseConnectInput(input);
    if (plan.kind === "unknown") return plan.reason;
    const c = await ensureConfigured(notify);
    if (!c) {
      return "Couldn't reach the chaos relay to set up your connection. Check your network and try again.";
    }
    if (plan.kind === "telegram") return (await addTelegram(c, plan.token)).summary;
    if (plan.kind === "discord") return (await addDiscord(c, plan.token)).summary;
    if (plan.kind === "email") return (await addEmail(c, plan.email)).summary;
    return (await addWebhook(c, plan.name)).summary;
  }

  const connectParams = Type.Object({
    input: Type.String({
      description:
        'One thing identifying the channel: a Telegram bot token (123456:ABC…), a ' +
        'Discord bot token, an email address, or the word "webhook" (optionally ' +
        '"webhook <name>"). Prefix with the type to disambiguate, e.g. "discord <token>".',
    }),
  });
  pi.registerTool({
    name: "relay_connect",
    label: "CHAOS Relay: connect (one-shot)",
    description:
      "One-shot connect: hand it a Telegram/Discord bot token, an email address, " +
      'or "webhook" and it sets up the relay (auto-registering your session if ' +
      "needed) AND registers the channel, returning the next step (pairing code / " +
      "verification link / webhook URL). Use this whenever the user pastes a token " +
      "or address and wants to connect — no prior /chaos-relay setup required.",
    promptSnippet:
      "relay_connect: paste a bot token / email / 'webhook' and it sets up the relay + channel in one step",
    parameters: connectParams,
    async execute(_id: string, params: Static<typeof connectParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      try {
        return textResult(await runConnect(params.input, (m) => ctx.ui.notify(m, "warning")));
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // relay_list_profiles — show the connection profiles and which is active.
  pi.registerTool({
    name: "relay_list_profiles",
    label: "CHAOS Relay: list profiles",
    description:
      "List the relay connection profiles (each is a separate identity with its " +
      "own channels) and mark the active one. Use before switching so the user " +
      "can pick.",
    parameters: Type.Object({}),
    async execute() {
      const profiles = listProfiles();
      const active = activeProfileName();
      return textResult(
        `Active profile: ${active}\nProfiles: ${profiles.map((p) => p.name).join(", ")}`,
        { profiles, active },
      );
    },
  });

  // relay_switch_profile — switch to (or create) a connection profile.
  const switchParams = Type.Object({
    name: Type.String({
      description:
        'Profile name to switch to, e.g. "work" or "home". If it doesn\'t exist ' +
        'yet it is created with a fresh identity. "default" is the base profile.',
    }),
  });
  pi.registerTool({
    name: "relay_switch_profile",
    label: "CHAOS Relay: switch profile",
    description:
      "Switch the active relay connection to a different profile, creating and " +
      "auto-provisioning it if new. Each profile is a separate identity with its " +
      "own channels and message queue. Note: this changes which single connection " +
      "this pi instance uses; to run two connections at once, launch separate pi " +
      "instances with CHAOS_RELAY_PROFILE=<name>.",
    promptSnippet:
      "relay_switch_profile: switch this pi to a different (or new) relay connection profile",
    parameters: switchParams,
    async execute(_id: string, params: Static<typeof switchParams>, _signal, _onUpdate, ctx: ExtensionContext) {
      try {
        return textResult(await switchProfile(params.name, (m) => ctx.ui.notify(m, "warning")));
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // --- /chaos-relay command --------------------------------------------------

  pi.registerCommand("chaos-relay", {
    description: "Set up and inspect the CHAOS relay bridge (subcommands: setup [--advanced], connect, profile, add, configure, status, poll, stop, approvals, reset, doctor, help)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "status";
      try {
        switch (sub) {
          case "help":
          case "--help":
          case "-h":
          case "?":
            ctx.ui.notify(renderHelp(), "info");
            break;
          case "setup":
            await runSetup(ctx, {
              advanced: parts.slice(1).some((p) =>
                ["advanced", "--advanced", "-a"].includes(p.toLowerCase())
              ),
            });
            break;
          case "connect": {
            const rest = parts.slice(1).join(" ").trim();
            if (!rest) {
              ctx.ui.notify(
                "Usage: /chaos-relay connect <telegram-token | discord-token | email | webhook [name]>\n" +
                  "Or just run /chaos-relay add for a guided wizard.",
                "info",
              );
              break;
            }
            ctx.ui.notify(await runConnect(rest, (m) => ctx.ui.notify(m, "warning")), "info");
            break;
          }
          case "profile": {
            const name = parts.slice(1).join(" ").trim();
            if (!name) {
              const profiles = listProfiles();
              const lines = profiles.map((p) =>
                `  ${p.active ? "* " : "  "}${p.name}`
              ).join("\n");
              ctx.ui.notify(
                `Connection profiles (each is a separate identity):\n${lines}\n\n` +
                  "Switch or create with /chaos-relay profile <name>. " +
                  "For two live at once, launch each instance with CHAOS_RELAY_PROFILE=<name>.",
                "info",
              );
              break;
            }
            ctx.ui.notify(await switchProfile(name, (m) => ctx.ui.notify(m, "warning")), "info");
            break;
          }
          case "add":
          case "channel":
            await runAddChannel(ctx);
            break;
          case "configure":
          case "config":
            await runConfigure(ctx);
            break;
          case "status":
            await runStatus(ctx);
            break;
          case "doctor":
            await runDoctor(ctx);
            break;
          case "reset": {
            // `/chaos-relay reset` clears the corrupted relayUrl but keeps
            // credentials/channels; `reset all` wipes everything. Accepts the
            // common --all/-y flags and is non-interactive so it works even
            // when the setup UI is unreachable.
            const flag = parts[1]?.toLowerCase();
            const all = flag === "all" || flag === "--all" || flag === "-a";
            await runReset(ctx, all);
            break;
          }
          case "poll":
            await pollAndDeliver();
            ctx.ui.notify("chaos-relay: polled for new messages.", "info");
            break;
          case "stop":
            stopPolling();
            ctx.ui.notify("chaos-relay: background poller stopped.", "info");
            break;
          case "approvals": {
            const mode = parts[1];
            if (!mode) {
              ctx.ui.notify(
                `Tool approvals: ${cfg.approvalMode}. ` +
                  `Set with /chaos-relay approvals <off|writes|all> — ` +
                  `off=autonomous, writes=ask before shell/edit/write (and text replies after reading files), all=ask before every tool.`,
                "info",
              );
              break;
            }
            if (!APPROVAL_MODES.includes(mode as ApprovalMode)) {
              ctx.ui.notify(
                `Invalid mode "${mode}". Use: off | writes | all.`,
                "warning",
              );
              break;
            }
            setApprovalMode(normalizeApprovalMode(mode));
            cfg = resolveConfig();
            ctx.ui.notify(`chaos-relay: tool approvals set to "${cfg.approvalMode}".`, "info");
            break;
          }
          default:
            ctx.ui.notify(
              `Unknown subcommand "${sub}". Run /chaos-relay help for the full list.\n\n` +
                renderHelp(),
              "warning",
            );
        }
      } catch (err) {
        const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
        ctx.ui.notify(`chaos-relay error: ${message}`, "error");
      }
    },
  });

  /**
   * Human-readable command reference for `/chaos-relay help` (and the fallback
   * shown on an unknown subcommand). Kept in lockstep with the switch above and
   * the README Commands table.
   */
  function renderHelp(): string {
    const rows: Array<[string, string]> = [
      ["setup [--advanced]", "Zero-config connect + start polling, then offer to link a channel. --advanced prompts for a custom relay URL / agent id / pasted key"],
      ["connect <token|email|webhook [name]>", "One-shot: paste a Telegram/Discord bot token, an email, or 'webhook' and it sets up the relay + registers the channel in one step"],
      ["profile [name]", "No arg lists connection profiles (each a separate identity); with a name, switches to / creates one"],
      ["add", "Guided wizard to add a channel (Telegram / Discord / email / webhook)"],
      ["configure", "Get a one-time browser link to view and manage all channels on this key (no login)"],
      ["status", "Show config, poller state, and live relay health (default when run with no subcommand)"],
      ["poll", "Poll once now and deliver any new messages"],
      ["stop", "Stop the background poller"],
      ["approvals [off|writes|all]", "Show or set the tool-approval policy — off=autonomous, writes=ask before shell/edit/write (and text replies after reading files), all=ask before every tool"],
      ["doctor", "Diagnostics: config validity, credentials, relay reachability, transport, channels"],
      ["reset [all]", "Clear a corrupted relayUrl (keeps creds/channels); 'reset all' wipes the config file"],
      ["help", "Show this command reference"],
    ];
    const width = Math.max(...rows.map(([cmd]) => cmd.length));
    const lines = rows.map(([cmd, desc]) => `  ${cmd.padEnd(width)}  ${desc}`);
    return "CHAOS relay — /chaos-relay <subcommand>\n\n" + lines.join("\n") +
      "\n\nTools (LLM-callable): relay_connect, relay_check_messages, relay_list_profiles, relay_switch_profile.\n" +
      "Run two connections at once by launching each pi with CHAOS_RELAY_PROFILE=<name>.";
  }

  /** A few playful, kebab-case names to suggest when naming a connection. */
  function suggestSessionNames(count = 3): string[] {
    const adjectives = [
      "brave", "cosmic", "mellow", "swift", "clever", "sunny", "witty", "zen",
      "turbo", "nifty", "plucky", "fuzzy", "breezy", "snappy", "jolly",
    ];
    const creatures = [
      "otter", "panda", "comet", "ferret", "maple", "robin", "pixel", "walrus",
      "gecko", "badger", "heron", "yak", "lynx", "puffin", "marmot",
    ];
    const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
    const out = new Set<string>();
    // Bounded attempts so the small word-list can't loop forever.
    for (let i = 0; out.size < count && i < count * 20; i++) {
      out.add(`${pick(adjectives)}-${pick(creatures)}`);
    }
    return [...out];
  }

  /**
   * Ask the user to NAME this connection (stored as `agentId`). It's just a
   * friendly label so you can tell apart multiple connections to chaos (e.g. one
   * per device or bot) — routing is by your keypair, not this name. Offers fun
   * suggestions so nobody has to invent (or Google) anything.
   */
  async function promptSessionName(
    ctx: ExtensionCommandContext,
    current: string,
  ): Promise<string> {
    const suggestions = suggestSessionNames(3);
    const existing = current && current !== "pi" ? [current] : [];
    const options = [...new Set([...existing, ...suggestions]), "Enter my own…"];
    const choice = await ctx.ui.select(
      "Name this connection (just a label so you can tell several apart — " +
        "e.g. one per device or bot)",
      options,
    );
    if (!choice) return current || suggestions[0]; // cancelled — keep/auto-pick
    if (choice !== "Enter my own…") return choice;
    const custom = await ctx.ui.input("Connection name", current || suggestions[0]);
    const slug = (custom || "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || current || suggestions[0];
  }

  /**
   * Interactive setup: confirm/register a relay session, persist credentials,
   * and (re)start the poller. Telegram/email registration is left to the
   * dedicated tools/skills so the agent can drive it conversationally.
   */
  async function runSetup(
    ctx: ExtensionCommandContext,
    opts: { advanced?: boolean } = {},
  ): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Setup needs interactive UI. Set CHAOS_RELAY_URL and CHAOS_RELAY_API_KEY env vars instead.",
        "warning",
      );
      return;
    }

    const persisted = loadPersisted();

    // The common case needs ZERO config: a user shouldn't have to know what a
    // "relay URL" or an "agent id" is, or choose an auth scheme. Default to the
    // hosted relay and auto-register an ECDSA session — but honour
    // CHAOS_RELAY_URL when the operator set it, so registration and transport
    // never disagree. `--advanced` exposes the URL / agent-id / paste-key
    // prompts for self-hosters.
    let relayUrl = resolveConfig(persisted).relayUrl;
    let agentId = persisted.agentId ?? "pi";
    let apiKey = persisted.apiKey;
    let userId = persisted.userId;
    let keyPair = persisted.keyPair;
    let serverPublicKey = persisted.serverPublicKey;

    if (opts.advanced) {
      // Re-prompt for the relay URL until it's a valid absolute http(s) URL, so
      // malformed values can't be persisted and break every later request.
      relayUrl = (await ctx.ui.input("Relay URL", relayUrl)) || relayUrl;
      while (!isValidRelayUrl(relayUrl)) {
        ctx.ui.notify(
          "That is not a valid URL. Include the scheme, e.g. https://chaos-relay.com",
          "warning",
        );
        relayUrl = (await ctx.ui.input(
          "Relay URL (must start with http:// or https://)",
          DEFAULT_RELAY_URL,
        )) || DEFAULT_RELAY_URL;
      }

      agentId = await promptSessionName(ctx, agentId);

      const haveKey = Boolean(apiKey);
      const action = await ctx.ui.select(
        haveKey ? "Relay credentials" : "No API key found",
        haveKey
          ? ["Keep existing API key", "Register a new session (ECDSA)", "Paste an existing API key"]
          : ["Register a new session (ECDSA)", "Paste an existing API key"],
      );
      if (action === "Register a new session (ECDSA)") {
        ctx.ui.notify("Generating ECDSA keypair and registering session...", "info");
        const reg = await registerSessionWithKey(relayUrl, { keyPair });
        const pin = resolveServerKeyPin({ pinned: serverPublicKey, fresh: reg.serverPublicKey });
        if (pin.action === "refuse") {
          ctx.ui.notify(pin.message, "warning");
          return;
        }
        apiKey = reg.apiKey;
        userId = reg.userId;
        keyPair = reg.keyPair;
        serverPublicKey = pin.serverPublicKey;
        ctx.ui.notify(`Registered with ECDSA identity. userId=${userId}`, "info");
      } else if (action === "Paste an existing API key") {
        const pasted = await ctx.ui.input("Paste relay API key", "");
        if (pasted) apiKey = pasted.trim();
      }
    } else if (!apiKey) {
      // Default zero-config path: provision a private session automatically.
      // Deliberately differs from the silent auto-provision refusal in
      // ensureConfigured(): this is an EXPLICIT interactive action (the user ran
      // /chaos-relay setup), so a malformed CHAOS_RELAY_URL falls through to the
      // default here rather than refusing — the user sees the result on screen.
      ctx.ui.notify("Setting up your private relay connection…", "info");
      const reg = await registerSessionWithKey(relayUrl, { keyPair });
      const pin = resolveServerKeyPin({ pinned: serverPublicKey, fresh: reg.serverPublicKey });
      if (pin.action === "refuse") {
        ctx.ui.notify(pin.message, "warning");
        return;
      }
      apiKey = reg.apiKey;
      userId = reg.userId;
      keyPair = reg.keyPair;
      serverPublicKey = pin.serverPublicKey;
    }

    if (!apiKey) {
      ctx.ui.notify("Couldn't set up the relay connection — try again.", "warning");
      return;
    }

    // Persist credentials AND the keypair (the keypair is the secret identity;
    // it lives only in this 0600 file under ~/.pi and is never committed).
    savePersisted({ relayUrl, agentId, apiKey, userId, keyPair, serverPublicKey });

    // Verify reachability before declaring success.
    try {
      const verify = new RelayClient({ relayUrl, apiKey, keyPair });
      const h = await verify.health();
      ctx.ui.notify(`Relay reachable (status=${h.status}). Credentials saved.`, "info");
    } catch (err) {
      const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
      ctx.ui.notify(`Saved, but health check failed: ${message}`, "warning");
    }

    client = undefined;
    startPolling();
    ctx.ui.notify(
      "You're connected to the relay. Next, link a place to chat from " +
        "(Telegram, Discord, email, or a webhook).",
      "info",
    );

    // Onboarding: offer to link the first channel right now rather than leaving
    // the user to discover the tools/command on their own.
    const addNow = await ctx.ui.select(
      "Link a chat channel now?",
      ["Yes — link one now", "Not yet"],
    );
    if (addNow === "Yes — link one now") {
      await runAddChannel(ctx);
    } else {
      ctx.ui.notify(
        "No problem. When you're ready, just tell me in plain English — e.g. " +
          '"connect my Telegram" — and I\'ll walk you through it. ' +
          "(Or run /chaos-relay add.)",
        "info",
      );
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  }

  function renderCallableChannel(channel: unknown): string {
    const ch = asRecord(channel) ?? {};
    const metadata = asRecord(ch.metadata) ?? {};
    const type = asString(ch.type) ?? asString(ch.channelType) ?? "channel";
    const id = asString(ch.id) ?? asString(ch.channelId) ?? "(unknown id)";
    const label = asString(ch.label) ?? asString(ch.name) ?? asString(ch.channelName);
    const enabled = ch.enabled === false ? " [disabled]" : "";
    const prefix = `  - ${type} ${id}${label ? ` (${label})` : ""}${enabled} — `;

    if (type === "email") {
      const inboundAddress = asString(metadata.inboundAddress) ?? asString(ch.inboundAddress);
      const userEmail = asString(metadata.userEmail) ?? asString(ch.userEmail);
      const allowedSenders = asStringArray(metadata.allowedSenders);
      const sender = userEmail ?? allowedSenders[0];
      const verified = metadata.verified === false ? " (not verified yet)" : "";
      if (inboundAddress) {
        return `${prefix}send email${sender ? ` from ${sender}` : ""} to ${inboundAddress}${verified}`;
      }
      return `${prefix}email channel${sender ? ` for ${sender}` : ""}; relay did not return an inbound address${verified}`;
    }

    if (type === "telegram") {
      const botUsername = asString(metadata.botUsername) ?? asString(ch.botUsername);
      const allowedUsers = asStringArray(metadata.allowedUsers);
      return `${prefix}${botUsername ? `message @${botUsername}` : "message the registered Telegram bot"}${
        allowedUsers.length ? ` (allowed users: ${allowedUsers.join(", ")})` : ""
      }`;
    }

    if (type === "discord") {
      const botUsername = asString(metadata.botUsername) ?? asString(ch.botUsername);
      return `${prefix}${botUsername ? `message the Discord bot ${botUsername}` : "message the configured Discord bot/channel"}`;
    }

    if (type === "webhook") {
      const webhookUrl = asString(metadata.webhookUrl) ?? asString(ch.webhookUrl);
      return `${prefix}${
        webhookUrl
          ? `POST to ${webhookUrl}`
          : "POST to the webhook URL returned when the channel was registered (the relay did not return it in status)"
      }`;
    }

    return `${prefix}send a message through this ${type} channel`;
  }

  async function runStatus(ctx: ExtensionCommandContext): Promise<void> {
    const current = resolveConfig();
    const lines = [
      `extension:     pi-chaos-relay v${PACKAGE_VERSION}`,
      `config file:   ${getConfigPath()}`,
      `relayUrl:      ${safeUrlOrigin(current.relayUrl)}`,
      `connection:    ${current.agentId} (this session's name)`,
      `identity:      ${current.keyPair ? "ECDSA P-256 keypair (durable identity)" : "Bearer-only (legacy, no keypair)"}`,
      `apiKey:        ${
        current.apiKey
          ? (current.keyPair ? "cached (auto-issued from your ECDSA key)" : "set")
          : (current.keyPair ? "not cached — auto-issued from your ECDSA key on connect" : "MISSING (run /chaos-relay setup)")
      }`,
      `userId:        ${current.userId ?? "(unknown)"}`,
      `transport:     WebSocket (${ws?.connected ? "connected" : ws ? "connecting/reconnecting" : "stopped"}) + ${SAFETY_POLL_MS}ms safety poll`,
      `approvals:     ${current.approvalMode} (off=autonomous, writes=shell/edit/write + replies after reads, all=every tool)`,
      `local channels:${current.channels.length ? ` ${current.channels.length} cached record(s)` : " none"}`,
    ];
    for (const ch of current.channels) {
      const label = ch.label ?? ch.channelName ?? ch.userEmail;
      lines.push(`  - local ${ch.type} ${ch.channelId}${label ? ` (${label})` : ""}`);
    }
    // Live reachability + callable channel details from the relay, if configured.
    if (current.apiKey) {
      try {
        const c = new RelayClient({
          relayUrl: current.relayUrl,
          apiKey: current.apiKey,
          keyPair: current.keyPair,
        });
        const h = await c.health();
        lines.push(`relay health:  ${h.status}${h.version ? ` (v${h.version})` : ""}`);
        try {
          const live = await c.listChannels();
          const liveChannels = Array.isArray(live.channels) ? live.channels : [];
          lines.push(`relay channels:${liveChannels.length ? ` ${liveChannels.length} live` : " none live"}`);
          if (liveChannels.length) {
            for (const ch of liveChannels) lines.push(renderCallableChannel(ch));
          } else if (current.channels.length) {
            lines.push(
              "  - warning: this profile has cached local channel records, but the relay returned no live channels. " +
                "They may be stale; re-register with /chaos-relay add or /chaos-relay connect <email|token|webhook>.",
            );
          }
        } catch (err) {
          const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
          lines.push(`relay channels: unavailable — ${message}`);
        }
      } catch (err) {
        const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
        lines.push(`relay health:  unreachable — ${message}`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
  }

  /**
   * Non-interactive config reset. Used to recover from a corrupted config
   * (e.g. a bad relayUrl that bricks every request) without needing the
   * setup UI. `all=false` clears just the relayUrl; `all=true` wipes the file.
   */
  async function runReset(ctx: ExtensionCommandContext, all: boolean): Promise<void> {
    const before = loadPersisted();
    const hadUrl = Boolean(before.relayUrl);
    const hadKey = Boolean(before.apiKey);
    stopPolling();
    client = undefined;
    resetPersisted(all ? "all" : "url");
    cfg = resolveConfig();
    if (all) {
      ctx.ui.notify(
        `chaos-relay: reset complete. Config file removed (${getConfigPath()}). ` +
          `Run /chaos-relay setup to start fresh.`,
        "info",
      );
    } else {
      const kept = [
        hadKey ? "apiKey/keypair" : null,
        before.channels?.length ? `${before.channels.length} channel(s)` : null,
      ].filter(Boolean).join(", ");
      ctx.ui.notify(
        `chaos-relay: cleared relayUrl${hadUrl ? ` (was ${safeUrlOrigin(before.relayUrl)})` : ""}. ` +
          `Kept: ${kept || "nothing else was set"}. ` +
          `Run /chaos-relay setup to re-enter the URL, or /chaos-relay doctor to diagnose.`,
        "info",
      );
    }
  }

  /**
   * Diagnostics: a structured check-list of config validity, credential
   * state, relay reachability, transport state, and channels. Non-interactive;
   * safe to run in any state. Designed to be the first thing to run when
   * something is wrong — including the "Failed to parse URL" failure mode.
   */
  /**
   * `/chaos-relay configure` — mint a one-time link to the browser admin app so
   * the user can see and manage all the channels on this key (multiple bots,
   * emails, webhooks). No login: the link carries a short-lived token tied to
   * this ECDSA identity.
   */
  async function runConfigure(ctx: ExtensionCommandContext): Promise<void> {
    const c = ensureClient();
    if (!c) {
      ctx.ui.notify(
        "chaos-relay is not configured. Run `/chaos-relay setup` first.",
        "warning",
      );
      return;
    }
    try {
      const link = await c.deviceLink();
      const mins = Math.max(1, Math.round(link.expiresInSeconds / 60));
      ctx.ui.notify(
        `Open this link to manage your channels in the browser (valid ~${mins} min, one-time):\n\n${link.url}\n\n` +
          "No login needed — the link is tied to this key. You can add/remove multiple bots, emails, and webhooks there.",
        "info",
      );
    } catch (err) {
      const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
      ctx.ui.notify(
        `Couldn't create a configure link: ${message}. Check the relay connection with /chaos-relay status.`,
        "warning",
      );
    }
  }

  async function runDoctor(ctx: ExtensionCommandContext): Promise<void> {
    const checks: Array<{ ok: boolean; label: string; detail?: string; fix?: string }> = [];
    const mark = (ok: boolean) => (ok ? "✓" : "✗");

    // 1. Config file exists and parses. loadPersisted never throws (a corrupt
    // file degrades to defaults with a warning), so ask readPersisted which
    // case we are in rather than treating "did not throw" as "parses".
    const read = readPersisted();
    const persisted: ReturnType<typeof loadPersisted> = read.config;
    if (read.corrupt) {
      checks.push({
        ok: false,
        label: "config file parses",
        detail: read.corrupt.reason,
        fix: "Run /chaos-relay reset all, then /chaos-relay setup.",
      });
    } else {
      checks.push({
        ok: true,
        label: `config file (${getConfigPath()})`,
        detail: "present and parses",
      });
    }

    // 2. relayUrl validity — the exact failure mode this doctor targets.
    const envUrl = process.env.CHAOS_RELAY_URL;
    const effectiveUrl = resolveConfig().relayUrl;
    const urlOk = isValidRelayUrl(effectiveUrl);
    const persistedUrl = persisted.relayUrl;
    // Origin-only display: the raw URL values can carry credentials in userinfo
    // or be a pasted secret, so never echo them (safeUrlOrigin strips userinfo
    // and path/query, and renders a malformed value as "<invalid>").
    const urlDetail = [
      `effective=${safeUrlOrigin(effectiveUrl)}`,
      envUrl ? `env=${safeUrlOrigin(envUrl)}` : null,
      persistedUrl ? `file=${safeUrlOrigin(persistedUrl)}` : null,
    ].filter(Boolean).join(", ");
    checks.push({
      ok: urlOk,
      label: "relay URL is valid http(s)",
      detail: urlDetail,
      fix: urlOk
        ? undefined
        : "Run /chaos-relay reset to clear the bad URL, then /chaos-relay setup.",
    });

    // 3. Identity + session token.
    // The ECDSA keypair is the durable identity. The Bearer API key is just a
    // session token AUTO-ISSUED from that keypair — you never supply it or need
    // to keep it; if it's absent or stale the client re-issues it from the
    // keypair on the next connect. So with a keypair present, a missing API key
    // is NOT an error.
    const current = resolveConfig();
    const hasKeyPair = Boolean(current.keyPair);
    const hasApiKey = Boolean(current.apiKey);

    checks.push({
      ok: hasKeyPair,
      label: "ECDSA identity (keypair)",
      detail: hasKeyPair
        ? "present — your durable identity; the API key is auto-derived from it"
        : "missing",
      fix: hasKeyPair ? undefined : "Run /chaos-relay setup to generate one.",
    });

    if (hasKeyPair) {
      // With a keypair the API key is disposable/auto-recovered — never an error.
      checks.push({
        ok: true,
        label: "session API key",
        detail: hasApiKey
          ? "cached (auto-issued from your ECDSA key)"
          : "not cached yet — auto-issued from your ECDSA key on next connect",
      });
    } else {
      // Legacy Bearer-only: the API key is the only credential, so it's required.
      checks.push({
        ok: hasApiKey,
        label: "session API key (Bearer-only, no keypair)",
        detail: hasApiKey ? "set" : "MISSING",
        fix: hasApiKey ? undefined : "Run /chaos-relay setup.",
      });
    }

    // 4. Reachability — /health is unauthenticated, so a valid URL is enough.
    if (urlOk) {
      try {
        const c = new RelayClient({
          relayUrl: current.relayUrl,
          apiKey: current.apiKey ?? "",
          keyPair: current.keyPair,
        });
        const h = await c.health();
        checks.push({
          ok: true,
          label: "relay reachable",
          detail: `health=${h.status}${h.version ? ` (v${h.version})` : ""}`,
        });
      } catch (err) {
        const message = redactUrlSecretsFromMessage(err instanceof Error ? err.message : String(err));
        checks.push({
          ok: false,
          label: "relay reachable",
          detail: message,
          fix: "Check the URL, your network, or run /chaos-relay setup again.",
        });
      }
    }

    // 5. Transport state.
    checks.push({
      ok: Boolean(ws?.connected),
      label: "WebSocket transport",
      detail: ws?.connected
        ? "connected"
        : ws
          ? "connecting/reconnecting"
          : "stopped (polling safety net only)",
    });

    // 6. Channels.
    const ch = current.channels ?? [];
    checks.push({
      ok: ch.length > 0,
      label: "channels registered",
      detail: ch.length
        ? ch.map((c) => `${c.type}:${c.channelId.slice(0, 8)}`).join(", ")
        : "none — run /chaos-relay add",
    });

    // Render.
    const lines = checks.map((c) => {
      const base = `  ${mark(c.ok)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
      return c.fix ? `${base}\n     → ${c.fix}` : base;
    });
    const allOk = checks.every((c) => c.ok);
    const summary = allOk
      ? "chaos-relay doctor: all checks passed."
      : `chaos-relay doctor: ${checks.filter((c) => !c.ok).length} issue(s) found above.`;
    ctx.ui.notify([summary, ...lines].join("\n"), allOk ? "info" : "warning");
  }

  // Print a short getting-started guide to the terminal when the extension
  // loads, so a new user knows the setup → add-channel → chat flow without
  // having to read the docs.
  function logGettingStarted(): void {
    if (!isConfigured(cfg)) {
      log(
        "\n" +
          "  ┌─ chaos-relay ─ drive this pi agent from Telegram / Discord / email / webhooks\n" +
          "  │  Not set up yet. Three steps:\n" +
          "  │   1. /chaos-relay setup   — connect to the relay (registers a session)\n" +
          "  │   2. /chaos-relay add     — add a channel (Telegram bot, email, …)\n" +
          "  │   3. message that channel — it reaches the agent, which replies back\n" +
          "  │  Then: /chaos-relay status · /chaos-relay approvals <off|writes|all>\n" +
          "  └─",
      );
      return;
    }
    const n = cfg.channels.length;
    if (n === 0) {
      log(
        "chaos-relay connected, but no channels yet. Run /chaos-relay add to add one " +
          "(Telegram / Discord / email / webhook) — or just ask the agent to register one.",
      );
    } else {
      log(
        `chaos-relay active — ${n} channel(s), approvals=${cfg.approvalMode}. ` +
          "Add more with /chaos-relay add; inspect with /chaos-relay status.",
      );
    }
  }

  logGettingStarted();
}

/** Turn relay errors into agent-friendly Error messages, with any embedded
 *  URL secrets redacted so they never reach the LLM tool response or the
 *  conversation transcript. */
export function toFriendly(err: unknown): Error {
  if (err instanceof RelayError) {
    return new Error(redactUrlSecretsFromMessage(err.message));
  }
  if (err instanceof Error) {
    return new Error(redactUrlSecretsFromMessage(err.message));
  }
  return new Error(redactUrlSecretsFromMessage(String(err)));
}

// Re-export types for consumers/tests.
export type { ChannelMessage } from "./relay-client.ts";
