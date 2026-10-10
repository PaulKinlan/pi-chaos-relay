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

`npm ci` (or `npm install`) must run before the `npx tsc --noEmit` gate, which needs the `typescript` devDependency — without it `npx` instead runs the unrelated `tsc@2.0.4` package and reports "This is not the tsc command you are looking for"; `npm test` needs no install.

Both must be green. Add or update tests for behavior changes.

### Focused iteration: the fast gate (implementers)

While iterating, `npm run test:fast` runs the same two whole-tree checks plus only
the tests affected by your branch, so an isolated module change does not pay for
the 3,000-line `test/index.test.ts` integration suite on every commit:

```sh
npm run test:fast                  # npx tsc --noEmit + version gate + affected tests
npm run test:fast -- --dry-run     # print the plan (mode, tests, commands), run nothing
npm run test:fast -- --base <ref>  # change list against <ref> instead of the default branch
```

It is conservative by construction, and what it does NOT cover is stated rather
than glossed: a mapped module runs every test file that transitively imports it
(unit level), and the **integration suite `test/index.test.ts` is not part of the
affected tier** — the entry point imports every module, so including it would make
every change the full suite. That is the trade the fast tier is: only the full
tier runs integration coverage, and the full tier is what the merger runs before
anything lands. Anything else the selector cannot prove isolated falls back to
the FULL suite: the entry point, `package.json` / `package-lock.json`,
`tsconfig.json`, anything under `test/`, **any path that is not in the explicit
reverse-dependency map** (`MODULE_TESTS` in `scripts/fast-gate.ts`), a change list
it cannot read, and a checkout where no default branch resolves. The working tree
is always included, so a dirty checkout only ever widens the run. `--base <ref>`
must resolve: a typo is a usage error, not a narrower run.

This is NOT the landing gate. The merger runs the full
`npx tsc --noEmit && npm test` on the merged union, and a change is green only
once that passes. When you add a module, decide its fast-tier coverage in one
line — add it to `MODULE_TESTS` (its own tests plus the tests of the modules that
import it) or to `FULL_TESTS_TRIGGERS`; `test/fast-gate.test.ts` fails while a
shipped module is in neither, and the map's coverage of the real import graph is
re-derived by that test file (a new import edge cannot silently escape the fast
tier). On the fleet VMs this is what `~/.fleet/check.conf` points `CHECK_FAST_CMD`
at; `CHECK_CMD` stays the full gate.

`npm test` also enforces version consistency. Its `pretest` step runs
`scripts/check-version-consistency-gate.mjs`, which picks the strongest base it can
resolve and then runs the strict check in `scripts/check-version-consistency.mjs`:
`package.json`, the top-level `version` in `package-lock.json` and
`package-lock.json`'s `packages[""].version` must agree, and the version must not
move below that base. The **agreement** half needs no base, so it is enforced on
every run; the **monotonicity** half is enforced against the default branch when
that ref resolves, and in a shallow, single-branch, offline or remote-less checkout
the wrapper falls back to `HEAD` and SAYS SO — naming the half it did not enforce and
how to enforce it. The default base is read through the FULLY QUALIFIED ref
`refs/remotes/origin/master`, because a local branch named `origin/master` would
otherwise shadow it (git resolves a bare name by precedence, `refs/heads` first, with
only a warning). For the same reason the strict checker REFUSES an ambiguous bare
base name rather than resolving it. Run the strict check directly with
`npm run check:version -- --base refs/remotes/origin/master`: there the base ref is
required and an unresolvable ref fails closed rather than skipping the check.

## Keep docs in sync — in the SAME commit

A user-facing change is not done until the docs match it. Update whichever of
these the change touches, in the same commit as the code:

- **`README.md`** — env-var / command / tool tables, the quick-start and flows,
  the inbound-delivery and security sections.
- **`skills/chaos-relay/SKILL.md`** — agent-facing how-to: tools table, commands
  table, channel + profile flows.
- **`skills/chaos-relay-troubleshoot/SKILL.md`** — the `doctor` checklist and the
  symptom → fix steps.
- **`AGENTS.md` / `CLAUDE.md`** — `CLAUDE.md` mirrors the load-bearing rules from
  this file; a rule change must update both together.

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
- `profile-lock.ts` — the profile lock protocol: exclusive claim, refuse a live
  holder, reclaim a stale/ambiguous file after the create grace. index.ts keeps
  the policy around it (when to claim, what to tell the user, shutdown release).
- `approvals.ts` — the outstanding-approval queue (one entry per request, nonce
  and sender/channel binding, independent timeouts) and `summarizeToolCall`, the
  payload-safe one-liner shown in the approval question.
- `config.ts` — resolves config from env + `~/.pi/chaos-relay.json` (0600).
- `crypto.ts` — keypair generation + request signing.

## Conventions

- The keypair in `~/.pi/chaos-relay.json` is the secret identity — never log it,
  never commit it (the file lives under `~/.pi`, outside the repo).
- Every network call must be bounded by a timeout so a hung relay can never
  block the agent (see `DEFAULT_TIMEOUT_MS` in `relay-client.ts`).
- The canonical relay server lives in `~/chaos/packages/server`; match its
  API spec (`~/chaos/docs/relay-api-spec.md`).
- Background delivery is bound to ONE session runtime, and there is nothing to
  re-arm: an event handler's `ExtensionContext` has no `sendUserMessage` (only
  `ExtensionAPI` and `ReplacedSessionContext` do). For `/new`, `/resume` and
  `/fork` pi disposes the session, which invalidates the whole instance — every
  later `pi.*` call throws "stale after session replacement"; for `/reload` it
  clears the extension module cache and builds a fresh instance without
  invalidating the old one, and the SDK still says not to use the old ctx. Either
  way the old instance must stop, and pi loads a replacement instance that arms
  itself in its own `session_start`.
- Hand accepted-but-undelivered batches back at `session_shutdown`, synchronously,
  BEFORE the replacement reads the poller state. pi awaits that handler before it
  disposes the session and builds the replacement, so a `requeue` there is
  guaranteed to land first; requeueing later, from the delivery that failed, races
  the replacement's own state read (for a slow attachment download the replacement
  usually wins, and its next write overwrites the rewound cursor — the message is
  lost after all). `MessagePoller.requeue` un-sees the batch and rewinds the
  cursor one second before its earliest message, never forwards; without it the
  persisted cursor has already moved past those messages, so the replacement could
  never fetch them. Tracked in `inFlightBatches` from `queueDelivery` until a
  `sendUserMessage` succeeds — a delivered batch is never handed back.
- Never `accept()` (persist a cursor) from an instance that can no longer deliver:
  a catch-up or safety poll may still be awaiting the relay when the swap lands, so
  re-check liveness AFTER the await, immediately before `accept()` — the check
  before the await is not enough (`pollAndDeliver` awaits `pollRaw()`, then
  accepts). A batch reaching a replaced runtime early is handed back rather than
  silently dropped; it may have been accepted before the flag was set.
