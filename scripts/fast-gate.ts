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
 * CONSERVATIVE BY CONSTRUCTION: a changed path is only ever narrowed to a
 * mapped test set. Anything this script does not recognise — the entry point,
 * a manifest/lockfile, tsconfig, the shared test harness, a doc, a brand-new
 * module, a deleted path — falls back to the full suite. The map is explicit
 * and additive: adding a module means adding it to MODULE_TESTS, otherwise it
 * costs the full suite (a wrong answer here can only cost time, never
 * coverage).
 *
 * USAGE
 *   npm run test:fast                     # tsc + version gate + affected tests
 *   node scripts/fast-gate.ts --dry-run   # print the plan, run nothing
 *   node scripts/fast-gate.ts --base <ref># compare against <ref> instead
 *   node scripts/fast-gate.ts --help
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Explicit reverse dependency map: a source path → every test file that covers
 * it, i.e. its own direct test PLUS the tests of the modules that import it (a
 * change to an imported module can change a consumer's behaviour). Derived from
 * the real import graph, checked by test/fast-gate.test.ts so it cannot drift
 * silently — an unmapped file is never narrowed.
 */
export const MODULE_TESTS: Record<string, string[]> = {
  "crypto.ts": ["test/crypto.test.ts", "test/relay-client.test.ts"],
  "relay-client.ts": [
    "test/relay-client.test.ts",
    "test/poller.test.ts",
    "test/inbound-attachments.test.ts",
    "test/ws-client.test.ts",
  ],
  "poller.ts": ["test/poller.test.ts"],
  "ws-client.ts": ["test/ws-client.test.ts"],
  "inbound-attachments.ts": ["test/inbound-attachments.test.ts"],
  "config.ts": ["test/config.test.ts"],
  "connect.ts": ["test/connect.test.ts"],
  "reply-format.ts": ["test/reply-format.test.ts"],
  "url-redact.ts": ["test/url-redact.test.ts"],
  "approval-policy.ts": ["test/approval-policy.test.ts"],
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
 * point is what the integration suite drives, the manifests decide how the
 * suite is installed and run, and tsconfig decides what is type-checked. A
 * path in neither this set nor MODULE_TESTS also forces the full suite.
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
    // The suite itself: any test file, and any other path under test/ (a shared
    // helper or fixture a single file would not cover).
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

/**
 * Base for the change list. Prefers the default branch — like the version gate,
 * it says which base it used and what it could not check — then falls back to
 * HEAD so the script still works in a shallow, offline or remote-less checkout.
 * The working tree (staged, unstaged and untracked) is ALWAYS included: a dirty
 * tree is a superset, which can only widen the run.
 */
export function resolveBase(requested?: string): { ref: string; mergeBase: string; note: string } {
  const candidates = requested
    ? [requested]
    : ["refs/remotes/origin/master", "refs/remotes/origin/main", "refs/heads/master"];
  for (const ref of candidates) {
    const mb = git(["merge-base", ref, "HEAD"]);
    if (mb.ok && mb.out.trim()) {
      const note = requested
        ? `base ${ref} (requested)`
        : `base ${ref} (default branch)`;
      return { ref, mergeBase: mb.out.trim(), note };
    }
  }
  const head = git(["rev-parse", "HEAD"]);
  return {
    ref: "HEAD",
    mergeBase: head.out.trim(),
    note: "base HEAD — no default branch resolved here, so only worktree changes and this commit are considered",
  };
}

/** Every path that differs from `mergeBase`, plus the dirty worktree. */
export function changedFiles(mergeBase: string): string[] {
  const sets: string[][] = [];
  for (const args of [
    ["diff", "--name-only", `${mergeBase}...HEAD`],
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = git(args);
    if (result.ok) sets.push(result.out.split("\n").filter((l) => l.trim() !== ""));
  }
  const all = new Set<string>();
  for (const set of sets) for (const path of set) all.add(normalizePath(path));
  return [...all].sort();
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
This is the implementer fast tier — the merger still runs the full gate on the
merged union.`;

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
  const changed = changedFiles(base.mergeBase);
  const selection = selectTests(changed);

  console.log("[fast-gate] FAST tier — the merger still runs the full gate on the merged union");
  console.log(`[fast-gate] ${base.note}`);
  console.log(`[fast-gate] changed (${changed.length}): ${changed.length ? changed.join(", ") : "(none)"}`);
  console.log(`[fast-gate] mode: ${selection.mode} — ${selection.reason}`);
  if (selection.mode === "affected") {
    console.log(
      `[fast-gate] tests (${selection.tests.length} of ${discoverTestFiles().length}): ${selection.tests.join(" ") || "(none)"}`,
    );
  }

  const steps: Array<{ label: string; command: string; args: string[] }> = [
    { label: "typecheck (whole tree)", command: "npx", args: ["tsc", "--noEmit"] },
    {
      label: "version consistency (whole tree)",
      command: "node",
      args: ["scripts/check-version-consistency-gate.mjs"],
    },
    selection.mode === "full"
      ? { label: "tests (full suite)", command: "node", args: ["--test"] }
      : {
          label: `tests (affected: ${selection.tests.length})`,
          command: "node",
          args: ["--test", ...selection.tests],
        },
  ];

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
