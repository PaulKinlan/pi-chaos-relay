/**
 * Direct unit coverage for scripts/check-version-consistency.mjs.
 *
 * The gate's own tests (version-consistency.test.ts, version-consistency-gate.test.ts)
 * drive the script end-to-end through spawnSync, which left two things unpinned
 * (pi-chaos-relay-3qd):
 *
 *   1. the module had NO entry-point guard, so it could not be imported at all —
 *      `import` ran parseArgs(process.argv.slice(2)) and process.exit(2);
 *   2. consequently compareVersions' boundary semantics were never asserted
 *      directly, and a prerelease compared EQUAL to its release
 *      ("1.0.0-beta" == "1.0.0"), which for a gate whose job is refusing a
 *      version regression is a real hole rather than a coverage nicety.
 *
 * The first test spawns a process that only imports the module: without the
 * guard it exits 2 with a usage error, so it fails loudly instead of quietly
 * pinning nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = new URL("../scripts/check-version-consistency.mjs", import.meta.url);
// fileURLToPath, not URL.pathname: pathname percent-encodes and is not a path.
const SCRIPT_PATH = fileURLToPath(SCRIPT);

const { compareVersions } = (await import(SCRIPT.href)) as {
  compareVersions: (a: string, b: string) => number;
};

test("the module is importable without running the CLI (entry-point guard)", () => {
  // A fresh process that imports the module and prints a marker. Without the
  // guard, the top-level parseArgs runs with no --base and exits 2.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(SCRIPT.href)});\nprocess.stdout.write("imported-without-cli");`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    child.status,
    0,
    `import must not execute the CLI (status ${child.status}): ${child.stderr}`,
  );
  assert.equal(child.stdout, "imported-without-cli");
  assert.equal(child.stderr, "", "no usage error on import");
});

test("compareVersions orders plain numeric versions", () => {
  assert.ok(compareVersions("0.17.6", "0.17.4") > 0);
  assert.ok(compareVersions("0.17.4", "0.17.6") < 0);
  assert.equal(compareVersions("0.17.6", "0.17.6"), 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
});

test("compareVersions treats missing release segments as zero", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0, "'1.0' === '1.0.0'");
  assert.equal(compareVersions("1", "1.0.0.0"), 0);
  assert.ok(compareVersions("1.0.1", "1.0") > 0, "a longer version with a real segment still wins");
  assert.ok(compareVersions("1.0.0.1", "1.0") > 0);
});

test("compareVersions folds non-numeric release segments to zero", () => {
  // parseInt("x") is NaN, and the gate deliberately folds that to 0 rather than
  // throwing (it must survive surprising input and still compare something).
  assert.equal(compareVersions("1.x.3", "1.0.3"), 0);
  assert.equal(compareVersions("1.0.x", "1.0.0"), 0);
  // A leading 'v' is NOT stripped: the segment 'v1' folds to 0, so this parses
  // as [0,2,3] and sorts below [1,2,3]. Recorded deliberately — package.json
  // and the lockfile never carry a 'v', so folding it is the honest boundary
  // rather than a silently-added convenience.
  assert.ok(compareVersions("v1.2.3", "1.2.3") < 0);
  assert.ok(compareVersions("1.0.1", "1.x") > 0);
});

test("compareVersions sorts a prerelease BELOW its release (semver §11)", () => {
  assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0, "prerelease is lower");
  assert.ok(compareVersions("1.0.0", "1.0.0-beta") > 0);
  assert.ok(compareVersions("0.17.14-rc.1", "0.17.14") < 0, "the gate's own regression case");
  assert.ok(compareVersions("0.17.14", "0.17.14-rc.1") > 0);
  // …and a prerelease of a lower release is still below that release.
  assert.ok(compareVersions("0.17.13-rc.1", "0.17.14") < 0);
});

test("compareVersions orders prereleases by identifier, including build metadata", () => {
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0, "alphanumeric identifiers compare lexically");
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0, "numeric identifiers sort before alphanumeric");
  assert.ok(compareVersions("1.0.0-2", "1.0.0-10") < 0, "numeric identifiers compare numerically, not lexically");
  // Secondary numeric identifiers must compare numerically too, in BOTH
  // directions — lexically "10" < "2", so this is the case a string compare
  // gets wrong.
  assert.ok(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2") > 0, "alpha.10 is above alpha.2");
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0, "and the reverse direction agrees");
  assert.ok(compareVersions("1.0.0-rc.10", "1.0.0-rc.9") > 0, "rc.10 is above rc.9");
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0, "fewer identifiers sorts lower");
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1+build.9"), 0, "build metadata is ignored");
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0+build.6"), 0);
  assert.ok(compareVersions("1.0.1+build.1", "1.0.0+build.9") > 0, "release segments still decide");
});

test("the gate's regression rule now catches a prerelease branch version", () => {
  // The end-to-end oracle: the gate refuses when the current version is BELOW
  // the base. A prerelease of the base version must count as below it.
  const below = compareVersions("0.17.14-rc.1", "0.17.14") < 0;
  assert.equal(below, true);
  const above = compareVersions("0.17.15", "0.17.14") < 0;
  assert.equal(above, false, "a strictly greater release is accepted");
});

test("the entry-point guard survives being invoked through a SYMLINK", () => {
  // Node resolves import.meta.url through symlinks but leaves process.argv[1] as
  // the typed path, so comparing them without realpathSync made a symlinked
  // invocation skip main() and exit 0 — a silent gate bypass that reported
  // success without checking anything. This drives the script through a symlink
  // against a fixture whose versions DISAGREE, so a real check must exit 1
  // (and a bypass would exit 0).
  const dir = mkdtempSync(join(tmpdir(), "version-gate-symlink-"));
  try {
    // A minimal git repo so --base HEAD resolves inside the fixture.
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = (args: string[]) =>
      spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
    run(["init", "-q"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }) + "\n");
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", packages: { "": { version: "1.0.0" } } }) + "\n");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "fixture"]);
    // Now make the tree disagree with itself (and with HEAD): the gate must fail.
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "0.9.0", packages: { "": { version: "0.9.0" } } }) + "\n");

    const link = join(dir, "gate-link.mjs");
    symlinkSync(SCRIPT_PATH, link);

    const result = spawnSync(process.execPath, [link, "--base", "HEAD", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `a symlinked invocation must still CHECK (exit 1 on a disagreement, not a silent 0): ` +
        `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
    );
    assert.match(result.stderr, /!= package-lock\.json/, `it reported the disagreement: ${result.stderr}`);

    // …and the same invocation NOT through a symlink behaves identically.
    const direct = spawnSync(process.execPath, [SCRIPT_PATH, "--base", "HEAD", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(direct.status, 1, "direct invocation also fails the bad fixture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard also holds under --preserve-symlinks-main (import.meta.url keeps the symlink)", () => {
  // Under --preserve-symlinks-main / --preserve-symlinks, import.meta.url stays
  // the SYMLINK url while realpathSync(argv[1]) resolves to the target, so a
  // canonicalize-only comparison was false, main() was skipped and the process
  // exited 0 — the silent bypass again, reached through a flag instead of a
  // plain symlink. The guard now tests the raw url first.
  const dir = mkdtempSync(join(tmpdir(), "version-gate-preserve-"));
  try {
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
    run(["init", "-q"]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }) + "\n");
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", packages: { "": { version: "1.0.0" } } }) + "\n");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "fixture"]);
    // Disagree with itself so a real check must fail.
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "0.9.0", packages: { "": { version: "0.9.0" } } }) + "\n");

    const link = join(dir, "gate-preserve.mjs");
    symlinkSync(SCRIPT_PATH, link);

    for (const flag of ["--preserve-symlinks-main", "--preserve-symlinks"]) {
      const result = spawnSync(process.execPath, [flag, link, "--base", "HEAD", "--dir", dir], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        1,
        `${flag}: the gate must still CHECK through a symlink (exit 1, not a silent 0): ` +
          `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.match(result.stderr, /!= package-lock\.json/, `${flag}: reported the disagreement`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
