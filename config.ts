/**
 * Configuration + credential storage for the pi-chaos-relay extension.
 *
 * Precedence for every value: environment variable > persisted config file >
 * built-in default. Secrets (the relay API key) live only in env or the
 * persisted file under ~/.pi — never in the repo. The config file is created
 * with 0600 permissions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { KeyPairJwk } from "./crypto.ts";

export const DEFAULT_RELAY_URL = "https://chaos-relay.com";
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const MIN_POLL_INTERVAL_MS = 3_000;

export const CONFIG_DIR = join(homedir(), ".pi");

/**
 * Resolve the per-instance config file. Each file is a separate relay identity
 * (its own ECDSA keypair → userId → message queue), so two pi instances on the
 * same machine can hold distinct connections instead of sharing one:
 *
 *   CHAOS_RELAY_CONFIG=/abs/path.json   explicit file (highest precedence)
 *   CHAOS_RELAY_PROFILE=work            → ~/.pi/chaos-relay.work.json
 *   (unset / "default")                 → ~/.pi/chaos-relay.json  (back-compat)
 *
 * Exported as a pure function so it can be unit-tested without touching env.
 */
export function configPathFor(
  env: Record<string, string | undefined>,
  dir: string = CONFIG_DIR,
): string {
  const explicit = env.CHAOS_RELAY_CONFIG?.trim();
  if (explicit) return explicit;
  const profile = (env.CHAOS_RELAY_PROFILE ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const file = profile && profile !== "default"
    ? `chaos-relay.${profile}.json`
    : "chaos-relay.json";
  return join(dir, file);
}

function envOf(): Record<string, string | undefined> {
  // process.env is available in the pi runtime (already used below for overrides).
  return (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
}

/**
 * The profile name an explicit env var forces, or undefined when none is set.
 * (CHAOS_RELAY_CONFIG / CHAOS_RELAY_PROFILE.) Pure given an env object.
 */
export function envProfileName(env: Record<string, string | undefined> = envOf()): string | undefined {
  const explicit = env.CHAOS_RELAY_CONFIG?.trim() || (env.CHAOS_RELAY_PROFILE ?? "").trim();
  return explicit ? profileNameForPath(configPathFor(env)) : undefined;
}

// The config file the extension is currently reading/writing. At load it's just
// env-or-default; the real per-session selection happens at session_start (see
// the session→profile map below + chooseProfileForSession in index.ts). Mutable
// so a profile can be switched at runtime (setActiveConfigPath / switchProfile).
let activeConfigPath = configPathFor(envOf());

// ── Session → profile map ─────────────────────────────────────────────────
// Which relay profile each pi SESSION is bound to, so resuming a session
// reconnects as the identity it was using (not a machine-global guess). Keyed by
// pi's stable session id. Holds profile names only — not secrets.
const SESSION_MAP_PATH = join(CONFIG_DIR, "chaos-relay-sessions.json");
const SESSION_MAP_MAX = 200; // LRU cap so the map can't grow unbounded

/** (path, reason) pairs already warned about for the session→profile map. */
const warnedCorruptSessionMaps = new Set<string>();

function warnCorruptSessionMap(reason: string): Record<string, string> {
  if (!warnedCorruptSessionMaps.has(reason)) {
    warnedCorruptSessionMaps.add(reason);
    console.warn(`pi-chaos-relay: ${reason} — ignoring the session→profile map.`);
  }
  return {};
}

/**
 * Read the session→profile map, tolerating anything that is not valid persisted
 * JSON — the same tolerant-read policy as {@link readPersisted}. A missing map is
 * the normal "no bindings yet" case and stays silent; a truncated/corrupt map
 * (an interrupted or concurrent write) degrades to an empty map with ONE warning
 * instead of throwing on the session-start path.
 */
export function loadSessionMap(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(SESSION_MAP_PATH, "utf-8");
  } catch (err) {
    // Not existing is the normal "nothing recorded yet" case — stay quiet.
    if ((err as { code?: string }).code === "ENOENT") return {};
    return warnCorruptSessionMap(`Failed to read ${SESSION_MAP_PATH}: ${messageOf(err)}`);
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return warnCorruptSessionMap(`Failed to parse ${SESSION_MAP_PATH}: ${messageOf(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return warnCorruptSessionMap(
      `Failed to parse ${SESSION_MAP_PATH}: expected a JSON object, got ${got}`,
    );
  }
  // Drop non-string values: a corrupt entry must not leak a non-string profile
  // name into getSessionProfile → chooseProfile → configPathFor, where it would
  // hit .trim() and crash a session start.
  const map: Record<string, string> = {};
  for (const [sessionId, profile] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof profile === "string") map[sessionId] = profile;
  }
  return map;
}

/** The profile bound to a pi session, or undefined if none recorded. */
export function getSessionProfile(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return loadSessionMap()[sessionId];
}

/**
 * Pure: record `sessionId → profile`, moving it to most-recent and trimming the
 * oldest beyond the cap. Exported for testing.
 */
export function applySessionProfile(
  map: Record<string, string>,
  sessionId: string,
  profile: string,
  cap: number = SESSION_MAP_MAX,
): Record<string, string> {
  const next: Record<string, string> = {};
  // Re-insert all except this id (preserves order), then append this id last.
  for (const [k, v] of Object.entries(map)) {
    if (k !== sessionId) next[k] = v;
  }
  next[sessionId] = profile;
  const keys = Object.keys(next);
  if (keys.length > cap) {
    for (const k of keys.slice(0, keys.length - cap)) delete next[k];
  }
  return next;
}

/**
 * Pure profile-selection policy for a session start, by precedence:
 * env (pins) → the session's recorded profile → inherit on new/fork → default.
 * Exported so every row of the launch/use matrix is unit-testable.
 */
export function chooseProfile(opts: {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  envProfile?: string;
  recordedProfile?: string;
  inheritedProfile?: string;
}): string {
  if (opts.envProfile) return opts.envProfile;
  if (opts.recordedProfile) return opts.recordedProfile;
  if ((opts.reason === "new" || opts.reason === "fork") && opts.inheritedProfile) {
    return opts.inheritedProfile;
  }
  return "default";
}

export type ProfileLockOutcome =
  | { action: "connect"; profile: string }
  | { action: "refuse"; profile: string; pid: number | null; message: string };

/**
 * Pure decision for the profile-lock collision path: given the profile a session
 * chose and whether another live process holds its lock, either connect on that
 * profile or refuse (never mint a new identity).
 *
 * Refusing is deliberate. Auto-creating `hostname-pid` on every collision
 * produced unbounded config files — each one a fresh keypair and relay identity —
 * and could silently put an operator on an identity they never chose. The
 * refusal names both the profile and its lock file, and says how to resolve it.
 * Exported so the collision path is unit-testable without the pi runtime.
 */
export function resolveProfileLockCollision(opts: {
  profile: string;
  locked: boolean;
  pid?: number | null;
  lockPath: string;
}): ProfileLockOutcome {
  if (!opts.locked) return { action: "connect", profile: opts.profile };
  const pid = opts.pid ?? null;
  const holder =
    pid === null ? "another live pi session" : `another live pi session (PID ${pid})`;
  const message =
    `Relay profile "${opts.profile}" is already held by ${holder}. ` +
    `Lock file: ${opts.lockPath}. ` +
    `This session will not switch to a new identity. ` +
    `Resolve it by closing that session, or give this one its own profile: ` +
    `launch with CHAOS_RELAY_PROFILE=<name> pi, or run /chaos-relay profile <name> here.`;
  return { action: "refuse", profile: opts.profile, pid, message };
}

/** Persist `sessionId → profile` atomically (best-effort). Bounded by an LRU cap. */
export function setSessionProfile(sessionId: string | undefined, profile: string): void {
  if (!sessionId) return;
  try {
    const next = applySessionProfile(loadSessionMap(), sessionId, profile);
    // Temp-file + rename so an interrupted/concurrent write can never leave a
    // truncated map at the target; the previous complete map survives instead.
    atomicWriteSync(SESSION_MAP_PATH, JSON.stringify(next, null, 2) + "\n");
  } catch {
    /* best effort */
  }
}

/** The config file currently in use. */
export function getConfigPath(): string {
  return activeConfigPath;
}

/** Point the extension at a different config file (used when switching profiles). */
export function setActiveConfigPath(path: string): void {
  activeConfigPath = path;
  // The new profile's config may still carry legacy in-config tracking fields,
  // so its one-time migration to the side-car must run again.
  stateMigrated = false;
}

/** Absolute path for a named profile ("default" → chaos-relay.json). */
export function profilePathForName(name: string): string {
  return configPathFor({ CHAOS_RELAY_PROFILE: name }, CONFIG_DIR);
}

/** Profile name for a config path ("default" for the base chaos-relay.json). */
export function profileNameForPath(path: string): string {
  const m = basename(path).match(/^chaos-relay(?:\.(.+))?\.json$/);
  return m ? (m[1] ?? "default") : basename(path);
}

/** The active profile's name. */
export function activeProfileName(): string {
  return profileNameForPath(activeConfigPath);
}

/** Profile config files under ~/.pi: chaos-relay.json or chaos-relay.<name>.json. */
const PROFILE_FILE_RE = /^chaos-relay(?:\.(.+))?\.json$/;

/**
 * List known profiles — every chaos-relay[.<name>].json in ~/.pi, plus the
 * active one (which may live elsewhere via CHAOS_RELAY_CONFIG).
 */
export function listProfiles(): { name: string; active: boolean }[] {
  const active = activeProfileName();
  const names = new Set<string>([active]);
  try {
    for (const f of readdirSync(CONFIG_DIR)) {
      const m = f.match(PROFILE_FILE_RE);
      if (m) names.add(m[1] ?? "default");
    }
  } catch {
    /* ~/.pi may not exist yet */
  }
  return [...names].sort().map((name) => ({ name, active: name === active }));
}

/**
 * Hard cap on on-disk profile config files under ~/.pi. Each file is a separate
 * relay identity (its own keypair), so an LLM-callable switch must not be able
 * to mint them without bound.
 */
export const MAX_PROFILE_CONFIGS = 100;

/** Number of profile config files on disk (chaos-relay[.<name>].json). */
export function countProfileConfigs(dir: string = CONFIG_DIR): number {
  try {
    return readdirSync(dir).filter((f) => PROFILE_FILE_RE.test(f)).length;
  } catch {
    return 0;
  }
}

export type ProfileCreateOutcome =
  | { action: "allow"; profile: string }
  | { action: "refuse"; profile: string; limit: number; message: string };

/**
 * Pure decision for creating a NEW profile file. Refuses only when the target
 * does not already exist AND the on-disk profile count has reached the cap — an
 * existing-but-unconfigured profile is a switch, not a creation, and stays
 * allowed. Exported so the cap is unit-testable without the pi runtime.
 */
export function resolveProfileCreate(opts: {
  profile: string;
  exists: boolean;
  existingCount: number;
  limit?: number;
}): ProfileCreateOutcome {
  // ACCEPTED RESIDUAL (pi-chaos-relay-icj): the count is read before an async
  // registration writes the new config, so two SEPARATE pi processes that both
  // start at limit-1 can both pass this check and both create, ending one over
  // the cap. It is accepted rather than locked because the cap is a resource
  // guard (bounding identity/keypair files in ~/.pi), not a security boundary;
  // reaching it needs two processes to collide at exactly the limit; tool
  // execution is already serialized within a process, so a single pi cannot
  // race itself; and a second filesystem-locking mechanism beside the profile
  // locks would cost more than the residual it closes pre-1.0. One file over a
  // 100-cap bound is harmless, and the next creation attempt sees the true
  // count. Revisit if the cap ever becomes a security control.
  const limit = opts.limit ?? MAX_PROFILE_CONFIGS;
  if (opts.exists) return { action: "allow", profile: opts.profile };
  if (opts.existingCount >= limit) {
    return {
      action: "refuse",
      profile: opts.profile,
      limit,
      message:
        `Relay profile "${opts.profile}" would create a new identity, but the ` +
        `profile cap of ${limit} is already reached (${opts.existingCount} profile ` +
        `file${opts.existingCount === 1 ? "" : "s"} on disk). Reuse an existing ` +
        `profile (/chaos-relay profile <name>) or remove unused profile files ` +
        `from ~/.pi (chaos-relay*.json) before creating another.`,
    };
  }
  return { action: "allow", profile: opts.profile };
}

export type ApprovalMode = "off" | "writes" | "all";
export const APPROVAL_MODES: ApprovalMode[] = ["off", "writes", "all"];

/** Coerce an arbitrary value to a valid ApprovalMode, defaulting to "writes" so a
 *  channel-driven session is NOT ungated out of the box. "off" remains an
 *  explicit opt-out; an absent or malformed value falls back to the gated
 *  default rather than silently disabling the gate. */
export function normalizeApprovalMode(v: unknown): ApprovalMode {
  return APPROVAL_MODES.includes(v as ApprovalMode) ? (v as ApprovalMode) : "writes";
}

/**
 * True if `url` is an absolute http(s) URL we can safely build request URLs
 * from. Rejects empty strings, relative paths, and non-http schemes — all of
 * which would otherwise produce "Failed to parse URL" errors at fetch time.
 *
 * Accepted: "https://chaos-relay.com", "http://localhost:8787",
 *          "https://relay.example.com/" (trailing slash ok).
 * Rejected: "", "/chaos-relay approvals writes", "chaos-relay.com",
 *          "ftp://x", "file:///x", "relay foo".
 */
export function isValidRelayUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export interface PersistedConfig {
  /** Relay base URL. */
  relayUrl?: string;
  /** Bearer API key from POST /auth/register. Secret. */
  apiKey?: string;
  /** Relay userId returned alongside the API key (informational). */
  userId?: string;
  /** Agent id this client routes channels to. Defaults to "pi". */
  agentId?: string;
  /** Poll interval in milliseconds. */
  pollIntervalMs?: number;
  /** Channels registered through this extension (for reference / reply routing). */
  channels?: RegisteredChannelRecord[];
  /**
   * Tool-approval policy for channel-driven turns:
   *  - "writes" (default) — ask over the channel before shell/edit/write tools
   *    run (and before relay_reply ships a file attachment).
   *  - "off"    — run every tool autonomously (explicit opt-out; sandbox the agent).
   *  - "all"    — ask before EVERY tool (except the read-only relay plumbing).
   */
  approvalMode?: ApprovalMode;
  /**
   * Cursor (ISO timestamp) of the most recent message delivered to the agent.
   * LEGACY pre-0.17.5 location: still READ for one-time migration, but new
   * writes go to the side-car state file (see loadMessageState).
   */
  messagesCursor?: string;
  /**
   * Ids of messages already delivered to the agent (capped, most-recent last).
   * The authoritative de-dup log: it survives restarts so the relay's on-connect
   * replay (a 5-minute WebSocket lookback) and any catch-up poll never
   * re-process a message we've already handled. The timestamp cursor only bounds
   * the fetch window; this is what prevents re-delivery.
   * LEGACY pre-0.17.5 location: still READ for one-time migration, but new
   * writes go to the side-car state file (see loadMessageState).
   */
  seenMessageIds?: string[];
  /**
   * Tombstone set when the legacy cursor/seen-id fields above were stripped
   * from this config (their data now lives ONLY in the <config>.state
   * side-car). Its purpose is diagnostic: if the side-car then goes missing,
   * loadMessageState can tell a genuine first run (silent) from a LOST
   * side-car after migration (loud warning — de-dup was reset, so recent
   * messages may be re-delivered; restore the side-car from backup).
   * Backups of a profile must therefore include BOTH the config file and its
   * .state side-car.
   */
  messageStateMigrated?: boolean;
  /**
   * ECDSA P-256 keypair (JWK) bound to this session at registration. The
   * private key is SECRET — it is the client's identity and is never sent to
   * the relay or committed. Stored only in this 0600 file under ~/.pi.
   */
  keyPair?: KeyPairJwk;
  /** Server's ECDSA public key (JWK) returned at registration — TOFU pin. */
  serverPublicKey?: JsonWebKey;
}

export interface RegisteredChannelRecord {
  channelId: string;
  type: "telegram" | "email" | "webhook" | "discord";
  label?: string;
  createdAt: string;
  /**
   * Material to AUTO RE-REGISTER this channel if the relay loses the session
   * (a forced-new session, where channels can't be reclaimed by keypair).
   * Secret — the Telegram bot token especially — so it lives only in this 0600
   * file under ~/.pi and is never committed. Optional: channels registered
   * before this existed simply won't auto re-bind.
   */
  botToken?: string;
  userEmail?: string;
  channelName?: string;
  /**
   * For webhook channels: the secret token in the inbound URL. Re-registering
   * with the same channelId + secret keeps the public webhook URL stable across
   * session recovery, so external services don't need to be reconfigured.
   */
  webhookSecret?: string;
}

export interface ResolvedConfig {
  relayUrl: string;
  apiKey?: string;
  userId?: string;
  agentId: string;
  pollIntervalMs: number;
  channels: RegisteredChannelRecord[];
  /** Tool-approval policy for channel-driven turns. */
  approvalMode: ApprovalMode;
  /** ECDSA keypair for request signing. File-only (never from env). */
  keyPair?: KeyPairJwk;
  /** Pinned server public key (TOFU). File-only. */
  serverPublicKey?: JsonWebKey;
}

/**
 * Result of reading the persisted config file.
 *
 * `config` is always usable — `{}` (the same defaults an absent file produces)
 * whenever the file is missing, empty, or unreadable. `corrupt` is set when the
 * file exists but could not be read or parsed, so `/chaos-relay doctor` can still
 * report the file as broken instead of lying that it "parses".
 */
export interface PersistedReadResult {
  config: PersistedConfig;
  corrupt?: { path: string; reason: string };
}

/** (path, reason) pairs already warned about, so a hot-path read warns once. */
const warnedCorruptConfigs = new Set<string>();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Emit ONE operator-facing warning per corrupt config file and fall back to
 * defaults. loadPersisted runs on the message-delivery path
 * (deliverToAgent → ensureClient → resolveConfig → loadPersisted), so the
 * warning is deduped per path + reason — an unreadable file must be visible,
 * but it must not print on every delivered batch.
 */
function degradeToDefaults(reason: string): PersistedReadResult {
  if (!warnedCorruptConfigs.has(reason)) {
    warnedCorruptConfigs.add(reason);
    console.warn(
      `pi-chaos-relay: ${reason} — ignoring it and falling back to defaults. ` +
        `Fix the file, or run /chaos-relay reset all then /chaos-relay setup.`,
    );
  }
  return { config: {}, corrupt: { path: activeConfigPath, reason } };
}

/**
 * Read the persisted config, tolerating anything that is not valid persisted
 * JSON. An empty / whitespace-only file is a truncation artifact — e.g. a legacy
 * non-atomic write that was interrupted, or a reader that caught a
 * truncate-then-write mid-flight — so it recovers silently. Everything else
 * that fails to read or parse degrades to defaults with one warning, because
 * throwing here was fatal: this runs on the message-delivery path
 * (deliverToAgent → ensureClient → resolveConfig → loadPersisted), so an
 * "Unexpected end of JSON input" became an uncaughtException that crashed pi.
 */
export function readPersisted(): PersistedReadResult {
  let raw: string;
  try {
    raw = readFileSync(activeConfigPath, "utf-8");
  } catch (err) {
    // Not existing is the normal "nothing persisted yet" case — stay quiet.
    if ((err as { code?: string }).code === "ENOENT") return { config: {} };
    return degradeToDefaults(`Failed to read ${activeConfigPath}: ${messageOf(err)}`);
  }
  if (raw.trim() === "") return { config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return degradeToDefaults(`Failed to parse ${activeConfigPath}: ${messageOf(err)}`);
  }
  // Valid JSON that is not the expected shape (null, an array, a bare scalar)
  // has no config fields to read — and `null` would crash resolveConfig.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return degradeToDefaults(
      `Failed to parse ${activeConfigPath}: expected a JSON object, got ${got}`,
    );
  }
  return { config: parsed as PersistedConfig };
}

export function loadPersisted(): PersistedConfig {
  return readPersisted().config;
}

// Monotonic suffix so overlapping writes from one process never collide on the
// temp path (pid disambiguates across processes sharing a profile file).
let tmpCounter = 0;

/**
 * Atomic file replace: serialize to a unique temp file in the same directory,
 * then rename(2) over the target. The rename is atomic on POSIX, so a
 * concurrent reader always sees either the complete old file or the complete
 * new one — never a half-written/truncated file. Shared by the config writer
 * and the message-state side-car writer so BOTH get the same guarantee.
 *
 * Crash residual, stated rather than glossed: this is atomic-replace, not
 * crash-without-trace. If the process dies between the temp write and the
 * rename, an inert `<target>.tmp.<pid>.<n>` orphan is left beside the target
 * and the PREVIOUS complete file survives at the target, if one existed (on a
 * first-ever write there is no previous file, so the target is simply absent
 * and a later batch may replay after restart — the de-dup log's job). The
 * chmod to 0600 is best-effort: on filesystems that reject it the file keeps
 * the temp file's default mode. Neither residual affects a concurrent reader.
 */
function atomicWriteSync(path: string, contents: string): void {
  // Ensure the target's directory exists (the config may live outside ~/.pi
  // when CHAOS_RELAY_CONFIG points elsewhere; the side-car sits beside it).
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${tmpCounter++}`;
  writeFileSync(tmp, contents);
  // Best effort: tighten permissions (the config holds the API key; the
  // side-car is not secret but stays 0600 for consistency). Done on the temp
  // file so the tightened mode is what lands at the target.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* non-POSIX filesystems may not support chmod */
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Clean up the temp file so a failed rename doesn't leak turds next to the
    // target; re-throw so the caller still learns the write failed.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

export function savePersisted(updates: Partial<PersistedConfig>): PersistedConfig {
  const current = existsSync(activeConfigPath) ? loadPersisted() : {};
  const merged: PersistedConfig = { ...current, ...updates };
  atomicWriteSync(activeConfigPath, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function addChannelRecord(record: RegisteredChannelRecord): void {
  const persisted = loadPersisted();
  const channels = persisted.channels ?? [];
  channels.push(record);
  savePersisted({ channels });
}

/** Replace the full channel list (e.g. after auto re-binding to a new session). */
export function setChannelRecords(channels: RegisteredChannelRecord[]): void {
  savePersisted({ channels });
}

/**
 * Inbound-message tracking state (resume cursor + de-dup log) that lives in a
 * small SIDE-CAR file next to the profile config, not in the config itself.
 *
 * Why a side-car: the poller flushes this state once per delivered batch, and
 * the de-dup log can hold up to 1000 message ids (~tens of KB). When it lived
 * inside the config, every flush re-read, re-parsed and re-serialized the
 * whole profile config (keypair, channel records, the id log itself) — measured
 * as the dominant per-message CPU cost of the extension (bead
 * pi-chaos-relay-mlq). With the side-car, the delivery hot path never touches
 * the config at all, and both files keep the same atomic write guarantee
 * (unique temp file + rename, see atomicWriteSync).
 */
export interface MessageTrackingState {
  /** Resume cursor (ISO timestamp) of the most recent delivered message. */
  cursor?: string;
  /** Ids of already-delivered messages (capped, most-recent last). */
  seenIds: string[];
}

/** The side-car path for the active profile's message-tracking state. */
export function messageStatePath(): string {
  // `<config>.state` deliberately does NOT end in `.json` so listProfiles'
  // chaos-relay*.json glob can never mistake it for a profile config.
  return `${activeConfigPath}.state`;
}

/** (path, reason) pairs already warned about, for the side-car's hot-path reads. */
const warnedCorruptStates = new Set<string>();

/**
 * Read the message-tracking state. Precedence:
 *  1. the side-car file (`<config>.state`), when present and parseable;
 *  2. the legacy in-config fields (`messagesCursor` / `seenMessageIds`), so a
 *     profile written by an older version keeps its cursor + de-dup log
 *     across the upgrade (the first save migrates them to the side-car).
 *
 * Tolerant by design: a missing side-car is the normal not-yet-migrated case,
 * and a corrupt one degrades to the legacy values with ONE warning instead of
 * throwing — this runs on the message-delivery path, where an uncaught throw
 * would kill pi. A corrupt side-car self-heals on the next save.
 */
export function loadMessageState(): MessageTrackingState {
  let raw: string | undefined;
  try {
    raw = readFileSync(messageStatePath(), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      const reason = `Failed to read ${messageStatePath()}: ${messageOf(err)}`;
      if (!warnedCorruptStates.has(reason)) {
        warnedCorruptStates.add(reason);
        console.warn(`pi-chaos-relay: ${reason} — ignoring the side-car state file.`);
      }
    }
  }
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as {
        cursor?: unknown;
        seenIds?: unknown;
      };
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
          seenIds: Array.isArray(parsed.seenIds)
            ? parsed.seenIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      }
    } catch {
      /* fall through to the legacy fields; warn-once below */
    }
    const reason = `Failed to parse ${messageStatePath()}`;
    if (!warnedCorruptStates.has(reason)) {
      warnedCorruptStates.add(reason);
      console.warn(
        `pi-chaos-relay: ${reason} — ignoring the side-car state file ` +
          `(it will be rewritten on the next delivered message).`,
      );
    }
  }
  // Legacy fallback (pre-side-car profiles) — also the seed for migration.
  const persisted = loadPersisted();
  // A profile that already migrated carries no legacy fields, so a missing
  // side-car would otherwise silently reset de-dup. The tombstone makes the
  // loss LOUD: warn once that recent messages may be re-delivered and that the
  // side-car should be restored from backup (a genuine first run has no
  // tombstone and stays silent).
  if (persisted.messageStateMigrated) {
    const reason = `message-state side-car ${messageStatePath()} is missing, but this profile already migrated to it`;
    if (!warnedCorruptStates.has(reason)) {
      warnedCorruptStates.add(reason);
      console.warn(
        `pi-chaos-relay: ${reason}. The de-dup log has been reset, so the ` +
          `relay's on-connect replay may re-deliver recent messages. Restore ` +
          `${messageStatePath()} from backup (backups must include BOTH the ` +
          `config file and its .state side-car).`,
      );
    }
  }
  return {
    cursor: persisted.messagesCursor,
    seenIds: persisted.seenMessageIds ?? [],
  };
}

/** Whether the one-time legacy→side-car migration already ran (per profile). */
let stateMigrated = false;

/**
 * Persist the message-tracking state with ONE small atomic write to the
 * side-car. Also migrates a legacy profile once: strips `messagesCursor` /
 * `seenMessageIds` out of the config so later config writes stop re-serializing
 * the (potentially 1000-id) de-dup log. The migration flag resets on profile
 * switches so each active config gets its own one-time pass.
 *
 * Residual, documented not fixed: the backfill can only diagnose a side-car
 * loss that happens AFTER the tombstone exists. A profile that migrated
 * BEFORE the tombstone was introduced, and whose side-car was lost BEFORE its
 * first post-upgrade flush, still resets de-dup silently once — that loss
 * precedes the tombstone that would have made it loud, and there is no cheap
 * way to tell a never-yet-flushed profile from a lost one. The tombstone
 * makes every LATER loss loud.
 */
export function saveMessageState(state: MessageTrackingState): void {
  atomicWriteSync(
    messageStatePath(),
    JSON.stringify({ cursor: state.cursor, seenIds: state.seenIds }, null, 2) + "\n",
  );
  if (stateMigrated) return;
  const persisted = loadPersisted();
  // One-time pass per process/profile: strip any legacy in-config fields, and
  // make sure the tombstone exists even for profiles that migrated before the
  // tombstone was introduced (otherwise their side-car loss would stay
  // silent). Costs a single config write at the first delivered batch.
  if (
    persisted.seenMessageIds !== undefined ||
    persisted.messagesCursor !== undefined ||
    persisted.messageStateMigrated !== true
  ) {
    savePersisted({
      seenMessageIds: undefined,
      messagesCursor: undefined,
      messageStateMigrated: true,
    });
  }
  // Arm the flag ONLY after the tombstone config write succeeded. Arming it
  // before (as a prior revision did) would make a FAILED write — after the
  // side-car write already succeeded — silently skip migration on every later
  // batch, leaving the tombstone unwritten so a subsequent side-car loss
  // resets de-dup silently: exactly the failure the tombstone exists to make
  // loud. If savePersisted throws above, stateMigrated stays false and the
  // next batch retries the one-time pass.
  stateMigrated = true;
}

/** Persist the tool-approval policy. */
export function setApprovalMode(mode: ApprovalMode): void {
  savePersisted({ approvalMode: mode });
}

/**
 * Reset persisted config. `scope`:
 *  - "url"  — clear only `relayUrl` (fixes the common corruption where a bad
 *            value was pasted/saved; keeps credentials, keypair, channels).
 *  - "all"  — wipe the config file entirely (full fresh start; the user must
 *            re-run setup, which registers a new session + keypair).
 *
 * Non-interactive and safe: used by `/chaos-relay reset` to recover from a
 * corrupted config without needing the setup UI.
 */
export function resetPersisted(scope: "url" | "all"): void {
  if (scope === "all") {
    if (existsSync(activeConfigPath)) {
      unlinkSync(activeConfigPath);
    }
    // "all" is a full fresh start: drop the message-tracking side-car too, so
    // a stale cursor / seen-id log from the previous identity can never
    // suppress delivery of a replayed message on the new one.
    if (existsSync(messageStatePath())) {
      unlinkSync(messageStatePath());
    }
    // Whatever lands at this path next (a re-run setup, or a legacy config
    // restored by hand) must get its own migration pass — the flag keeping the
    // one-time legacy strip from re-running per flush is no longer valid for
    // the file we just deleted.
    stateMigrated = false;
    return;
  }
  // "url": clear just the relayUrl field. savePersisted merges, and
  // JSON.stringify drops undefined-valued keys, so this removes it cleanly.
  savePersisted({ relayUrl: undefined });
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the effective config. Env vars override the persisted file.
 *
 * Env vars:
 *   CHAOS_RELAY_URL       — relay base URL
 *   CHAOS_RELAY_API_KEY   — Bearer API key (secret)
 *   CHAOS_RELAY_AGENT_ID  — agent id to route channels to
 *   CHAOS_RELAY_POLL_MS   — poll interval (ms)
 *   CHAOS_RELAY_PROFILE   — separate config file per instance (see configPathFor)
 *   CHAOS_RELAY_CONFIG    — explicit config file path (see configPathFor)
 */
export function resolveConfig(persisted = loadPersisted()): ResolvedConfig {
  // Pick the FIRST VALID candidate in precedence order (env > file > default).
  // Each candidate is validated, not just the ??-winner: a set-but-invalid env
  // value must not win the chain, fail validation, and then fall back to the
  // default — that silently discarded a valid persisted self-hosted URL. Skipping
  // a malformed value (e.g. a command accidentally pasted into the URL field)
  // also prevents it from ever reaching fetch() and throwing "Failed to parse
  // URL". The selected value is TRIMMED: isValidRelayUrl validates url.trim(),
  // so a value with surrounding whitespace would otherwise be returned (and
  // persisted) with the space, breaking fetch and the WebSocket URL.
  // DEFAULT_RELAY_URL is always valid, so the find always resolves.
  const relayUrl = (
    [process.env.CHAOS_RELAY_URL, persisted.relayUrl, DEFAULT_RELAY_URL].find(
      (candidate) => isValidRelayUrl(candidate),
    ) ?? DEFAULT_RELAY_URL
  ).trim();
  const apiKey = process.env.CHAOS_RELAY_API_KEY ?? persisted.apiKey;
  const agentId = process.env.CHAOS_RELAY_AGENT_ID ?? persisted.agentId ?? "pi";

  const rawInterval =
    envInt("CHAOS_RELAY_POLL_MS") ?? persisted.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, rawInterval);

  return {
    relayUrl,
    apiKey,
    userId: persisted.userId,
    agentId,
    pollIntervalMs,
    channels: persisted.channels ?? [],
    approvalMode: normalizeApprovalMode(
      process.env.CHAOS_RELAY_APPROVAL_MODE ?? persisted.approvalMode,
    ),
    // The inbound-message resume cursor + de-dup log now live in the side-car
    // state file (loadMessageState); they are no longer part of the resolved
    // config. The poller is their only consumer.
    // The keypair is the client's identity and is intentionally NOT
    // overridable via env — it lives only in the 0600 config file.
    keyPair: persisted.keyPair,
    serverPublicKey: persisted.serverPublicKey,
  };
}

export function isConfigured(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.apiKey);
}
