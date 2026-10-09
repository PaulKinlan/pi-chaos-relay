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
Telegram / Discord / Email / Webhook ──> CHAOS relay ──/ws push (poll fallback)──> pi agent
                          ^                                            │
                          └──────────────── POST /reply ──────────────┘
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
| `CHAOS_RELAY_AGENT_ID` | `pi` | Connection/session label channels are tagged with |
| `CHAOS_RELAY_APPROVAL_MODE` | `writes` | Tool-approval policy: `off` / `writes` / `all` (see Tool approvals) |
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

Creating a profile writes a new `~/.pi/chaos-relay.<name>.json` (a fresh
identity + keypair). To keep that bounded, the extension caps on-disk profile
files at **100**; a switch that would create a new one beyond that is **refused
with a clear message and nothing is written**. Reuse an existing profile
(`/chaos-relay profile <name>`) or remove unused `chaos-relay*.json` files to
create another.

The cap is a resource guard, not a security boundary, and it is enforced
per-process: two separate pi processes that both start at 99 profiles could each
pass the check before either writes, ending one or two over. That is an accepted
residual (pi-chaos-relay-icj) — a single process cannot race itself, reaching it
needs a deliberate collision at exactly the limit, and the worst case is a
handful of extra files in `~/.pi`. The next creation attempt sees the true count.

Switching re-points **this** pi instance at that profile's identity (one active
connection at a time). To have **two connections live simultaneously**, launch
two instances with `CHAOS_RELAY_PROFILE=<name>` as above.

**Profiles are bound to the pi session.** Each session remembers the profile it
was using (in `~/.pi/chaos-relay-sessions.json`, keyed by pi's session id), so
**resuming a session reconnects as the same identity** — not a machine-global
guess. The profile a session connects as is chosen, in order:

1. **Explicit env** — `CHAOS_RELAY_CONFIG` / `CHAOS_RELAY_PROFILE` (and it pins:
   the session is recorded as that profile)
2. **The session's recorded profile** — set by a previous switch / launch
   (covers resume and reload)
3. **Inherit** — a `new`/`fork` session adopts the profile of the session it
   came from
4. **Default** — `chaos-relay.json`

So: switch a session to `work`, quit, **resume that session** → back on `work`.
A brand-new session with no env → `default` (or inherits its parent). Two
instances stay independent because each is a different session.

#### The collision: a held profile is refused, never replaced

If the profile a session picks is **already held by another live pi process**,
the extension **refuses to connect** rather than switching identity:

```
Relay profile "default" is already held by another live pi session (PID 12345).
Lock file: /home/you/.pi/chaos-relay-default.lock. This session will not switch
to a new identity. Resolve it by closing that session, or give this one its own
profile: launch with CHAOS_RELAY_PROFILE=<name> pi, or run /chaos-relay profile
<name> here.
```

You get that as a `ctx.ui.notify` at `session_start` and in
`~/.pi/agent/logs/chaos-relay.log`. The session is left **unbound** — on the
profile it was already using, or with the relay idle if it had none — so the
collision is obvious instead of quietly becoming someone else.

**Why not auto-create.** Until v0.17.3 the extension dodged the collision by
minting a new profile named `hostname-pid` (a base36 process id). The name
looked random (`omarchy-2if`) but was derived from the pid, and every collision
minted a new identity — a config file, an ECDSA keypair, a relay session. One
machine on this project accumulated **~3,000 profile files** before anyone
noticed, with sessions connecting as whichever identity they happened to land on.

**To run two sessions at once**, name them yourself — that is the supported path,
and it is one env var (or one command from inside pi):

```sh
CHAOS_RELAY_PROFILE=work pi     # ~/.pi/chaos-relay.work.json
CHAOS_RELAY_PROFILE=home pi     # ~/.pi/chaos-relay.home.json
```

Check what you actually have, and which one is live:

```sh
ls -lt ~/.pi/chaos-relay*.json | head   # newest first, with times
/chaos-relay profile                    # inside pi: lists profiles, active marked
# or, as a tool: relay_list_profiles
```

#### The pattern: one profile owns the channels, everything else is silent

Pick the **one** session that answers Telegram/email, and point every other
session at a profile whose config has **no channels** — it registers, polls, and
receives nothing, so it never races the channel owner.

`no-relay` is a **convention, not a feature**: nothing in the code treats that
name specially. `configPathFor()` only slugifies whatever you pass in
`CHAOS_RELAY_PROFILE` (`config.ts:33`), and "silent" simply means the profile
file has no `channels` array. The name is still worth using because it is
greppable.

```sh
# the ONE session that answers Telegram/email
CHAOS_RELAY_PROFILE=default pi

# every other session: silent, and unable to collide
export CHAOS_RELAY_PROFILE="no-relay-$$"   # per-shell name — see below
pi
```

Or keep the intent in a launcher so it cannot be forgotten:

```sh
pi-silent() { CHAOS_RELAY_PROFILE="no-relay-$$" pi "$@"; }
```

**Why `$$`, and the trade-off.** A silent profile is a *single lock-holding
profile like any other*: two concurrent sessions pinned to the same `no-relay`
name collide exactly as two `default` sessions do, and the second one is
**refused** (no minted identity, no relay delivery) — the hole this pattern
exists to close. A
per-shell name closes it (`no-relay-$$`), at the cost of **one inert profile file
per shell**: it owns no channels, so it is safe to delete, but it does
accumulate. The alternative is a small fixed set of per-lane names
(`no-relay-a`, `no-relay-b`) that you reuse — which is silent only while one
session uses each name.

Either way, a sweep is cheap and safe **for profiles that own no channels**:

```sh
for f in ~/.pi/chaos-relay*.json; do
  printf '%s: ' "$f"
  node -e "const d=require(process.argv[1]);console.log((d.channels||[]).length+' channel(s)')" "$f"
done
```

**Do not sweep the profile that owns your channels.** That file *is* the
identity the channels are bound to: deleting it loses the keypair, and with it
the relay session that receives your Telegram/email. Legacy auto-created names
(`omarchy-…`, minted before v0.17.3) and per-shell `no-relay-…` names are the
ones that can go; a profile you named yourself — or that reports channels above
— deserves a look first.

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

Default setup is zero-config and never asks for a URL, so this only affects
older configs or a bad `CHAOS_RELAY_URL` / `--advanced` entry. A URL must be an
absolute `http(s)://…`; the effective URL is the **first valid** value in
precedence order (env → saved file → default), so a malformed value is skipped
rather than silently discarding a valid lower-precedence one. If no URL is
configured anywhere, auto-provisioning targets the hosted relay (with a warning),
and a set-but-invalid `CHAOS_RELAY_URL` with no saved URL is **refused** instead
of silently registering against the default.

The config file (and the `<config>.state` side-car holding the message cursor
and de-dup log) are written atomically (temp file + rename), so a concurrent
reader — e.g. a second pi session sharing the same profile —
never sees a half-written file. A crash between the temp write and the rename
leaves an inert `.tmp.*` orphan beside the file while the previous complete
file survives, if one existed (a first-ever write has no previous file).
**Backups of a profile must include BOTH the config file and
its `.state` side-car**: the de-dup log lives only in the side-car, so a
backup that restores the config without it resets de-dup (recent messages may
be re-delivered — the extension warns loudly when it detects this).
A damaged config never crashes the bridge: an
empty or whitespace-only file self-heals silently, and anything else that
fails to read or parse (truncated JSON, a hand-edit, non-object content) is
ignored with one warning naming the file and the error, falling back to
defaults. `/chaos-relay reset` (or `reset all`) clears a file you don't want
to repair by hand.

### "The reply was accepted" does not mean it was delivered

`relay_reply` returning `ok: true` means the relay **resolved and stored** the
reply. It does **not** mean Telegram or email delivered it — delivery happens
server-side and is not observable from this client. Two guarantees back this up
(since relay v0.17.0 / a journal-xk4 server):

- **Unknown channels are refused by name, before anything is stored.** If the
  `channelId` matches no channel registered to your session — or your
  `channelType` contradicts the channel's type — the relay answers `REFUSED`
  naming the channel (and lists your registered channels). A mistyped id can
  no longer round-trip as a confirmation; nothing is stored, nothing is sent.
- **Acceptance names the channel the relay actually resolved.** The success
  confirmation quotes `type / label / id` from the relay's own answer, not
  from your request. Against an older relay that names nothing, the tool says
  so — the confirmation then "only echoes the requested id and is NOT proof of
  delivery."

The extension logs the same distinction when the ack arrives:

```
relay_reply: WS ack ok responseId=… NOTE: ack means the relay RESOLVED + STORED the reply —
actual Telegram/email delivery happens server-side and is logged there.
```

So when inbound messages arrive fine and your replies vanish: a `REFUSED` is
this client or the relay telling you the target is wrong (fix the id); an
acceptance means ask whether the relay stored them and then failed to forward
— the channel's own state (e.g. can the bot post in that chat? is the email
address still verified?) — rather than retrying the send.

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
| `/chaos-relay help` | Show the full command reference (also shown on an unknown subcommand) |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `relay_connect` | **One-shot**: give it a bot token / email / `webhook` and it sets up the relay (auto-registering your session) and the channel in one step. Lets you just paste a token and say "connect this" |
| `relay_list_profiles` | List connection profiles and the active one |
| `relay_switch_profile` | Switch to (or create) a connection profile — "switch to my work connection" |
| `relay_check_messages` | Pull pending inbound Telegram/email messages and securely materialize attached images/files |
| `relay_reply` | Reply to a channel message (`channelType`, `channelId`, `content`, optional `replyTo`, optional `files` — absolute paths to attach; images render inline on Telegram, email gets real attachments; max 3 files, 5MB each, passed through and never stored). An unknown/mismatched `channelId` is **REFUSED by name** — nothing is stored or sent. **`ok: true` means the relay resolved + stored the reply (naming the resolved channel), not that the channel delivered it** — see Troubleshooting |
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
| `writes` *(default)* | Ask before `bash`, `edit`, and `write`; reads/searches run freely. `relay_reply` is gated when it ships a file attachment, **and a text-only `relay_reply` is gated once the session has inspected local content (`read`/`grep`/`bash`)** — this closes the read → text-reply exfiltration path without prompting on every read. The **control-plane** relay tools — `relay_connect`, `relay_register_telegram`/`_discord`/`_email`/`_webhook`, `relay_switch_profile` — are gated too, and any future `relay_*` name is gated by default. Only the read-only plumbing (`relay_check_messages`, `relay_list_profiles`) stays open. |
| `all` | Ask before **every** tool except the read-only relay plumbing (`relay_check_messages`, `relay_list_profiles`). |
| `off` | Fully autonomous — run every tool. Best paired with a sandbox/container. |

The `writes` read guard is **session-scoped**: once the session has inspected
local content (from a channel turn or a terminal/local turn), every later
channel-driven text-only `relay_reply` requires approval until the session ends.
Inspection means any `read` or `grep` of a local file **and any `bash`
execution** — a shell command can print arbitrary local content (`cat`, `grep`,
`env`, …), so a successful bash run taints the session exactly like a read does.
The taint is cleared only at session start/shutdown, not per turn — the LLM
conversation context persists across turns, so a secret read in turn 1 cannot be
text-replied out in turn 2 without approval. It does **not** gate the reads or
the bash execution themselves (in `writes` mode `bash` is gated for being a
write-class tool, and an approved run taints the session). For the strongest
posture — where a channel-driven turn cannot inspect local content at all
without approval — use `all` (which also gates every read/search and every
reply).

`writes` is the default so a channel-driven session is NOT ungated out of the
box; choose `off` (or `/chaos-relay approvals off`) for the old fully-autonomous
posture. Set with `/chaos-relay approvals <off|writes|all>` or the
`CHAOS_RELAY_APPROVAL_MODE` env var.

The control-plane gate matters even when you never touch `relay_connect`
yourself: `relay_register_*` would otherwise let a channel-borne prompt injection
register **the attacker's own channel**, and `relay_switch_profile` would let it
move the session to a profile whose approval mode is `off`. Either one takes the
session over *and* self-approves the gate, because the next approval question is
then delivered to the attacker's channel. In `writes` and `all` modes those
calls pause for your approval like any other gated tool.

When a tool is gated, the agent pauses and sends an approval request to the active
channel; **reply `yes <code>` to allow or `no <code>` to deny** — the prompt shows a
short code, and only the originating sender's reply counts (auto-denies after 5 minutes).
The prompt describes the tool without echoing its payload: a `relay_reply` shows only
its channel type, a short channel fingerprint, and a character/byte count (plus the
name and size of each attachment); a `bash`
approval shows a **REDACTED command string** (secret-shaped values are masked) so the
operator can judge benign vs destructive; `write`/`edit` show the **target path and
size**; a control-plane call shows the parsed channel kind, a short fingerprint for
`channelId` and for any name the caller chose (never the name itself), an email address
because that is the routing target a verification link would go to, and only a length
for credential fields (`botToken`, `password`, `secret`, `relay_connect`'s token) — the
question adds a line saying the call changes where the session connects or who may drive
it, so deny it if you did not ask for it. Caller-supplied names are deliberately drawn
as a fingerprint rather than echoed, because the agent chooses them: a channel-borne
`relay_switch_profile {name: …}` must not be able to copy local file contents into a
question that goes back out over the relay. Other tools show field sizes or path
fingerprints — never their contents.
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
5. Done. Messages, photos, and files you send the bot now arrive at the agent
   (auto-injected by the poller). The agent replies with `relay_reply` and they
   appear in your Telegram thread.

## Email setup — end to end

> The relay must be running with `CHAOS_EMAIL_DOMAIN` configured (and an email
> provider such as Resend wired up). See the relay's self-hosting docs.

1. Make sure the relay is configured (`/chaos-relay setup`).
2. Ask the agent to register email, or call the tool with your **email address**.
   The extension calls `POST /channels/email/register` and returns a **channelId**
   and an **inboundAddress** (e.g. `ch_abc123@your-relay-domain`).
3. Check your inbox for a **verification link** and click it to activate the
   channel.
4. Done. Email text and attachments sent to the inbound address reach the agent;
   replies go back to the sender via `relay_reply`.

## How inbound delivery works

While a pi session is active, the extension holds a **WebSocket** to the relay
and receives messages the instant they arrive. A slow background **safety poll**
(every ~120s) runs only as a backstop in case a push is missed between
reconnects. Reconnects back off exponentially (2s→4s→…→30s), and the fast
first retry is earned, not given: the backoff only resets once a connection
has stayed open for 30 seconds, so a relay that accepts the WebSocket and
immediately drops it gets the full exponential curve instead of hammering a
2-second reconnect floor forever. New messages are de-duplicated by id — and
that de-dup log is
**persisted** (in a small side-car `<config>.state` file next to the config,
written once per delivery batch), so the relay's on-connect
replay (a 5-minute lookback it sends every time the WebSocket connects) never
re-processes a message already handled before a restart. Fresh messages are
injected into the agent as a user message that includes each message's `id`,
`channelType`, `channelId`, sender, and content — everything the agent needs to
call `relay_reply`. Each message's block is fenced by an identical
`--- chaos-relay message <random-token> ---` line before and after it, and the
envelope fields on the line after the opening fence are JSON-quoted: a sender
controls both their display name and their content, so the per-delivery random
boundary (plus escaping) is what stops either from forging a second envelope or
a different sender in the agent's prompt. When a message was sent as a **reply** (Telegram
reply-threading, e.g. tapping reply on a question and answering "Drop"), the
replied-to message travels with it as an
`[In reply to message id="…" from "…": "…quoted text…"]` line **before** the
content, so a terse answer can be resolved to the question it answered; channels
that give only the id (or only the quoted text) still get
`[In reply to message id="…"]`. Inbound Telegram/email attachment descriptors
are downloaded through an ECDSA-signed, user/message-scoped relay endpoint.
Files are written to
private `0700` directories with mode `0600`; supported PNG/JPEG/GIF/WebP images
are also injected directly into the Pi image context after magic-byte checks.
Per-file failures are shown without dropping the text message. Stale local files
are removed after 24 hours. You can force an immediate pull with
`relay_check_messages` or `/chaos-relay poll`.

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
- **The relay's public key is pinned (TOFU).** Registration returns the relay's
  public key and the client persists it (`serverPublicKey`). A later
  re-registration that returns a DIFFERENT key is refused — the client fails
  closed rather than silently adopting a new key — which closes the
  "impersonate the relay after first contact" path at registration time. The
  pin does NOT yet authenticate the *content* of WebSocket frames or HTTP
  responses: that requires server-side response/frame signing, which is not
  implemented (see *Known limitations*).
- Bot tokens are sent only to the relay's register endpoint over HTTPS; the relay
  encrypts them at rest. They are not persisted by this extension.
- The durable relay log (`~/.pi/agent/logs/chaos-relay.log`) is kept owner-only
  (directory `0700`, file `0600`), and pairing codes, channel ids, bot usernames,
  email addresses and webhook URLs are withheld from it. The interactive tool
  output still shows the fresh pairing code / verification link the operator
  needs to finish linking a channel.
- Inbound attachments are capped at 3 files per message and 5MB each. The relay
  stores only bounded descriptors and private provider references—not bytes,
  credentials, or Resend signed URLs. Attachment retrieval requires request
  signing even for otherwise legacy bearer-only sessions and returns `no-store`.

## Development

```bash
npm test        # node --test unit tests (relay client, poller, config); runs the version check first
npx tsc --noEmit -p tsconfig.json   # type-check against pi types
npm run check:version -- --base origin/master   # package.json/lockfile agreement (required by the gate)
npm run test:fast   # implementer iteration: the two checks above + only the affected tests
```

`npm run test:fast` is for iteration, not for landing. It always runs the
whole-tree type-check and the version gate, then narrows the tests using the
explicit reverse-dependency map in `scripts/fast-gate.ts` — and falls back to the
**full** suite for the entry point, the manifests/lockfile, `tsconfig.json`,
anything under `test/`, and any path that is not in the map. Landing (and the
fleet merger) still runs `npx tsc --noEmit && npm test` on the merged tree; see
AGENTS.md.

`npm test` runs the version check first (via `pretest`), so a tree whose
`package.json` and `package-lock.json` disagree fails the gate instead of shipping —
that half needs no base and always applies. The check also refuses a version that
has moved backwards: it compares against the default branch (read as the fully
qualified `refs/remotes/origin/master`, so a local branch named `origin/master`
cannot shadow it), and in a shallow, single-branch, offline or remote-less checkout
it falls back to `HEAD` and **says which half it could not enforce** and how to
enforce it explicitly. The strict check takes a required `--base`, refuses an
ambiguous bare name rather than resolving it, and fails closed on an unresolvable
ref.

`npm ci` (or `npm install`) must run before the `npx tsc` check, which needs the
`typescript` devDependency — without it `npx` instead runs the unrelated
`tsc@2.0.4` package and reports "This is not the tsc command you are looking
for"; `npm test` needs no install.

Integration testing against a local relay: run the CHAOS relay server
(`deno task start` in `packages/server` with `--unstable-kv`) and point
`CHAOS_RELAY_URL=http://localhost:8787`.

## Known gaps / future work

- **A locked profile leaves the session without relay delivery.** A collision is
  now refused instead of auto-replaced (see *The collision: a held profile is
  refused, never replaced*), so the losing session has no push connection until
  you close the holder or give it its own `CHAOS_RELAY_PROFILE`. That trade is
  deliberate — an inert session you can see beats a new identity you never chose
  — and the check still runs at `session_start` only, so a collision that only
  appears later (a second instance that starts while this one is still
  provisioning) is not re-checked until the next `session_start`.
- **The reply-ack note is WS-only.** The WebSocket path logs that `ok` means
  *stored, not delivered* (`index.ts:879`); the HTTP fallback logs a bare `ok=`
  (`index.ts:900`) and the tool text says "will forward it". One shared sentence
  in all three places would stop the client from implying more than it knows.
- **Server response signing.** The client enforces the TOFU pin on the relay's
  public key (a re-registration returning a different key fails closed), but it
  does not yet verify server signatures on the *content* of WebSocket frames or
  HTTP responses — the relay does not sign them. Authenticating frame/response
  content requires a server-side change (sign frames/responses with the pinned
  server key). Outbound request signing (the key threat: someone spending your
  API key) is fully implemented.
- Email registration depends on relay-side `CHAOS_EMAIL_DOMAIN` + provider config.

## License

MIT — see [LICENSE](./LICENSE).
