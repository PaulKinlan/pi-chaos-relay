/**
 * Integration coverage for the extension entry point (index.ts) — profile binding and the profile lock: session_start refusal/claim, the lock protocol edge cases, the session map, and switchProfile.
 *
 * Partitioned from the monolithic test/index.test.ts (bead pi-chaos-relay-h1t,
 * ADR pi-chaos-relay-mpf): every index-* suite is behavior-owned, runs in its
 * own node --test child process, and redirects into its own throwaway HOME/XDG
 * sandbox via createSandbox() BEFORE the dynamic imports below, because
 * config.ts resolves CONFIG_DIR from homedir() at import. Changing THIS file
 * selects only this suite in the implementer fast gate; the shared harness and
 * index.ts itself stay full-tier triggers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createSandbox,
  OFFLINE_RELAY_URL,
  makeFakePi,
  makeCtx,
  callHandler,
  isAlive,
  PushWebSocket,
  socketCarries,
  socketForProfile,
  waitFor,
  startOtherLiveSession,
  createStateHelpers,
} from "./integration-harness.ts";

const { PI_DIR } = createSandbox();

const config = await import("../config.ts");
const { default: chaosRelayExtension, claimProfileLock, log } =
  await import("../index.ts");

type ExtensionApi = Parameters<typeof chaosRelayExtension>[0];

const { SESSIONS_PATH, lockPath, readSessionMap, relayStateFiles, resetState, writeProfileConfig } = createStateHelpers(config, PI_DIR);

test("session_start refuses a held profile lock: no connect, no lock write, warning raised, prior binding kept", async (t) => {
  resetState();
  // Both profiles are already provisioned: if the refusal ever stops returning,
  // the fall-through connect stays on the refused loopback URL instead of
  // registering a session against the real relay.
  const defaultFile = writeProfileConfig("default", "ak_default_offline");
  const workFile = writeProfileConfig("work", "ak_work_offline");
  const defaultConfigBefore = readFileSync(defaultFile, "utf-8");
  // Pin the chosen profile so the refusal is a no-op for the *previous* binding:
  // the process starts on the default config and must stay there.
  process.env.CHAOS_RELAY_PROFILE = "work";
  const otherPid = startOtherLiveSession(t);
  const lock = lockPath("work");
  writeFileSync(lock, String(otherPid));
  // The refusing session stays on the default profile, so shutdown releases the
  // *default* lock: hold that one too, so "never unlock someone else" is
  // actually exercised rather than trivially true for an absent file.
  const previousLock = lockPath("default");
  writeFileSync(previousLock, String(otherPid));
  const boundBefore = config.getConfigPath();
  assert.equal(boundBefore, defaultFile);
  assert.equal(config.activeProfileName(), "default", "bound to the default profile before the refusal");
  const filesBefore = relayStateFiles();

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const sid = "sess-refuse-held-lock";
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx(sid, fake.notifications),
  );

  // The user is told, by name, why the session refused.
  assert.equal(fake.notifications.length, 1, "exactly one notification");
  const [note] = fake.notifications;
  assert.equal(note.level, "warning");
  assert.match(note.message, /Relay profile "work" is already held/);
  assert.ok(
    note.message.includes(lock),
    `warning names the lock file (${lock}): ${note.message}`,
  );

  // (a) no connect attempt: the process was not re-pointed at the chosen profile.
  assert.equal(config.getConfigPath(), boundBefore, "stays on the previous config");
  assert.notEqual(
    config.getConfigPath(),
    workFile,
    "did not switch identity to the locked profile",
  );
  assert.equal(
    readFileSync(defaultFile, "utf-8"),
    defaultConfigBefore,
    "the previous profile's config was not rewritten",
  );

  // (b) no lock file written: the holder's pid is untouched.
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid), "holder's lock intact");

  // (c) no new binding/identity was created for this session.
  assert.equal(readSessionMap()[sid], undefined, "session was not bound to a profile");
  assert.deepEqual(relayStateFiles(), filesBefore, "no new config/identity files");

  // Shutdown must not release a lock this process never owned — neither the
  // chosen profile's (it never connected) nor the previous profile's.
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx(sid, fake.notifications));
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(otherPid),
    "refusing session leaves the held profile's lock alone on shutdown",
  );
  assert.equal(
    readFileSync(previousLock, "utf-8"),
    String(otherPid),
    "refusing session does not release the previous profile's lock either",
  );
});

test("session_start connects as the session's recorded profile when its lock is free (negative control)", async () => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  const profileFile = writeProfileConfig("work", "ak_negative_control");
  const sid = "sess-connect-free-lock";
  writeFileSync(SESSIONS_PATH, JSON.stringify({ [sid]: "work" }) + "\n");
  const boundBefore = config.getConfigPath();
  assert.equal(boundBefore, join(PI_DIR, "chaos-relay.json"), "starts on the default config");
  const lock = lockPath("work");
  assert.equal(existsSync(lock), false);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "resume" },
    makeCtx(sid, fake.notifications),
  );

  assert.equal(fake.notifications.length, 0, "no refusal warning when the lock is free");
  assert.equal(config.getConfigPath(), profileFile, "connected as the chosen profile");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "lock claimed by this process");
  assert.equal(readSessionMap()[sid], "work", "legacy name-only binding is preserved");

  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx(sid, fake.notifications));
  assert.equal(existsSync(lock), false, "own lock released on shutdown");
});

test("0tf: session_start binds an explicit CHAOS_RELAY_CONFIG path outside ~/.pi, and reads and writes land there", async () => {
  // pi-chaos-relay-0tf: session_start reduced the explicit path to the profile name
  // "staging" and connectAsProfile rebuilt it as ~/.pi/chaos-relay.staging.json. A
  // decoy of that name with a DIFFERENT apiKey shows which file the session used.
  resetState();
  writeProfileConfig("default", "ak_0tf_default");
  const decoyFile = writeProfileConfig("staging", "ak_0tf_decoy");
  const decoyState = `${decoyFile}.state`;
  rmSync(decoyState, { force: true });
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-chaos-relay-0tf-outside-"));
  const explicitFile = join(outsideDir, "chaos-relay.staging.json");
  writeFileSync(
    explicitFile,
    JSON.stringify({ relayUrl: OFFLINE_RELAY_URL, apiKey: "ak_0tf_explicit" }) + "\n",
  );
  process.env.CHAOS_RELAY_CONFIG = explicitFile;
  const origWs = globalThis.WebSocket;
  PushWebSocket.instances = [];
  globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
  const fake = makeFakePi();
  const sid = "sess-0tf-explicit";
  const ctx = makeCtx(sid, fake.notifications);
  let shutDown = false;
  try {
    chaosRelayExtension(fake.pi as unknown as ExtensionApi);
    await callHandler(fake.handlers, "session_start", { reason: "startup" }, ctx);

    assert.equal(config.getConfigPath(), explicitFile, "the session is bound to the explicit file");
    assert.equal(config.messageStatePath(), `${explicitFile}.state`);
    // READ: the live connection carries the explicit file's apiKey, never the decoy's.
    const socket = socketForProfile("ak_0tf_explicit");
    assert.equal(
      PushWebSocket.instances.some((s) => socketCarries(s, "ak_0tf_decoy")),
      false,
      "no connection was opened with the ~/.pi namesake's apiKey",
    );

    // WRITE: a delivered message's de-dup state lands beside the explicit file.
    socket.pushFrame(
      JSON.stringify({
        type: "message",
        message: {
          id: "m-0tf-1",
          channelType: "telegram",
          channelId: "chan-0tf",
          from: "alice",
          content: "which file?",
          timestamp: "2026-10-13T00:00:01.000Z",
        },
      }),
    );
    await waitFor(() => fake.sent.length > 0);
    shutDown = true;
    await callHandler(fake.handlers, "session_shutdown", {}, ctx);
    const state = JSON.parse(readFileSync(`${explicitFile}.state`, "utf-8")) as { seenIds: string[] };
    assert.ok(state.seenIds.includes("m-0tf-1"), `state written beside the explicit file: ${JSON.stringify(state)}`);
    assert.equal(existsSync(decoyState), false, "nothing was written to the ~/.pi namesake's side-car");
  } finally {
    if (!shutDown) await callHandler(fake.handlers, "session_shutdown", {}, ctx).catch(() => {});
    globalThis.WebSocket = origWs;
    delete process.env.CHAOS_RELAY_CONFIG;
    rmSync(decoyState, { force: true });
    rmSync(decoyFile, { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    resetState();
  }
});

test("session_start refusal leaves an unbound session unbound and mints no identity", async (t) => {
  resetState();
  const defaultFile = writeProfileConfig("default", "ak_default_offline");
  const defaultConfigBefore = readFileSync(defaultFile, "utf-8");
  const sid = "sess-unbound";
  const otherPid = startOtherLiveSession(t);
  const lock = lockPath("default");
  writeFileSync(lock, String(otherPid));
  const filesBefore = relayStateFiles();

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "startup" },
    makeCtx(sid, fake.notifications),
  );

  assert.equal(fake.notifications.length, 1);
  assert.match(fake.notifications[0].message, /Relay profile "default" is already held/);
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid), "holder's lock intact");
  assert.equal(
    readFileSync(defaultFile, "utf-8"),
    defaultConfigBefore,
    "no keypair/identity was minted into the config",
  );
  assert.deepEqual(relayStateFiles(), filesBefore, "no config/keypair minted for the refusal");
  assert.equal(existsSync(SESSIONS_PATH), false, "no new session→profile binding");
});

test("doctor reports the config-parses check as FAILED for a corrupt config file", async () => {
  resetState();
  const corruptPath = join(PI_DIR, "chaos-relay-broken.json");
  writeFileSync(corruptPath, '{ "relayUrl": "http://127.0.0.1:9", ');
  config.setActiveConfigPath(corruptPath);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const command = fake.commands.get("chaos-relay");
  assert.ok(command, "extension registers the /chaos-relay command");

  await command.handler("doctor", makeCtx("sess-doctor", fake.notifications));

  assert.equal(fake.notifications.length, 1);
  const note = fake.notifications[0];
  assert.equal(note.level, "warning");
  assert.ok(
    note.message.includes(`✗ config file parses — Failed to parse ${corruptPath}`),
    `doctor failed the corrupt-config check with the reason: ${note.message}`,
  );
  assert.match(note.message, /chaos-relay doctor: \d+ issue\(s\) found above\./);
});

test("removeProfileLock refuses a lock owned by another pid and unlinks its own", async (t) => {
  resetState();
  // currentProfile is bound from the active config path at extension load.
  config.setActiveConfigPath(config.profilePathForName("guard"));
  const lock = lockPath("guard");

  const otherPid = startOtherLiveSession(t);
  writeFileSync(lock, String(otherPid));
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-guard", fake.notifications));
  assert.equal(existsSync(lock), true, "another process's lock is left in place");
  assert.equal(readFileSync(lock, "utf-8"), String(otherPid));

  writeFileSync(lock, String(process.pid));
  await callHandler(fake.handlers, "session_shutdown", {}, makeCtx("sess-guard", fake.notifications));
  assert.equal(existsSync(lock), false, "this process's own lock is released");
});



// ── pi-chaos-relay-bxa: the profile lock is claimed atomically, pre-connect ──
//
// The old flow read the lock, awaited connectAsProfile() (which can register a
// live relay session), and only then wrote the lock with a plain writeFileSync.
// Two processes starting together could both observe "unlocked", both connect,
// and both write. The claim is now an exclusive create (flag "wx") made BEFORE
// any connect, so a race has exactly one winner and a live holder is never
// overwritten.

test("claimProfileLock refuses a live holder without touching its file", () => {
  resetState();
  const lock = lockPath("race-held");
  // A pid that is alive and is not us: this test process's own parent chain is
  // fine, but the simplest always-alive foreign pid is 1 (init).
  writeFileSync(lock, "1");
  const before = readFileSync(lock, "utf-8");

  const result = claimProfileLock("race-held");

  assert.equal(result.claimed, false, "must not claim a profile a live process holds");
  assert.equal(result.pid, 1, "reports the live holder's pid for the refusal message");
  assert.equal(readFileSync(lock, "utf-8"), before, "the holder's lock file is untouched");
  assert.equal(result.path, lock, "names the lock file");
});

test("claimProfileLock cleans a stale holder and claims the profile", () => {
  resetState();
  const lock = lockPath("race-stale");
  // A pid that no longer exists (spawned and reaped), so the lock is genuinely
  // stale rather than "unparseable by accident".
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, "2147483646"); // beyond any real pid: not alive
  assert.equal(isAlive(2147483646), false, "test premise: the recorded pid is dead");

  const result = claimProfileLock("race-stale");

  assert.equal(result.claimed, true, "a dead holder's lock is stale and reclaimable");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "the lock now names this process");
});

test("claimProfileLock: two processes racing the same profile — exactly one wins", async (t) => {
  resetState();
  const profile = "race-atomic";
  const lock = lockPath(profile);
  const extUrl = new URL("../index.ts", import.meta.url).href;
  const HOLD_MS = 4_000;
  // All children attempt at the same wall-clock instant so the exclusive
  // creates genuinely overlap. Crucially, the winner HOLDS the lock (sleeps)
  // while the losers attempt: a winner that exited instantly would leave a
  // genuinely stale lock, and then a second claim is CORRECT, not a race
  // failure. So the results are read while every child is still alive.
  const startAt = Date.now() + 700;
  const child = `
    const { claimProfileLock } = await import(${JSON.stringify(extUrl)});
    while (Date.now() < Number(process.env.START_AT)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = claimProfileLock(process.env.LOCK_PROFILE);
    // console.log appends the newline the parent's line reader needs.
    console.log(JSON.stringify({ pid: process.pid, claimed: result.claimed, holder: result.pid }));
    // Stay alive so the losers must see a LIVE holder (not a stale file).
    await new Promise((r) => setTimeout(r, ${HOLD_MS}));
  `;

  /** Resolve with the child's first stdout line (its claim result). */
  function startRacer(): { firstLine: Promise<string>; exited: Promise<void> } {
    const p = spawn(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, START_AT: String(startAt), LOCK_PROFILE: profile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let err = "";
    let resolveFirst!: (line: string) => void;
    const firstLine = new Promise<string>((resolve) => (resolveFirst = resolve));
    p.stdout.on("data", (c) => {
      buffer += String(c);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolveFirst(buffer.slice(0, nl));
    });
    p.stderr.on("data", (c) => (err += String(c)));
    const exited = new Promise<void>((resolve, reject) =>
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`racer exited ${code}: ${err}`)),
      ),
    );
    return { firstLine, exited };
  }

  const racers = [startRacer(), startRacer(), startRacer()];
  const results = (await Promise.all(racers.map((r) => r.firstLine))).map(
    (line) => JSON.parse(line) as { pid: number; claimed: boolean; holder: number | null },
  );
  const winners = results.filter((r) => r.claimed);
  assert.equal(
    winners.length,
    1,
    `exactly one process may claim the profile while the others are live: ${JSON.stringify(results)}`,
  );
  // Every loser saw the live winner (not a stale file it was entitled to clean).
  for (const loser of results.filter((r) => !r.claimed)) {
    assert.equal(loser.holder, winners[0].pid, "a loser must report the live holder's pid");
  }
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(winners[0].pid),
    "the lock names the single winner, not the last writer",
  );

  // While the winner is still alive, a further claim is refused and cannot
  // overwrite it.
  const after = claimProfileLock(profile);
  assert.equal(after.claimed, false, "a live holder is never reclaimed");
  assert.equal(after.pid, winners[0].pid, "refusal names the live winner");
  assert.equal(readFileSync(lock, "utf-8"), String(winners[0].pid), "still the winner's pid");

  await Promise.all(racers.map((r) => r.exited));
  t.diagnostic(`race result: ${JSON.stringify(results)}`);
});

test("loadSessionMap ignores an orphan temp file beside the session map (reader tolerance)", () => {
  resetState();
  config.setSessionProfile("sess-atomic", "work");
  assert.deepEqual(config.loadSessionMap(), { "sess-atomic": "work" });
  const previousRaw = readFileSync(SESSIONS_PATH, "utf-8");

  // Simulate a crash between the temp write and the rename: an orphan temp file
  // beside the target holds a partial NEXT map, but the target was never renamed,
  // so the previous complete map must still be what the reader sees — and the
  // orphan must be ignored (it is not the target path).
  const orphan = `${SESSIONS_PATH}.tmp.simulated`;
  writeFileSync(orphan, '{"sess-atomic":"home"');
  try {
    assert.deepEqual(config.loadSessionMap(), { "sess-atomic": "work" });
    assert.equal(readFileSync(SESSIONS_PATH, "utf-8"), previousRaw, "target map byte-identical");
  } finally {
    unlinkSync(orphan);
  }
});

test("loadSessionMap tolerates a corrupt session map without crashing", () => {
  resetState();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    writeFileSync(SESSIONS_PATH, "{ not json");
    assert.deepEqual(config.loadSessionMap(), {});
    writeFileSync(SESSIONS_PATH, "[]");
    assert.deepEqual(config.loadSessionMap(), {});
    // A non-string value is a corrupt entry: it is dropped rather than leaking
    // a non-string profile name into profile resolution (which would crash).
    writeFileSync(
      SESSIONS_PATH,
      JSON.stringify({ "sess-ok": "work", "sess-bad": 123 }) + "\n",
    );
    assert.deepEqual(config.loadSessionMap(), { "sess-ok": "work" });
  } finally {
    console.warn = originalWarn;
  }
});

test("relay_switch_profile refuses a new profile beyond the cap without writing a file", async () => {
  resetState();
  // Remove any profile configs left by earlier tests so the count is deterministic.
  for (const f of relayStateFiles()) {
    if (/^chaos-relay(?:\.(.+))?\.json$/.test(f)) {
      try {
        unlinkSync(join(PI_DIR, f));
      } catch {
        /* already gone */
      }
    }
  }
  const cap = config.MAX_PROFILE_CONFIGS;
  for (let i = 0; i < cap; i++) {
    writeProfileConfig(i === 0 ? "default" : `fill-${i}`, `ak_fill_${i}`);
  }
  assert.equal(config.countProfileConfigs(), cap);

  const overflowPath = config.profilePathForName("overflow");
  assert.equal(existsSync(overflowPath), false);

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const tool = fake.tools.find((t) => t.name === "relay_switch_profile");
  assert.ok(tool, "extension registers relay_switch_profile");
  const execute = tool.execute as (
    id: string,
    params: { name: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
  const result = await execute("t1", { name: "overflow" }, undefined, undefined, {
    ui: {
      notify: (message: string, level?: string) => fake.notifications.push({ message, level }),
    },
  });

  const text =
    (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? String(result);
  assert.match(
    text,
    /profile cap of 100 is already reached \(100 profile files on disk\)/,
  );
  assert.equal(existsSync(overflowPath), false, "no profile config file was written beyond the cap");
  assert.equal(config.countProfileConfigs(), cap, "profile count unchanged after the refusal");
  assert.ok(
    fake.notifications.some(
      (n) => n.level === "warning" && n.message.includes("profile cap of 100"),
    ),
    `refusal was surfaced as a warning notification (${JSON.stringify(fake.notifications)})`,
  );

  const outsideDir = mkdtempSync(join(tmpdir(), "rg6-cap-"));
  const explicit = join(outsideDir, "chaos-relay.outside.json");
  process.env.CHAOS_RELAY_CONFIG = explicit;
  const outside = makeFakePi();
  const ctx = makeCtx("rg6-cap-explicit", outside.notifications);
  try {
    chaosRelayExtension(outside.pi as unknown as ExtensionApi);
    await callHandler(outside.handlers, "session_start", { reason: "startup" }, ctx);
    assert.equal(config.getConfigPath(), explicit, "the full ~/.pi cap does not reject an outside file");
    assert.equal(outside.notifications.some((n) => n.message.includes("profile cap")), false);
    await callHandler(outside.handlers, "session_shutdown", {}, ctx);
  } finally {
    delete process.env.CHAOS_RELAY_CONFIG;
    rmSync(outsideDir, { recursive: true, force: true });
    resetState();
  }
});


// ── pi-chaos-relay-bw5: /chaos-relay profile claims the lock before connect ──

test("switchProfile claims the lock, refuses a live holder, and reclaims a stale one", async (t) => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  writeProfileConfig("beta", "ak_beta_offline");
  const lock = lockPath("beta");

  // (a) a live holder: refused, named, and its file untouched.
  const holderPid = startOtherLiveSession(t);
  writeFileSync(lock, String(holderPid));
  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  const cmd = fake.commands.get("chaos-relay")!;
  const ctx = makeCtx("sess-switch-a", fake.notifications);
  await cmd.handler("profile beta", ctx);

  const refusal = fake.notifications.map((n) => n.message).join("\n");
  assert.match(refusal, /Relay profile "beta" is already held/, `refusal: ${refusal}`);
  assert.ok(refusal.includes(String(holderPid)), "refusal names the live holder's pid");
  assert.equal(readFileSync(lock, "utf-8"), String(holderPid), "holder's lock untouched");
  assert.notEqual(
    config.getConfigPath(),
    config.profilePathForName("beta"),
    "a refused switch does not move the session onto the held profile",
  );

  // (b) a stale holder (dead pid): reclaimed and the switch proceeds.
  writeFileSync(lock, "2147483646");
  assert.equal(isAlive(2147483646), false, "test premise: the recorded pid is dead");
  const fake2 = makeFakePi();
  chaosRelayExtension(fake2.pi as unknown as ExtensionApi);
  await fake2.commands.get("chaos-relay")!.handler(
    "profile beta",
    makeCtx("sess-switch-b", fake2.notifications),
  );
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "stale lock reclaimed by us");
  assert.equal(
    config.getConfigPath(),
    config.profilePathForName("beta"),
    "the switch completed onto the reclaimed profile",
  );
  const switched = fake2.notifications.map((n) => n.message).join("\n");
  assert.match(switched, /Switched to profile "beta"/, `switch outcome: ${switched}`);
});

test("an empty lock file is only reclaimed after the create grace (a racer may be mid-create)", () => {
  resetState();
  const lock = lockPath("grace");
  // Fresh empty file: indistinguishable from another process's in-flight
  // exclusive create, so it must be treated as held, not stolen.
  writeFileSync(lock, "");
  const fresh = claimProfileLock("grace");
  assert.equal(fresh.claimed, false, "a just-created empty lock is treated as held");
  assert.equal(readFileSync(lock, "utf-8"), "", "and is not deleted");

  // Old empty file: a crashed leftover, so it is reclaimed.
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lock, old, old);
  const reclaimed = claimProfileLock("grace");
  assert.equal(reclaimed.claimed, true, "an old empty lock is a stale leftover");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid), "now names this process");
});

test("two concurrent switches to the same profile: exactly one connects, the other is refused", async (t) => {
  resetState();
  writeProfileConfig("default", "ak_default_offline");
  const target = writeProfileConfig("shared", "ak_shared_offline");
  const lock = lockPath("shared");
  const extUrl = new URL("../index.ts", import.meta.url).href;
  const HOLD_MS = 4_000;
  // Inter-process on purpose: the lock records a pid, so two sessions in ONE
  // process are indistinguishable to it. The threat the bead describes is two
  // pi processes switching to one profile, which is what this drives.
  const startAt = Date.now() + 900;
  const child = `
    const { default: chaosRelayExtension } = await import(${JSON.stringify(extUrl)});
    const commands = new Map();
    const notifications = [];
    const pi = {
      on() {},
      registerCommand(name, def) { commands.set(name, def); },
      registerTool() {},
      sendUserMessage() {},
    };
    chaosRelayExtension(pi);
    const ctx = {
      model: { input: ["text"] },
      sessionManager: { getSessionId: () => "child-" + process.pid },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    };
    while (Date.now() < Number(process.env.START_AT)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await commands.get("chaos-relay").handler("profile shared", ctx);
    console.log(JSON.stringify({
      pid: process.pid,
      notifications: notifications.map((n) => n.message),
    }));
    // Hold the lock (if won) so the loser must see a LIVE holder.
    await new Promise((r) => setTimeout(r, ${HOLD_MS}));
  `;

  function startSwitcher(): { firstLine: Promise<string>; exited: Promise<void> } {
    const p = spawn(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, START_AT: String(startAt) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let err = "";
    let resolveFirst!: (line: string) => void;
    const firstLine = new Promise<string>((resolve) => (resolveFirst = resolve));
    p.stdout.on("data", (c) => {
      buffer += String(c);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolveFirst(buffer.slice(0, nl));
    });
    p.stderr.on("data", (c) => (err += String(c)));
    const exited = new Promise<void>((resolve, reject) =>
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`switcher exited ${code}: ${err}`)),
      ),
    );
    return { firstLine, exited };
  }

  const switchers = [startSwitcher(), startSwitcher()];
  const results = (await Promise.all(switchers.map((s) => s.firstLine))).map(
    (line) => JSON.parse(line) as { pid: number; notifications: string[] },
  );
  const connected = results.filter((r) => r.notifications.some((m) => /Switched to profile "shared"/.test(m)));
  const refused = results.filter((r) => !connected.includes(r));
  assert.equal(
    connected.length,
    1,
    `exactly one concurrent switch may connect: ${JSON.stringify(results)}`,
  );
  assert.equal(refused.length, 1, "the other switch is refused");
  assert.ok(
    refused[0].notifications.some((m) => /already held/.test(m)),
    `the refused switch explains itself: ${JSON.stringify(refused[0].notifications)}`,
  );
  assert.ok(
    refused[0].notifications.some((m) => m.includes(String(connected[0].pid))),
    "the refusal names the winning process's pid",
  );
  assert.equal(
    readFileSync(lock, "utf-8"),
    String(connected[0].pid),
    "the lock names the process that actually connected",
  );
  assert.equal(readFileSync(target, "utf-8").length > 0, true, "target profile config exists");

  await Promise.all(switchers.map((s) => s.exited));
  t.diagnostic(`concurrent switch result: ${JSON.stringify(results)}`);
});


// ── pi-chaos-relay-hp2: the atomic-write test must DISCRIMINATE ──────────────
//
// The test above pins a reader property (an orphan temp file is ignored), which
// passed against the pre-atomic implementation too: nothing read that file
// either way, so it never proved the WRITE was atomic. This one does — a
// temp-file + rename replaces the directory entry, so the inode CHANGES, while
// an in-place writeFileSync keeps the same inode.

test("setSessionProfile replaces the session map via rename, not an in-place write", () => {
  resetState();
  config.setSessionProfile("sess-ino", "work");
  const firstRaw = readFileSync(SESSIONS_PATH, "utf-8");
  const inoBefore = statSync(SESSIONS_PATH).ino;

  config.setSessionProfile("sess-ino", "home");

  assert.notEqual(
    statSync(SESSIONS_PATH).ino,
    inoBefore,
    "the target was replaced by a rename; an in-place write would keep the same inode",
  );
  assert.notEqual(readFileSync(SESSIONS_PATH, "utf-8"), firstRaw, "the map actually changed");
  assert.deepEqual(config.loadSessionMap(), { "sess-ino": "home" });
  const leftovers = readdirSync(PI_DIR).filter((f) => f.startsWith(`${basename(SESSIONS_PATH)}.tmp.`));
  assert.deepEqual(leftovers, [], "no temp residue after a completed write");
});


// ── pi-chaos-relay-8ni: pid 0, and a future mtime, are not "held by a live peer"

test("a lock file containing '0' is not a live holder and is reclaimable", () => {
  resetState();
  const lock = lockPath("pid-zero");
  // process.kill(0, 0) signals the caller's own process group and succeeds, so
  // '0' previously looked like a live holder that could never be reclaimed.
  writeFileSync(lock, "0");
  const claimed = claimProfileLock("pid-zero");
  assert.equal(claimed.claimed, true, "pid 0 must not block the claim");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

test("an empty lock whose mtime is in the FUTURE is reclaimed, not held in grace", () => {
  resetState();
  const lock = lockPath("future-mtime");
  writeFileSync(lock, "");
  // A clock step / NTP correction can leave mtime ahead of now. The grace window
  // only applies to a non-negative age, otherwise such a file would stay "just
  // created" until the wall clock caught up and block the profile indefinitely.
  const future = Date.now() / 1000 + 3600;
  utimesSync(lock, future, future);
  const claimed = claimProfileLock("future-mtime");
  assert.equal(claimed.claimed, true, "a future-dated empty lock is stale, not in grace");
  assert.equal(readFileSync(lock, "utf-8"), String(process.pid));
});

test("a fresh empty lock (age inside the grace window) is still treated as held", () => {
  resetState();
  const lock = lockPath("fresh-empty");
  writeFileSync(lock, "");
  const claimed = claimProfileLock("fresh-empty");
  assert.equal(claimed.claimed, false, "the grace window still protects a mid-create lock");
  assert.equal(readFileSync(lock, "utf-8"), "");
});


// ── pi-chaos-relay-9oi: a FAILED switch still releases the profile left behind

test("a switch whose connect fails releases the previous profile's lock", async (t) => {
  resetState();
  // Session starts on "alpha" (pre-provisioned, so it connects offline and
  // claims alpha's lock), then switches to a profile that EXISTS but is
  // unconfigured, so connectAsProfile() attempts a live registration and fails
  // against the offline relay. The target exists on purpose: a brand-new name
  // would trip the profile cap in this shared test HOME (which accumulates
  // config files), testing the wrong refusal.
  const alpha = writeProfileConfig("alpha", "ak_alpha_offline");
  writeProfileConfig("default", "ak_default_offline");
  const targetConfig = config.profilePathForName("brandnew");
  writeFileSync(targetConfig, "{}\n");
  const sid = "sess-failed-switch";
  writeFileSync(SESSIONS_PATH, JSON.stringify({ [sid]: "alpha" }) + "\n");
  const alphaLock = lockPath("alpha");
  const targetLock = lockPath("brandnew");

  const fake = makeFakePi();
  chaosRelayExtension(fake.pi as unknown as ExtensionApi);
  await callHandler(
    fake.handlers,
    "session_start",
    { reason: "resume" },
    makeCtx(sid, fake.notifications),
  );
  assert.equal(readFileSync(alphaLock, "utf-8"), String(process.pid), "alpha claimed at session start");
  assert.equal(config.getConfigPath(), alpha);

  await fake.commands.get("chaos-relay")!.handler(
    "profile brandnew",
    makeCtx(sid, fake.notifications),
  );

  const out = fake.notifications.map((n) => n.message).join("\n");
  assert.match(out, /couldn't reach the relay to connect/, `switch outcome: ${out}`);
  assert.equal(
    existsSync(alphaLock),
    false,
    "the profile the session LEFT is released even though the new connect failed",
  );
  assert.equal(
    readFileSync(targetLock, "utf-8"),
    String(process.pid),
    "the target stays claimed for the retrying poller",
  );
  t.diagnostic(`notifications: ${JSON.stringify(fake.notifications.map((n) => n.message))}`);
});


// ── pi-chaos-relay-vut: same-millisecond mtime skew must not unlink a fresh lock

test("an empty lock read in the same millisecond it was created is still held", () => {
  resetState();
  const lock = lockPath("same-ms");
  writeFileSync(lock, "");
  // Deterministically reproduce the skew the reviewer found: Date.now() is
  // integer ms while mtimeMs is fractional, so a lock created and read inside
  // one millisecond yields ageMs ≈ -0.8. The old `ageMs >= 0` test treated that
  // as a future mtime and UNLINKED a mid-create lock — the window the grace
  // exists to protect (and it made the sibling test pass only by timing luck).
  // 20ms ahead: inside the 50ms tolerance with room for the few ms of drift
  // between setting the mtime and reading it (a 1ms probe drifts to ~0 and
  // stops discriminating). The real skew is sub-millisecond; this pins the
  // tolerance band itself.
  const slightlyAhead = Date.now() / 1000 + 0.02;
  utimesSync(lock, slightlyAhead, slightlyAhead);
  const claimed = claimProfileLock("same-ms");
  assert.equal(claimed.claimed, false, "same-millisecond skew is inside the grace window");
  assert.equal(readFileSync(lock, "utf-8"), "", "and the file was not unlinked");

  // The tolerance is bounded: a REAL future mtime stays stale and reclaimable.
  const future = Date.now() / 1000 + 5;
  utimesSync(lock, future, future);
  const reclaimed = claimProfileLock("same-ms");
  assert.equal(reclaimed.claimed, true, "a genuinely future-dated lock is stale, not in grace");
});

test("rg6: a persisted explicit path resumes without env; a missing path degrades to name", async () => {
  resetState();
  const namesake = writeProfileConfig("staging", "ak_rg6_namesake");
  const outsideDir = mkdtempSync(join(tmpdir(), "rg6-resume-"));
  const explicit = join(outsideDir, "chaos-relay.staging.json");
  writeFileSync(explicit, JSON.stringify({ relayUrl: OFFLINE_RELAY_URL, apiKey: "ak_rg6_explicit" }));
  const sid = "rg6-explicit-resume";
  process.env.CHAOS_RELAY_CONFIG = explicit;
  const first = makeFakePi();
  const ctx = makeCtx(sid, first.notifications);
  try {
    chaosRelayExtension(first.pi as unknown as ExtensionApi);
    await callHandler(first.handlers, "session_start", { reason: "startup" }, ctx);
    assert.deepEqual(readSessionMap()[sid], { profile: "staging", path: explicit });
    await callHandler(first.handlers, "session_shutdown", {}, ctx);
    delete process.env.CHAOS_RELAY_CONFIG;
    const resumed = makeFakePi();
    chaosRelayExtension(resumed.pi as unknown as ExtensionApi);
    await callHandler(resumed.handlers, "session_start", { reason: "resume" }, ctx);
    assert.equal(config.getConfigPath(), explicit);
    assert.equal(config.messageStatePath(), `${explicit}.state`);
    // A model-requested switch is name-based even while the resumed session
    // holds a recorded explicit path for that same name.
    const switchTool = resumed.tools.find((tool) => tool.name === "relay_switch_profile");
    assert.ok(switchTool);
    const execute = switchTool.execute as (id: string, params: { name: string }, signal: unknown,
      onUpdate: unknown, ctx: unknown) => Promise<unknown>;
    await execute("rg6-switch", { name: "staging" }, undefined, undefined,
      { ui: { notify: () => {} } });
    assert.equal(config.getConfigPath(), namesake, "model switch resolves the name, not the recorded path");
    await callHandler(resumed.handlers, "session_shutdown", {}, ctx);

    rmSync(explicit);
    config.setSessionProfile(sid, "staging", explicit);
    // The saved record is not rewritten or dropped merely because its file
    // vanished. Resolution falls back to the existing ~/.pi namesake.
    const fallback = makeFakePi();
    chaosRelayExtension(fallback.pi as unknown as ExtensionApi);
    await callHandler(fallback.handlers, "session_start", { reason: "resume" }, ctx);
    assert.equal(config.getConfigPath(), namesake);
    await callHandler(fallback.handlers, "session_shutdown", {}, ctx);
  } finally {
    delete process.env.CHAOS_RELAY_CONFIG;
    rmSync(outsideDir, { recursive: true, force: true });
    resetState();
  }
});
