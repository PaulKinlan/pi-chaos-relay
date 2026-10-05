import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-version-consistency.mjs", import.meta.url));

/** Build a git repo whose committed package.json is `baseVersion` and whose working
 *  tree currently holds `pkg` / `lockTop` / `lockRoot`. The commit is the base ref. */
function makeFixture(
  baseVersion: string,
  current: { pkg?: string; lockTop?: string; lockRoot?: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), "version-consistency-"));
  const write = (pkg: string, lockTop: string, lockRoot: string) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: pkg }, null, 2));
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify(
        { name: "fixture", version: lockTop, lockfileVersion: 3, packages: { "": { name: "fixture", version: lockRoot } } },
        null,
        2,
      ),
    );
  };

  write(baseVersion, baseVersion, baseVersion);
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  assert.equal(git(["init", "-q"]).status, 0, "git init");
  assert.equal(git(["add", "-A"]).status, 0, "git add");
  assert.equal(git(["commit", "-q", "-m", "base"]).status, 0, "git commit");

  // Now the working tree holds the "current" versions, with HEAD still the base.
  write(current.pkg ?? baseVersion, current.lockTop ?? baseVersion, current.lockRoot ?? baseVersion);
  return dir;
}

function run(dir: string, base: string) {
  const result = spawnSync(process.execPath, [SCRIPT, "--base", base, "--dir", dir], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("version consistency: agreement above the base passes", () => {
  const dir = makeFixture("0.17.4", { pkg: "0.17.6", lockTop: "0.17.6", lockRoot: "0.17.6" });
  try {
    const { status, stdout } = run(dir, "HEAD");
    assert.equal(status, 0, `expected pass, got ${status}`);
    assert.match(stdout, /check-version-consistency: OK/);
    assert.match(stdout, /package\.json=0\.17\.6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: equal to the base passes (not below is the rule)", () => {
  const dir = makeFixture("0.17.6", {});
  try {
    const { status, stdout } = run(dir, "HEAD");
    assert.equal(status, 0);
    // Assert the OUTPUT too, not only the exit status: a status-only assertion is
    // satisfied by any script that exits 0, including one that does nothing.
    assert.match(stdout, /check-version-consistency: OK/);
    assert.match(stdout, /package\.json=0\.17\.6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: package.json ahead of the lockfile is refused (the shape that shipped)", () => {
  const dir = makeFixture("0.17.4", { pkg: "0.17.6", lockTop: "0.17.3", lockRoot: "0.17.3" });
  try {
    const { status, stderr } = run(dir, "HEAD");
    assert.equal(status, 1, "must exit 1");
    assert.match(stderr, /package\.json \(0\.17\.6\) != package-lock\.json top-level \(0\.17\.3\)/);
    assert.match(stderr, /package\.json \(0\.17\.6\) != package-lock\.json packages\[""\] \(0\.17\.3\)/);
    assert.match(stderr, /FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: inconsistency inside the lockfile alone is refused", () => {
  const dir = makeFixture("0.17.4", { pkg: "0.17.6", lockTop: "0.17.6", lockRoot: "0.17.5" });
  try {
    const { status, stderr } = run(dir, "HEAD");
    assert.equal(status, 1);
    assert.match(stderr, /packages\[""\] \(0\.17\.5\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: a version below the base is refused", () => {
  const dir = makeFixture("0.17.4", { pkg: "0.17.2", lockTop: "0.17.2", lockRoot: "0.17.2" });
  try {
    const { status, stderr } = run(dir, "HEAD");
    assert.equal(status, 1);
    assert.match(stderr, /version 0\.17\.2 is BELOW HEAD \(0\.17\.4\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: an unresolvable base fails closed rather than skipping", () => {
  const dir = makeFixture("0.17.4", { pkg: "0.17.6", lockTop: "0.17.6", lockRoot: "0.17.6" });
  try {
    const { status, stderr } = run(dir, "no-such-ref");
    assert.equal(status, 1, "an unresolvable base must not pass");
    assert.match(stderr, /cannot resolve base ref 'no-such-ref'/);
    assert.match(stderr, /refusing rather than skipping the check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: --base is required", () => {
  const dir = makeFixture("0.17.4", {});
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.equal(result.status, 2, "usage error must exit 2");
    assert.match(result.stderr ?? "", /--base is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version consistency: unreadable metadata is a failure, not a pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "version-consistency-bad-"));
  try {
    writeFileSync(join(dir, "package.json"), "{ not json");
    const { status, stderr } = run(dir, "HEAD");
    assert.equal(status, 1);
    assert.match(stderr, /cannot parse package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Local fixture helpers for this file (the gate test has its own copies). */
function writeVersions(dir: string, version: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }, null, 2));
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify(
      { name: "fixture", version, lockfileVersion: 3, packages: { "": { name: "fixture", version } } },
      null,
      2,
    ),
  );
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** Make a commit carrying `version` and return its sha, WITHOUT moving HEAD. */
function sideCommit(dir: string, version: string): string {
  writeVersions(dir, version);
  const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() });
  assert.equal(git(["add", "-A"]).status, 0);
  const tree = git(["write-tree"]).stdout.trim();
  const commit = spawnSync("git", ["-C", dir, "commit-tree", tree, "-m", `version ${version}`], {
    encoding: "utf8",
    env: gitEnv(),
  }).stdout.trim();
  assert.ok(commit, `commit-tree produced a commit for ${version}`);
  return commit;
}

test("version consistency: an AMBIGUOUS bare base name fails closed instead of resolving", () => {
  // A local branch named like a remote shadows refs/remotes/origin/master; git
  // resolves the bare name by precedence with only a warning, so the check must
  // refuse rather than compare against whichever ref git happened to prefer.
  const dir = makeFixture("0.17.7", { pkg: "0.17.7", lockTop: "0.17.7", lockRoot: "0.17.7" });
  try {
    const shadow = sideCommit(dir, "0.99.0");
    const remote = sideCommit(dir, "0.17.7");
    const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() });
    // BOTH refs must exist, or there is nothing to be ambiguous about.
    assert.equal(git(["update-ref", "refs/remotes/origin/master", remote]).status, 0);
    assert.equal(git(["update-ref", "refs/heads/origin/master", shadow]).status, 0);
    writeVersions(dir, "0.17.7");

    const bare = run(dir, "origin/master");
    assert.equal(bare.status, 1, "an ambiguous bare base must not resolve silently");
    assert.match(bare.stderr, /is AMBIGUOUS/);
    assert.match(bare.stderr, /refs\/heads\/origin\/master and refs\/remotes\/origin\/master/);
    assert.match(bare.stderr, /fully-qualified ref/);

    // The qualified form is the documented escape hatch and must work.
    const qualified = run(dir, "refs/remotes/origin/master");
    assert.equal(qualified.status, 0, "the fully-qualified ref must resolve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
