/**
 * Configuration + credential storage for the pi-chaos-relay extension.
 *
 * Precedence for every value: environment variable > persisted config file >
 * built-in default. Secrets (the relay API key) live only in env or the
 * persisted file under ~/.pi — never in the repo. The config file is created
 * with 0600 permissions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { KeyPairJwk } from "./crypto.ts";

export const DEFAULT_RELAY_URL = "https://chaos-relay.com";
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const MIN_POLL_INTERVAL_MS = 3_000;

export const CONFIG_DIR = join(homedir(), ".pi");
export const CONFIG_PATH = join(CONFIG_DIR, "chaos-relay.json");

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
  type: "telegram" | "email";
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
}

export interface ResolvedConfig {
  relayUrl: string;
  apiKey?: string;
  userId?: string;
  agentId: string;
  pollIntervalMs: number;
  channels: RegisteredChannelRecord[];
  /** ECDSA keypair for request signing. File-only (never from env). */
  keyPair?: KeyPairJwk;
  /** Pinned server public key (TOFU). File-only. */
  serverPublicKey?: JsonWebKey;
}

export function loadPersisted(): PersistedConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as PersistedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }
}

export function savePersisted(updates: Partial<PersistedConfig>): PersistedConfig {
  const current = existsSync(CONFIG_PATH) ? loadPersisted() : {};
  const merged: PersistedConfig = { ...current, ...updates };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
  // Best effort: tighten permissions since this file holds the API key.
  try {
    chmodSync(CONFIG_PATH, 0o600);
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
 */
export function resolveConfig(persisted = loadPersisted()): ResolvedConfig {
  const relayUrl = process.env.CHAOS_RELAY_URL ?? persisted.relayUrl ?? DEFAULT_RELAY_URL;
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
    // The keypair is the client's identity and is intentionally NOT
    // overridable via env — it lives only in the 0600 config file.
    keyPair: persisted.keyPair,
    serverPublicKey: persisted.serverPublicKey,
  };
}

export function isConfigured(cfg: ResolvedConfig): boolean {
  return Boolean(cfg.apiKey);
}
