# CLAUDE.md — pi-chaos-relay

See [AGENTS.md](./AGENTS.md) for the full agent guide (layout, conventions,
relay API reference). The rules below are load-bearing — follow them on every
change.

## Bump the version on every commit (semver)

`package.json` `version` MUST be bumped in the same commit as any change to
shipped code, per [Semantic Versioning](https://semver.org/). While pre-1.0
(`0.y.z`):

- **PATCH** (`0.1.1 → 0.1.2`) — bug fixes, hardening, perf, refactors, and docs
  that ship with code. Most commits.
- **MINOR** (`0.1.x → 0.2.0`) — new backwards-compatible capability, OR any
  change that breaks existing setups (config shape, relay protocol). Pre-1.0,
  MINOR is the breaking-change lever.
- **MAJOR** (`→ 1.0.0`) — first stable release.

Pure doc/test-only commits may keep the version; if unsure, bump PATCH. Put the
new version in the commit footer (e.g. `v0.1.2`).

## Validate before committing

```sh
npx tsc --noEmit     # type-check
npm test             # node --test
```

`npm ci` (or `npm install`) must run before the `npx tsc --noEmit` gate, which needs the `typescript` devDependency — without it `npx` instead runs the unrelated `tsc@2.0.4` package and reports "This is not the tsc command you are looking for"; `npm test` needs no install.

Both must pass. Add/adjust tests for behavior changes.

**While iterating**, `npm run test:fast` runs `npx tsc --noEmit` and the version
gate as always, then only the test files affected by your change
(`scripts/fast-gate.ts` holds the explicit map). The entry point, the
manifests/lockfile, `tsconfig.json`, anything under `test/`, and any unmapped
path fall back to the FULL suite. It never replaces the merger's full gate: a
change is green only after `npx tsc --noEmit && npm test` passes on the merged
union. See AGENTS.md for the map's rules.

## Keep docs in sync (same commit)

Any change to a command (`/chaos-relay …`), tool (`relay_*`), env var
(`CHAOS_RELAY_*`), or the `doctor` checklist MUST update the docs in the same
commit: `README.md` (env / command / tool tables + flows),
`skills/chaos-relay/SKILL.md`, and `skills/chaos-relay-troubleshoot/SKILL.md`.
Keep those lists 1:1 with `index.ts` / `config.ts`; never document a knob the
code doesn't consume. See AGENTS.md for the checklist.

`CLAUDE.md` mirrors the load-bearing rules from `AGENTS.md`; a rule change must
update both together.

## Gotchas

- Secrets (the ECDSA keypair, apiKey) live in `~/.pi/chaos-relay.json` (0600),
  outside the repo. Never log or commit them.
- Every relay network call must be timeout-bounded (`DEFAULT_TIMEOUT_MS`) so a
  hung relay can't block the agent.
- Dedup of inbound messages happens in exactly ONE place per delivery path. The
  WS catch-up uses `poller.pollRaw()` (no dedup) and lets `onMessage` →
  `accept()` dedup; using `poller.poll()` there double-dedups and silently drops
  every caught-up message.
