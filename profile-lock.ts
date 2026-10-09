/**
 * Profile lock — the filesystem protocol that stops two pi instances from
 * sharing one relay profile (and therefore one relay identity).
 *
 * Extracted from index.ts (bead pi-chaos-relay-eg1, ADR pi-chaos-relay-hu4):
 * index.ts appeared in 18 of 33 recent first-parent change lists and the lock is
 * one of several unrelated domains competing for it, while the lock itself is
 * pure filesystem plus process state — no session, config or registration
 * coupling. index.ts keeps the POLICY (when a session may claim, what the user
 * is told on refusal, shutdown wiring); this module owns the protocol.
 *
 * Invariants that must not change without a race review:
 *   - claim is an exclusive create (`flag: "wx"`), so exactly one of two
 *     concurrent starters wins and no path overwrites a live holder's lock;
 *   - a lock whose holder pid is alive is never removed, and the create-grace
 *     window protects a holder that has the file but has not written its pid yet;
 *   - release only unlinks a lock this process wrote.
 */
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Profile lock: detect concurrent pi instances on the same relay profile ──

function lockFilePath(profile: string): string {
  return join(homedir(), ".pi", `chaos-relay-${profile}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but belongs to another user — treating
    // that as "dead" would make the stale-lock cleanup unlink a live holder's
    // lock. Only ESRCH (no such process) is genuinely dead.
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * How long an unparseable/empty lock file must be untouched before it is
 * treated as a crashed leftover rather than another process's in-flight
 * exclusive create (see claimProfileLock).
 */
const LOCK_CREATE_GRACE_MS = 1_000;

/**
 * Tolerance below zero for the create-grace age check: Date.now() is integer
 * milliseconds while statSync().mtimeMs is fractional, so a lock created and
 * read within the SAME millisecond has a legitimately negative age of well
 * under 1 ms. Rejecting that unlinked a mid-create lock — the exact window the
 * grace exists to protect. Anything beyond this tolerance is a real future
 * mtime (a clock step), which stays stale.
 */
const LOCK_CREATE_SKEW_TOLERANCE_MS = 50;

/**
 * What a lock file's contents say:
 *  - "ambiguous": empty, partial or unparseable. Another process's exclusive
 *    create is visible from open(2), before its pid is written, so this may be
 *    a live racer: the create-grace applies.
 *  - "invalid-pid": numeric but unusable as a holder (0 or negative). Never
 *    ambiguous — no process has pid 0, and process.kill(0, 0) signals the
 *    caller's own process group and succeeds, which is exactly why such a file
 *    must NOT look like a live holder.
 *  - "pid": a usable pid.
 */
type LockHolder =
  | { kind: "ambiguous" }
  | { kind: "invalid-pid" }
  | { kind: "pid"; pid: number };

/** Read what a lock file records. Missing/unreadable files read as ambiguous. */
function readLockHolder(path: string): LockHolder {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return { kind: "ambiguous" };
  }
  if (raw === "") return { kind: "ambiguous" };
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid)) return { kind: "ambiguous" };
  if (pid <= 0) return { kind: "invalid-pid" };
  return { kind: "pid", pid };
}

/**
 * Atomically claim `profile` for this process, BEFORE any connect or
 * registration work.
 *
 * Why: the previous flow read the lock, awaited connectAsProfile() (which can
 * perform a live relay registration), and only then wrote the lock with a
 * plain writeFileSync — a TOCTOU window in which two pi processes starting
 * together both observe "unlocked", both connect, and both write, so two live
 * sessions share one relay identity and defeat the collision refusal.
 *
 * `flag: "wx"` is an exclusive create: exactly one of two racers can win, and
 * the loser gets EEXIST instead of clobbering the winner. On EEXIST the holder
 * is inspected — a live holder (a different pid that still exists) means
 * refuse; a stale file (dead pid, unparseable, or our own pid) is removed and
 * the exclusive create retried, bounded. There is NO path that overwrites a
 * live holder's lock.
 *
 * `claimed: true` means this process may proceed (for the exotic case where
 * the lock file cannot be created at all — see `lockError` — it proceeds
 * without holding one, keeping the historical fail-open behaviour rather than
 * breaking every session on an unwritable ~/.pi). `pid` is the holder's pid
 * when the claim was refused, for the collision message.
 */
export function claimProfileLock(profile: string): {
  claimed: boolean;
  pid: number | null;
  path: string;
  lockError?: string;
} {
  const path = lockFilePath(profile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return { claimed: true, pid: process.pid, path };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        // Unexpected FS error (read-only ~/.pi, exotic mount): proceed without
        // the lock, but report it so the caller can warn — never overwrite.
        return {
          claimed: true,
          pid: null,
          path,
          lockError: err instanceof Error ? err.message : String(err),
        };
      }
      const holder = readLockHolder(path);
      if (holder.kind === "pid" && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
        return { claimed: false, pid: holder.pid, path };
      }
      if (holder.kind === "ambiguous") {
        // AMBIGUOUS content: `open(2)` creates the file before the winner
        // writes its pid, so a racer that reads it in that window would see an
        // empty (or partial) file and — treating that as stale — delete a live
        // process's lock from under it, the very double-claim this exists to
        // prevent. Reclaim such a file only once it is older than the grace
        // window; before that, treat it as held and refuse.
        let ageMs = Number.POSITIVE_INFINITY;
        try {
          ageMs = Date.now() - statSync(path).mtimeMs;
        } catch {
          /* vanished between read and stat: fall through to the retry */
        }
        // Only an age inside the window is "possibly still being created".
        // The window extends slightly BELOW zero for same-millisecond skew (see
        // LOCK_CREATE_SKEW_TOLERANCE_MS); a real clock step is far outside it.
        if (ageMs >= -LOCK_CREATE_SKEW_TOLERANCE_MS && ageMs < LOCK_CREATE_GRACE_MS) {
          return { claimed: false, pid: null, path };
        }
      }
      // Stale: a dead holder's pid, our own pid, an invalid pid (0/negative —
      // no process has pid 0), or an ambiguous file past the grace window.
      // Clear it and retry the exclusive create; a racing cleaner just means we
      // see EEXIST again.
      try {
        unlinkSync(path);
      } catch {
        /* already gone / another process cleaned it */
      }
    }
  }
  // Lost the retry loop: a real collision, not a stale file.
  const holder = readLockHolder(path);
  return { claimed: false, pid: holder.kind === "pid" ? holder.pid : null, path };
}

/** Release the profile lock on shutdown — but only a lock this process wrote.
 *  A session that refused a collision stays bound to its previous profile name,
 *  and must not unlock the session that legitimately holds it. */
export function removeProfileLock(profile: string): void {
  try {
    const path = lockFilePath(profile);
    if (readFileSync(path, "utf-8").trim() !== String(process.pid)) return;
    unlinkSync(path);
  } catch { /* ignore */ }
}
