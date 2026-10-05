#!/usr/bin/env node
/**
 * check-version-consistency-gate.mjs — base SELECTION for the repo's own gate.
 *
 * `npm test` has to work in a shallow, single-branch, offline or remote-less
 * checkout, where `origin/master` does not exist. So this wrapper picks the
 * strongest base that actually resolves, runs the strict checker, and is NEVER
 * SILENT ABOUT WHAT IT COULD NOT CHECK:
 *
 *   - prefers `origin/master` (the default branch), in which case the
 *     monotonicity-against-the-default-branch half IS enforced;
 *   - otherwise falls back to `HEAD` and SAYS SO, including that the
 *     monotonicity half was therefore not enforced in this checkout.
 *
 * A fallback that did not name itself would be a check whose failure mode is a
 * pass: on a branch worktree the comparison would become trivially satisfied and
 * the output would still read OK.
 *
 * The agreement half — package.json == package-lock.json top-level ==
 * package-lock.json packages[""] — needs no base at all, so it is enforced on
 * every run, in every environment, fallback or not.
 *
 * The strict checker keeps `--base` REQUIRED and fails closed on an unresolvable
 * ref, so `npm run check:version -- --base <ref>` is exactly as strict as before.
 *
 * USAGE
 *   node scripts/check-version-consistency-gate.mjs [--dir <path>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/check-version-consistency-gate.mjs [--dir <path>]";
const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "check-version-consistency.mjs");
// FULLY QUALIFIED, deliberately: a bare `origin/master` can be shadowed by a local
// branch of that name, and git resolves the bare form by precedence (refs/heads
// before refs/remotes) with only a warning — which is how a check ends up
// comparing against a stale branch while reporting success.
const PREFERRED = "refs/remotes/origin/master";
const PREFERRED_DISPLAY = "origin/master (refs/remotes/origin/master)";

function usageError(message) {
  console.error(`check-version-consistency-gate: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { dir: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) usageError("--dir requires a value");
      opts.dir = value;
      i += 1;
    } else if (arg.startsWith("--dir=")) {
      opts.dir = arg.slice("--dir=".length);
    } else {
      usageError(`unknown argument '${arg}'`);
    }
  }
  return opts;
}

/** True when `ref` resolves AND carries a readable package.json. */
function resolves(dir, ref) {
  try {
    execFileSync("git", ["-C", dir, "show", `${ref}:package.json`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const { dir } = parseArgs(process.argv.slice(2));

let base;
let enforced;
if (resolves(dir, PREFERRED)) {
  base = PREFERRED;
  enforced = true;
  console.log(
    `check-version-consistency-gate: base=${PREFERRED_DISPLAY} (monotonicity against the default branch is ENFORCED)`,
  );
} else {
  base = "HEAD";
  enforced = false;
  console.log(
    `check-version-consistency-gate: base=HEAD (FALLBACK: ${PREFERRED_DISPLAY} is unavailable in this checkout, ` +
      `so the monotonicity-against-the-default-branch half is NOT enforced here; ` +
      `the package.json/package-lock.json AGREEMENT half is enforced regardless)`,
  );
}

const result = spawnSync(process.execPath, [CHECKER, "--base", base, "--dir", dir], { stdio: "inherit" });
if (result.error) {
  console.error(`check-version-consistency-gate: could not run the checker: ${result.error.message}`);
  process.exit(1);
}
if (!enforced) {
  console.log(
    "check-version-consistency-gate: note — this run did not compare against " +
      `${PREFERRED_DISPLAY}. To enforce that half explicitly, run: ` +
      `npm run check:version -- --base ${PREFERRED}`,
  );
}
process.exit(result.status ?? 1);
