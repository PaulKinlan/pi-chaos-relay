/**
 * Configuration + credential storage for the pi-chaos-relay extension.
 *
 * Precedence for every value: environment variable > persisted config file >
 * built-in default. Secrets (the relay API key) live only in env or the
 * persisted file under ~/.pi — never in the repo. The config file is created
 * with 0600 permissions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
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

// Pointer file remembering the last profile switched to from inside pi, so a
// plain (no-env) restart resumes it instead of snapping back to default. Holds
// just a profile name — not a secret. Env vars still win over it.
const ACTIVE_PROFILE_POINTER = join(CONFIG_DIR, "chaos-relay-active");

function readActiveProfilePointer(): string | undefined {
  try {
    const name = readFileSync(ACTIVE_PROFILE_POINTER, "utf-8").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist which profile is active so a plain restart resumes it. Pass "default"
 * to pin the base profile. Best-effort (a failure just means it won't stick).
 */
export function setPersistedActiveProfile(name: string): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(ACTIVE_PROFILE_POINTER, name + "\n");
  } catch {
    /* best effort */
  }
}

/**
 * Choose the startup config path. Precedence: explicit env (CHAOS_RELAY_CONFIG /
 * CHAOS_RELAY_PROFILE) > the persisted in-pi switch pointer > default. Pure +
 * exported so it can be unit-tested without the filesystem.
 */
export function pickConfigPath(
  env: Record<string, string | undefined>,
  pointer: string | undefined,
  dir: string = CONFIG_DIR,
): string {
  const envExplicit = env.CHAOS_RELAY_CONFIG?.trim() ||
    (env.CHAOS_RELAY_PROFILE ?? "").trim();
  if (envExplicit) return configPathFor(env, dir);
  if (pointer && pointer.trim()) {
    return configPathFor({ CHAOS_RELAY_PROFILE: pointer.trim() }, dir);
  }
  return configPathFor(env, dir); // default chaos-relay.json
}

// The config file the extension is currently reading/writing. Initialised at
// load (env > persisted switch pointer > default), but mutable at runtime so a
// profile can be switched from inside pi without relaunching (see
// setActiveConfigPath / switchProfile).
let activeConfigPath = pickConfigPath(
  // process.env is available in the pi runtime (already used below for overrides).
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {},
  readActiveProfilePointer(),
);

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
  try {
    return JSON.parse(readFileSync(activeConfigPath, "utf-8")) as PersistedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${activeConfigPath}: ${message}`);
  }
}

export function savePersisted(updates: Partial<PersistedConfig>): PersistedConfig {
  const current = existsSync(activeConfigPath) ? loadPersisted() : {};
  const merged: PersistedConfig = { ...current, ...updates };
  // Ensure the config file's own directory exists (it may be outside ~/.pi when
  // CHAOS_RELAY_CONFIG points elsewhere).
  const dir = dirname(activeConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(activeConfigPath, JSON.stringify(merged, null, 2) + "\n");
  // Best effort: tighten permissions since this file holds the API key.
  try {
    chmodSync(activeConfigPath, 0o600);
  } catch {
    /* non-POSIX filesystems may not support chmod */
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
