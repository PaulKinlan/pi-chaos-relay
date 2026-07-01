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

export function loadSessionMap(): Record<string, string> {
  try {
    const obj = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf-8"));
    return obj && typeof obj === "object" ? obj as Record<string, string> : {};
  } catch {
    return {};
  }
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

/** Persist `sessionId → profile` (best-effort). Bounded by an LRU cap. */
export function setSessionProfile(sessionId: string | undefined, profile: string): void {
  if (!sessionId) return;
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    const next = applySessionProfile(loadSessionMap(), sessionId, profile);
    writeFileSync(SESSION_MAP_PATH, JSON.stringify(next, null, 2) + "\n");
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

/**
 * List known profiles — every chaos-relay[.<name>].json in ~/.pi, plus the
 * active one (which may live elsewhere via CHAOS_RELAY_CONFIG).
 */
export function listProfiles(): { name: string; active: boolean }[] {
  const active = activeProfileName();
  const names = new Set<string>([active]);
  try {
    for (const f of readdirSync(CONFIG_DIR)) {
      const m = f.match(/^chaos-relay(?:\.(.+))?\.json$/);
      if (m) names.add(m[1] ?? "default");
    }
  } catch {
    /* ~/.pi may not exist yet */
  }
  return [...names].sort().map((name) => ({ name, active: name === active }));
}

export type ApprovalMode = "off" | "writes" | "all";
export const APPROVAL_MODES: ApprovalMode[] = ["off", "writes", "all"];

/** Coerce an arbitrary value to a valid ApprovalMode, defaulting to "off". */
export function normalizeApprovalMode(v: unknown): ApprovalMode {
  return APPROVAL_MODES.includes(v as ApprovalMode) ? (v as ApprovalMode) : "off";
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
   *  - "off"    (default) — run every tool autonomously (sandbox the agent).
   *  - "writes" — ask over the channel before shell/edit/write tools run.
   *  - "all"    — ask before EVERY tool (except the relay_* plumbing).
   */
  approvalMode?: ApprovalMode;
  /**
   * Cursor (ISO timestamp) of the most recent message delivered to the agent.
   * Persisted so a restart resumes AFTER it instead of re-reading the relay's
   * whole 24h backlog. Advanced from delivered message timestamps.
   */
  messagesCursor?: string;
  /**
   * Ids of messages already delivered to the agent (capped, most-recent last).
   * The authoritative de-dup log: it survives restarts so the relay's on-connect
   * replay (a 5-minute WebSocket lookback) and any catch-up poll never
   * re-process a message we've already handled. The timestamp cursor only bounds
   * the fetch window; this is what prevents re-delivery.
   */
  seenMessageIds?: string[];
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
  /** Resume cursor (ISO timestamp) for inbound message polling. File-only. */
  messagesCursor?: string;
  /** ECDSA keypair for request signing. File-only (never from env). */
  keyPair?: KeyPairJwk;
  /** Pinned server public key (TOFU). File-only. */
  serverPublicKey?: JsonWebKey;
}

export function loadPersisted(): PersistedConfig {
  if (!existsSync(activeConfigPath)) return {};
  const raw = readFileSync(activeConfigPath, "utf-8");
  // An empty / whitespace-only file is a truncation artifact — e.g. a legacy
  // non-atomic write that was interrupted, or a reader that caught a
  // truncate-then-write mid-flight. There are no credentials to lose, so
  // recover silently instead of throwing. Throwing here was fatal: this runs on
  // the WebSocket message path (setMessagesCursor → savePersisted →
  // loadPersisted), so an "Unexpected end of JSON input" became an
  // uncaughtException that crashed pi.
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as PersistedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${activeConfigPath}: ${message}`);
  }
}

// Monotonic suffix so overlapping writes from one process never collide on the
// temp path (pid disambiguates across processes sharing a profile file).
let tmpCounter = 0;

export function savePersisted(updates: Partial<PersistedConfig>): PersistedConfig {
  const current = existsSync(activeConfigPath) ? loadPersisted() : {};
  const merged: PersistedConfig = { ...current, ...updates };
  // Ensure the config file's own directory exists (it may be outside ~/.pi when
  // CHAOS_RELAY_CONFIG points elsewhere).
  const dir = dirname(activeConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic write: serialize to a unique temp file in the same directory, then
  // rename(2) over the target. The rename is atomic on POSIX, so a concurrent
  // reader (a cursor advance, or another pi session sharing this profile)
  // always sees either the complete old file or the complete new one — never a
  // half-written/truncated file. The previous plain writeFileSync truncated the
  // target first, which is exactly what let loadPersisted read an empty file
  // mid-write and crash pi.
  const tmp = `${activeConfigPath}.tmp.${process.pid}.${tmpCounter++}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  // Best effort: tighten permissions since this file holds the API key. Do it
  // on the temp file so the tightened mode is what lands at the target.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* non-POSIX filesystems may not support chmod */
  }
  try {
    renameSync(tmp, activeConfigPath);
  } catch (err) {
    // Clean up the temp file so a failed rename doesn't leak turds next to the
    // config; re-throw so the caller still learns the write failed.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
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

/** Persist the inbound-message resume cursor (ISO timestamp). */
export function setMessagesCursor(cursor: string): void {
  savePersisted({ messagesCursor: cursor });
}

/** Persist the de-dup log of already-delivered message ids (capped list). */
export function setSeenMessageIds(ids: string[]): void {
  savePersisted({ seenMessageIds: ids });
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
  // Validate at the chokepoint: env > file > default, but fall back to the
  // default if the chosen value isn't an absolute http(s) URL. This prevents a
  // malformed value (e.g. a command accidentally pasted into the URL field)
  // from ever reaching fetch() and throwing "Failed to parse URL".
  const candidateUrl = process.env.CHAOS_RELAY_URL ?? persisted.relayUrl ?? DEFAULT_RELAY_URL;
  let relayUrl = candidateUrl;
  if (!isValidRelayUrl(candidateUrl)) {
    // Helpful stderr warning — visible in logs without blocking startup.
    const where = process.env.CHAOS_RELAY_URL === candidateUrl
      ? "CHAOS_RELAY_URL env var"
      : persisted.relayUrl === candidateUrl
        ? "relayUrl in ~/.pi/chaos-relay.json"
        : "default";
    console.warn(
      `pi-chaos-relay: ignoring invalid relay URL "${candidateUrl}" (from ${where}); ` +
        `falling back to ${DEFAULT_RELAY_URL}. Run /chaos-relay setup to fix.`,
    );
    relayUrl = DEFAULT_RELAY_URL;
  }
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
    messagesCursor: persisted.messagesCursor,
    // The keypair is the client's identity and is intentionally NOT
    // overridable via env — it lives only in the 0600 config file.
    keyPair: persisted.keyPair,
    serverPublicKey: persisted.serverPublicKey,
  };
}

export function isConfigured(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.apiKey);
}
