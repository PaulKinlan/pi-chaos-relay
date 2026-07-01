import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  DEFAULT_RELAY_URL,
  MIN_POLL_INTERVAL_MS,
  getConfigPath,
  configPathFor,
  envProfileName,
  applySessionProfile,
  chooseProfile,
  isConfigured,
  isValidRelayUrl,
  loadPersisted,
  normalizeApprovalMode,
  resetPersisted,
  resolveConfig,
  savePersisted,
} from "../config.ts";

test("configPathFor: default profile uses chaos-relay.json", () => {
  assert.equal(configPathFor({}, "/cfg"), "/cfg/chaos-relay.json");
  assert.equal(
    configPathFor({ CHAOS_RELAY_PROFILE: "default" }, "/cfg"),
    "/cfg/chaos-relay.json",
  );
});

test("configPathFor: named profile gets its own file", () => {
  assert.equal(
    configPathFor({ CHAOS_RELAY_PROFILE: "work" }, "/cfg"),
    "/cfg/chaos-relay.work.json",
  );
  // Two distinct profiles → two distinct files (separate identities).
  assert.notEqual(
    configPathFor({ CHAOS_RELAY_PROFILE: "a" }, "/cfg"),
    configPathFor({ CHAOS_RELAY_PROFILE: "b" }, "/cfg"),
  );
});

test("configPathFor: profile names are slugified safely", () => {
  assert.equal(
    configPathFor({ CHAOS_RELAY_PROFILE: "My Work Box!" }, "/cfg"),
    "/cfg/chaos-relay.my-work-box.json",
  );
});

test("configPathFor: explicit CHAOS_RELAY_CONFIG wins over profile", () => {
  assert.equal(
    configPathFor(
      { CHAOS_RELAY_CONFIG: "/abs/custom.json", CHAOS_RELAY_PROFILE: "work" },
      "/cfg",
    ),
    "/abs/custom.json",
  );
});

test("envProfileName: undefined when no relevant env is set", () => {
  assert.equal(envProfileName({}), undefined);
  assert.equal(envProfileName({ SOMETHING_ELSE: "x" }), undefined);
});

test("envProfileName: derives the name from env profile / config", () => {
  assert.equal(envProfileName({ CHAOS_RELAY_PROFILE: "work" }), "work");
  assert.equal(envProfileName({ CHAOS_RELAY_PROFILE: "default" }), "default");
  assert.equal(
    envProfileName({ CHAOS_RELAY_CONFIG: "/abs/chaos-relay.staging.json" }),
    "staging",
  );
});

test("applySessionProfile: records and updates a session's profile", () => {
  let map: Record<string, string> = {};
  map = applySessionProfile(map, "sess-A", "work");
  map = applySessionProfile(map, "sess-B", "home");
  assert.deepEqual(map, { "sess-A": "work", "sess-B": "home" });
  // Re-recording updates the value and moves it to most-recent.
  map = applySessionProfile(map, "sess-A", "staging");
  assert.equal(map["sess-A"], "staging");
  assert.deepEqual(Object.keys(map), ["sess-B", "sess-A"]);
});

test("applySessionProfile: trims oldest beyond the cap (LRU by write)", () => {
  let map: Record<string, string> = {};
  for (let i = 0; i < 5; i++) map = applySessionProfile(map, `s${i}`, "p", 3);
  // Only the 3 most recently written survive.
  assert.deepEqual(Object.keys(map), ["s2", "s3", "s4"]);
});

// One row of the launch/use matrix per assertion.
test("chooseProfile: env pins and wins over everything", () => {
  assert.equal(
    chooseProfile({
      reason: "resume",
      envProfile: "work",
      recordedProfile: "home",
      inheritedProfile: "staging",
    }),
    "work",
  );
});

test("chooseProfile: resume uses the session's recorded profile", () => {
  assert.equal(
    chooseProfile({ reason: "resume", recordedProfile: "home", inheritedProfile: "x" }),
    "home",
  );
});

test("chooseProfile: reload uses the recorded profile (same session)", () => {
  assert.equal(chooseProfile({ reason: "reload", recordedProfile: "home" }), "home");
});

test("chooseProfile: new/fork inherit when nothing recorded", () => {
  assert.equal(chooseProfile({ reason: "new", inheritedProfile: "work" }), "work");
  assert.equal(chooseProfile({ reason: "fork", inheritedProfile: "work" }), "work");
});

test("chooseProfile: cold startup with nothing → default", () => {
  assert.equal(chooseProfile({ reason: "startup" }), "default");
  // A plain new session with no inherit/record → default too.
  assert.equal(chooseProfile({ reason: "new" }), "default");
});

test("chooseProfile: recorded beats inherit on new/fork", () => {
  assert.equal(
    chooseProfile({ reason: "fork", recordedProfile: "home", inheritedProfile: "work" }),
    "home",
  );
});

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
  const backup = `${getConfigPath()}.bak-${process.pid}-${Date.now()}`;
  const existed = existsSync(getConfigPath());
  if (existed) copyFileSync(getConfigPath(), backup);
  if (existed) unlinkSync(getConfigPath());
  try {
    fn();
  } finally {
    // Restore exactly what was there before (or leave it absent).
    if (existsSync(getConfigPath())) unlinkSync(getConfigPath());
    if (existed) copyFileSync(backup, getConfigPath());
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
    const after = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
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
    assert.equal(existsSync(getConfigPath()), true);
    resetPersisted("all");
    assert.equal(existsSync(getConfigPath()), false);
  });
});

test("loadPersisted tolerates an empty/truncated config file (no crash)", () => {
  withConfigIsolated(() => {
    // Reproduces the crash: a reader that caught a truncate-then-write mid-flight
    // (or a legacy interrupted write) sees an empty file. This used to throw
    // "Unexpected end of JSON input" on the WebSocket message path and kill pi.
    writeFileSync(getConfigPath(), "");
    assert.deepEqual(loadPersisted(), {});
    writeFileSync(getConfigPath(), "   \n  ");
    assert.deepEqual(loadPersisted(), {});
  });
});

test("savePersisted onto a truncated file still lands the update", () => {
  withConfigIsolated(() => {
    writeFileSync(getConfigPath(), "");
    savePersisted({ relayUrl: "https://x.example.com", apiKey: "k" });
    const after = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    assert.equal(after.relayUrl, "https://x.example.com");
    assert.equal(after.apiKey, "k");
  });
});

test("savePersisted writes atomically and leaves no temp files behind", () => {
  withConfigIsolated(() => {
    savePersisted({ relayUrl: "https://x.example.com", apiKey: "k" });
    // The atomic write goes through a `<config>.tmp.*` file then renames it
    // over the target; none of those temp files must linger.
    const dir = dirname(getConfigPath());
    const name = basename(getConfigPath());
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(`${name}.tmp.`));
    assert.deepEqual(leftovers, []);
    // A genuinely corrupt (non-empty, unparseable) file still surfaces loudly —
    // we only recover from the unambiguous empty case.
    writeFileSync(getConfigPath(), "{ not json");
    assert.throws(() => loadPersisted(), /Failed to parse/);
  });
});
