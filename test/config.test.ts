import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, copyFileSync } from "node:fs";
import {
  DEFAULT_RELAY_URL,
  MIN_POLL_INTERVAL_MS,
  CONFIG_PATH,
  isConfigured,
  isValidRelayUrl,
  normalizeApprovalMode,
  resetPersisted,
  resolveConfig,
  savePersisted,
} from "../config.ts";

/** Snapshot and restore the env vars these tests touch. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = Object.keys(vars);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("resolveConfig falls back to defaults with empty persisted + no env", () => {
  withEnv(
    {
      CHAOS_RELAY_URL: undefined,
      CHAOS_RELAY_API_KEY: undefined,
      CHAOS_RELAY_AGENT_ID: undefined,
      CHAOS_RELAY_POLL_MS: undefined,
    },
    () => {
      const cfg = resolveConfig({});
      assert.equal(cfg.relayUrl, DEFAULT_RELAY_URL);
      assert.equal(cfg.agentId, "pi");
      assert.equal(cfg.apiKey, undefined);
      assert.equal(isConfigured(cfg), false);
    },
  );
});

test("approvalMode defaults off, persists, and respects env override", () => {
  withEnv({ CHAOS_RELAY_APPROVAL_MODE: undefined }, () => {
    assert.equal(resolveConfig({}).approvalMode, "off");
    assert.equal(resolveConfig({ approvalMode: "writes" }).approvalMode, "writes");
    // Invalid persisted value falls back to off.
    assert.equal(
      resolveConfig({ approvalMode: "bogus" as never }).approvalMode,
      "off",
    );
  });
  withEnv({ CHAOS_RELAY_APPROVAL_MODE: "all" }, () => {
    // Env wins over persisted.
    assert.equal(resolveConfig({ approvalMode: "off" }).approvalMode, "all");
  });
});

test("normalizeApprovalMode coerces invalid values to off", () => {
  assert.equal(normalizeApprovalMode("all"), "all");
  assert.equal(normalizeApprovalMode("writes"), "writes");
  assert.equal(normalizeApprovalMode("off"), "off");
  assert.equal(normalizeApprovalMode("nonsense"), "off");
  assert.equal(normalizeApprovalMode(undefined), "off");
});

test("env vars override persisted config", () => {
  withEnv(
    {
      CHAOS_RELAY_URL: "http://localhost:8787",
      CHAOS_RELAY_API_KEY: "env-key",
      CHAOS_RELAY_AGENT_ID: "agent-x",
      CHAOS_RELAY_POLL_MS: undefined,
    },
    () => {
      const cfg = resolveConfig({
        relayUrl: "http://persisted",
        apiKey: "persisted-key",
        agentId: "persisted-agent",
      });
      assert.equal(cfg.relayUrl, "http://localhost:8787");
      assert.equal(cfg.apiKey, "env-key");
      assert.equal(cfg.agentId, "agent-x");
      assert.equal(isConfigured(cfg), true);
    },
  );
});

test("poll interval is clamped to the minimum", () => {
  withEnv({ CHAOS_RELAY_POLL_MS: "100" }, () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.pollIntervalMs, MIN_POLL_INTERVAL_MS);
  });
});

test("persisted poll interval is used when no env override", () => {
  withEnv({ CHAOS_RELAY_POLL_MS: undefined }, () => {
    const cfg = resolveConfig({ pollIntervalMs: 30000 });
    assert.equal(cfg.pollIntervalMs, 30000);
  });
});

test("isValidRelayUrl accepts absolute http(s) URLs", () => {
  assert.equal(isValidRelayUrl("https://chaos-relay.com"), true);
  assert.equal(isValidRelayUrl("https://chaos-relay.com/"), true);
  assert.equal(isValidRelayUrl("http://localhost:8787"), true);
  assert.equal(isValidRelayUrl("https://relay.example.com/path"), true);
});

test("isValidRelayUrl rejects non-absolute / non-http values", () => {
  // The exact malformed values that caused the onboarding crash.
  assert.equal(isValidRelayUrl("/chaos-relay approvals writes"), false);
  assert.equal(isValidRelayUrl("chaos-relay approvals writes/auth/register"), false);
  assert.equal(isValidRelayUrl(""), false);
  // Bare hostnames (no scheme), relative paths, wrong schemes.
  assert.equal(isValidRelayUrl("chaos-relay.com"), false);
  assert.equal(isValidRelayUrl("localhost:8787"), false);
  assert.equal(isValidRelayUrl("ftp://chaos-relay.com"), false);
  assert.equal(isValidRelayUrl("file:///etc/passwd"), false);
  // Non-strings.
  assert.equal(isValidRelayUrl(undefined), false);
  assert.equal(isValidRelayUrl(42 as never), false);
  assert.equal(isValidRelayUrl(null as never), false);
});

test("resolveConfig falls back to default when persisted relayUrl is invalid", () => {
  withEnv(
    { CHAOS_RELAY_URL: undefined, CHAOS_RELAY_API_KEY: undefined },
    () => {
      // A command accidentally pasted into the URL field should not poison
      // every subsequent request — fall back to the default instead.
      const cfg = resolveConfig({
        relayUrl: "/chaos-relay approvals writes",
        apiKey: "k",
      });
      assert.equal(cfg.relayUrl, DEFAULT_RELAY_URL);
      assert.equal(isConfigured(cfg), true);
    },
  );
});

test("resolveConfig falls back to default when env CHAOS_RELAY_URL is invalid", () => {
  withEnv(
    { CHAOS_RELAY_URL: "not a url", CHAOS_RELAY_API_KEY: undefined },
    () => {
      const cfg = resolveConfig({ relayUrl: "https://persisted.example.com" });
      // Env wins when valid, but an INVALID env must not win — fall back.
      assert.equal(cfg.relayUrl, DEFAULT_RELAY_URL);
    },
  );
});

test("resolveConfig keeps a valid persisted relayUrl when env is unset", () => {
  withEnv({ CHAOS_RELAY_URL: undefined }, () => {
    const cfg = resolveConfig({ relayUrl: "https://my-relay.example.com" });
    assert.equal(cfg.relayUrl, "https://my-relay.example.com");
  });
});

/**
 * Back up the user's real config file to a temp path, run `fn`, then restore it
 * (or remove it if it didn't exist before). Lets us test the file-writing
 * helpers (savePersisted/resetPersisted) without polluting ~/.pi/chaos-relay.json.
 */
function withConfigIsolated(fn: () => void): void {
  const backup = `${CONFIG_PATH}.bak-${process.pid}-${Date.now()}`;
  const existed = existsSync(CONFIG_PATH);
  if (existed) copyFileSync(CONFIG_PATH, backup);
  if (existed) unlinkSync(CONFIG_PATH);
  try {
    fn();
  } finally {
    // Restore exactly what was there before (or leave it absent).
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existed) copyFileSync(backup, CONFIG_PATH);
    if (existsSync(backup)) unlinkSync(backup);
  }
}

test("resetPersisted('url') clears only relayUrl, keeps credentials + channels", () => {
  withConfigIsolated(() => {
    // Seed a config with a corrupted URL plus valid creds and a channel.
    savePersisted({
      relayUrl: "/chaos-relay approvals writes",
      apiKey: "secret-key",
      userId: "u-1",
      channels: [{ channelId: "ch-1", type: "telegram", createdAt: "2026-01-01" }],
    });
    resetPersisted("url");
    const after = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    assert.equal(after.relayUrl, undefined);
    // Credentials and channels survive.
    assert.equal(after.apiKey, "secret-key");
    assert.equal(after.userId, "u-1");
    assert.equal(after.channels.length, 1);
  });
});

test("resetPersisted('all') removes the config file entirely", () => {
  withConfigIsolated(() => {
    savePersisted({ relayUrl: "https://x.example.com", apiKey: "k" });
    assert.equal(existsSync(CONFIG_PATH), true);
    resetPersisted("all");
    assert.equal(existsSync(CONFIG_PATH), false);
  });
});
