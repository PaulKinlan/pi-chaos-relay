# pi-chaos-relay

A [pi](https://github.com/earendil-works) coding-agent extension that bridges your
pi agent to a [CHAOS](https://github.com/PaulKinlan/chaos) **relay server**
([`packages/server`](https://github.com/PaulKinlan/chaos/tree/main/packages/server)),
so you can drive your agent from — and have it reply to — **Telegram**, **Discord**,
**email**, and inbound **webhooks**.

External channels (a Telegram/Discord bot, an email address, a webhook URL) deliver
messages to the relay. This extension makes pi the client: it receives new messages
over a WebSocket (with a polling fallback), surfaces them to the agent, and sends the
agent's answers back to the original thread. It is the same poll-and-reply pattern the
CHAOS Chrome extension uses.

```
Telegram / Email ──> CHAOS relay ──poll GET /messages──> pi agent
                          ^                                  │
                          └──────── POST /reply ─────────────┘
```

## Quick start

```bash
pi install pi-chaos-relay
```

Then, inside pi:

1. **`/chaos-relay setup`** — connect to the relay (registers a session for you).
2. **`/chaos-relay add`** — pick a channel (Telegram / Discord / email / webhook) and follow the prompts.
3. **Message that channel** — it reaches the agent, and the agent replies back.

That's it. `/chaos-relay status` shows state; `/chaos-relay approvals <off|writes|all>`
gates risky tools behind a yes/no over the channel. Prefer talking? You can also just
ask the agent: *"register a Telegram bot, the token is 123:ABC."*

## What it does

- Registers a relay **session** with an **ECDSA P-256 keypair** (the relay's
  real identity model) and stores the credentials + key locally.
- **Signs every authenticated request** (`X-Timestamp` / `X-Nonce` /
  `X-Signature`) so the relay can verify it really came from this client.
- Registers **Telegram**, **Discord**, **email**, and inbound **webhook**
  channels via the relay.
- Receives new messages over a **WebSocket** push (background safety poll as a
  fallback) and injects them into the pi agent (also exposed as an on-demand tool).
- **Replies** to a channel via the relay; optional **tool approvals** let you
  gate risky tools from the channel.

## Install

Published on npm as [`pi-chaos-relay`](https://www.npmjs.com/package/pi-chaos-relay):

```bash
pi install pi-chaos-relay
# or pin a version:
pi install pi-chaos-relay@latest
# or from git / a local checkout:
pi install git:github.com/paulkinlan/pi-chaos-relay
pi install ./pi-chaos-relay
```

`pi list` should then show `pi-chaos-relay`. Remove with `pi remove ...`.

## Configuration

Configuration is read with this precedence: **environment variable > saved config
file > default**. The saved config file is `~/.pi/chaos-relay.json` (written with
`0600` permissions; it holds your API key, so it is never committed).

| Env var | Default | Meaning |
|---------|---------|---------|
| `CHAOS_RELAY_URL` | `https://chaos-relay.com` | Relay base URL |
| `CHAOS_RELAY_API_KEY` | — | Bearer API key from `POST /auth/register` (secret) |
| `CHAOS_RELAY_AGENT_ID` | `pi` | Agent id channels route to |
| `CHAOS_RELAY_POLL_MS` | `15000` | Background poll interval in ms (min `3000`) |
| `CHAOS_RELAY_PROFILE` | `default` | Names a separate config file (`~/.pi/chaos-relay.<profile>.json`) — see Multiple instances |
| `CHAOS_RELAY_CONFIG` | — | Absolute path to the config file (overrides `CHAOS_RELAY_PROFILE`) |

### Multiple instances / sessions

Each config file is a **separate identity** — its own ECDSA keypair → `userId` →
message queue. By default every pi instance on a machine shares
`~/.pi/chaos-relay.json`, so they'd share one connection and all receive the
same messages. To run two instances you can talk to independently, give each its
own profile:

```sh
CHAOS_RELAY_PROFILE=work   pi   # ~/.pi/chaos-relay.work.json
CHAOS_RELAY_PROFILE=home   pi   # ~/.pi/chaos-relay.home.json
```

Then register a **separate channel per instance** (e.g. a different Telegram bot,
or a different email address) so messaging that channel reaches that specific
instance. `/chaos-relay status` shows the active `config file` so you can tell
which is which. (`CHAOS_RELAY_CONFIG=/abs/path.json` sets the file explicitly.)

**Manage profiles from inside pi.** You don't have to relaunch to create or
switch a profile — just ask the agent ("switch to my work connection", "make a
new profile called staging") or use the command:

```
/chaos-relay profile           # list profiles, mark the active one
/chaos-relay profile work      # switch to "work" (creates + provisions it if new)
```

Switching re-points **this** pi instance at that profile's identity (one active
connection at a time). To have **two connections live simultaneously**, launch
two instances with `CHAOS_RELAY_PROFILE=<name>` as above.

The **ECDSA private key** is part of your identity and is deliberately *not*
configurable via an env var — it lives only in the `0600` config file. Setup
generates the keypair, sends only the **public** key to the relay, and persists
the pair locally. The Bearer API key you see in the config is just a session
token *auto-issued from that keypair* — you never enter or manage it, and it's
re-issued automatically if it expires.

The quickest start is zero-config — just tell the agent what you want:

> "connect my Telegram"

The agent registers a relay session for you on first use (no setup step needed)
and walks you through linking the channel. Or run the interactive setup:

```
/chaos-relay setup
```

This asks **no questions** in the common case: it connects to the hosted relay,
auto-registers your private session, starts the background poller, and offers to
link your first channel. Add more any time with `/chaos-relay add`, and check
state with `/chaos-relay status`.

**Self-hosting / custom relay?** Use `/chaos-relay setup --advanced` to enter a
custom relay URL, agent id, or paste an existing API key (or set the
`CHAOS_RELAY_URL` env var).

## Troubleshooting

If setup or a request fails with `Failed to parse URL from /…` (or any
"relay error" during onboarding), the saved relay URL is malformed — usually
a command was accidentally pasted into the URL field. Two ways to recover:

- **`/chaos-relay doctor`** — runs a diagnostics check-list (config validity,
  credentials, reachability, transport, channels) and points at the fix.
- **`/chaos-relay reset`** — non-interactively clears the bad `relayUrl` but
  keeps your credentials and channels. Then run `/chaos-relay setup` to re-enter
  the URL. Use **`/chaos-relay reset all`** for a full wipe.

Since v0.6.2 the setup prompt rejects invalid URLs (must be absolute
`http(s)://…`), so this should no longer happen on fresh setups.

## Commands

| Command | Description |
|---------|-------------|
| `/chaos-relay setup` | Zero-config connect (auto-registers your session) + start polling, then offers to link a channel. `--advanced` for a custom relay URL / agent id / pasted key |
| `/chaos-relay connect <token\|email\|webhook>` | One-shot: paste a Telegram/Discord bot token, an email, or `webhook` and it sets up the relay + registers the channel in a single step |
| `/chaos-relay profile [name]` | List connection profiles, or switch to / create one (each is a separate identity). No arg lists them |
| `/chaos-relay add` | Interactive wizard to add a channel (Telegram / Discord / email / webhook) |
| `/chaos-relay status` | Show config, poller state, and live relay health |
| `/chaos-relay poll` | Poll once now and deliver any new messages |
| `/chaos-relay stop` | Stop the background poller |
| `/chaos-relay approvals <off\|writes\|all>` | Set/show the tool-approval policy |
| `/chaos-relay doctor` | Diagnostics: config validity, credentials, relay reachability, transport, channels |
| `/chaos-relay reset [all]` | Clear a corrupted `relayUrl` (keeps creds/channels); `reset all` wipes the config file |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `relay_connect` | **One-shot**: give it a bot token / email / `webhook` and it sets up the relay (auto-registering your session) and the channel in one step. Lets you just paste a token and say "connect this" |
| `relay_list_profiles` | List connection profiles and the active one |
| `relay_switch_profile` | Switch to (or create) a connection profile — "switch to my work connection" |
| `relay_check_messages` | Pull pending inbound Telegram/email messages |
| `relay_reply` | Reply to a channel message (`channelType`, `channelId`, `content`, optional `replyTo`) |
| `relay_register_telegram` | Register a Telegram bot channel |
| `relay_register_discord` | Register a Discord bot channel |
| `relay_register_email` | Register an email channel |
| `relay_register_webhook` | Register an inbound (one-way) webhook URL |

## Tool approvals

pi has no built-in per-tool permission prompts — it runs tools with your account's
permissions. For turns driven from a channel you can require approval over that
channel before risky tools run:

| Mode | Behaviour |
|------|-----------|
| `off` *(default)* | Fully autonomous — run every tool. Best paired with a sandbox/container. |
| `writes` | Ask before `bash`, `edit`, and `write`; reads/searches run freely. |
| `all` | Ask before **every** tool (the `relay_*` plumbing is never gated). |

Set with `/chaos-relay approvals writes` or the `CHAOS_RELAY_APPROVAL_MODE` env var.
When a tool is gated, the agent pauses and sends an approval request to the active
channel; **reply `yes` to allow or `no` to deny** (auto-denies after 5 minutes).
Terminal/local turns are never gated.

## Telegram setup — end to end

1. In Telegram, talk to **@BotFather**, create a bot, and copy the **bot token**.
2. In pi, make sure the relay is configured (`/chaos-relay setup`).
3. Ask the agent to register Telegram, or call the tool directly with the bot
   token. The extension calls `POST /channels/telegram/register`, which validates
   the token, sets the Telegram webhook, and returns a **channelId**, **bot
   username**, and a **pairing code**.
4. Open Telegram, message your bot, and send it the **pairing code** to link your
   chat.
5. Done. Messages you send the bot now arrive at the agent (auto-injected by the
   poller). The agent replies with `relay_reply` and they appear in your Telegram
   thread.

## Email setup — end to end

> The relay must be running with `CHAOS_EMAIL_DOMAIN` configured (and an email
> provider such as Resend wired up). See the relay's self-hosting docs.

1. Make sure the relay is configured (`/chaos-relay setup`).
2. Ask the agent to register email, or call the tool with your **email address**.
   The extension calls `POST /channels/email/register` and returns a **channelId**
   and an **inboundAddress** (e.g. `ch_abc123@your-relay-domain`).
3. Check your inbox for a **verification link** and click it to activate the
   channel.
4. Done. Email sent to the inbound address reaches the agent; replies go back to
   the sender via `relay_reply`.

## How inbound delivery works

While a pi session is active, a background poller runs every `CHAOS_RELAY_POLL_MS`
milliseconds. New messages are de-duplicated by id (so nothing is delivered twice)
and injected into the agent as a user message that includes each message's `id`,
`channelType`, `channelId`, sender, and content — everything the agent needs to
call `relay_reply`. You can also force an immediate pull with `relay_check_messages`
or `/chaos-relay poll`.

## Security

- **ECDSA P-256 request signing is the default identity path.** At registration
  the client generates a P-256 keypair, sends only the public key to the relay
  (`POST /auth/register` with `publicKey`), and the relay binds the session to
  it. Every authenticated request after that is signed: a base64 ECDSA-SHA256
  `X-Signature` over `{timestamp}|{nonce}|{path}|{bodyHash}` (path = pathname
  only, `bodyHash` = SHA-256 hex of the body, empty body for GET), plus
  `X-Timestamp` (ISO 8601, ±5 min) and `X-Nonce` (16 random bytes hex, replay
  protected). This matches the canonical CHAOS extension/server implementation.
- The **private key never leaves the machine** — it is stored only in
  `~/.pi/chaos-relay.json` (0600) and never sent to the relay or committed. The
  API key lives in the same file (or the `CHAOS_RELAY_API_KEY` env var).
  `.gitignore` blocks stray `chaos-relay.json` / `.env` files.
- **Bearer-only** mode is kept as a fallback for legacy sessions registered
  without a public key (e.g. a pasted API key). The relay still accepts unsigned
  requests for those; signed is preferred and automatic when a keypair exists.
- Bot tokens are sent only to the relay's register endpoint over HTTPS; the relay
  encrypts them at rest. They are not persisted by this extension.

## Development

```bash
npm test        # node --test unit tests (relay client, poller, config)
npx tsc --noEmit -p tsconfig.json   # type-check against pi types
```

Integration testing against a local relay: run the CHAOS relay server
(`deno task start` in `packages/server` with `--unstable-kv`) and point
`CHAOS_RELAY_URL=http://localhost:8787`.

## Known gaps / future work

- **Server response signing / TOFU pinning.** The relay returns its public key
  at registration and we persist it (`serverPublicKey`), but the client does not
  yet verify server signatures on poll responses. Outbound request signing (the
  key threat: someone spending your API key) is fully implemented.
- **WebSocket** real-time delivery (`GET /ws`) is not used; the extension polls.
  Polling is simpler and robust; a WS transport could lower latency later.
- Email registration depends on relay-side `CHAOS_EMAIL_DOMAIN` + provider config.

## License

MIT — see [LICENSE](./LICENSE).
