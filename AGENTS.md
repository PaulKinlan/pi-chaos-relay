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
  A delivered relay message queues its ORIGIN (channel/sender) plus the exact text
  that delivery sent, and the turn it starts adopts it, so a gated tool call asks over
  the channel that message came from. Binding happens in `message_start` for the user
  message and matches that text — NOT by shifting the queue in `agent_start`, which
  fires per agent run, including locally initiated runs, but not once per queued
  follow-up turn, so a positional bind let a terminal
  turn consume the origin of a relay message still queued behind it (bead
  pi-chaos-relay-pl2). `message_start` specifically, because it is an agent event and
  so fires on both delivery paths, while `before_agent_start` — the obvious hook, since
  it carries the prompt — is emitted only from the SDK's idle `prompt()` path; a
  message delivered while the agent is streaming goes through `_queueFollowUp` and
  never reaches it, and this extension always delivers as a follow-up.
  Matching requires the WHOLE delivered text to be present, as the turn's prefix (pi
  appends image hints after the composition point; a floor length stops a short terminal
  message matching a long delivery). Deliberately not a prefix in the other direction:
  every delivery opens with the same static line ("You have N new message(s) from
  chaos-relay. …"), so accepting a prefix as proof of origin let a message containing
  just that line match and consume the pending origin (review round 2).
  A turn whose text ties to no pending delivery is either something the operator typed
  or steered, or a delivery whose text an `input` extension rewrote — indistinguishable
  — so it is BLOCKED: the gated call is refused outright and NO channel is asked, so an
  unrelated recipient never authorizes (or sees the summary of) a call they did not
  initiate (review round 2: an authorization boundary, not a UX preference). The pending
  origin is NOT consumed, so the relay turn is still gated over its own channel when it
  arrives — that misattribution is what this bead fixes. With nothing pending, a
  non-relay turn is not gated at all, and clears any binding left by a turn that ended
  without `agent_end`.
  `test/index.test.ts` drives turns through a `startTurn` helper (`agent_start` then the
  turn's user `message_start`), because a test that fires only `agent_start` no longer exercises
  binding, and `agent_start` alone cannot model the queued path at all.
- `relay-client.ts` — signed HTTP client for the relay (ECDSA P-256 identity).
- `ws-client.ts` — WebSocket transport (push delivery + reconnect/backoff). The
  upgrade authenticates via `wsConnectTarget` — `Authorization: Bearer <apiKey>` in
  `header` mode, the legacy `?token=` in `query` mode;
  `toWsUrl` takes no credential, so no URL built here can contain one. The legacy
  `?token=` form is what ships by default (see below); `CHAOS_RELAY_WS_AUTH=header`
  moves the key into the upgrade request and out of the URL. A URL-carried key is
  warned about once per connection lifecycle, and an unusable value uses (and names)
  the default with a warning — never silently. The DEFAULT is `query` only because the
  relay's `/ws` handler reads the token from the query string and 401s without it
  (PaulKinlan/chaos `packages/server/src/main.ts`, the upgrade branch): defaulting to
  `header` would silently downgrade every session to the safety poll. Flip the default
  when the relay reads an upgrade Authorization header. `wsAuthSummary` feeds the
  `status` line and the doctor fix text. A runtime that rejects the `headers` option
  (any construct failure, not only a TypeError) logs the query-token way out instead
  of looking like a dead apiKey.
- `state-writer.ts` — debounced persistence for the poller's resume state (bead
  pi-chaos-relay-7jp). `stage()` coalesces a burst; `stageUrgent()` writes NOW and is
  for state another process reads — a hand-back. The flush points are the drain edge
  (index.ts's delivery chain, when nothing is queued behind the batch), the 2s
  safety-net interval, `session_shutdown` (flush then dispose), and any urgent write.
  The writer is created by `makePoller` and PINNED to the profile's state path at
  that moment: the write is deferred, so resolving the path at flush time would put
  state staged under one profile into the next profile's side-car. The release at
  `connectAsProfile` and the pin are redundant for that: either alone is sufficient
  in today's flow, and the profile-switch test only fails when BOTH are removed —
  that pair is the regression it pins. A reset drops the state
  instead of flushing it (`releaseStateWriter(false)`), or it would recreate the
  files `resetPersisted("all")` just deleted.
  Do NOT add a `runtimeReplaced` guard to the write: suppressing the hand-back write
  is what the d8e regression test catches. Do not remove the `disposed` check either:
  a superseded instance holding older state must not flush it over the replacement's.
- `poller.ts` — cursor + dedup; HTTP catch-up and safety poll. `accept()` is also
  the inbound shape gate: both transports hand it raw relay payloads, so it runs
  every message through `inbound-message.ts` before anything reads a field.
- `inbound-message.ts` — shape/size checks for inbound messages (`parseInboundMessage`)
  and the log-line limiter for refused frames. The relay forwards channel payloads
  as-is and signs nothing, so this is the boundary: a message whose field would
  break or corrupt state is refused and reported, an oversized/extra payload is
  repaired with a warning (content truncated at 256 KiB with a visible marker,
  first 3 attachments, 200-char filenames, with a note for anything not delivered
  carried in `inboundMeta` — rendered into the agent's prompt by
  `formatMessagesForAgent`, never written into the sender's body, because
  `approvals.settle` matches answers against that body), and a missing timestamp is delivered but
  never allowed to move the resume cursor (which is compared as an instant, not as
  a string). `ws-client.ts` bounds the raw frame — the same 5 MiB as
  `MAX_CONTROL_PLANE_BYTES`, before `JSON.parse` — and uses the parser as a
  VERDICT ONLY, forwarding the message unchanged so the repair and its single log
  line happen exactly once, in `accept`.
- `profile-lock.ts` — the profile lock protocol: exclusive claim, refuse a live
  holder, reclaim a stale/ambiguous file after the create grace. index.ts keeps
  the policy around it (when to claim, what to tell the user, shutdown release).
- `approvals.ts` — the outstanding-approval queue (one entry per request, nonce
  and sender/channel binding, independent timeouts) and `summarizeToolCall`, the
  payload-safe one-liner shown in the approval question. `settle` matches an
  answer against the SENDER'S text, with `stripInboundRepairNotes` applied first:
  the inbound shape checks append notes after the message, and an approval reply
  that itself carried an unusable attachment must still answer its request
  instead of timing out.
- `config.ts` — resolves config from env + `~/.pi/chaos-relay.json` (0600).
- `crypto.ts` — keypair generation + request signing.

## Conventions

- The keypair in `~/.pi/chaos-relay.json` is the secret identity — never log it,
  never commit it (the file lives under `~/.pi`, outside the repo).
- Every network call must be bounded by a timeout so a hung relay can never
  block the agent (see `DEFAULT_TIMEOUT_MS` in `relay-client.ts`).
- The canonical relay server lives in `~/chaos/packages/server`; match its
  API spec (`~/chaos/docs/relay-api-spec.md`).
- The relay URL carries the bearer API key, so `isValidRelayUrl` accepts
  `https://` anywhere and `http://` only on loopback (`localhost`, 127.0.0.0/8,
  `[::1]`). Never weaken that to a scheme check: a plaintext external URL sends
  the key in every request and in the WebSocket upgrade.
  `CHAOS_RELAY_ALLOW_INSECURE_HTTP=1` is the only bypass, it is off unless set,
  and any connect that relies on it logs a warning. A refused plaintext URL must
  fail closed — never fall back to `DEFAULT_RELAY_URL` for a session that is
  already bound, and never let the failure be reported as a malformed URL.
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
