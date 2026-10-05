#!/usr/bin/env node
/**
 * check-version-consistency.mjs — refuse a tree whose version metadata disagrees
 * with itself, or that moves the version BACKWARDS relative to a base ref.
 *
 * WHY THIS EXISTS: a branch shipped `package.json` at 0.17.6 while
 * `package-lock.json` still said 0.17.3, and it passed type-checking, the full
 * test suite and the secret scan — only a human reading two files caught it.
 * The rule ("package.json and package-lock.json must always agree, and a change
 * must not move the version backwards") is entirely mechanical, so it belongs in
 * the gate rather than in an attentive reviewer.
 *
 * USAGE
 *   node scripts/check-version-consistency.mjs --base <git-ref> [--dir <path>]
 *
 *   --base <ref>  REQUIRED. The ref the current version must not go below,
 *                 normally `refs/remotes/origin/master`. Resolved with `git show`.
 *   --dir <path>  Directory holding package.json/package-lock.json.
 *                 Defaults to the current working directory.
 *
 * EXIT CODES
 *   0  versions agree and the current version is not below the base's
 *   1  a check failed (disagreement, version regression, an ambiguous base, an
 *      unresolvable base, or unreadable files); every problem found is printed
 *   2  usage error (missing --base, unknown flag)
 *
 * FAIL CLOSED, TWICE:
 *   - an unresolvable base ref is a FAILURE, never a skip — "I could not compare"
 *     is not "the comparison passed";
 *   - an AMBIGUOUS bare base name is a FAILURE, never a resolution: git picks one
 *     ref by precedence (refs/heads before refs/remotes) and only warns, so a
 *     local branch named `origin/master` can silently become the base. Pass a
 *     fully-qualified ref (`refs/remotes/origin/master`) to make it unambiguous.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const USAGE = "usage: node scripts/check-version-consistency.mjs --base <git-ref> [--dir <path>]";

function usageError(message) {
  console.error(`check-version-consistency: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { base: undefined, dir: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--base" || arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) usageError(`${arg} requires a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--base=")) {
      opts.base = arg.slice("--base=".length);
    } else if (arg.startsWith("--dir=")) {
      opts.dir = arg.slice("--dir=".length);
    } else {
      usageError(`unknown argument '${arg}'`);
    }
  }
  if (!opts.base || opts.base.trim() === "") {
    usageError("--base is required (for example: --base refs/remotes/origin/master)");
  }
  return opts;
}

/** Numeric comparison of dot-separated versions. Returns >0, 0 or <0. */
export function compareVersions(a, b) {
  const split = (v) => String(v).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

function readJson(dir, name, problems) {
  let raw;
  try {
    raw = readFileSync(join(dir, name), "utf8");
  } catch (err) {
    problems.push(`cannot read ${name}: ${err.message}`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    problems.push(`cannot parse ${name}: ${err.message}`);
    return undefined;
  }
}

/**
 * The ref namespaces a bare name can resolve from, in git's own precedence order.
 * A name matching more than one of them is ambiguous: git picks one and only
 * prints a warning, so a check can silently compare against a ref the caller
 * never meant. A local branch named `origin/master` shadowing
 * `refs/remotes/origin/master` is exactly that case.
 */
const RESOLUTION_NAMESPACES = [
  (n) => `refs/heads/${n}`,
  (n) => `refs/remotes/${n}`,
  (n) => `refs/tags/${n}`,
  (n) => `refs/${n}`,
];

/** Every existing ref a bare `base` would resolve from. Fully-qualified names cannot be ambiguous. */
export function ambiguousBaseRefs(dir, base) {
  if (base.startsWith("refs/")) return [];
  const found = [];
  for (const candidate of RESOLUTION_NAMESPACES.map((f) => f(base))) {
    try {
      execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", candidate], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      found.push(candidate);
    } catch {
      // This candidate does not exist; not a source of ambiguity.
    }
  }
  return found;
}

function readBaseVersion(dir, base, problems) {
  const path = `${base}:package.json`;
  let raw;
  try {
    raw = execFileSync("git", ["-C", dir, "show", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim().split("\n").pop();
    problems.push(
      `cannot resolve base ref '${base}' (git show ${path} failed${detail ? `: ${detail}` : ""}); ` +
        "refusing rather than skipping the check",
    );
    return undefined;
  }
  try {
    return JSON.parse(raw).version;
  } catch (err) {
    problems.push(`base ref '${base}' has an unreadable package.json: ${err.message}`);
    return undefined;
  }
}

const opts = parseArgs(process.argv.slice(2));
const dir = resolve(opts.dir);
const problems = [];

const pkg = readJson(dir, "package.json", problems);
const lock = readJson(dir, "package-lock.json", problems);

const pkgVersion = pkg?.version;
const lockTop = lock?.version;
const lockRoot = lock?.packages?.[""]?.version;

if (pkg && (typeof pkgVersion !== "string" || pkgVersion === "")) {
  problems.push("package.json has no version");
}
if (lock && (typeof lockTop !== "string" || lockTop === "")) {
  problems.push("package-lock.json has no top-level version");
}
if (lock && (typeof lockRoot !== "string" || lockRoot === "")) {
  problems.push('package-lock.json has no version at packages[""]');
}
if (typeof pkgVersion === "string" && typeof lockTop === "string" && pkgVersion !== lockTop) {
  problems.push(`package.json (${pkgVersion}) != package-lock.json top-level (${lockTop})`);
}
if (typeof pkgVersion === "string" && typeof lockRoot === "string" && pkgVersion !== lockRoot) {
  problems.push(`package.json (${pkgVersion}) != package-lock.json packages[""] (${lockRoot})`);
}

// Ambiguity guard: refuse rather than resolve a bare name by git's precedence.
const ambiguous = ambiguousBaseRefs(dir, opts.base);
let baseVersion;
if (ambiguous.length > 1) {
  problems.push(
    `base ref '${opts.base}' is AMBIGUOUS: it resolves to ${ambiguous.join(" and ")}, and git ` +
      "picks one of them by precedence (refs/heads before refs/remotes) with only a warning. " +
      "Refusing rather than comparing against a ref you may not have meant; pass a " +
      `fully-qualified ref, e.g. refs/remotes/${opts.base}`,
  );
} else {
  baseVersion = readBaseVersion(dir, opts.base, problems);
  if (
    baseVersion !== undefined &&
    typeof pkgVersion === "string" &&
    compareVersions(pkgVersion, baseVersion) < 0
  ) {
    problems.push(`version ${pkgVersion} is BELOW ${opts.base} (${baseVersion})`);
  }
}

const summary =
  `package.json=${pkgVersion ?? "?"}, package-lock.json=${lockTop ?? "?"}, ` +
  `packages[""]=${lockRoot ?? "?"}, ${opts.base}=${baseVersion ?? "?"}`;

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-version-consistency: ${problem}`);
  console.error(`check-version-consistency: FAILED (${summary})`);
  process.exit(1);
}

console.log(`check-version-consistency: OK (${summary})`);
