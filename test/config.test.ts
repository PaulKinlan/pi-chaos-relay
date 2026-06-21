import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RELAY_URL,
  MIN_POLL_INTERVAL_MS,
  isConfigured,
  resolveConfig,
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
