import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../scripts/check-version-consistency-gate.mjs", import.meta.url));

const gitEnv = () => ({
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});

function writeVersions(dir: string, version: string) {
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

/**
 * A git repo whose committed (HEAD) version is `headVersion`, optionally carrying
 * a remote-tracking `origin/master` ref committed at `defaultBranchVersion`, and
 * whose working tree holds `currentVersion`.
 */
function makeRepo(
  headVersion: string,
  currentVersion: string,
  defaultBranchVersion?: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "version-gate-"));
  const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() });

  assert.equal(git(["init", "-q"]).status, 0);
  writeVersions(dir, headVersion);
  assert.equal(git(["add", "-A"]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "head"]).status, 0);

  if (defaultBranchVersion !== undefined) {
    // A commit that is NOT reachable from HEAD, published as origin/master. It must
    // carry defaultBranchVersion, so stage those versions and build the commit from
    // THAT tree (writing it from the index tree would reuse the head versions and the
    // fixture would silently stop testing what it claims to test).
    writeVersions(dir, defaultBranchVersion);
    assert.equal(git(["add", "-A"]).status, 0);
    const tree = git(["write-tree"]).stdout.trim();
    const commit = spawnSync(
      "git",
      ["-C", dir, "commit-tree", tree, "-m", "default branch"],
      { encoding: "utf8", env: gitEnv() },
    ).stdout.trim();
    assert.ok(commit, "commit-tree produced a commit");
    assert.equal(git(["update-ref", "refs/remotes/origin/master", commit]).status, 0);
  }

  // Working tree holds the "current" versions; HEAD and origin/master are untouched.
  writeVersions(dir, currentVersion);
  return dir;
}

function runGate(dir: string) {
  const result = spawnSync(process.execPath, [GATE, "--dir", dir], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("gate: prefers origin/master when it resolves, and says monotonicity is enforced", () => {
  const dir = makeRepo("0.17.6", "0.17.7", "0.17.6");
  try {
    const { status, stdout } = runGate(dir);
    assert.equal(status, 0, stdout + "\n" + "expected pass");
    assert.match(stdout, /base=origin\/master/);
    assert.match(stdout, /ENFORCED/);
    assert.match(stdout, /check-version-consistency: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: falls back to HEAD when origin/master is absent, and NAMES the fallback", () => {
  const dir = makeRepo("0.17.7", "0.17.7");
  try {
    const { status, stdout } = runGate(dir);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /base=HEAD/);
    assert.match(stdout, /FALLBACK/);
    assert.match(stdout, /is NOT enforced here/);
    assert.match(stdout, /AGREEMENT half is enforced regardless/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: the fallback cannot silently mask a default-branch violation", () => {
  // origin/master sits at a HIGHER version than this tree, so with the ref present
  // the monotonicity half must refuse...
  const withRef = makeRepo("0.17.7", "0.17.7", "0.17.9");
  try {
    const { status, stdout, stderr } = runGate(withRef);
    assert.equal(status, 1, "must refuse against origin/master 0.17.9");
    assert.match(stderr, /is BELOW .*\(0\.17\.9\)/);
    assert.doesNotMatch(stdout, /FALLBACK/);
  } finally {
    rmSync(withRef, { recursive: true, force: true });
  }

  // ...and the same tree WITHOUT the ref passes only by falling back, while saying
  // so out loud. This is the property that keeps a fallback from being a silent skip.
  const withoutRef = makeRepo("0.17.7", "0.17.7");
  try {
    const { status, stdout } = runGate(withoutRef);
    assert.equal(status, 0);
    assert.match(stdout, /FALLBACK/);
    assert.match(stdout, /not compare against origin\/master/);
  } finally {
    rmSync(withoutRef, { recursive: true, force: true });
  }
});

test("gate: propagates a real failure through the fallback path", () => {
  const dir = makeRepo("0.17.7", "0.17.7");
  try {
    // Break only the agreement half, with no origin/master present.
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify(
        { name: "fixture", version: "0.17.3", lockfileVersion: 3, packages: { "": { name: "fixture", version: "0.17.3" } } },
        null,
        2,
      ),
    );
    const { status, stderr } = runGate(dir);
    assert.equal(status, 1, "the agreement half must fail even on the fallback path");
    assert.match(stderr, /package\.json \(0\.17\.7\) != package-lock\.json top-level \(0\.17\.3\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Make a commit carrying `version` and return its sha, without moving HEAD. */
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

test("gate: ignores a local branch named origin/master that shadows the remote-tracking ref", () => {
  // The real base (refs/remotes/origin/master) is 0.17.7 and the tree is 0.17.7,
  // so this passes. A LOCAL branch named origin/master points at 0.99.0 instead,
  // and git resolves the bare name to refs/heads first — so a gate that compares
  // against the bare name refuses this tree, and this test fails. That is what
  // makes it a discriminating test rather than a comment.
  const dir = makeRepo("0.17.7", "0.17.7", "0.17.7");
  try {
    const shadow = sideCommit(dir, "0.99.0");
    const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() });
    assert.equal(git(["update-ref", "refs/heads/origin/master", shadow]).status, 0, "shadow ref created");
    writeVersions(dir, "0.17.7");

    const { status, stdout, stderr } = runGate(dir);
    assert.equal(status, 0, `must read the remote-tracking ref, not the shadow\n${stdout}${stderr}`);
    // Assert the MESSAGE, not only the status: a non-zero exit is satisfied by any
    // failure, including an unrelated one, so a status-only test could pass for the
    // wrong reason. These pin WHICH ref was used and at which version.
    assert.match(stdout, /refs\/remotes\/origin\/master/);
    assert.match(stdout, /refs\/remotes\/origin\/master=0\.17\.7/);
    assert.doesNotMatch(stdout, /0\.99\.0/);
    assert.match(stdout, /check-version-consistency: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
