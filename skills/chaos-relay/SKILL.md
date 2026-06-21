---
name: chaos-relay
description: Drive the pi agent from, and reply to, Telegram and email via a CHAOS relay server. Use when the user wants to set up the relay bridge, register a Telegram bot or email channel, check for inbound messages from those channels, or reply to a Telegram/email thread the agent received through chaos-relay.
---

# CHAOS Relay Bridge

This skill connects pi to a CHAOS relay server so messages from Telegram and
email reach the agent, and the agent can reply back to those threads.

## How it works

External channels (Telegram bot, email) deliver to the relay. This extension
polls `GET /messages` and surfaces new messages to you; you answer with the
`relay_reply` tool, which posts to `POST /reply`. A background poller runs while
a pi session is active and injects new messages automatically. You can also pull
on demand with `relay_check_messages`.

## First-time setup

1. Run `/chaos-relay setup` in pi (interactive). It will:
   - ask for the relay URL (default `https://chaos-relay.deno.dev`),
   - ask for an agent id (default `pi`),
   - register a new relay session (or reuse/paste an existing API key),
   - verify the relay is reachable and save credentials to `~/.pi/chaos-relay.json`.
   Alternatively set `CHAOS_RELAY_URL` and `CHAOS_RELAY_API_KEY` env vars.
2. Check state any time with `/chaos-relay status`.

## Register a Telegram channel

1. Create a bot with @BotFather in Telegram and copy the bot token.
2. Call the `relay_register_telegram` tool with that `botToken`.
3. The tool returns a `channelId`, `botUsername`, and a `pairingCode`.
4. Tell the user to open Telegram, message the bot, and send the pairing code to
   finish linking. After that, messages to the bot arrive as inbound messages.

## Register an email channel

1. Call `relay_register_email` with the user's `userEmail` (and optional name).
   (The relay must have `CHAOS_EMAIL_DOMAIN` configured.)
2. The tool returns a `channelId` and an `inboundAddress`.
3. Tell the user to click the verification link sent to their address.
4. Once verified, mail sent to the inbound address reaches the agent.

## Receiving and replying

- New messages are injected automatically by the background poller. To pull
  immediately, call `relay_check_messages`.
- To answer, call `relay_reply` with the `channelType`, `channelId`, and the
  message `id` (as `replyTo`) from the inbound message, plus your `content`.

## Tools

| Tool | Purpose |
|------|---------|
| `relay_check_messages` | Poll for new inbound Telegram/email messages |
| `relay_reply` | Reply to a channel message |
| `relay_register_telegram` | Register a Telegram bot channel |
| `relay_register_email` | Register an email channel |

## Commands

`/chaos-relay setup` · `/chaos-relay status` · `/chaos-relay poll` · `/chaos-relay stop`
