/**
 * Selector tests for scripts/fast-gate.ts (bead pi-chaos-relay-a1x).
 *
 * The fast gate is only safe if its narrowing is conservative: a changed path
 * that is not PROVABLY isolated must send the run to the full suite. These tests
 * pin that matrix and the map's hygiene, so a new module cannot silently become
 * an unmapped hole (the guard tells the author to add it to MODULE_TESTS or to
 * FULL_TESTS_TRIGGERS), and so the fast tier can never quietly become the full
 * tier by pulling in test/index.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FULL_TESTS_TRIGGERS,
  INTEGRATION_TEST,
  MARKER_PREFIX,
  MODULE_TESTS,
  changedFiles,
  discoverTestFiles,
  dispatchMarkers,
  failingSuitesFromTap,
  outcomeMarkers,
  resolveBase,
  selectTests,
  unknownMarker,
} from "../scripts/fast-gate.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_URL = new URL("../scripts/fast-gate.ts", import.meta.url);
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);

test("importing fast-gate does not run the gate", () => {
  // The module must be importable by these tests (and by anything else). Without
  // the entry-point guard, importing it would run tsc + the suite and exit.
  const result = spawnSync(process.execPath, ["--eval", `await import(${JSON.stringify(SCRIPT_URL.href)})`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `import should be inert: ${result.stderr}`);
  assert.equal(result.stdout, "", "an import must print nothing");
});

test("a mapped module selects its own tests and its importers' tests", () => {
  const selection = selectTests(["config.ts"]);
  assert.equal(selection.mode, "affected");
  // approval-policy.ts and profile-lock.ts import config.ts, so their tests
  // can catch a config change.
  assert.deepEqual(selection.tests, ["test/approval-policy.test.ts", "test/config.test.ts", "test/profile-lock.test.ts"]);

  // relay-client is imported by poller, ws-client, inbound-attachments and
  // inbound-message, so a change there can change their behaviour too — all five
  // come along.
  const client = selectTests(["relay-client.ts"]);
  assert.equal(client.mode, "affected");
  assert.deepEqual(client.tests, [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/relay-client.test.ts",
    "test/ws-client.test.ts",
  ]);
  // A new module joins the tier on the same terms: its own tests plus every test
  // whose import closure reaches it (the inbound shape checks are imported by the
  // poller, the WebSocket transport and the attachment downloader).
  const shape = selectTests(["inbound-message.ts"]);
  assert.equal(shape.mode, "affected");
  assert.deepEqual(shape.tests, [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/ws-client.test.ts",
  ]);
});

test("several isolated modules union their tests, sorted and deduped", () => {
  const selection = selectTests(["config.ts", "url-redact.ts", "connect.ts", "config.ts"]);
  assert.equal(selection.mode, "affected");
  // url-redact fans out to every module that imports it (relay-client, ws-client,
  // inbound-attachments and poller through relay-client); config reaches
  // approval-policy and profile-lock. The closure guard test proves these edges are complete:
  // it is what caught the two new edges when approvals.ts extracted the summary
  // (approvals.ts imports parseConnectInput and redactCommandSecrets, so connect
  // and url-redact changes can now affect the approvals tests).
  assert.deepEqual(selection.tests, [
    "test/approval-policy.test.ts",
    "test/approvals.test.ts",
    "test/config.test.ts",
    "test/connect.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/profile-lock.test.ts",
    "test/relay-client.test.ts",
    "test/url-redact.test.ts",
    "test/ws-client.test.ts",
  ]);
  assert.deepEqual(selection.changed, ["config.ts", "connect.ts", "url-redact.ts"]);
});

test("the entry point always forces the full suite", () => {
  assert.equal(selectTests(["index.ts"]).mode, "full");
  // …and so does anything reached from nowhere in the map below (the guard test
  // proves index.ts is the only module that needs this rule).
  assert.match(selectTests(["index.ts"]).reason, /global/);
});

test("manifests, lockfiles and tsconfig force the full suite", () => {
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", ".npmrc"]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} must not be narrowed`);
    assert.match(selection.reason, /full suite/);
  }
});

test("any test file — or anything else under test/ — forces the full suite", () => {
  for (const path of ["test/config.test.ts", "test/index.test.ts", "test/helpers.ts", "test/fixtures/a.json"]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} must not be narrowed`);
    assert.match(selection.reason, /suite|harness/);
  }
  // The selector's own test is the single exception: it exercises the selector.
  assert.deepEqual(selectTests(["test/fast-gate.test.ts"]).tests, ["test/fast-gate.test.ts"]);
});

test("an unknown, new or deleted path forces the full suite", () => {
  for (const path of [
    "binary.ts",
    "lib/new-module.ts",
    "scripts/other.mjs",
    "README.md",
    "docs/preview.png",
    "skills/chaos-relay/SKILL.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/ci.yml",
  ]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} is not mapped and must not be narrowed`);
    assert.match(selection.reason, /not in the affected-test map|global/);
  }
});

test("one unmapped path out of many sends the whole run to the full suite", () => {
  const selection = selectTests(["config.ts", "url-redact.ts", "mystery.txt"]);
  assert.equal(selection.mode, "full");
  assert.match(selection.reason, /mystery\.txt/);
});

test("an empty change list selects nothing and says so", () => {
  const selection = selectTests([]);
  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.tests, []);
  assert.match(selection.reason, /no tracked change/);
  assert.deepEqual(selection.changed, []);
});

test("paths are normalised before matching (./ prefix, backslashes)", () => {
  assert.deepEqual(selectTests(["./config.ts"]).tests, [
    "test/approval-policy.test.ts",
    "test/config.test.ts",
    "test/profile-lock.test.ts",
  ]);
  // A Windows-style separator still lands under test/ and must force the full suite.
  assert.equal(selectTests(["test\\config.test.ts"]).mode, "full");
});

test("the map is a SUPERSET of the real import closure (the guard that matters)", () => {
  // This is the check that would have caught the first draft of the map: it
  // hand-listed url-redact -> [url-redact.test] while relay-client, ws-client and
  // inbound-attachments all import it. Derive who-imports-what from the files
  // themselves, so a new edge cannot silently escape the fast tier's coverage.
  const modules = discoverSourcePaths();
  const tests = discoverTestFiles().filter((t) => t !== INTEGRATION_TEST);
  const closureOf = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const dep of relativeImportsOf(file)) closureOf(dep, seen);
    return seen;
  };
  const missing = findMissingMapEdges(modules, tests, closureOf, MODULE_TESTS);
  assert.deepEqual(
    missing,
    [],
    `MODULE_TESTS under-covers the import graph for:\n  ${missing.join("\n  ")}\n` +
      `Add each test file to that module's list in scripts/fast-gate.ts.`,
  );
});

test("every test file that exists is accounted for by the affected tier", () => {
  // The real condition: no test file may be an unaccounted hole. Either some
  // mapped module selects it, or it is one of the files only the full tier runs.
  const selected = new Set(Object.values(MODULE_TESTS).flat());
  const unaccounted = discoverTestFiles().filter(
    (test) => !selected.has(test) && !FULL_TIER_ONLY_TESTS.includes(test),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `add each to a MODULE_TESTS entry, or to FULL_TIER_ONLY_TESTS with a reason: ${unaccounted.join(", ")}`,
  );
  // …and the full-tier-only list is not a dumping ground: those files must exist.
  for (const test of FULL_TIER_ONLY_TESTS) {
    assert.ok(discoverTestFiles().includes(test), `full-tier-only test is missing: ${test}`);
  }
});

test("the import parser understands every form the guard claims to cover", () => {
  const source = [
    'import { a } from "./binding.ts";',
    'import "./side-effect.ts";',
    'const c = await import("./dynamic.ts");',
    "const d = await import(`./template.ts`);",
    'const e = await import(`./interpolated-${x}.ts`);',
    'import { fs } from "node:fs";',
    'import { z } from "../outside.ts";',
  ].join("\n");
  // Order follows the three patterns (binding/from first, then side-effect, then
  // dynamic); the guard only ever asks set membership.
  assert.deepEqual(importSpecifiersFrom(source), [
    "./binding.ts",
    "../outside.ts",
    "./side-effect.ts",
    "./dynamic.ts",
    "./template.ts",
    "./interpolated-${x}.ts",
  ]);
  // A side-effect edge is a real edge: the guard must fail when a module's map
  // entry exists (so its changes NARROW) but omits a test that imports it — the
  // exact shape of the round-1 coverage miss.
  const modules = ["a.ts", "side-effect.ts"];
  const closureOf = (file: string) => new Set(file === "test/a.test.ts" ? modules : []);
  const underCovering = { "a.ts": ["test/a.test.ts"], "side-effect.ts": ["test/b.test.ts"] };
  assert.deepEqual(findMissingMapEdges(modules, ["test/a.test.ts"], closureOf, underCovering), [
    "side-effect.ts <- test/a.test.ts",
  ]);
  assert.deepEqual(
    findMissingMapEdges(modules, ["test/a.test.ts"], closureOf, {
      "a.ts": ["test/a.test.ts"],
      "side-effect.ts": ["test/a.test.ts"],
    }),
    [],
  );
});

test("the affected tier never runs the integration suite, and the full tier does", () => {
  // The boundary is deliberate (the entry point imports every module, so
  // including it would make the fast tier the full tier), which is why it is
  // asserted rather than assumed: no mapped module may select it…
  for (const module of Object.keys(MODULE_TESTS)) {
    const selection = selectTests([module]);
    if (selection.mode === "affected") {
      assert.ok(
        !selection.tests.includes(INTEGRATION_TEST),
        `${module} must not select the integration suite in the affected tier`,
      );
    }
  }
  // …and changing the suite itself, or the entry point it drives, routes to FULL.
  assert.equal(selectTests([INTEGRATION_TEST]).mode, "full");
  assert.equal(selectTests(["index.ts"]).mode, "full");
  assert.ok(discoverTestFiles().includes(INTEGRATION_TEST), "the integration suite must be discovered");
});

test("the discovered test list is what the full suite would run", () => {
  const discovered = discoverTestFiles();
  assert.ok(discovered.length >= 15, `expected the repo's test files, got ${discovered.length}`);
  assert.ok(discovered.includes("test/index.test.ts"));
  assert.ok(discovered.every((f) => f.startsWith("test/") && f.endsWith(".test.ts")));
});

test("the base resolution names what it used, and the change list is real", () => {
  const base = resolveBase();
  assert.match(base.note, /base (refs\/|HEAD)/);
  assert.match(base.mergeBase, /^[0-9a-f]{40}$/);
  // In this worktree the selector must see the branch's own changes, whatever
  // they are — an empty list here would mean the base was resolved wrongly.
  const diff = changedFiles(base.mergeBase);
  assert.equal(diff.ok, true, "the selector must be able to read its own branch history");
  assert.ok(Array.isArray(diff.files));
  // An explicit base is honoured as given (that is how a lane compares against a
  // pinned sha), and HEAD resolves to this commit.
  const head = resolveBase("HEAD");
  assert.equal(head.ref, "HEAD");
  assert.match(head.note, /requested/);
  const thisCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  assert.equal(head.mergeBase, thisCommit);
});

/**
 * Every relative module specifier in a source string. Three forms, because the
 * round-2 review pointed out that a guard which only understands `from "…"`
 * cannot honour the claim that a new edge cannot escape it:
 *   import x from "./a.ts"      — binding import
 *   import "./b.ts"             — side-effect import
 *   import("./c.ts") / import(`./d.ts`) — dynamic import
 * `import(`./${x}.ts`)` matches too, and is then dropped because the path does
 * not exist, which is the conservative direction.
 */
function importSpecifiersFrom(source: string): string[] {
  const specs: string[] = [];
  for (const re of [
    /\bfrom\s*["'](\.[^"']+)["']/g,
    /\bimport\s*["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'`](\.\.?\/[^"'`]+)["'`]/g,
  ]) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/** Every root .ts module and every scripts/*.ts|mjs, repo-relative. */
function discoverSourcePaths(): string[] {
  const roots = (readdirSync(ROOT) as string[]).filter((f: string) => f.endsWith(".ts"));
  const scripts = existsSync(join(ROOT, "scripts"))
    ? (readdirSync(join(ROOT, "scripts")) as string[])
        .filter((f: string) => f.endsWith(".ts") || f.endsWith(".mjs"))
        .map((f: string) => `scripts/${f}`)
    : [];
  return [...roots, ...scripts].sort();
}

/** Relative .ts imports of a repo-relative file, keeping only real files (tests
 *  name fake modules in string fixtures). */
function relativeImportsOf(file: string): string[] {
  return importSpecifiersFrom(readFileSync(join(ROOT, file), "utf8"))
    .map((spec) => posix.normalize(posix.join(posix.dirname(file), spec)))
    .filter((path) => path.endsWith(".ts") && existsSync(join(ROOT, path)));
}

/** The guard itself, as a pure function so it can be tested against synthetic
 *  graphs (a guard whose only test is "the real map happens to pass" is not a
 *  guard). Returns every `<module> <- <test>` edge the map fails to cover. */
function findMissingMapEdges(
  modules: string[],
  tests: string[],
  closureOf: (file: string) => Set<string>,
  map: Record<string, string[]>,
): string[] {
  const missing: string[] = [];
  for (const module of modules) {
    if (!(module in map)) continue; // unmapped modules fall back to the full suite
    for (const test of tests) {
      if (closureOf(test).has(module) && !map[module].includes(test)) {
        missing.push(`${module} <- ${test}`);
      }
    }
  }
  return missing;
}

/** Test files that only the FULL tier runs, and why. `pack-files.test.ts` guards
 *  the published file list in package.json, and the manifest is a full-tier
 *  trigger, so it has no module to hang off. */
const FULL_TIER_ONLY_TESTS = [INTEGRATION_TEST, "test/pack-files.test.ts"];

test("an explicit --base that does not resolve is fatal, never a silent fallback", () => {
  const result = resolveBase("definitely-not-a-ref-in-this-repo");
  assert.equal(result.ok, false);
  assert.match(result.note, /does not resolve/);
  // The CLI must refuse it (exit 2) rather than testing the wrong range.
  const cli = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", "--base", "definitely-not-a-ref"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /does not resolve/);
});

test("without a default branch the CLI fails closed to the full suite", () => {
  // End to end in a real checkout that HAS no origin/master, origin/main or
  // master branch: resolveBase must report failure and main() must run the full
  // suite rather than diffing against HEAD (which in a clean checkout would
  // report "no changes" while knowing nothing).
  const dir = mkdtempSync(join(tmpdir(), "fast-gate-nobase-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(SCRIPT_PATH, join(dir, "scripts", "fast-gate.ts"));
    const gitIn = (args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    gitIn(["init", "-q", "-b", "work"]);
    gitIn(["add", "."]);
    gitIn(["commit", "-q", "-m", "init"]);
    const result = spawnSync(process.execPath, ["scripts/fast-gate.ts", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no default branch resolves in this checkout/);
    assert.match(result.stdout, /mode: full/);
    assert.match(result.stdout, /tests \(full suite\): node --test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable change list is never read as an empty one", () => {
  const failure = changedFiles("not-a-commit-at-all");
  assert.equal(failure.ok, false, "git failures must be reported, not ignored");
  const good = changedFiles(resolveBase().mergeBase);
  assert.equal(good.ok, true);
});

// ── CLI contract ───────────────────────────────────────────────────────────

test("--dry-run prints the plan and runs nothing", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", "--base", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[fast-gate\] mode: (affected|full)/);
  assert.match(result.stdout, /planned steps:/);
  assert.match(result.stdout, /typecheck \(whole tree\): npx tsc --noEmit/);
  assert.match(result.stdout, /the merger still runs the full gate/);
  if (/\[fast-gate\] mode: affected/.test(result.stdout)) {
    assert.match(result.stdout, /a PASS here is not a landing verdict/);
  }
});

test("a bad invocation fails closed with a usage error", () => {
  const noValue = spawnSync(process.execPath, [SCRIPT_PATH, "--base"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--base requires a ref/);

  const unknown = spawnSync(process.execPath, [SCRIPT_PATH, "--nope"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument/);

  const help = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /affected test files or the full suite/);
});

test("the selector module is importable by path URL (no CJS/ESM trap)", () => {
  assert.equal(new URL(SCRIPT_URL).protocol, "file:");
  assert.ok(pathToFileURL(SCRIPT_PATH).href.endsWith("scripts/fast-gate.ts"));
});

// ── Coverage markers (fleet docs/speed.md R14/R15) ─────────────────────────
//
// A fast PASS proves nothing about coverage unless the log says WHICH suites
// executed. Before this bead every PASS recorded here read UNKNOWN ("no
// fast-gate marker and no runner evidence"), because the gate only printed
// bracketed `[fast-gate] …` banners that the fleet's reader cannot see.

/**
 * The vocabulary fleet tooling accepts, anchored at line start, copied from
 * `~/fleet/remote/check-coverage.py` (docs/speed.md R15). A marker outside this
 * set is invisible to the reader; anything matching it is published as a suite
 * name, so the anchoring is the contract and these tests pin it.
 */
const ACCEPTED_MARKERS = [
  /^fast-gate:\s*(?:running|ran|passed|completed|failed):\s*(.*)$/,
  /^fast-gate:\s*unmapped:\s*(.*)$/,
  /^fast-gate:\s*unknown:\s*(.*)$/,
];

const acceptedByReader = (line: string): boolean => ACCEPTED_MARKERS.some((re) => re.test(line));

/** A TAP report of one assertion failure in b.test.mjs, as `node --test` writes it. */
const TAP_ONE_FAILURE = `TAP version 13
# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 1.220968
  type: 'test'
  ...
# Subtest: fails
not ok 2 - fails
  ---
  duration_ms: 2.383005
  location: '/work/repo/test/b.test.ts:3:1'
  failureType: 'testCodeFailure'
  error: '1 == 2'
  ...
1..2
# tests 2
# fail 1
`;

/** A file whose import throws: TAP still carries the file's location. */
const TAP_IMPORT_THROW = `TAP version 13
# Subtest: /work/repo/test/c.test.ts
not ok 1 - /work/repo/test/c.test.ts
  ---
  duration_ms: 131.36
  location: '/work/repo/test/c.test.ts:1:1'
  ...
1..1
`;

test("every emitted marker is inside the vocabulary the fleet reader accepts", () => {
  const lines = [
    ...dispatchMarkers(["test/a.test.ts", "test/b.test.ts"]),
    ...outcomeMarkers(["test/a.test.ts"], { ok: true }),
    ...outcomeMarkers(["test/a.test.ts", "test/b.test.ts"], { ok: false, tap: TAP_ONE_FAILURE }),
    unknownMarker("the whole-tree typecheck failed, so no test suite was dispatched"),
  ];
  for (const line of lines) assert.ok(acceptedByReader(line), `not in the accepted vocabulary: ${line}`);
  // The human banners stay OUTSIDE it: an unanchored marker once published
  // sixteen "files" from a run that had four (fleet-agch).
  for (const banner of [
    "[fast-gate] ok tests (full suite)",
    "[fast-gate] mode: affected — isolated to config.ts",
    "  fast-gate: passed: test/indented.test.ts",
  ]) {
    assert.equal(acceptedByReader(banner), false, `a banner must never be read as coverage: ${banner}`);
  }
});

test("the dispatch marker names each planned suite before anything runs", () => {
  assert.deepEqual(dispatchMarkers(["test/config.test.ts", "test/url-redact.test.ts"]), [
    `${MARKER_PREFIX}running: test/config.test.ts`,
    `${MARKER_PREFIX}running: test/url-redact.test.ts`,
  ]);
  assert.deepEqual(dispatchMarkers([]), []);
});

test("a passing run claims exactly the suites it dispatched", () => {
  const planned = ["test/config.test.ts", "test/url-redact.test.ts"];
  assert.deepEqual(outcomeMarkers(planned, { ok: true }), [
    `${MARKER_PREFIX}passed: test/config.test.ts`,
    `${MARKER_PREFIX}passed: test/url-redact.test.ts`,
  ]);
});

test("a mixed run claims only the suite TAP proves failed — never a pass", () => {
  const planned = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  const markers = outcomeMarkers(planned, { ok: false, tap: TAP_ONE_FAILURE });
  assert.deepEqual(markers, [`${MARKER_PREFIX}failed: test/b.test.ts`]);
  assert.equal(
    markers.some((line) => /passed:/.test(line)),
    false,
    "a suite must never be announced as passed when the run failed",
  );
  // An import-time throw is attributed the same way (the runner reports the file).
  assert.deepEqual(outcomeMarkers(planned, { ok: false, tap: TAP_IMPORT_THROW }), [
    `${MARKER_PREFIX}failed: test/c.test.ts`,
  ]);
});

test("a failed run with no usable evidence claims nothing at all", () => {
  const planned = ["test/a.test.ts", "test/b.test.ts"];
  // No TAP report at all (the runner never produced one).
  assert.deepEqual(outcomeMarkers(planned, { ok: false }), []);
  // TAP that only names a path outside the plan (a shared helper) is not guessed at.
  const helperTap = `not ok 1 - helper
  ---
  location: '/work/repo/test/helpers.ts:9:1'
  ...
1..1
`;
  assert.deepEqual(outcomeMarkers(planned, { ok: false, tap: helperTap }), []);
  assert.deepEqual(failingSuitesFromTap(TAP_ONE_FAILURE, []), []);
  // …and a report whose every entry passed attributes no failure.
  const allPassed = `ok 1 - passes
ok 2 - other
1..2
`;
  assert.deepEqual(failingSuitesFromTap(allPassed, planned), []);
});

test("the TAP parser reads quoted, unquoted and file:// locations", () => {
  const planned = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  const tap = [
    "not ok 1 - one",
    "  location: 'test/a.test.ts:4:2'",
    "not ok 2 - two",
    "  location: file:///work/repo/test/b.test.ts:7:9",
    "not ok 3 - three",
    "  location: /work/repo/test/c.test.ts:1:1",
    "1..3",
  ].join("\n");
  assert.deepEqual(failingSuitesFromTap(tap, planned), planned);
  // Plan order wins, so the marker order does not depend on the runner's order.
  assert.deepEqual(failingSuitesFromTap(tap, ["test/c.test.ts", "test/a.test.ts"]), [
    "test/c.test.ts",
    "test/a.test.ts",
  ]);
});

test("a pre-dispatch failure is UNKNOWN and claims no suite", () => {
  // End to end: a real checkout where the whole-tree typecheck fails. The marker
  // contract is the point — coverage must read UNKNOWN (never a zero, never a
  // pass) and no suite may be announced as running or passed.
  const dir = mkdtempSync(join(tmpdir(), "fast-gate-fail-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    copyFileSync(SCRIPT_PATH, join(dir, "scripts", "fast-gate.ts"));
    // A local `tsc` that fails, so the test needs no network and no real TypeScript.
    const fakeTsc = join(dir, "node_modules", ".bin", "tsc");
    writeFileSync(fakeTsc, "#!/bin/sh\necho \"fake tsc: type error\" >&2\nexit 1\n", { mode: 0o755 });
    const gitIn = (args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    gitIn(["init", "-q", "-b", "work"]);
    gitIn(["add", "."]);
    gitIn(["commit", "-q", "-m", "init"]);

    const result = spawnSync(process.execPath, ["scripts/fast-gate.ts"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(result.status, 0, "a failed whole-tree check must fail the gate");
    assert.match(result.stdout, /^fast-gate: unknown: the whole-tree typecheck failed/m);
    assert.doesNotMatch(result.stdout, /^fast-gate: (?:running|passed|failed):/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every test file the runner would discover is one the gate can name", () => {
  // In the full tier the gate runs `node --test` discovery but names the suites
  // from discoverTestFiles(), so the two sets must be the same: otherwise the
  // markers would understate (or invent) what ran. Node discovers `test/**/*`
  // plus root-level `*.test.*`, `*-test.*`, `*_test.*`, `test-*.*` and `test.*`.
  assert.deepEqual(
    (readdirSync(join(ROOT, "test")) as string[]).filter((name) => !name.endsWith(".test.ts")),
    [],
    "every file under test/ must be named *.test.ts, or discovery and the marker list diverge",
  );
  const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n");
  const disguised = tracked.filter(
    (path) =>
      path !== "" &&
      !path.startsWith("test/") &&
      /(^|\/)(?:[^/]*\.test\.|test-[^/]*\.|test\.|[^/]*-test\.|[^/]*_test\.)/.test(path),
  );
  assert.deepEqual(disguised, [], "a test file outside test/ would run but never be named");
});
