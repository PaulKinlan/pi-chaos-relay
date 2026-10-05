import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, copyFileSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  readPersisted,
  setActiveConfigPath,
  normalizeApprovalMode,
  resetPersisted,
  resolveConfig,
  resolveProfileLockCollision,
  savePersisted,
  loadMessageState,
  saveMessageState,
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

test("resolveProfileLockCollision: no lock → connect on the chosen profile", () => {
  // Negative control: an ordinary startup resolves to the session's persisted
  // profile, and the unlocked path hands exactly that name back — the extension
  // connects as it, and mints no new identity.
  const persisted = chooseProfile({ reason: "resume", recordedProfile: "work" });
  const outcome = resolveProfileLockCollision({
    profile: persisted,
    locked: false,
    pid: null,
    lockPath: "/cfg/chaos-relay.work.lock",
  });
  assert.deepEqual(outcome, { action: "connect", profile: "work" });
});

test("resolveProfileLockCollision: a held lock refuses on the same profile (no new identity)", () => {
  const outcome = resolveProfileLockCollision({
    profile: "default",
    locked: true,
    pid: 12345,
    lockPath: "/home/me/.pi/chaos-relay-default.lock",
  });
  assert.ok(outcome.action === "refuse", "a held lock must refuse, not connect");
  // The profile is never replaced by a freshly minted hostname-pid.
  assert.equal(outcome.profile, "default");
  assert.equal(outcome.pid, 12345);
  // Actionable: names the profile, the lock file, the holder, and both fixes.
  assert.match(outcome.message, /"default"/);
  assert.match(outcome.message, /\/home\/me\/\.pi\/chaos-relay-default\.lock/);
  assert.match(outcome.message, /PID 12345/);
  assert.match(outcome.message, /CHAOS_RELAY_PROFILE/);
  assert.match(outcome.message, /\/chaos-relay profile/);
});

test("resolveProfileLockCollision: unknown holder still refuses without inventing a PID", () => {
  const outcome = resolveProfileLockCollision({
    profile: "work",
    locked: true,
    pid: null,
    lockPath: "/cfg/chaos-relay.work.lock",
  });
  assert.ok(outcome.action === "refuse", "a held lock must refuse, not connect");
  assert.equal(outcome.profile, "work");
  assert.equal(outcome.pid, null);
  assert.match(outcome.message, /"work"/);
  assert.doesNotMatch(outcome.message, /PID (null|undefined|NaN)/);
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

/**
 * Run `fn` with the active config path pointed at a fresh temp file and with
 * `console.warn` captured. Each case gets its own path, which keeps the
 * module's once-per-reason warning dedupe from letting one case suppress
 * another — and keeps these tests off the user's real ~/.pi config.
 */
let tempConfigCounter = 0;
function withTempConfig(fn: (path: string, warnings: string[]) => void): void {
  const previous = getConfigPath();
  const path = join(tmpdir(), `chaos-relay-test-${process.pid}-${tempConfigCounter++}.json`);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  setActiveConfigPath(path);
  try {
    fn(path, warnings);
  } finally {
    console.warn = originalWarn;
    setActiveConfigPath(previous);
    if (existsSync(path)) unlinkSync(path);
    // Also clean the message-tracking side-car (and any temp residue) these
    // tests may have created next to the temp config.
    const statePath = `${path}.state`;
    for (const f of readdirSync(dirname(path))) {
      if (f === basename(statePath) || f.startsWith(`${basename(statePath)}.tmp.`)) {
        try { unlinkSync(join(dirname(path), f)); } catch { /* racing cleanup */ }
      }
    }
  }
}

/** Env vars resolveConfig reads, neutralised so a corrupt-file case is isolated. */
const NO_RELAY_ENV = {
  CHAOS_RELAY_URL: undefined,
  CHAOS_RELAY_API_KEY: undefined,
  CHAOS_RELAY_AGENT_ID: undefined,
  CHAOS_RELAY_POLL_MS: undefined,
  CHAOS_RELAY_APPROVAL_MODE: undefined,
};

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

test("readPersisted: an empty file recovers silently, with no warning", () => {
  withTempConfig((path, warnings) => {
    writeFileSync(path, "");
    withEnv(NO_RELAY_ENV, () => {
      const read = readPersisted();
      assert.deepEqual(read.config, {});
      assert.equal(read.corrupt, undefined);
      // Empty/whitespace is the documented truncation artifact: silent recovery.
      assert.deepEqual(warnings, []);
      assert.equal(resolveConfig().relayUrl, DEFAULT_RELAY_URL);
    });
  });
});

test("readPersisted: truncated JSON degrades to defaults with one warning", () => {
  withTempConfig((path, warnings) => {
    // A partial write / hand-edit that lost its tail.
    writeFileSync(path, '{ "relayUrl": "https://x.example.com", "apiKey": "sk-1');
    withEnv(NO_RELAY_ENV, () => {
      const read = readPersisted();
      assert.deepEqual(read.config, {});
      assert.match(read.corrupt!.reason, /Failed to parse/);
      assert.ok(read.corrupt!.reason.includes(path));
      // The warning names the path and the parse error.
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(path));
      assert.match(warnings[0], /Failed to parse/);
      // resolveConfig does not throw and returns the absent-file defaults.
      const cfg = resolveConfig();
      assert.equal(cfg.relayUrl, DEFAULT_RELAY_URL);
      assert.equal(cfg.agentId, "pi");
      assert.equal(cfg.apiKey, undefined);
      assert.deepEqual(cfg.channels, []);
      assert.equal(isConfigured(cfg), false);
      // loadPersisted runs on the message path — it must warn once, not per read.
      loadPersisted();
      loadPersisted();
      assert.equal(warnings.length, 1);
    });
  });
});

test("readPersisted: garbage non-JSON content degrades to defaults with one warning", () => {
  withTempConfig((path, warnings) => {
    writeFileSync(path, "this is not json at all\n");
    withEnv(NO_RELAY_ENV, () => {
      const read = readPersisted();
      assert.deepEqual(read.config, {});
      assert.match(read.corrupt!.reason, /Failed to parse/);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(path));
      assert.equal(resolveConfig().relayUrl, DEFAULT_RELAY_URL);
      // A corrupt file must not outrank env: precedence is still env > file.
      withEnv({ CHAOS_RELAY_URL: "https://env.example.com" }, () => {
        assert.equal(resolveConfig().relayUrl, "https://env.example.com");
      });
    });
  });
});

test("readPersisted: valid JSON that is not an object degrades to defaults", () => {
  // Each of these parses as JSON but has no config fields — `null` would throw
  // in resolveConfig (reading a property off null) if it were passed through.
  for (const content of ["null", "[]", "42", '"hello"']) {
    withTempConfig((path, warnings) => {
      writeFileSync(path, content);
      withEnv(NO_RELAY_ENV, () => {
        const read = readPersisted();
        assert.deepEqual(read.config, {});
        assert.match(read.corrupt!.reason, /expected a JSON object/);
        assert.equal(warnings.length, 1);
        const cfg = resolveConfig();
        assert.equal(cfg.relayUrl, DEFAULT_RELAY_URL);
        assert.equal(cfg.agentId, "pi");
      });
    });
  }
});

test("readPersisted: a read error that is not ENOENT degrades to defaults", () => {
  // existsSync is true but readFileSync fails (EISDIR) — this used to escape as
  // a raw fs error out of resolveConfig.
  withTempConfig((path, warnings) => {
    mkdirSync(path);
    withEnv(NO_RELAY_ENV, () => {
      const read = readPersisted();
      assert.deepEqual(read.config, {});
      assert.match(read.corrupt!.reason, /Failed to read/);
      assert.equal(warnings.length, 1);
      assert.equal(resolveConfig().relayUrl, DEFAULT_RELAY_URL);
    });
    rmdirSync(path);
  });
});

test("readPersisted: a missing file stays silent (no warning, no corruption flag)", () => {
  withTempConfig((path, warnings) => {
    assert.equal(existsSync(path), false);
    withEnv(NO_RELAY_ENV, () => {
      const read = readPersisted();
      assert.deepEqual(read.config, {});
      assert.equal(read.corrupt, undefined);
      assert.deepEqual(warnings, []);
      assert.equal(resolveConfig().relayUrl, DEFAULT_RELAY_URL);
    });
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
    // over the target; none of those temp files must linger. Normal-completion
    // scope only — a crash between temp-write and rename leaves an inert
    // orphan while the previous complete file survives (see atomicWriteSync).
    const dir = dirname(getConfigPath());
    const name = basename(getConfigPath());
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(`${name}.tmp.`));
    assert.deepEqual(leftovers, []);
    // A genuinely corrupt (non-empty, unparseable) file no longer throws: it
    // degrades to defaults and warns (see the readPersisted cases above).
    writeFileSync(getConfigPath(), "{ not json");
    assert.deepEqual(loadPersisted(), {});
  });
});

// ── Message-tracking side-car state (<config>.state) ────────────────────────

test("the side-car never shows up as a profile in listProfiles()", () => {
  // REAL behavioral pin (a path-string equality check would be vacuous, and
  // CONFIG_DIR is fixed at module load so an in-process HOME override can't
  // reach it): run listProfiles() in a CHILD node process whose HOME is a
  // fixture dir holding a profile config AND its .state side-car, and assert
  // it offers exactly the one profile.
  const home = join(tmpdir(), `chaos-relay-lp-${process.pid}-${tempConfigCounter++}`);
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "chaos-relay.json"), "{}");
  writeFileSync(join(home, ".pi", "chaos-relay.json.state"), '{"seenIds":[]}');
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { listProfiles } = await import(${JSON.stringify(
          new URL("../config.ts", import.meta.url).href,
        )});
         process.stdout.write(JSON.stringify(listProfiles()));`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          // Neutralise any inherited profile selection (this lane's own env
          // pins CHAOS_RELAY_PROFILE) so the child resolves the fixture's
          // default profile.
          CHAOS_RELAY_PROFILE: undefined,
          CHAOS_RELAY_CONFIG: undefined,
        },
        encoding: "utf-8",
      },
    );
    assert.equal(child.status, 0, `child stderr: ${child.stderr}`);
    assert.deepEqual(JSON.parse(child.stdout), [{ name: "default", active: true }]);
  } finally {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("saveMessageState writes the side-car atomically; loadMessageState round-trips", () => {
  withTempConfig((path) => {
    saveMessageState({ cursor: "2026-10-05T00:00:00Z", seenIds: ["a", "b"] });
    const statePath = `${path}.state`;
    const raw = readFileSync(statePath, "utf-8");
    // Same serialized shape + trailing newline as the config writer.
    assert.ok(raw.endsWith("\n"));
    const parsed = JSON.parse(raw);
    assert.equal(parsed.cursor, "2026-10-05T00:00:00Z");
    assert.deepEqual(parsed.seenIds, ["a", "b"]);
    // Restart continuity: a fresh load returns exactly what was persisted.
    assert.deepEqual(loadMessageState(), {
      cursor: "2026-10-05T00:00:00Z",
      seenIds: ["a", "b"],
    });
    // Atomic write, normal-completion scope: no `<config>.state.tmp.*`
    // residue after a completed flush. (This is NOT a crash guarantee: a
    // process death between the temp write and the rename leaves an inert
    // .tmp.* orphan while the previous complete file survives — see
    // atomicWriteSync's comment.)
    const dir = dirname(statePath);
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(`${basename(statePath)}.tmp.`));
    assert.deepEqual(leftovers, []);
    // The steady-state hot path never rewrites the profile config: the only
    // config write is the ONE-TIME tombstone pass (messageStateMigrated),
    // which carries no cursor/seen data — and later flushes leave the config
    // byte-identical.
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(cfg.messageStateMigrated, true);
    assert.equal("seenMessageIds" in cfg, false);
    const cfgRawAfterFirst = readFileSync(path, "utf-8");
    saveMessageState({ cursor: "2026-10-05T00:01:00Z", seenIds: ["a", "b", "c"] });
    assert.equal(readFileSync(path, "utf-8"), cfgRawAfterFirst); // untouched
  });
});

test("saveMessageState tolerates a cursor-less state (key omitted, not null)", () => {
  withTempConfig((path) => {
    saveMessageState({ seenIds: ["x"] });
    const parsed = JSON.parse(readFileSync(`${path}.state`, "utf-8"));
    assert.equal("cursor" in parsed, false);
    assert.deepEqual(loadMessageState(), { cursor: undefined, seenIds: ["x"] });
  });
});

test("legacy config fields are read as fallback and migrated out on first save", () => {
  withTempConfig((path, warnings) => {
    // A pre-0.17.5 profile: cursor + seen log still inside the config file.
    savePersisted({
      relayUrl: "https://relay.example.com",
      apiKey: "k",
      messagesCursor: "2026-01-01T00:00:00Z",
      seenMessageIds: ["old1", "old2"],
    });
    // No side-car yet → the legacy values keep working across the upgrade.
    assert.deepEqual(loadMessageState(), {
      cursor: "2026-01-01T00:00:00Z",
      seenIds: ["old1", "old2"],
    });
    // First flush: state lands in the side-car and the legacy fields are
    // stripped from the config (one time, off the steady-state hot path).
    saveMessageState({ cursor: "2026-01-02T00:00:00Z", seenIds: ["new1"] });
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal("seenMessageIds" in cfg, false);
    assert.equal("messagesCursor" in cfg, false);
    assert.equal(cfg.apiKey, "k"); // the rest of the config survives the strip
    assert.deepEqual(loadMessageState(), { cursor: "2026-01-02T00:00:00Z", seenIds: ["new1"] });
    assert.deepEqual(warnings, []); // a clean migration warns nothing
  });
});

test("a corrupt side-car degrades to the legacy values without throwing", () => {
  withTempConfig((path, warnings) => {
    savePersisted({ seenMessageIds: ["legacy"] });
    writeFileSync(`${path}.state`, "{ not json");
    // Corrupt side-car → warn once, fall back, keep pi alive.
    assert.deepEqual(loadMessageState(), { cursor: undefined, seenIds: ["legacy"] });
    assert.ok(warnings.some((w) => w.includes("Failed to parse")));
    // The next save self-heals the file.
    saveMessageState({ cursor: "c", seenIds: ["s"] });
    assert.deepEqual(loadMessageState(), { cursor: "c", seenIds: ["s"] });
  });
});

test("resetPersisted('all') wipes the side-car along with the config", () => {
  withTempConfig((path) => {
    savePersisted({ apiKey: "k" });
    saveMessageState({ cursor: "c", seenIds: ["a"] });
    assert.equal(existsSync(`${path}.state`), true);
    resetPersisted("all");
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.state`), false);
    // After a full reset the tracking state is empty, not the old identity's.
    assert.deepEqual(loadMessageState(), { cursor: undefined, seenIds: [] });
  });
});

test("an empty side-car file degrades silently to the legacy values", () => {
  // An empty/whitespace-only file is a truncation artifact (same policy as the
  // config reader): recover from the legacy fields with NO warning, and let
  // the next save rewrite the side-car.
  withTempConfig((path, warnings) => {
    savePersisted({ messagesCursor: "2026-01-01T00:00:00Z", seenMessageIds: ["legacy"] });
    writeFileSync(`${path}.state`, "   \n");
    assert.deepEqual(loadMessageState(), {
      cursor: "2026-01-01T00:00:00Z",
      seenIds: ["legacy"],
    });
    assert.deepEqual(warnings, []);
    saveMessageState({ cursor: "c", seenIds: ["s"] });
    assert.deepEqual(loadMessageState(), { cursor: "c", seenIds: ["s"] });
  });
});

test("resetPersisted('url') keeps the side-car tracking state", () => {
  withTempConfig((path) => {
    savePersisted({ relayUrl: "https://bad.example.com", apiKey: "k" });
    saveMessageState({ cursor: "c", seenIds: ["a"] });
    resetPersisted("url");
    // Only the relayUrl was cleared: config survives (minus the URL) and the
    // cursor + de-dup log stay exactly where they were.
    assert.deepEqual(loadPersisted().apiKey, "k");
    assert.equal(loadPersisted().relayUrl, undefined);
    assert.deepEqual(loadMessageState(), { cursor: "c", seenIds: ["a"] });
  });
});

test("reset all re-arms the one-time legacy migration for a restored config", () => {
  // Reviewer finding: after `reset all`, a legacy config hand-restored to the
  // same path in the SAME session must still get its legacy fields migrated to
  // the side-car on the next flush (the migrated-once flag must not survive
  // the reset).
  withTempConfig((path) => {
    savePersisted({ apiKey: "k" });
    saveMessageState({ cursor: "first", seenIds: ["a"] }); // arms stateMigrated
    resetPersisted("all");
    // Simulate restoring a pre-0.17.5 backup over the fresh start.
    writeFileSync(
      path,
      JSON.stringify({ apiKey: "k2", messagesCursor: "old-cursor", seenMessageIds: ["old"] }, null, 2) + "\n",
    );
    saveMessageState({ cursor: "new", seenIds: ["n"] });
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal("seenMessageIds" in cfg, false); // legacy fields stripped again
    assert.equal("messagesCursor" in cfg, false);
    assert.equal(cfg.apiKey, "k2");
  });
});

test("a missing side-car after migration warns LOUDLY; a genuine first run stays silent", () => {
  // Reviewer finding: saveMessageState strips the legacy in-config fields, so
  // if the side-car is later lost (e.g. a backup that skipped it), the legacy
  // fallback silently resets de-dup. The messageStateMigrated tombstone makes
  // that loss loud, while a profile that never tracked messages stays quiet.
  withTempConfig((path, warnings) => {
    // Migrate a legacy profile: strip + tombstone.
    savePersisted({ apiKey: "k", seenMessageIds: ["a"], messagesCursor: "c" });
    saveMessageState({ cursor: "c", seenIds: ["a"] });
    assert.equal(warnings.length, 0);
    // Lose the side-car (backup restored the config without it).
    unlinkSync(`${path}.state`);
    assert.deepEqual(loadMessageState(), { cursor: undefined, seenIds: [] });
    assert.ok(
      warnings.some((w) => w.includes("missing") && w.includes("migrated") && w.includes("backup")),
      `expected the loud lost-side-car warning, got: ${JSON.stringify(warnings)}`,
    );
  });
  withTempConfig((_path, warnings) => {
    // Genuine first run: no side-car, no legacy fields, no tombstone.
    savePersisted({ apiKey: "k" });
    assert.deepEqual(loadMessageState(), { cursor: undefined, seenIds: [] });
    assert.deepEqual(warnings, []);
  });
});

test("an old profile migrated before the tombstone gets one on its next flush", () => {
  // Rollout gap: 0.17.5/0.17.6 stripped the legacy fields without writing a
  // tombstone. The one-time pass must add it so those profiles' side-car loss
  // is also loud — at the cost of a single config write, not a hot-path write.
  withTempConfig((path) => {
    writeFileSync(path, JSON.stringify({ apiKey: "k" }, null, 2) + "\n");
    saveMessageState({ cursor: "c", seenIds: ["a"] });
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(cfg.messageStateMigrated, true);
    assert.equal(cfg.apiKey, "k");
  });
});
