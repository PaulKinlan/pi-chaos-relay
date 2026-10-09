/**
 * Focused coverage for profile-lock.ts (bead pi-chaos-relay-eg1): the filesystem
 * protocol that stops two pi instances from sharing one relay profile.
 *
 * The integration test still drives the policy through the extension (the
 * session_start refusal, switchProfile collisions, shutdown release). This file
 * exercises the protocol itself — including the windows that are hard to reach
 * from the extension: the create-grace for a holder that has not written its pid
 * yet, a clock step, an invalid pid, a directory that cannot be written, and a
 * real multi-process race on the extracted module.
 *
 * HOME is redirected before anything touches the lock path: lockFilePath()
 * resolves homedir() per call, so every path here stays inside a throwaway
 * directory and the real ~/.pi is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_DIR = mkdtempSync(join(tmpdir(), "pi-chaos-relay-lock-test-"));
const PI_DIR = join(HOME_DIR, ".pi");
mkdirSync(PI_DIR, { recursive: true });
process.env.HOME = HOME_DIR;

const { claimProfileLock, removeProfileLock } = await import("../profile-lock.ts");

const lockPath = (profile: string) => join(PI_DIR, `chaos-relay-${profile}.lock`);
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
};

// ── the claim ────────────────────────────────────────────────────────────────

test("claims a free profile: pid-only contents, owner-only mode, exact path", () => {
  const profile = "free";
  const result = claimProfileLock(profile);

  assert.equal(result.claimed, true);
  assert.equal(result.pid, process.pid, "reports this process as the holder");
  assert.equal(result.path, lockPath(profile), "names the lock file it created");
  assert.equal(result.lockError, undefined);
  assert.equal(readFileSync(lockPath(profile), "utf-8"), String(process.pid), "records only the pid");
  assert.equal(statSync(lockPath(profile)).mode & 0o777, 0o600, "created owner-only");
});

test("refuses a live holder and leaves its lock byte-for-byte intact", () => {
  const profile = "held";
  const lock = lockPath(profile);
  // pid 1 is always alive and is never this process, so it is a live foreign
  // holder without needing to spawn anything.
  writeFileSync(lock, "1");
  const before = readFileSync(lock, "utf-8");

  const result = claimProfileLock(profile);

  assert.equal(result.claimed, false, "a live holder's profile is never claimed");
  assert.equal(result.pid, 1, "reports the holder for the collision message");
  assert.equal(result.path, lock);
  assert.equal(readFileSync(lock, "utf-8"), before, "the holder's file is untouched");
});

test("reclaims a lock whose holder is dead, and one that names this process", () => {
  const dead = "stale";
  writeFileSync(lockPath(dead), "2147483646"); // beyond any real pid
  assert.equal(isAlive(2147483646), false, "test premise: the recorded pid is dead");
  const stale = claimProfileLock(dead);
  assert.equal(stale.claimed, true, "a dead holder's lock is stale and reclaimable");
  assert.equal(readFileSync(lockPath(dead), "utf-8"), String(process.pid));

  // Our own pid is not a foreign holder: a restart within one process reclaims.
  const own = "own-pid";
  writeFileSync(lockPath(own), String(process.pid));
  assert.equal(claimProfileLock(own).claimed, true);
});

test("reclaims an invalid pid — 0 and negative are never live holders", () => {
  // process.kill(0, 0) signals the caller's own process group and succeeds, so a
  // lock file reading "0" would look alive unless it is rejected as invalid.
  for (const raw of ["0", "-1"]) {
    const profile = `invalid-${raw.replace("-", "neg")}`;
    writeFileSync(lockPath(profile), raw);
    const result = claimProfileLock(profile);
    assert.equal(result.claimed, true, `"${raw}" is not a live holder`);
    assert.equal(readFileSync(lockPath(profile), "utf-8"), String(process.pid));
  }
});

// ── the create-grace window ──────────────────────────────────────────────────

test("an empty lock is held inside the create grace, then reclaimable", () => {
  const profile = "grace";
  const lock = lockPath(profile);
  writeFileSync(lock, "");

  // Age inside the window: another process may have created the file and not yet
  // written its pid, so removing it would be taking a live racer's lock.
  const held = claimProfileLock(profile);
  assert.equal(held.claimed, false, "an ambiguous lock inside the grace is held");
  assert.equal(held.pid, null, "there is no holder pid to report");
  assert.equal(readFileSync(lock, "utf-8"), "", "the possibly-mid-create file is not removed");

  // Age past the window (1_000 ms) with an explicit mtime rather than a sleep.
  const old = (Date.now() - 5_000) / 1_000;
  utimesSync(lock, old, old);
  const reclaimed = claimProfileLock(profile);
  assert.equal(reclaimed.claimed, true, "a crashed leftover is reclaimed after the grace");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

test("an empty lock whose mtime is now (same-millisecond skew) is still held", () => {
  const profile = "skew";
  const lock = lockPath(profile);
  writeFileSync(lock, "");
  const now = Date.now() / 1_000;
  utimesSync(lock, now, now); // age ≈ 0, i.e. inside [−50 ms, +1000 ms)

  assert.equal(claimProfileLock(profile).claimed, false, "same-millisecond skew keeps the grace");
  assert.equal(existsSync(lock), true);
});

test("an empty lock dated in the future is a clock step, not a live racer", () => {
  const profile = "future";
  const lock = lockPath(profile);
  writeFileSync(lock, "");
  const future = (Date.now() + 60_000) / 1_000;
  utimesSync(lock, future, future); // far beyond the 50 ms skew tolerance

  assert.equal(claimProfileLock(profile).claimed, true, "a future mtime is stale, not protected");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

// ── failure and release paths ────────────────────────────────────────────────

test("an unwritable ~/.pi fails open with a lockError and creates nothing", () => {
  const profile = "unwritable";
  const lock = lockPath(profile);
  assert.equal(existsSync(lock), false, "test premise: no lock file yet");
  const dirMode = statSync(PI_DIR).mode & 0o777;
  try {
    chmodSync(PI_DIR, 0o500);
    if ((statSync(PI_DIR).mode & 0o200) !== 0 || process.getuid?.() === 0) {
      return; // the mode did not take (root / exotic filesystem): nothing to assert
    }
    const result = claimProfileLock(profile);
    // Historical behaviour is to proceed without a lock (breaking every session
    // on an unwritable ~/.pi would be worse), but the failure must be reported
    // so the caller can warn — and nothing may be written.
    assert.equal(result.claimed, true, "the fail-open behaviour is kept");
    assert.ok(result.lockError, "…and the failure is reported, not swallowed");
    assert.equal(result.pid, null, "no holder pid is invented");
    assert.equal(existsSync(lock), false, "nothing is created in an unwritable directory");
  } finally {
    chmodSync(PI_DIR, dirMode);
  }
});

test("removeProfileLock unlinks only a lock this process wrote", () => {
  const foreign = "release-foreign";
  writeFileSync(lockPath(foreign), "1");
  removeProfileLock(foreign);
  assert.equal(existsSync(lockPath(foreign)), true, "another session's lock survives");
  assert.equal(readFileSync(lockPath(foreign), "utf-8"), "1", "…unchanged");

  const mine = "release-mine";
  claimProfileLock(mine);
  assert.equal(existsSync(lockPath(mine)), true);
  removeProfileLock(mine);
  assert.equal(existsSync(lockPath(mine)), false, "our own lock is released");

  // A profile that was never locked (or already released) is a no-op.
  removeProfileLock("release-never-locked");
});

// ── the race the lock exists for ─────────────────────────────────────────────

test("three processes racing one profile: exactly one wins, on the extracted module", async () => {
  const profile = "race";
  const moduleUrl = new URL("../profile-lock.ts", import.meta.url).href;
  const HOLD_MS = 3_000;
  const startAt = Date.now() + 700;
  // Every child attempts at the same wall-clock instant, and the winner HOLDS
  // the lock while the losers try: a winner that exited first would leave a
  // genuinely stale file and a second claim would be correct, not a race.
  const child = `
    const { claimProfileLock } = await import(${JSON.stringify(moduleUrl)});
    while (Date.now() < Number(process.env.START_AT)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = claimProfileLock(process.env.LOCK_PROFILE);
    console.log(JSON.stringify({ pid: process.pid, claimed: result.claimed, holder: result.pid }));
    await new Promise((r) => setTimeout(r, ${HOLD_MS}));
  `;

  const racers = Array.from({ length: 3 }, () => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, HOME: HOME_DIR, START_AT: String(startAt), LOCK_PROFILE: profile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let resolveFirst!: (line: string) => void;
    const firstLine = new Promise<string>((resolve) => (resolveFirst = resolve));
    proc.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolveFirst(buffer.slice(0, nl));
    });
    return { proc, firstLine };
  });

  try {
    const results = await Promise.all(racers.map((r) => r.firstLine));
    const parsed = results.map((line) => JSON.parse(line) as { pid: number; claimed: boolean; holder: number | null });
    const winners = parsed.filter((r) => r.claimed);
    assert.equal(winners.length, 1, `exactly one process may claim: ${results.join(" | ")}`);
    for (const loser of parsed.filter((r) => !r.claimed)) {
      assert.equal(loser.holder, winners[0].pid, "a loser is told which live pid holds it");
    }
    // And the file on disk names the winner, not a loser.
    assert.equal(readFileSync(lockPath(profile), "utf-8"), String(winners[0].pid));
  } finally {
    for (const racer of racers) racer.proc.kill("SIGKILL");
  }
});
