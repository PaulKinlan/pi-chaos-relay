---
name: chaos-relay-troubleshoot
description: Diagnose and recover from CHAOS relay problems — setup errors, "Failed to parse URL", messages not arriving, replies not sending, relay unreachable, channel pairing failures, corrupted config, WebSocket/transport issues, ECDSA signature errors, stale sessions. Use whenever the user reports the relay bridge is broken or behaving unexpectedly, when /chaos-relay status shows problems, or when an onboarding/registration call fails. The first action is always /chaos-relay doctor.
---

# CHAOS Relay Troubleshooting & Recovery

Use this whenever the relay bridge is misbehaving. **Always start with
`/chaos-relay doctor`** — it runs a structured check-list and prints the exact
failing check plus the fix, which beats guessing.

## Step 1: run doctor

```
/chaos-relay doctor
```

It reports ✓/✗ on each of:

1. **Config file parses** — `~/.pi/chaos-relay.json` is valid JSON.
2. **Relay URL is valid http(s)** — an absolute `http://`/`https://` URL.
3. **API key configured** — a session is registered.
4. **ECDSA identity** — keypair present (signed requests) vs Bearer-only (legacy).
5. **Relay reachable** — a live `GET /health` against the configured URL.
6. **WebSocket transport** — connected / reconnecting / stopped.
7. **Channels registered** — at least one channel wired up.

Each failing line ends with `→ <fix>`. Work down the failing checks in order —
earlier failures often cause later ones.

## Step 2: map the symptom to the fix

### "Failed to parse URL from /…" / onboarding error during setup
The saved relay URL is malformed — almost always a command or non-URL string
pasted into the URL field, or a bad `CHAOS_RELAY_URL` env var. (Since v0.6.2 the
setup prompt rejects these, but old corrupted configs still exist.)

**Fix:**
- `/chaos-relay reset` — clears the bad `relayUrl` only, keeps credentials,
  keypair, and channels. Then `/chaos-relay setup` to re-enter the URL.
- If that doesn't clear it (or the whole file is corrupted):
  `/chaos-relay reset all` — wipes the config; full fresh start, then
  `/chaos-relay setup` (or just `/chaos-relay connect <token>` to re-provision).

### Config file won't parse
`~/.pi/chaos-relay.json` is corrupt JSON (hand-edited, partial write, merge
conflict).

**Fix:** `/chaos-relay reset all`, then `/chaos-relay setup` or
`/chaos-relay connect <value>`.

### Messages not arriving
- Check doctor: **WebSocket transport** stopped and **relay reachable** ok →
  the poller isn't running. Restart it by re-running setup, or just
  `/chaos-relay poll` to drain the queue once.
- **Relay reachable** ✗ → the relay host is down or the URL is wrong
  (`/chaos-relay status` shows the current URL). Verify network, then reset/setup.
- Transport connected but still nothing → the sender's channel isn't linked.
  For Telegram/Discord the user must send the **pairing code** to the bot first;
  for email they must click the **verification link**. Re-register the channel
  (`relay_register_*`) to get a fresh pairing code / link if needed.
- Messages arrive repeatedly on restart → the resume cursor is stale; harmless,
  it self-heals. (Persists the last-delivered timestamp.)

### Replies not sending / "Relay request failed"
- **ECDSA identity** is Bearer-only (legacy session with no keypair) and the
  relay now requires signatures → `/chaos-relay setup` and choose
  "Register a new session (ECDSA)" to bind a keypair. Old Bearer-only sessions
  are accepted only if the relay still allows unsigned requests.
- **Relay reachable** ✗ → same as above; check URL/network.
- Clock skew → signatures carry a timestamp; a system clock more than a small
  window off will fail signature verification. Fix the system clock.

### Channel pairing fails
- Telegram: the user must send the **pairing code** to the bot in Telegram
  itself (not to the agent). Re-run `relay_register_telegram` to get a new code.
- Discord: no `setWebhook` exists — the bot's interaction endpoint (or a
  gateway relay) must be pointed at `https://<relay>/discord/<channelId>`.
  Pairing code alone isn't enough without that route.
- Email: the verification link goes to the user's inbox; if it expired,
  re-register with `relay_register_email`.

### "unknown" from `connect`
`/chaos-relay connect` couldn't detect the channel type. Have the user prefix
it explicitly: `telegram <token>`, `discord <token>`, `email <addr>`,
`webhook <name>`.

## Step 3: commands

| Command | Purpose |
|---------|---------|
| `/chaos-relay doctor` | Diagnostics check-list — **run this first** |
| `/chaos-relay status` | Config, poller state, live relay health |
| `/chaos-relay reset` | Clear corrupted `relayUrl` only (keeps creds + channels) |
| `/chaos-relay reset all` | Wipe the whole config file (fresh start) |
| `/chaos-relay setup` | Re-enter URL/credentials; "Register new session (ECDSA)" binds a keypair |
| `/chaos-relay connect <value>` | Re-provision from scratch with one paste |
| `/chaos-relay poll` | Drain the inbound queue once |
| `/chaos-relay stop` | Stop the background poller |

## Rules of thumb

- **Doctor first, always.** It pinpoints the layer; don't reset blindly.
- **`reset` before `reset all`.** The url-only reset preserves credentials and
  channels; reach for the full wipe only when the file itself is corrupt.
- After any reset/setup, re-run `/chaos-relay status` (or `doctor`) to confirm
  green before declaring it fixed.
- If a channel was registered against an old session that's now gone, it must
  be re-registered (`relay_register_*`) — the relay can't reclaim it from the
  keypair alone. The extension auto-tries this on session recovery when it has
  the stored bot token / email.
