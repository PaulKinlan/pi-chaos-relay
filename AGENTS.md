# Agent guide — pi-chaos-relay

A [pi](https://github.com/earendil-works) extension that bridges the pi coding
agent to a CHAOS relay server so it can be driven from (and reply to) Telegram
and email. This file is the source of truth for how agents work in this repo.

## Versioning — bump on EVERY commit

`package.json` `version` MUST be bumped on every commit that changes shipped
code, following [Semantic Versioning](https://semver.org/). Do it in the same
commit as the change.

While the project is pre-1.0 (`0.y.z`):

- **PATCH** (`0.1.0 → 0.1.1`) — backwards-compatible bug fixes, hardening,
  performance, refactors, and docs that ship alongside code. (Most commits.)
- **MINOR** (`0.1.1 → 0.2.0`) — new backwards-compatible capability (a new tool,
  command, channel type, or transport) **or** any change that alters the config
  file shape, the relay wire protocol, or otherwise breaks existing setups.
  Pre-1.0, MINOR is the lever for breaking changes.
- **MAJOR** (`→ 1.0.0`) — reserved for the first stable release.

Doc-only or test-only commits that touch no shipped code (e.g. editing this
file) may keep the version, but if in doubt, bump PATCH.

Reference the new version in the commit message footer, e.g. `v0.1.1`.

## Build / validate before committing

Run these and make sure they pass before every commit:

```sh
npx tsc --noEmit     # type-check (no emit)
npm test             # node --test over test/*.test.ts
```

Both must be green. Add or update tests for behavior changes.

## Keep docs in sync — in the SAME commit

A user-facing change is not done until the docs match it. Update whichever of
these the change touches, in the same commit as the code:

- **`README.md`** — env-var / command / tool tables, the quick-start and flows,
  the inbound-delivery and security sections.
- **`skills/chaos-relay/SKILL.md`** — agent-facing how-to: tools table, commands
  table, channel + profile flows.
- **`skills/chaos-relay-troubleshoot/SKILL.md`** — the `doctor` checklist and the
  symptom → fix steps.

Whenever you add / rename / remove a **command** (`/chaos-relay …`), a **tool**
(`relay_*`), an **env var** (`CHAOS_RELAY_*`), or change the `doctor` checks:
grep the docs for the old names and fix **every** table. The command, tool, and
env-var lists in the README and skills must stay 1:1 with `index.ts` and
`config.ts` — and never document a knob the code doesn't actually consume.

## Layout

- `index.ts` — pi extension entry: registers tools (`relay_reply`,
  `relay_register_telegram`, `relay_register_email`, …) and the `/chaos-relay`
  command (`setup`/`status`/`poll`/`stop`); owns the poller + WebSocket.
- `relay-client.ts` — signed HTTP client for the relay (ECDSA P-256 identity).
- `ws-client.ts` — WebSocket transport (push delivery + reconnect/backoff).
- `poller.ts` — cursor + dedup; HTTP catch-up and safety poll.
- `config.ts` — resolves config from env + `~/.pi/chaos-relay.json` (0600).
- `crypto.ts` — keypair generation + request signing.

## Conventions

- The keypair in `~/.pi/chaos-relay.json` is the secret identity — never log it,
  never commit it (the file lives under `~/.pi`, outside the repo).
- Every network call must be bounded by a timeout so a hung relay can never
  block the agent (see `DEFAULT_TIMEOUT_MS` in `relay-client.ts`).
- The canonical relay server lives in `~/chaos/packages/server`; match its
  API spec (`~/chaos/docs/relay-api-spec.md`).
