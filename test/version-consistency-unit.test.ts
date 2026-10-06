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

const SCRIPT = new URL("../scripts/check-version-consistency.mjs", import.meta.url);

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

test("compareVersions orders prereleases by identifier", () => {
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-beta") < 0, "alphanumeric identifiers compare lexically");
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0, "numeric identifiers sort before alphanumeric");
  assert.ok(compareVersions("1.0.0-2", "1.0.0-10") < 0, "numeric identifiers compare numerically, not lexically");
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0, "fewer identifiers sorts lower");
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1+build.9"), 0, "build metadata is ignored");
});

test("compareVersions ignores build metadata", () => {
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
