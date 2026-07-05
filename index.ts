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
import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";
import {
  addChannelRecord,
  DEFAULT_RELAY_URL,
  isConfigured,
  isValidRelayUrl,
  APPROVAL_MODES,
  type ApprovalMode,
  loadPersisted,
  normalizeApprovalMode,
  resetPersisted,
  resolveConfig,
  savePersisted,
  setApprovalMode,
  setChannelRecords,
  setMessagesCursor,
  setSeenMessageIds,
  getConfigPath,
  setActiveConfigPath,
  profilePathForName,
  profileNameForPath,
  activeProfileName,
  listProfiles,
  envProfileName,
  getSessionProfile,
  setSessionProfile,
  chooseProfile,
  type ResolvedConfig,
  type RegisteredChannelRecord,
} from "./config.ts";
import { MessagePoller, formatMessagesForAgent } from "./poller.ts";
import { RelayWebSocket } from "./ws-client.ts";
import { parseConnectInput } from "./connect.ts";

/**
 * Slow safety poll. The WebSocket is the primary transport (instant push);
 * this only runs as a backstop in case a push is missed between reconnects.
 */
const SAFETY_POLL_MS = 120_000;

const LOG_PREFIX = "[pi-chaos-relay]";
const RELAY_LOG_DIR = join(homedir(), ".pi", "agent", "logs");
const RELAY_LOG_FILE = join(RELAY_LOG_DIR, "chaos-relay.log");

/** Relay logs are routed to a file ONLY. They must NOT go to stderr, because pi
 *  renders extension stderr into the TUI prompt/input area, which is noisy
 *  (e.g. the "WebSocket connected" banner on every (re)connect). Tail
 *  ~/.pi/agent/logs/chaos-relay.log to see them. */
function log(message: string, ...rest: unknown[]): void {
  const line = `${LOG_PREFIX} ${message}${rest.length ? " " + rest.map((r) => String(r)).join(" ") : ""}`;
  try {
    mkdirSync(RELAY_LOG_DIR, { recursive: true });
    appendFileSync(RELAY_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* never throw from logging */
  }
}

// ── Profile lock: detect concurrent pi instances on the same relay profile ──

function lockFilePath(profile: string): string {
  return join(homedir(), ".pi", `chaos-relay-${profile}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Check if another live pi process holds the lock for this profile. */
function checkProfileLock(profile: string): { locked: boolean; pid: number | null } {
  const path = lockFilePath(profile);
  if (!existsSync(path)) return { locked: false, pid: null };
  try {
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (isNaN(pid)) return { locked: false, pid: null };
    if (pid !== process.pid && isProcessAlive(pid)) return { locked: true, pid };
    // Stale lock (process died) — clean it
    try { unlinkSync(path); } catch { /* ignore */ }
    return { locked: false, pid: null };
  } catch { return { locked: false, pid: null }; }
}

/** Claim this profile for the current process. */
function writeProfileLock(profile: string): void {
  try { writeFileSync(lockFilePath(profile), String(process.pid)); } catch { /* ignore */ }
}

/** Release the profile lock on shutdown. */
function removeProfileLock(profile: string): void {
  try { unlinkSync(lockFilePath(profile)); } catch { /* ignore */ }
}

/** Generate a unique profile name for a concurrent session. */
function generateUniqueProfileName(): string {
  const host = hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12) || "pi";
  const shortPid = (process.pid % 10000).toString(36);
  return `${host}-${shortPid}`;
}

/** Wrap text content into the AgentToolResult shape pi expects. */
function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function chaosRelayExtension(pi: ExtensionAPI): void {
  let client: RelayClient | undefined;
  let poller: MessagePoller | undefined;
  let ws: RelayWebSocket | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
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
  let lastChannel:
    | { channelType: ChannelMessage["channelType"]; channelId: string }
    | undefined;
  let relayInputSinceIdle = false;

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
      savePersisted({
        apiKey: reg.apiKey,
        userId: reg.userId,
        keyPair: reg.keyPair,
        serverPublicKey: reg.serverPublicKey ?? persisted.serverPublicKey,
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
      log(`auth recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Re-register persisted channels against the current (new) session and update
   * their stored channelIds. Telegram/email re-registration is automatic, but
   * the relay issues a fresh pairing code / verification step for security — so
   * we surface that to the user (log + a message injected into the agent) to
   * complete the one manual step. Channels without stored re-bind material are
   * skipped with a note.
   */
  async function rebindChannels(): Promise<void> {
    const c = client;
    if (!c) return;
    const records = loadPersisted().channels ?? [];
    if (records.length === 0) return;
    const updated: RegisteredChannelRecord[] = [];
    const notes: string[] = [];
    for (const rec of records) {
      try {
        if (rec.type === "telegram" && rec.botToken) {
          const res = await c.registerTelegram({ botToken: rec.botToken, agentId: cfg.agentId });
          updated.push({ ...rec, channelId: res.channelId, label: res.botUsername });
          notes.push(
            `Telegram @${res.botUsername}: re-registered. Send the pairing code "${res.pairingCode}" to the bot to re-link this chat.`,
          );
        } else if (rec.type === "email" && rec.userEmail) {
          const res = await c.registerEmail({
            userEmail: rec.userEmail,
            agentId: cfg.agentId,
            channelName: rec.channelName,
          });
          updated.push({ ...rec, channelId: res.channelId });
          notes.push(
            `Email ${rec.userEmail}: re-registered. Check your inbox and click the verification link to reactivate (then email ${res.inboundAddress}).`,
          );
        } else if (rec.type === "discord" && rec.botToken) {
          const res = await c.registerDiscord({ botToken: rec.botToken, agentId: cfg.agentId });
          updated.push({ ...rec, channelId: res.channelId, label: res.botUsername });
          notes.push(
            `Discord ${res.botUsername}: re-registered. Send the pairing code "${res.pairingCode}" to the bot to re-link this channel.`,
          );
        } else if (rec.type === "webhook") {
          // Recreate with the same id + secret so the public URL is unchanged.
          const res = await c.registerWebhook({
            id: rec.channelId,
            webhookSecret: rec.webhookSecret,
            channelName: rec.channelName,
          });
          updated.push({ ...rec, channelId: res.channelId });
          notes.push(
            `Webhook ${rec.label ?? rec.channelId}: re-registered. URL unchanged — ${res.webhookUrl}`,
          );
        } else {
          updated.push(rec); // no re-bind material — keep the record, note it
          notes.push(
            `${rec.type} channel ${rec.label ?? rec.channelId}: could not auto re-bind (no stored ${rec.type === "telegram" ? "bot token" : "email"}). Re-add it with /chaos-relay or the relay_register_* tool.`,
          );
        }
      } catch (err) {
        updated.push(rec);
        notes.push(
          `${rec.type} channel ${rec.label ?? rec.channelId}: re-bind failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    setChannelRecords(updated);
    cfg = resolveConfig();
    if (notes.length > 0) {
      const summary =
        "chaos-relay recovered a new session after the relay lost the old one. " +
        "Channel re-binding status (some need a quick manual step):\n- " +
        notes.join("\n- ");
      log(summary);
      // Surface to the user via the agent so they can complete pairing/verification.
      try {
        pi.sendUserMessage(summary);
      } catch {
        /* agent may not be ready to receive — the log still records it */
      }
    }
  }

  /** (Re)build the relay client from current config. Returns undefined if no API key. */
  // Create a poller that resumes from the persisted cursor and writes the
  // cursor back as it advances, so a restart doesn't re-read the relay backlog.
  function makePoller(c: RelayClient): MessagePoller {
    const persisted = loadPersisted();
    return new MessagePoller(c, {
      since: persisted.messagesCursor,
      // Persisting the resume cursor is best-effort and runs on the WebSocket
      // message-delivery path — never let a disk error here become an
      // uncaughtException that kills pi. Losing a cursor update at worst
      // re-reads a little backlog; the de-dup log filters the rest.
      onAdvance: (s) => {
        try {
          setMessagesCursor(s);
        } catch (err) {
          log(`WARN: failed to persist resume cursor: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      // Restore + persist the de-dup log so restarts don't re-process the
      // relay's on-connect message replay.
      seen: persisted.seenMessageIds,
      onSeen: (ids) => {
        try {
          setSeenMessageIds(ids);
        } catch (err) {
          log(`WARN: failed to persist seen-message log: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
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
        `connecting to relay ${cfg.relayUrl} as agentId="${cfg.agentId}" (${identity})`,
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
   * Like {@link ensureClient}, but if the relay isn't configured yet it
   * auto-provisions a session (ECDSA keypair at the default relay URL) WITHOUT
   * any interactive setup. This lets the agent fulfil requests like "register my
   * telegram bot 123:ABC" directly — the user never has to run /chaos-relay setup
   * or know what a relay URL is. Returns undefined only if provisioning fails
   * (e.g. the relay is unreachable).
   */
  async function ensureConfigured(): Promise<RelayClient | undefined> {
    const existing = ensureClient();
    if (existing) return existing;

    const persisted = loadPersisted();
    const relayUrl = isValidRelayUrl(persisted.relayUrl ?? "")
      ? persisted.relayUrl!
      : DEFAULT_RELAY_URL;
    try {
      // Reuse any existing keypair so the identity (and its channels) stay stable.
      const reg = await registerSessionWithKey(relayUrl, { keyPair: persisted.keyPair });
      savePersisted({
        relayUrl,
        agentId: persisted.agentId ?? "pi",
        apiKey: reg.apiKey,
        userId: reg.userId,
        keyPair: reg.keyPair,
        serverPublicKey: reg.serverPublicKey ?? persisted.serverPublicKey,
      });
      cfg = resolveConfig();
      client = undefined;
      startPolling();
      log(`auto-provisioned relay session userId=${reg.userId} at ${relayUrl}`);
      return ensureClient();
    } catch (err) {
      log(`auto-provision failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Connect this process as the named profile: re-point config at its file,
   * reconnect as that identity (auto-provisioning if new), restart polling, and
   * bind the current pi session to it (so a resume reconnects the same way).
   * Returns whether the profile was freshly created.
   */
  async function connectAsProfile(name: string): Promise<{ isNew: boolean; connected: boolean }> {
    stopPolling();
    client = undefined;
    poller = undefined;
    setActiveConfigPath(profilePathForName(name));
    cfg = resolveConfig();
    currentProfile = activeProfileName();
    // Bind the active session → this profile so resume/reload restore it.
    setSessionProfile(currentSessionId, currentProfile);

    const isNew = !isConfigured(cfg);
    const c = await ensureConfigured(); // provisions a fresh identity if new
    if (!c) return { isNew, connected: false };
    startPolling(); // ensure the poller runs for an already-provisioned profile too
    cfg = resolveConfig();
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
  async function switchProfile(name: string): Promise<string> {
    const slug = profileNameForPath(profilePathForName(name));
    if (profilePathForName(name) === getConfigPath()) {
      return `Already on profile "${slug}".`;
    }
    const { isNew, connected } = await connectAsProfile(name);
    if (!connected) {
      return `Switched config to profile "${slug}" but couldn't reach the relay to connect — check your network, then /chaos-relay status.`;
    }
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
  function deliverToAgent(messages: ChannelMessage[]): void {
    // Remember where the latest message came from so we can show a typing
    // indicator there while the agent works on it.
    const last = messages[messages.length - 1];
    if (last) {
      lastChannel = { channelType: last.channelType, channelId: last.channelId };
      relayInputSinceIdle = true;
    }
    pi.sendUserMessage(formatMessagesForAgent(messages), { deliverAs: "followUp" });
  }

  /** Repeatedly send a "typing" indicator to the active channel until stopped. */
  function startTyping(): void {
    stopTyping();
    if (!relayInputSinceIdle || !lastChannel) return;
    const c = ensureClient();
    if (!c) return;
    const ch = lastChannel;
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
  const RISKY_WRITE_TOOLS = new Set(["bash", "edit", "write"]);
  let pendingApproval:
    | { channelId: string; resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;

  function approvalNeeded(toolName: string): boolean {
    if (cfg.approvalMode === "off") return false;
    // Never gate the relay's own plumbing (relay_reply etc.) — gating it would
    // deadlock the very channel we ask over.
    if (toolName.startsWith("relay_")) return false;
    if (cfg.approvalMode === "all") return true;
    return RISKY_WRITE_TOOLS.has(toolName); // "writes"
  }

  function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "bash") return `bash: ${String(input.command ?? "").slice(0, 300)}`;
    if (toolName === "edit" || toolName === "write") {
      return `${toolName}: ${String(input.path ?? input.file_path ?? "")}`;
    }
    const j = JSON.stringify(input ?? {});
    return `${toolName}: ${j.length > 300 ? j.slice(0, 300) + "…" : j}`;
  }

  /** Ask the channel to approve a tool call; resolves true=allow, false=deny. */
  async function requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    ch: { channelType: ChannelMessage["channelType"]; channelId: string },
  ): Promise<boolean> {
    const c = ensureClient();
    if (!c) return true; // can't ask → don't block
    const question = `⚠️ Approval needed — the agent wants to run:\n` +
      `${summarizeToolCall(toolName, input)}\n\n` +
      `Reply "yes" to allow or "no" to deny (auto-denies in 5 min).`;
    try {
      if (ws?.connected) {
        await ws.reply({ channelType: ch.channelType, channelId: ch.channelId, content: question });
      } else {
        await c.reply({ channelType: ch.channelType, channelId: ch.channelId, content: question });
      }
    } catch (err) {
      log(`approval: failed to send request, allowing by default: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
    log(`approval: requested for ${toolName} via ${ch.channelType}; waiting for reply`);
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingApproval) {
          pendingApproval = undefined;
          log("approval: timed out → denied");
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      pendingApproval = { channelId: ch.channelId, resolve, timer };
    });
  }

  /** If an approval is pending, consume the answering message from `fresh`
   * (so it is not forwarded to the agent) and resolve the approval. */
  function consumeApprovalReplies(fresh: ChannelMessage[]): ChannelMessage[] {
    if (!pendingApproval) return fresh;
    const out: ChannelMessage[] = [];
    for (const m of fresh) {
      if (pendingApproval && m.channelId === pendingApproval.channelId) {
        const approved = /^\s*(y|yes|yep|ok|okay|approve|allow|sure|do it)\b/i
          .test(m.content ?? "");
        clearTimeout(pendingApproval.timer);
        const resolve = pendingApproval.resolve;
        pendingApproval = undefined;
        log(`approval: reply "${(m.content ?? "").slice(0, 24)}" → ${approved ? "approved" : "denied"}`);
        resolve(approved);
        continue; // consume — do not forward to the agent
      }
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
      deliverToAgent(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    log(`connecting relay WebSocket to ${cfg.relayUrl}`);
    ws = new RelayWebSocket({
      relayUrl: cfg.relayUrl,
      apiKey: cfg.apiKey!,
      log: (m) => log(m),
      onMessage: (messages) => {
        if (!poller) return;
        const fresh = consumeApprovalReplies(poller.accept(messages));
        if (fresh.length === 0) return;
        log(`delivering ${fresh.length} message(s) to the agent`);
        deliverToAgent(fresh);
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
    if (poller) poller.reset();
    currentSessionId = ctx.sessionManager.getSessionId();
    let profile = chooseProfileForSession(event.reason, currentSessionId);

    // Detect concurrent pi instances on the same relay profile. If another
    // live process holds the lock, auto-create a new profile so both sessions
    // get independent push delivery (otherwise the WebSocket conflict means
    // only one session receives real-time messages).
    const lock = checkProfileLock(profile);
    let autoCreated = false;
    if (lock.locked) {
      const newProfile = generateUniqueProfileName();
      log(`another pi instance (PID ${lock.pid}) holds relay profile "${profile}"; auto-creating "${newProfile}"`);
      profile = newProfile;
      autoCreated = true;
    }

    const result = await connectAsProfile(profile);
    if (!result.connected) {
      log(`session ${event.reason}: selected profile "${profile}" but couldn't connect (will retry on next poll)`);
    } else {
      writeProfileLock(profile);
      if (autoCreated) {
        log(`session ${event.reason}: connected as auto-created profile "${profile}" (another instance held the original)`);
        try {
          pi.sendUserMessage(
            `Another pi session was already using relay profile. ` +
            `Auto-created a new profile "${profile}" for this session so both receive messages independently.`,
          );
        } catch { /* agent may not be ready at startup — log is enough */ }
      } else {
        log(`session ${event.reason}: connected as profile "${profile}"`);
      }
    }
  });

  pi.on("session_shutdown", () => {
    stopPolling();
    stopTyping();
    removeProfileLock(currentProfile);
  });

  // Show a "typing" indicator in the active channel while the agent works on a
  // relay-delivered message, and clear it when the run finishes.
  pi.on("agent_start", () => startTyping());
  pi.on("agent_end", () => {
    stopTyping();
    relayInputSinceIdle = false;
  });

  // Tool approval: when enabled and the turn came from a channel, pause risky
  // tools and ask the user over that channel before they run.
  pi.on("tool_call", async (event) => {
    if (!approvalNeeded(event.toolName)) return; // allow
    // Only gate turns driven from a channel — terminal/local use is unaffected.
    if (!relayInputSinceIdle || !lastChannel) return;
    // Pause the typing indicator while we wait on the human.
    stopTyping();
    const approved = await requestApproval(
      event.toolName,
      event.input as Record<string, unknown>,
      lastChannel,
    );
    if (!approved) {
      return {
        block: true,
        reason:
          `The user denied this ${event.toolName} call over ${lastChannel.channelType}. ` +
          `Do not retry it; ask them what to do instead.`,
      };
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
      "an id, channelType, channelId, sender, and content. Use relay_reply to respond.",
    promptSnippet: "relay_check_messages: fetch pending Telegram/email messages from chaos-relay",
    parameters: checkParams,
    async execute(_id: string, _params: Static<typeof checkParams>, _signal, _onUpdate, _ctx: ExtensionContext) {
      const c = ensureClient();
      if (!c || !poller) {
        return textResult(
          "chaos-relay is not configured. Run `/chaos-relay setup` (or set CHAOS_RELAY_API_KEY).",
        );
      }
      try {
        const messages = await poller.poll();
        return textResult(formatMessagesForAgent(messages), { count: messages.length });
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
    channelId: Type.String({ description: "channelId from the inbound message." }),
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
      "attachments (max 3 files, 5MB each).",
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
        `relay_reply: sending to ${params.channelType}/${params.channelId} ` +
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
          log(
            `relay_reply: WS ack ok=${res.ok} responseId=${res.responseId ?? "?"}. ` +
              `NOTE: ack means the relay STORED the reply — actual Telegram/email ` +
              `delivery happens server-side and is logged there.`,
          );
          return textResult(
            `Reply accepted by relay for ${params.channelType} channel ${params.channelId} (via WebSocket). ` +
              `Relay will forward it to the channel.`,
            res,
          );
        } catch (err) {
          log(`relay_reply: WS reply failed, falling back to HTTP: ${err instanceof Error ? err.message : String(err)}`);
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
        // The relay returns {ok, channelType, channelId} for telegram and
        // {ok, responseId} for webhook-style channels — fall back to the
        // request values so the confirmation is always meaningful.
        return textResult(
          `Reply accepted by relay for ${res.channelType ?? params.channelType} channel ${res.channelId ?? params.channelId}. ` +
            `Relay will forward it to the channel.`,
          res,
        );
      } catch (err) {
        log(`relay_reply: HTTP reply failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const c = await ensureConfigured();
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
        `Channel registration failed: ${err instanceof Error ? err.message : String(err)}`,
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
    async execute(_id: string, params: Static<typeof tgParams>) {
      const c = await ensureConfigured();
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
    async execute(_id: string, params: Static<typeof dcParams>) {
      const c = await ensureConfigured();
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
    async execute(_id: string, params: Static<typeof emailParams>) {
      const c = await ensureConfigured();
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
    async execute(_id: string, params: Static<typeof webhookParams>, _signal, _onUpdate, _ctx: ExtensionContext) {
      const c = await ensureConfigured();
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
  async function runConnect(input: string): Promise<string> {
    const plan = parseConnectInput(input);
    if (plan.kind === "unknown") return plan.reason;
    const c = await ensureConfigured();
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
    async execute(_id: string, params: Static<typeof connectParams>) {
      try {
        return textResult(await runConnect(params.input));
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
    async execute(_id: string, params: Static<typeof switchParams>) {
      try {
        return textResult(await switchProfile(params.name));
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // --- /chaos-relay command --------------------------------------------------

  pi.registerCommand("chaos-relay", {
    description: "Set up and inspect the CHAOS relay bridge (subcommands: setup [--advanced], connect, profile, add, status, poll, stop, approvals, reset, doctor, help)",
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
            ctx.ui.notify(await runConnect(rest), "info");
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
            ctx.ui.notify(await switchProfile(name), "info");
            break;
          }
          case "add":
          case "channel":
            await runAddChannel(ctx);
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
                  `off=autonomous, writes=ask before shell/edit/write, all=ask before every tool.`,
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
        const message = err instanceof Error ? err.message : String(err);
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
      ["status", "Show config, poller state, and live relay health (default when run with no subcommand)"],
      ["poll", "Poll once now and deliver any new messages"],
      ["stop", "Stop the background poller"],
      ["approvals [off|writes|all]", "Show or set the tool-approval policy — off=autonomous, writes=ask before shell/edit/write, all=ask before every tool"],
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
    // hosted relay and auto-register an ECDSA session. `--advanced` exposes the
    // URL / agent-id / paste-key prompts for self-hosters.
    let relayUrl = isValidRelayUrl(persisted.relayUrl ?? "")
      ? persisted.relayUrl!
      : DEFAULT_RELAY_URL;
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
          `"${relayUrl}" is not a valid URL. Include the scheme, e.g. https://chaos-relay.com`,
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
        apiKey = reg.apiKey;
        userId = reg.userId;
        keyPair = reg.keyPair;
        serverPublicKey = reg.serverPublicKey ?? serverPublicKey;
        ctx.ui.notify(`Registered with ECDSA identity. userId=${userId}`, "info");
      } else if (action === "Paste an existing API key") {
        const pasted = await ctx.ui.input("Paste relay API key", "");
        if (pasted) apiKey = pasted.trim();
      }
    } else if (!apiKey) {
      // Default zero-config path: provision a private session automatically.
      ctx.ui.notify("Setting up your private relay connection…", "info");
      const reg = await registerSessionWithKey(relayUrl, { keyPair });
      apiKey = reg.apiKey;
      userId = reg.userId;
      keyPair = reg.keyPair;
      serverPublicKey = reg.serverPublicKey ?? serverPublicKey;
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
      const message = err instanceof Error ? err.message : String(err);
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

  async function runStatus(ctx: ExtensionCommandContext): Promise<void> {
    const current = resolveConfig();
    const lines = [
      `config file:   ${getConfigPath()}`,
      `relayUrl:      ${current.relayUrl}`,
      `connection:    ${current.agentId} (this session's name)`,
      `identity:      ${current.keyPair ? "ECDSA P-256 keypair (durable identity)" : "Bearer-only (legacy, no keypair)"}`,
      `apiKey:        ${
        current.apiKey
          ? (current.keyPair ? "cached (auto-issued from your ECDSA key)" : "set")
          : (current.keyPair ? "not cached — auto-issued from your ECDSA key on connect" : "MISSING (run /chaos-relay setup)")
      }`,
      `userId:        ${current.userId ?? "(unknown)"}`,
      `transport:     WebSocket (${ws?.connected ? "connected" : ws ? "connecting/reconnecting" : "stopped"}) + ${SAFETY_POLL_MS}ms safety poll`,
      `approvals:     ${current.approvalMode} (off=autonomous, writes=shell/edit/write, all=every tool)`,
      `channels:      ${current.channels.length}`,
    ];
    for (const ch of current.channels) {
      lines.push(`  - ${ch.type} ${ch.channelId}${ch.label ? ` (${ch.label})` : ""}`);
    }
    // Live reachability + channel list from the relay, if configured.
    if (current.apiKey) {
      try {
        const c = new RelayClient({
          relayUrl: current.relayUrl,
          apiKey: current.apiKey,
          keyPair: current.keyPair,
        });
        const h = await c.health();
        lines.push(`relay health:  ${h.status}${h.version ? ` (v${h.version})` : ""}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        `chaos-relay: cleared relayUrl${hadUrl ? ` (was "${before.relayUrl}")` : ""}. ` +
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
  async function runDoctor(ctx: ExtensionCommandContext): Promise<void> {
    const checks: Array<{ ok: boolean; label: string; detail?: string; fix?: string }> = [];
    const mark = (ok: boolean) => (ok ? "✓" : "✗");

    // 1. Config file exists and parses.
    let persisted: ReturnType<typeof loadPersisted> = {};
    let fileOk = true;
    try {
      persisted = loadPersisted();
    } catch (err) {
      fileOk = false;
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        ok: false,
        label: "config file parses",
        detail: message,
        fix: "Run /chaos-relay reset all, then /chaos-relay setup.",
      });
    }
    if (fileOk) {
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
    const urlDetail = [
      `effective=${effectiveUrl}`,
      envUrl ? `env=\"${envUrl}\"` : null,
      persistedUrl ? `file=\"${persistedUrl}\"` : null,
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
        const message = err instanceof Error ? err.message : String(err);
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

/** Turn relay errors into agent-friendly Error messages. */
function toFriendly(err: unknown): Error {
  if (err instanceof RelayError) {
    return new Error(err.message);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// Re-export types for consumers/tests.
export type { ChannelMessage } from "./relay-client.ts";
