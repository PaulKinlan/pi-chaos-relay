---
name: chaos-relay
description: Drive the pi agent from, and reply to, Telegram, Discord, email, and webhooks via a CHAOS relay server. Use when the user wants to set up the relay bridge, connect a channel (Telegram bot, Discord bot, email, webhook), check for inbound messages from those channels, reply to a thread the agent received, or describe any "I want to message my agent / control pi from chat / email" need. This is the bridge between external channels and the pi agent.
---

# CHAOS Relay Bridge

This skill connects pi to a CHAOS relay server so messages from Telegram,
Discord, email, and webhooks reach the agent, and the agent can reply back to
those threads. It is how pi gets a two-way inbox outside the terminal.

## How it works

External channels deliver messages to the relay. The extension maintains a
WebSocket connection (with a safety poll backstop) and surfaces new messages
automatically while a pi session is active. The agent answers with the
`relay_reply` tool. You can also pull on demand with `relay_check_messages`.

Credentials live in `~/.pi/chaos-relay.json` (0600). Identity is an ECDSA P-256
keypair generated at first setup — the relay binds the session to it, and every
authenticated request is signed. The API key is auto-derived from the keypair.

## First-time setup (zero-config)

The default path needs **no jargon and no Googling**:

1. The user gives you *one* thing — a Telegram bot token, a Discord bot token,
   an email address, or the word "webhook".
2. Run `/chaos-relay connect <that thing>` (or call the `relay_connect` tool).
   It auto-detects the channel type from the value's shape, **self-provisions
   a relay session** (generates the keypair, registers with the relay, persists
   credentials) if none exists yet, then registers the channel.
3. Return the per-channel finishing step to the user (see below).

Only fall back to the interactive `/chaos-relay setup` wizard if the user
*wants* to choose a specific relay URL or agent id. That path is also what
`--advanced` exposes. Env vars (`CHAOS_RELAY_URL`, `CHAOS_RELAY_API_KEY`) still
override everything for headless/explicit setups.

## Connecting each channel type

**Telegram** (most common):
1. User creates a bot via [@BotFather](https://t.me/BotFather) and copies the token.
2. `/chaos-relay connect <token>` (or `relay_register_telegram`).
3. Returns `channelId`, `botUsername`, and a `pairingCode`.
4. **Finishing step for the user:** open Telegram, message the bot, and send
   the pairing code to link the chat. After that, messages to the bot arrive
   as inbound messages.

**Discord**:
1. User creates a bot in the Discord Developer Portal (Bot → Token).
2. `/chaos-relay connect <token>` (or `relay_register_discord`).
3. Returns `channelId`, `botUsername`, and a `pairingCode`.
4. **Finishing step for the user:** send the pairing code to the bot in
   Discord. Note: Discord has no `setWebhook`, so the bot's interaction
   endpoint (or a gateway relay) must be pointed at the relay's
   `/discord/<channelId>` URL.

**Email**:
1. `/chaos-relay connect <user@example.com>` (or `relay_register_email`).
   (Relay must have `CHAOS_EMAIL_DOMAIN` configured.)
2. Returns `channelId` and an `inboundAddress`.
3. **Finishing step for the user:** click the verification link sent to their
   address. Once verified, mail to the inbound address reaches the agent.

**Webhook** (inbound only — no reply):
1. `/chaos-relay connect webhook` or `connect webhook <name>`
   (or `relay_register_webhook`).
2. Returns a public `webhookUrl`. Any external service that POSTs JSON, form
   data, or plain text to it delivers a message to the agent. There is no
   reply path for webhooks — do not call `relay_reply` for them.

If `connect` can't tell what the user pasted, it asks them to prefix the type
explicitly: `telegram <token>`, `discord <token>`, `email <addr>`,
`webhook <name>`.

## Receiving and replying

- New messages are injected automatically (WebSocket push, with a safety-poll
  backstop). To pull immediately, call `relay_check_messages`.
- To answer, call `relay_reply` with the `channelType`, `channelId`, and the
  inbound message `id` (as `replyTo`), plus your `content`.
- Replies go back to the original channel thread.

## Tools

| Tool | Purpose |
|------|---------|
| `relay_connect` | One-shot: paste a token/email and it self-provisions + registers |
| `relay_register_telegram` | Register a Telegram bot channel (explicit) |
| `relay_register_discord` | Register a Discord bot channel (explicit) |
| `relay_register_email` | Register an email channel (explicit) |
| `relay_register_webhook` | Create an inbound-only webhook URL |
| `relay_check_messages` | Poll for new inbound messages |
| `relay_reply` | Reply to a channel message |
| `relay_list_profiles` | List connection profiles and the active one |
| `relay_switch_profile` | Switch to (or create) a connection profile |

## Commands

| Command | Purpose |
|---------|---------|
| `/chaos-relay connect <value>` | Zero-config: one paste provisions + registers |
| `/chaos-relay setup [--advanced]` | Interactive credential setup (self-provisions by default) |
| `/chaos-relay add` | Guided wizard to add a channel |
| `/chaos-relay profile [name]` | List connection profiles, or switch to / create one |
| `/chaos-relay status` | Config, poller state, live relay health |
| `/chaos-relay poll` | Poll once now and deliver any new messages |
| `/chaos-relay stop` | Stop the background poller |
| `/chaos-relay approvals <off\|writes\|all>` | Set/show the tool-approval policy |

For diagnosis and recovery, see the companion **chaos-relay-troubleshoot** skill
(`/chaos-relay doctor`, `/chaos-relay reset`).

## Multiple connections (profiles)

Each **profile** is a separate identity (its own keypair → message queue), so a
user can run more than one connection. The profile is **bound to the pi session**
and persists across restarts (resuming a session reconnects as the same identity).

- "switch to my work connection" / "make a new profile called staging" →
  `relay_switch_profile` (creates + auto-provisions if new), or
  `/chaos-relay profile <name>`.
- "what connections do I have" → `relay_list_profiles` or `/chaos-relay profile`.
- Switching changes the **one** connection this pi instance uses. To run two
  connections **at once**, the user launches separate pi instances with
  `CHAOS_RELAY_PROFILE=<name>`. Each instance needs its **own channel** (e.g. a
  different Telegram bot) to be addressable.

## Tool approvals

When the agent acts on an inbound channel message, you can gate destructive
tools: `off` = fully autonomous (default), `writes` = ask over the channel
before shell/edit/write, `all` = ask before every tool. Set with
`/chaos-relay approvals writes` or the `CHAOS_RELAY_APPROVAL_MODE` env var.
