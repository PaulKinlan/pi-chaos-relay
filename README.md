# pi-chaos-relay

A [pi](https://github.com/earendil-works) coding-agent extension that bridges your
pi agent to a [CHAOS](https://github.com/) **relay server**, so you can drive your
agent from — and have it reply to — **Telegram** and **email**.

External channels (a Telegram bot, an email address) deliver messages to the relay.
This extension makes pi the polling client: it polls the relay for new messages,
surfaces them to the agent, and sends the agent's answers back to the original
thread. It is the same poll-and-reply pattern the CHAOS Chrome extension and
Claude Code's Telegram plugin use.

```
Telegram / Email ──> CHAOS relay ──poll GET /messages──> pi agent
                          ^                                  │
                          └──────── POST /reply ─────────────┘
```

## What it does

- Registers a relay **session** with an **ECDSA P-256 keypair** (the relay's
  real identity model) and stores the credentials + key locally.
- **Signs every authenticated request** (`X-Timestamp` / `X-Nonce` /
  `X-Signature`) so the relay can verify it really came from this client.
- Registers a **Telegram bot** channel and an **email** channel via the relay.
- **Polls** `GET /messages` in the background and injects new messages into the
  pi agent (also exposed as an on-demand tool).
- **Replies** to a channel via `POST /reply`.

## Install

```bash
pi install git:github.com/paulkinlan/pi-chaos-relay
# or, from a local checkout:
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

The **ECDSA private key** is part of your identity and is deliberately *not*
configurable via an env var — it lives only in the `0600` config file. Running
`/chaos-relay setup` → "Register a new session (ECDSA)" generates the keypair,
sends only the **public** key to the relay, and persists the pair locally.

The quickest start is the interactive setup, which registers a session for you:

```
/chaos-relay setup
```

It asks for the relay URL and agent id, registers a new session (or lets you reuse
/ paste an existing API key), verifies the relay is reachable, saves the
credentials, and starts the background poller. Check state any time with
`/chaos-relay status`.

## Commands

| Command | Description |
|---------|-------------|
| `/chaos-relay setup` | Interactive credential setup + start polling |
| `/chaos-relay status` | Show config, poller state, and live relay health |
| `/chaos-relay poll` | Poll once now and deliver any new messages |
| `/chaos-relay stop` | Stop the background poller |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `relay_check_messages` | Pull pending inbound Telegram/email messages |
| `relay_reply` | Reply to a channel message (`channelType`, `channelId`, `content`, optional `replyTo`) |
| `relay_register_telegram` | Register a Telegram bot channel |
| `relay_register_email` | Register an email channel |

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
