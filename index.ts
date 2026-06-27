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
} from "./relay-client.ts";
import {
  addChannelRecord,
  isConfigured,
  loadPersisted,
  resolveConfig,
  savePersisted,
  setChannelRecords,
  setMessagesCursor,
  type ResolvedConfig,
  type RegisteredChannelRecord,
} from "./config.ts";
import { MessagePoller, formatMessagesForAgent } from "./poller.ts";
import { RelayWebSocket } from "./ws-client.ts";

/**
 * Slow safety poll. The WebSocket is the primary transport (instant push);
 * this only runs as a backstop in case a push is missed between reconnects.
 */
const SAFETY_POLL_MS = 120_000;

const LOG_PREFIX = "[pi-chaos-relay]";

function log(message: string, ...rest: unknown[]): void {
  console.error(`${LOG_PREFIX} ${message}`, ...rest);
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

  // Typing indicator state: the channel of the most recent inbound message, and
  // whether the current/next agent run was triggered by a relay message (so we
  // only show "typing" in the channel when the agent is actually working on a
  // message from it, not on terminal-driven turns).
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let lastChannel: { channelType: string; channelId: string } | undefined;
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
    return new MessagePoller(c, {
      since: loadPersisted().messagesCursor,
      onAdvance: (s) => setMessagesCursor(s),
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

  /** Poll once and, if there are new messages, inject them into the agent. */
  async function pollAndDeliver(): Promise<void> {
    if (!poller) return;
    try {
      const messages = await poller.poll();
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
        const fresh = poller.accept(messages);
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

  pi.on("session_start", () => {
    if (poller) poller.reset();
    startPolling();
  });

  pi.on("session_shutdown", () => {
    stopPolling();
    stopTyping();
  });

  // Show a "typing" indicator in the active channel while the agent works on a
  // relay-delivered message, and clear it when the run finishes.
  pi.on("agent_start", () => startTyping());
  pi.on("agent_end", () => {
    stopTyping();
    relayInputSinceIdle = false;
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
  });
  pi.registerTool({
    name: "relay_reply",
    label: "CHAOS Relay: reply",
    description:
      "Send a reply through the chaos-relay server to a Telegram/email (or other) " +
      "channel. Pass the channelType and channelId from the inbound message, and " +
      "optionally replyTo (the inbound message id).",
    promptSnippet: "relay_reply: send a reply to a Telegram/email channel via chaos-relay",
    parameters: replyParams,
    async execute(_id: string, params: Static<typeof replyParams>, _signal, _onUpdate, _ctx: ExtensionContext) {
      const c = ensureClient();
      if (!c) {
        return textResult(
          "chaos-relay is not configured. Run `/chaos-relay setup` (or set CHAOS_RELAY_API_KEY).",
        );
      }
      const transport = ws?.connected ? "WebSocket" : "HTTP";
      log(
        `relay_reply: sending to ${params.channelType}/${params.channelId} ` +
          `replyTo=${params.replyTo ?? "none"} via ${transport} (${params.content.length} chars)`,
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
      const c = ensureClient();
      if (!c) {
        return textResult("chaos-relay is not configured. Run `/chaos-relay setup` first.");
      }
      try {
        const res = await c.registerTelegram({ botToken: params.botToken, agentId: cfg.agentId });
        addChannelRecord({
          channelId: res.channelId,
          type: "telegram",
          label: res.botUsername,
          createdAt: new Date().toISOString(),
          // Persisted (0600, ~/.pi) so the channel can be auto re-registered if
          // the relay ever loses the session.
          botToken: params.botToken,
        });
        return textResult(
          `Telegram channel registered.\n` +
            `  channelId:   ${res.channelId}\n` +
            `  bot:         @${res.botUsername}\n` +
            `  pairingCode: ${res.pairingCode}\n\n` +
            `Open Telegram, message @${res.botUsername}, and send the pairing code "${res.pairingCode}" to complete setup.`,
          res,
        );
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
      const c = ensureClient();
      if (!c) {
        return textResult("chaos-relay is not configured. Run `/chaos-relay setup` first.");
      }
      try {
        const res = await c.registerDiscord({ botToken: params.botToken, agentId: cfg.agentId });
        addChannelRecord({
          channelId: res.channelId,
          type: "discord",
          label: res.botUsername,
          createdAt: new Date().toISOString(),
          // Persisted (0600, ~/.pi) so the channel can be auto re-registered if
          // the relay ever loses the session.
          botToken: params.botToken,
        });
        return textResult(
          `Discord channel registered.\n` +
            `  channelId:   ${res.channelId}\n` +
            `  bot:         ${res.botUsername}\n` +
            `  pairingCode: ${res.pairingCode}\n\n` +
            `In Discord, message the bot and send the pairing code "${res.pairingCode}" to complete setup. ` +
            `Make sure the bot forwards events to the relay's /discord/${res.channelId} endpoint.`,
          res,
        );
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
      const c = ensureClient();
      if (!c) {
        return textResult("chaos-relay is not configured. Run `/chaos-relay setup` first.");
      }
      // The relay requires a channelName (it seeds the inbound address slug).
      // Default to a slug derived from the email's local part so callers don't
      // have to supply one.
      const channelName = params.channelName ||
        params.userEmail.split("@")[0].replace(/[^a-z0-9]+/gi, "-")
          .replace(/^-+|-+$/g, "").toLowerCase() ||
        cfg.agentId || "agent";
      try {
        const res = await c.registerEmail({
          userEmail: params.userEmail,
          agentId: cfg.agentId,
          channelName,
        });
        addChannelRecord({
          channelId: res.channelId,
          type: "email",
          label: channelName,
          createdAt: new Date().toISOString(),
          userEmail: params.userEmail,
          channelName,
        });
        return textResult(
          `Email channel registered (pending verification).\n` +
            `  channelId:      ${res.channelId}\n` +
            `  inboundAddress: ${res.inboundAddress}\n\n` +
            `Check ${params.userEmail} for a verification link and click it to activate. ` +
            `Once active, email ${res.inboundAddress} to reach the agent.`,
          res,
        );
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
      const c = ensureClient();
      if (!c) {
        return textResult(
          "chaos-relay is not configured. Run `/chaos-relay setup` (or set CHAOS_RELAY_API_KEY).",
        );
      }
      try {
        const res = await c.registerWebhook({ channelName: params.channelName });
        addChannelRecord({
          channelId: res.channelId,
          type: "webhook",
          label: params.channelName ?? "webhook",
          createdAt: new Date().toISOString(),
          channelName: params.channelName,
          // Persisted (0600, ~/.pi) so the SAME URL can be recreated if the
          // relay ever loses the session.
          webhookSecret: res.webhookSecret,
        });
        return textResult(
          `Inbound webhook channel registered.\n` +
            `  channelId: ${res.channelId}\n` +
            `  POST to:   ${res.webhookUrl}\n\n` +
            `Any service that POSTs JSON, form data, or text to that URL delivers ` +
            `a message to the agent. It is one-way (inbound) — there is nothing to reply to.`,
          res,
        );
      } catch (err) {
        throw toFriendly(err);
      }
    },
  });

  // --- /chaos-relay command --------------------------------------------------

  pi.registerCommand("chaos-relay", {
    description: "Set up and inspect the CHAOS relay bridge (subcommands: setup, status, poll, stop)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] || "status";
      try {
        switch (sub) {
          case "setup":
            await runSetup(ctx);
            break;
          case "status":
            await runStatus(ctx);
            break;
          case "poll":
            await pollAndDeliver();
            ctx.ui.notify("chaos-relay: polled for new messages.", "info");
            break;
          case "stop":
            stopPolling();
            ctx.ui.notify("chaos-relay: background poller stopped.", "info");
            break;
          default:
            ctx.ui.notify(
              `Unknown subcommand "${sub}". Use: setup | status | poll | stop`,
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
   * Interactive setup: confirm/register a relay session, persist credentials,
   * and (re)start the poller. Telegram/email registration is left to the
   * dedicated tools/skills so the agent can drive it conversationally.
   */
  async function runSetup(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Setup needs interactive UI. Set CHAOS_RELAY_URL and CHAOS_RELAY_API_KEY env vars instead.",
        "warning",
      );
      return;
    }

    const persisted = loadPersisted();
    const relayUrl =
      (await ctx.ui.input(
        "Relay URL",
        persisted.relayUrl ?? resolveConfig().relayUrl,
      )) || resolveConfig().relayUrl;

    const agentId =
      (await ctx.ui.input("Agent id to route channels to", persisted.agentId ?? "pi")) || "pi";

    // Either reuse an existing API key or register a fresh session.
    let apiKey = persisted.apiKey;
    let userId = persisted.userId;
    let keyPair = persisted.keyPair;
    let serverPublicKey = persisted.serverPublicKey;
    const haveKey = Boolean(apiKey);
    const action = await ctx.ui.select(
      haveKey ? "Relay credentials" : "No API key found",
      haveKey
        ? ["Keep existing API key", "Register a new session (ECDSA)", "Paste an existing API key"]
        : ["Register a new session (ECDSA)", "Paste an existing API key"],
    );

    if (action === "Register a new session (ECDSA)") {
      ctx.ui.notify("Generating ECDSA keypair and registering session...", "info");
      // Reuse the existing keypair if present so the identity stays stable.
      const reg = await registerSessionWithKey(relayUrl, { keyPair });
      apiKey = reg.apiKey;
      userId = reg.userId;
      keyPair = reg.keyPair;
      serverPublicKey = reg.serverPublicKey ?? serverPublicKey;
      ctx.ui.notify(`Registered with ECDSA identity. userId=${userId}`, "info");
    } else if (action === "Paste an existing API key") {
      const pasted = await ctx.ui.input("Paste relay API key", "");
      if (pasted) apiKey = pasted.trim();
      // A pasted key with no local keypair falls back to Bearer-only auth.
    }

    if (!apiKey) {
      ctx.ui.notify("No API key set — aborting setup.", "warning");
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
      "chaos-relay configured. Use relay_register_telegram / relay_register_email to add channels.",
      "info",
    );
  }

  async function runStatus(ctx: ExtensionCommandContext): Promise<void> {
    const current = resolveConfig();
    const lines = [
      `relayUrl:      ${current.relayUrl}`,
      `agentId:       ${current.agentId}`,
      `apiKey:        ${current.apiKey ? "set" : "MISSING (run /chaos-relay setup)"}`,
      `identity:      ${current.keyPair ? "ECDSA P-256 (signed requests)" : "Bearer-only (legacy)"}`,
      `userId:        ${current.userId ?? "(unknown)"}`,
      `transport:     WebSocket (${ws?.connected ? "connected" : ws ? "connecting/reconnecting" : "stopped"}) + ${SAFETY_POLL_MS}ms safety poll`,
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
