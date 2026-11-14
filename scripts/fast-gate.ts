#!/usr/bin/env node
/**
 * fast-gate — the CONSERVATIVE affected-test gate for implementer iteration.
 *
 * This is NOT the gate that lands a change. The merger runs the full
 * `npx tsc --noEmit && npm test` on the merged union; this script exists so an
 * implementer working on one module does not pay for the 3,297-line
 * `test/index.test.ts` integration suite on every commit (decision
 * pi-chaos-relay-cru, bead pi-chaos-relay-a1x).
 *
 * It always runs the two WHOLE-TREE checks — `npx tsc --noEmit` and the version
 * consistency gate — and then either the affected test files or, when anything
 * is not provably isolated, the FULL suite.
 *
 * THE CONTRACT, stated exactly rather than optimistically:
 *
 *   - A mapped module runs every test file that transitively imports it
 *     (MODULE_TESTS, derived from the real import graph and re-checked by
 *     test/fast-gate.test.ts). That is unit-level coverage.
 *   - `test/index.test.ts` is the INTEGRATION suite and is NOT run by the
 *     affected tier. The entry point imports every module, so including it would
 *     make every change the full suite and the fast tier would not exist. It
 *     runs in the full tier — which the merger always runs, and which this
 *     script runs whenever the entry point, a manifest/lockfile, tsconfig, the
 *     test tree, or any unmapped path is touched. A fast PASS is therefore NOT a
 *     landing verdict, and the banner says so.
 *   - Anything this script does not recognise — a brand-new module, a doc, a
 *     deleted path, an unreadable change list, a checkout where the default
 *     branch cannot be resolved — falls back to the full suite. Every guard here
 *     fails CLOSED: a wrong answer can cost time, never coverage.
 *
 * COVERAGE MARKERS (fleet docs/speed.md R14/R15). A PASS proves nothing about
 * coverage unless the log says WHICH suites executed, so this gate emits the
 * fleet's producer vocabulary, anchored at line start:
 *
 *   fast-gate: running: <suite>   dispatched, outcome not yet known (printed
 *                                 BEFORE the runner starts, so a killed run
 *                                 never leaves a claim behind)
 *   fast-gate: passed: <suite>    the suite executed and passed (printed only
 *                                 after the run exited 0)
 *   fast-gate: failed: <suite>    TAP proves this suite failed, in a run that
 *                                 also ran others — so a mixed run can never be
 *                                 read as "all passed"
 *   fast-gate: unknown: <reason>  the gate never reached its test dispatch (a
 *                                 whole-tree check failed, or there are no test
 *                                 files) — coverage is UNKNOWN, never a false
 *                                 KNOWN
 *
 * The bracketed `[fast-gate] …` lines are for humans and are deliberately
 * OUTSIDE that vocabulary, so a banner can never be harvested as a suite
 * (fleet-agch: an unanchored marker once published sixteen "files" from a run
 * that had four).
 *
 * USAGE
 *   npm run test:fast                      # tsc + version gate + affected tests
 *   node scripts/fast-gate.ts --dry-run    # print the plan, run nothing
 *   node scripts/fast-gate.ts --base <ref> # compare against <ref> (required if
 *                                          # no default branch resolves here)
 *   node scripts/fast-gate.ts --help
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The integration suite the affected tier deliberately does not run. */
export const INTEGRATION_TEST = "test/index.test.ts";

/**
 * Explicit reverse dependency map: a source path → EVERY test file that
 * transitively imports it (a module's own test, plus the tests of the modules
 * that import it, plus theirs). Derived from the real import graph — including
 * the edges the first draft of this file got wrong (url-redact is imported by
 * relay-client, ws-client and inbound-attachments; crypto reaches seven test
 * files through config and relay-client) — and re-derived by
 * test/fast-gate.test.ts, which FAILS if the map under-covers the graph. The
 * integration suite is excluded here and listed under INTEGRATION_TEST instead.
 *
 * A path in NEITHER this map nor FULL_TESTS_TRIGGERS is never narrowed.
 */
export const MODULE_TESTS: Record<string, string[]> = {
  "approval-policy.ts": ["test/approval-policy.test.ts"],
  "approvals.ts": ["test/approvals.test.ts"],
  "config.ts": ["test/approval-policy.test.ts", "test/config.test.ts", "test/profile-lock.test.ts"],
  "connect.ts": ["test/approvals.test.ts", "test/connect.test.ts"],
  "crypto.ts": [
    "test/approval-policy.test.ts",
    "test/config.test.ts",
    "test/approvals.test.ts",
    "test/crypto.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/profile-lock.test.ts",
    "test/relay-client.test.ts",
    "test/ws-client.test.ts",
  ],
  "inbound-attachments.ts": ["test/inbound-attachments.test.ts"],
  // The shape checks both transports run: poller.ts applies them and ws-client.ts
  // asks for a verdict, so their tests exercise this module too.
  "inbound-message.ts": [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/ws-client.test.ts",
  ],
  "poller.ts": ["test/poller.test.ts", "test/ws-client.test.ts"],
  // A leaf: index.ts owns the wiring (the drain-edge flush and the urgent path),
  // so this module's own unit suite is its coverage.
  "state-writer.ts": ["test/state-writer.test.ts"],
  "profile-lock.ts": ["test/profile-lock.test.ts"],
  "relay-client.ts": [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/relay-client.test.ts",
    "test/ws-client.test.ts",
  ],
  "reply-format.ts": ["test/reply-format.test.ts"],
  "url-redact.ts": [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/relay-client.test.ts",
    "test/url-redact.test.ts",
    "test/ws-client.test.ts",
  ],
  "ws-client.ts": ["test/ws-client.test.ts"],
  "scripts/check-version-consistency.mjs": [
    "test/version-consistency.test.ts",
    "test/version-consistency-gate.test.ts",
    "test/version-consistency-unit.test.ts",
  ],
  "scripts/check-version-consistency-gate.mjs": [
    "test/version-consistency.test.ts",
    "test/version-consistency-gate.test.ts",
    "test/version-consistency-unit.test.ts",
  ],
  "scripts/fast-gate.ts": ["test/fast-gate.test.ts"],
  "test/fast-gate.test.ts": ["test/fast-gate.test.ts"],
};

/**
 * Paths that force the FULL suite. Each one changes something global: the entry
 * point is what the integration suite drives, the manifests decide how the suite
 * is installed and run, and tsconfig decides what is type-checked. A path in
 * neither this set nor MODULE_TESTS also forces the full suite.
 */
export const FULL_TESTS_TRIGGERS = new Set([
  "index.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
]);

/** The selector's own test is the one test file that is safe to run alone. */
const SELF_TEST = "test/fast-gate.test.ts";

export interface Selection {
  mode: "full" | "affected";
  /** Repo-relative test files to run (empty when mode is "full"). */
  tests: string[];
  /** Why, in one line, for the banner and for a reviewer reading the log. */
  reason: string;
  changed: string[];
}

/** Normalise a git-reported path: POSIX separators, no leading "./". */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Choose what to run for a set of changed paths. Pure: no filesystem reads, no
 * git — the caller supplies the change list, the tests pin the matrix.
 */
export function selectTests(changed: string[]): Selection {
  const normalized = [...new Set(changed.map(normalizePath).filter((p) => p !== ""))].sort();
  const full = (why: string): Selection => ({
    mode: "full",
    tests: [],
    reason: `full suite (${why})`,
    changed: normalized,
  });
  const tests = new Set<string>();
  const modules: string[] = [];

  for (const path of normalized) {
    if (path === SELF_TEST) {
      tests.add(SELF_TEST);
      continue;
    }
    // The suite itself: the integration test, any other test file, and any
    // other path under test/ (a shared helper or fixture one file would not
    // cover).
    if (path === INTEGRATION_TEST) return full(`${path} changed: the integration suite`);
    if (path.startsWith("test/")) return full(`${path} changed: the suite or its harness`);
    if (FULL_TESTS_TRIGGERS.has(path)) return full(`${path} changed: global`);
    const mapped = MODULE_TESTS[path];
    if (!mapped) return full(`${path} is not in the affected-test map`);
    modules.push(path);
    for (const test of mapped) tests.add(test);
  }

  if (tests.size === 0) {
    return {
      mode: "affected",
      tests: [],
      reason: "no tracked change affects any test file",
      changed: normalized,
    };
  }
  return {
    mode: "affected",
    tests: [...tests].sort(),
    reason: `isolated to ${modules.join(", ") || SELF_TEST}`,
    changed: normalized,
  };
}

/**
 * The producer prefix fleet tooling matches at line start (docs/speed.md R15).
 * Anything after it must be one of the vocabulary words; nothing else is read.
 */
export const MARKER_PREFIX = "fast-gate: ";

/**
 * `fast-gate: running: <suite>` for every suite about to be dispatched.
 *
 * Printed BEFORE the runner starts on purpose: a run that is killed, times out
 * or crashes never reaches its outcome lines, so emitting these first is what
 * keeps the log consistent with what actually happened (dispatched, outcome
 * unknown) instead of silent about suites that did start.
 */
export function dispatchMarkers(planned: string[]): string[] {
  return planned.map((suite) => `${MARKER_PREFIX}running: ${suite}`);
}

/** `fast-gate: unknown: <reason>` — coverage cannot be determined from this run. */
export function unknownMarker(reason: string): string {
  return `${MARKER_PREFIX}unknown: ${reason}`;
}

/**
 * `fast-gate: passed:`/`failed:` for a finished test step, from the run's exit
 * status and (when it failed) its TAP report.
 *
 * The exit status is the only authority for a PASS: a suite may only be
 * announced as passed when the whole invocation succeeded. On a non-zero exit
 * nothing is claimed as passed and the suites TAP proves failed are named — so a
 * mixed run reports "these failed" rather than either "all passed" or a bare
 * silence that reads like nothing ran.
 */
export function outcomeMarkers(planned: string[], run: { ok: boolean; tap?: string }): string[] {
  if (run.ok) return planned.map((suite) => `${MARKER_PREFIX}passed: ${suite}`);
  if (run.tap === undefined) return [];
  return failingSuitesFromTap(run.tap, planned).map((suite) => `${MARKER_PREFIX}failed: ${suite}`);
}

/**
 * The planned suites a TAP report proves failed, in plan order.
 *
 * Node's runner reports every failing test (or file-level failure, including an
 * import-time throw) with a `location: '<path>:<line>:<col>'` diagnostic, and it
 * does NOT emit one entry per file — a `node --test a b c` run is a single flat
 * list of test names. The location is therefore the only per-file evidence in
 * the report. A location that names no planned suite (a shared helper, say) is
 * ignored rather than guessed at.
 */
export function failingSuitesFromTap(tap: string, planned: string[]): string[] {
  const failed = new Set<string>();
  const suiteFor = (location: string): string | undefined => {
    const path = location.replace(/^file:\/\//, "").replace(/:\d+:\d+$/, "");
    return planned.find((suite) => path === suite || path.endsWith(`/${suite}`));
  };
  let inFailure = false;
  for (const line of tap.split(/\r?\n/)) {
    // Top-level TAP entries: a failure opens a diagnostic block, a pass or the
    // plan terminator closes it.
    if (/^not ok \d+ - /.test(line)) {
      inFailure = true;
      continue;
    }
    if (/^ok \d+ - /.test(line) || /^1\.\.\d+\s*$/.test(line)) {
      inFailure = false;
      continue;
    }
    if (!inFailure) continue;
    const match = line.match(/^\s*location:\s*'([^']+)'\s*$/u) ?? line.match(/^\s*location:\s*(\S+)\s*$/u);
    if (!match) continue;
    const suite = suiteFor(match[1]);
    if (suite !== undefined) failed.add(suite);
  }
  return planned.filter((suite) => failed.has(suite));
}

/**
 * Run a command, inheriting stdio. Returns its exit status.
 *
 * `tapFile` is only passed for the test step: it makes the runner write a TAP
 * report alongside the human `spec` output, which is where the per-suite failure
 * evidence comes from. The reporter flags go immediately after `--test`, ahead
 * of the positional file list.
 */
function run(command: string, args: string[], tapFile?: string): number {
  const finalArgs = tapFile
    ? [
        args[0],
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${tapFile}`,
        ...args.slice(1),
      ]
    : args;
  const result = spawnSync(command, finalArgs, { cwd: ROOT, stdio: "inherit" });
  return result.status ?? 1;
}

/** Print marker lines to stdout, where the gate log is read from. */
function emit(lines: string[]): void {
  for (const line of lines) console.log(line);
}

function git(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) return { ok: false, out: "" };
  return { ok: true, out: result.stdout };
}

export interface BaseResolution {
  ok: boolean;
  ref: string;
  mergeBase: string;
  /** One line naming the base and what it could not establish. */
  note: string;
}

/**
 * Base for the change list.
 *
 * An EXPLICIT `--base <ref>` must resolve: a typo would otherwise silently fall
 * back to a base that hides the change, so an unresolvable one is a fatal error
 * in main (review P1, a1x). With no explicit base this prefers the default
 * branch, and if none resolves it FAILS CLOSED (`ok: false`) rather than
 * diffing against HEAD — in a clean checkout that would report "no changes" and
 * narrow the run while knowing nothing. `--base HEAD` remains the deliberate way
 * to ask for "just my working tree".
 */
export function resolveBase(requested?: string): BaseResolution {
  if (requested) {
    const mb = git(["merge-base", requested, "HEAD"]);
    if (!mb.ok || !mb.out.trim()) {
      return {
        ok: false,
        ref: requested,
        mergeBase: "",
        note: `--base ${requested} does not resolve to a commit here`,
      };
    }
    return { ok: true, ref: requested, mergeBase: mb.out.trim(), note: `base ${requested} (requested)` };
  }
  for (const ref of ["refs/remotes/origin/master", "refs/remotes/origin/main", "refs/heads/master"]) {
    const mb = git(["merge-base", ref, "HEAD"]);
    if (mb.ok && mb.out.trim()) {
      return { ok: true, ref, mergeBase: mb.out.trim(), note: `base ${ref} (default branch)` };
    }
  }
  return {
    ok: false,
    ref: "",
    mergeBase: "",
    note:
      "no default branch resolves in this checkout (pass --base <ref> to enable narrowing); " +
      "the change list cannot be established, so the full suite runs",
  };
}

/**
 * Every path that differs from `mergeBase`, plus the dirty worktree. `ok: false`
 * means git could not answer (not a repository, missing objects) — the caller
 * must treat the change list as UNKNOWN and fail closed, never as empty.
 */
export function changedFiles(mergeBase: string): { ok: boolean; files: string[] } {
  const sets: string[][] = [];
  for (const args of [
    ["diff", "--name-only", `${mergeBase}...HEAD`],
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = git(args);
    if (!result.ok) return { ok: false, files: [] };
    sets.push(result.out.split("\n").filter((l) => l.trim() !== ""));
  }
  const all = new Set<string>();
  for (const set of sets) for (const path of set) all.add(normalizePath(path));
  return { ok: true, files: [...all].sort() };
}

/** Every test file the repo ships, for the "full suite" step and the guards. */
export function discoverTestFiles(): string[] {
  const dir = join(ROOT, "test");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`)
    .sort();
}

const USAGE = `usage: node scripts/fast-gate.ts [--base <ref>] [--dry-run] [--help]

Runs, in order: npx tsc --noEmit; the version-consistency gate; then either the
affected test files or the full suite when the change is not provably isolated.
Unit level only — the integration suite (test/index.test.ts) runs in the full
tier, and the merger still runs the full gate on the merged union.`;

function parseArgs(argv: string[]): { base?: string; dryRun: boolean } {
  const opts: { base?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--base") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`fast-gate: --base requires a ref\n${USAGE}`);
        process.exit(2);
      }
      opts.base = value;
      i += 1;
    } else {
      console.error(`fast-gate: unknown argument ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const base = resolveBase(opts.base);
  if (opts.base && !base.ok) {
    // An explicit base that does not resolve is a usage error, not a reason to
    // run something narrower: refuse instead of testing the wrong range.
    console.error(`fast-gate: ${base.note}\n${USAGE}`);
    process.exit(2);
  }

  let changed: string[] = [];
  let selection: Selection;
  if (!base.ok) {
    changed = [];
    selection = { mode: "full", tests: [], reason: `full suite (${base.note})`, changed: [] };
  } else {
    const diff = changedFiles(base.mergeBase);
    if (!diff.ok) {
      selection = {
        mode: "full",
        tests: [],
        reason: "full suite (the change list could not be read)",
        changed: [],
      };
    } else {
      changed = diff.files;
      selection = selectTests(changed);
    }
  }

  console.log("[fast-gate] FAST tier — the merger still runs the full gate on the merged union");
  if (base.ok) console.log(`[fast-gate] ${base.note}`);
  console.log(`[fast-gate] changed (${changed.length}): ${changed.length ? changed.join(", ") : "(none)"}`);
  console.log(`[fast-gate] mode: ${selection.mode} — ${selection.reason}`);
  if (selection.mode === "affected") {
    console.log(
      `[fast-gate] tests (${selection.tests.length} of ${discoverTestFiles().length}): ${selection.tests.join(" ") || "(none)"}`,
    );
    console.log(
      `[fast-gate] NOT run by this tier: ${INTEGRATION_TEST} (integration) — a PASS here is not a landing verdict`,
    );
  }

  console.log(
    "[fast-gate] coverage: 'fast-gate: running/passed/failed: <suite>' per suite, " +
      "'fast-gate: unknown: <reason>' if a whole-tree check fails before any test runs",
  );

  // The full tier runs discovery (`node --test`), so the suites it dispatches are
  // the repo's test files; the affected tier runs exactly what the selector chose.
  const planned = selection.mode === "full" ? discoverTestFiles() : selection.tests;
  const testLabel = selection.mode === "full" ? "tests (full suite)" : `tests (affected: ${planned.length})`;
  // The full tier always dispatches (discovery is the runner's job); the affected
  // tier only when the selector chose suites. An affected run with changed paths
  // and no suite is the one shape that certifies nothing, and it fails closed.
  const dispatchesTests = selection.mode === "full" || planned.length > 0;
  const wholeTree: Array<{ label: string; command: string; args: string[]; unknown: string }> = [
    {
      label: "typecheck (whole tree)",
      command: "npx",
      args: ["tsc", "--noEmit"],
      unknown: "the whole-tree typecheck failed, so no test suite was dispatched",
    },
    {
      label: "version consistency (whole tree)",
      command: "node",
      args: ["scripts/check-version-consistency-gate.mjs"],
      unknown: "the whole-tree version consistency gate failed, so no test suite was dispatched",
    },
  ];
  const steps = [
    ...wholeTree.map((step) => ({ label: step.label, command: step.command, args: step.args })),
    ...(dispatchesTests
      ? [
          {
            label: testLabel,
            command: "node",
            args: selection.mode === "full" ? ["--test"] : ["--test", ...planned],
          },
        ]
      : []),
  ];

  if (opts.dryRun) {
    console.log("[fast-gate] --dry-run, planned steps:");
    for (const step of steps) console.log(`[fast-gate]   ${step.label}: ${step.command} ${step.args.join(" ")}`);
    if (!dispatchesTests) console.log("[fast-gate] no affected tests to run — typecheck and the version gate only");
    process.exit(0);
  }

  for (const step of wholeTree) {
    console.log(`\n[fast-gate] === ${step.label} ===`);
    const status = run(step.command, step.args);
    if (status !== 0) {
      // Coverage is UNKNOWN, not zero: the gate never reached its test dispatch,
      // so no claim about which suites ran would be true.
      emit([unknownMarker(step.unknown)]);
      console.error(`[fast-gate] FAIL ${step.label} (exit ${status})`);
      process.exit(status);
    }
    console.log(`[fast-gate] ok ${step.label}`);
  }

  if (!dispatchesTests) {
    // Nothing is certified by a run that selects nothing (R14). With no changed
    // path there is genuinely nothing to cover and the fleet reports NONE; with
    // changed paths and no suite to run, coverage is UNKNOWN and the gate fails.
    if (changed.length > 0) {
      emit([unknownMarker(`no test suite was selected for the ${changed.length} changed path(s)`)]);
      console.error("[fast-gate] FAIL no test suite was selected");
      process.exit(1);
    }
    console.log("[fast-gate] no affected tests to run — typecheck and the version gate only");
    console.log(`\n[fast-gate] PASS (${selection.mode} tier)`);
    return;
  }

  console.log(`\n[fast-gate] === ${testLabel} ===`);
  if (planned.length === 0) {
    // A full-tier run in a checkout with no discoverable test file: the run still
    // happens (the runner's discovery is the authority), but nothing can be
    // attributed to it, so say so rather than imply coverage.
    emit([unknownMarker("no test file was found to attribute to the full-tier run")]);
  }
  emit(dispatchMarkers(planned));
  const tapDir = mkdtempSync(join(tmpdir(), "fast-gate-tap-"));
  const tapFile = join(tapDir, "run.tap");
  let status = 1;
  let tap: string | undefined;
  try {
    status = run("node", selection.mode === "full" ? ["--test"] : ["--test", ...planned], tapFile);
    if (existsSync(tapFile)) tap = readFileSync(tapFile, "utf8");
  } finally {
    rmSync(tapDir, { recursive: true, force: true });
  }
  emit(outcomeMarkers(planned, { ok: status === 0, tap }));
  if (status !== 0) {
    console.error(`[fast-gate] FAIL ${testLabel} (exit ${status})`);
    process.exit(status);
  }
  console.log(`[fast-gate] ok ${testLabel}`);
  console.log(`\n[fast-gate] PASS (${selection.mode} tier)`);
}

// Only run when executed directly: the selector must be importable by its tests
// (scripts/check-version-consistency.mjs documents the same trap).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
