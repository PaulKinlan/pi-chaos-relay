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
 * USAGE
 *   npm run test:fast                      # tsc + version gate + affected tests
 *   node scripts/fast-gate.ts --dry-run    # print the plan, run nothing
 *   node scripts/fast-gate.ts --base <ref> # compare against <ref> (required if
 *                                          # no default branch resolves here)
 *   node scripts/fast-gate.ts --help
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
  "config.ts": ["test/approval-policy.test.ts", "test/config.test.ts"],
  "connect.ts": ["test/approvals.test.ts", "test/connect.test.ts"],
  "crypto.ts": [
    "test/approval-policy.test.ts",
    "test/config.test.ts",
    "test/approvals.test.ts",
    "test/crypto.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
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

/** Run a command, inheriting stdio. Returns its exit status. */
function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  return result.status ?? 1;
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

  const steps: Array<{ label: string; command: string; args: string[] }> = [
    { label: "typecheck (whole tree)", command: "npx", args: ["tsc", "--noEmit"] },
    {
      label: "version consistency (whole tree)",
      command: "node",
      args: ["scripts/check-version-consistency-gate.mjs"],
    },
  ];
  if (selection.mode === "full") {
    steps.push({ label: "tests (full suite)", command: "node", args: ["--test"] });
  } else if (selection.tests.length > 0) {
    steps.push({
      label: `tests (affected: ${selection.tests.length})`,
      command: "node",
      args: ["--test", ...selection.tests],
    });
  } else {
    console.log("[fast-gate] no affected tests to run — typecheck and the version gate only");
  }

  if (opts.dryRun) {
    console.log("[fast-gate] --dry-run, planned steps:");
    for (const step of steps) console.log(`[fast-gate]   ${step.label}: ${step.command} ${step.args.join(" ")}`);
    process.exit(0);
  }

  for (const step of steps) {
    console.log(`\n[fast-gate] === ${step.label} ===`);
    const status = run(step.command, step.args);
    if (status !== 0) {
      console.error(`[fast-gate] FAIL ${step.label} (exit ${status})`);
      process.exit(status);
    }
    console.log(`[fast-gate] ok ${step.label}`);
  }
  console.log(`\n[fast-gate] PASS (${selection.mode} tier)`);
}

// Only run when executed directly: the selector must be importable by its tests
// (scripts/check-version-consistency.mjs documents the same trap).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
