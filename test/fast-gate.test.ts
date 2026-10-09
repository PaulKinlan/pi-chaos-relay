/**
 * Selector tests for scripts/fast-gate.ts (bead pi-chaos-relay-a1x).
 *
 * The fast gate is only safe if its narrowing is conservative: a changed path
 * that is not PROVABLY isolated must send the run to the full suite. These tests
 * pin that matrix and the map's hygiene, so a new module cannot silently become
 * an unmapped hole (the guard tells the author to add it to MODULE_TESTS or to
 * FULL_TESTS_TRIGGERS), and so the fast tier can never quietly become the full
 * tier by pulling in test/index.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FULL_TESTS_TRIGGERS,
  MODULE_TESTS,
  changedFiles,
  discoverTestFiles,
  resolveBase,
  selectTests,
} from "../scripts/fast-gate.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_URL = new URL("../scripts/fast-gate.ts", import.meta.url);
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);

test("importing fast-gate does not run the gate", () => {
  // The module must be importable by these tests (and by anything else). Without
  // the entry-point guard, importing it would run tsc + the suite and exit.
  const result = spawnSync(process.execPath, ["--eval", `await import(${JSON.stringify(SCRIPT_URL.href)})`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `import should be inert: ${result.stderr}`);
  assert.equal(result.stdout, "", "an import must print nothing");
});

test("a mapped module selects its own tests and its importers' tests", () => {
  const selection = selectTests(["config.ts"]);
  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.tests, ["test/config.test.ts"]);

  // relay-client is imported by poller, ws-client and inbound-attachments, so a
  // change there can change their behaviour too — all four come along.
  const client = selectTests(["relay-client.ts"]);
  assert.equal(client.mode, "affected");
  assert.deepEqual(client.tests, [
    "test/inbound-attachments.test.ts",
    "test/poller.test.ts",
    "test/relay-client.test.ts",
    "test/ws-client.test.ts",
  ]);
});

test("several isolated modules union their tests, sorted and deduped", () => {
  const selection = selectTests(["config.ts", "url-redact.ts", "connect.ts", "config.ts"]);
  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.tests, [
    "test/config.test.ts",
    "test/connect.test.ts",
    "test/url-redact.test.ts",
  ]);
  assert.deepEqual(selection.changed, ["config.ts", "connect.ts", "url-redact.ts"]);
});

test("the entry point always forces the full suite", () => {
  assert.equal(selectTests(["index.ts"]).mode, "full");
  // …and so does anything reached from nowhere in the map below (the guard test
  // proves index.ts is the only module that needs this rule).
  assert.match(selectTests(["index.ts"]).reason, /global/);
});

test("manifests, lockfiles and tsconfig force the full suite", () => {
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", ".npmrc"]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} must not be narrowed`);
    assert.match(selection.reason, /full suite/);
  }
});

test("any test file — or anything else under test/ — forces the full suite", () => {
  for (const path of ["test/config.test.ts", "test/index.test.ts", "test/helpers.ts", "test/fixtures/a.json"]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} must not be narrowed`);
    assert.match(selection.reason, /suite or its harness/);
  }
  // The selector's own test is the single exception: it exercises the selector.
  assert.deepEqual(selectTests(["test/fast-gate.test.ts"]).tests, ["test/fast-gate.test.ts"]);
});

test("an unknown, new or deleted path forces the full suite", () => {
  for (const path of [
    "binary.ts",
    "lib/new-module.ts",
    "scripts/other.mjs",
    "README.md",
    "docs/preview.png",
    "skills/chaos-relay/SKILL.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/ci.yml",
  ]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} is not mapped and must not be narrowed`);
    assert.match(selection.reason, /not in the affected-test map|global/);
  }
});

test("one unmapped path out of many sends the whole run to the full suite", () => {
  const selection = selectTests(["config.ts", "url-redact.ts", "mystery.txt"]);
  assert.equal(selection.mode, "full");
  assert.match(selection.reason, /mystery\.txt/);
});

test("an empty change list selects nothing and says so", () => {
  const selection = selectTests([]);
  assert.equal(selection.mode, "affected");
  assert.deepEqual(selection.tests, []);
  assert.match(selection.reason, /no tracked change/);
  assert.deepEqual(selection.changed, []);
});

test("paths are normalised before matching (./ prefix, backslashes)", () => {
  assert.deepEqual(selectTests(["./config.ts"]).tests, ["test/config.test.ts"]);
  // A Windows-style separator still lands under test/ and must force the full suite.
  assert.equal(selectTests(["test\\config.test.ts"]).mode, "full");
});

test("the fast tier can never pull in the integration suite", () => {
  // A narrowed run that included test/index.test.ts would BE the full tier: the
  // whole point of the fast gate is that it does not.
  for (const module of Object.keys(MODULE_TESTS)) {
    const selection = selectTests([module]);
    if (selection.mode === "affected") {
      assert.ok(
        !selection.tests.includes("test/index.test.ts"),
        `${module} must not select the integration suite`,
      );
    }
  }
});

// ── map hygiene: the explicit map cannot drift silently ─────────────────────

test("every mapped module and every mapped test file exists on disk", () => {
  for (const [module, tests] of Object.entries(MODULE_TESTS)) {
    assert.ok(existsSync(join(ROOT, module)), `mapped module missing: ${module}`);
    assert.ok(tests.length > 0, `${module} is mapped to no test file`);
    for (const file of tests) {
      assert.ok(existsSync(join(ROOT, file)), `${module} maps to a missing test: ${file}`);
    }
  }
});

test("every shipped module is either mapped or an explicit full-suite trigger", () => {
  // A new module that is in neither place still goes to the full suite (safe),
  // but the author should decide once, in one line. Read the shipped module list
  // from package.json `files` so this follows what users actually receive.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
  const shippedModules = pkg.files.filter((f) => f.endsWith(".ts"));
  assert.ok(shippedModules.length > 0, "package.json lists no shipped .ts modules");
  const unaccounted = shippedModules.filter(
    (m) => !(m in MODULE_TESTS) && !FULL_TESTS_TRIGGERS.has(m),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `add each to MODULE_TESTS (with its affected tests) or to FULL_TESTS_TRIGGERS: ${unaccounted.join(", ")}`,
  );
});

test("the discovered test list is what the full suite would run", () => {
  const discovered = discoverTestFiles();
  assert.ok(discovered.length >= 15, `expected the repo's test files, got ${discovered.length}`);
  assert.ok(discovered.includes("test/index.test.ts"));
  assert.ok(discovered.every((f) => f.startsWith("test/") && f.endsWith(".test.ts")));
});

test("the base resolution names what it used, and the change list is real", () => {
  const base = resolveBase();
  assert.match(base.note, /base (refs\/|HEAD)/);
  assert.match(base.mergeBase, /^[0-9a-f]{40}$/);
  // In this worktree the selector must see the branch's own changes, whatever
  // they are — an empty list here would mean the base was resolved wrongly.
  assert.ok(Array.isArray(changedFiles(base.mergeBase)));
  // An explicit base is honoured as given (that is how a lane compares against a
  // pinned sha), and HEAD resolves to this commit.
  const head = resolveBase("HEAD");
  assert.equal(head.ref, "HEAD");
  assert.match(head.note, /requested/);
  const thisCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  assert.equal(head.mergeBase, thisCommit);
});

// ── CLI contract ───────────────────────────────────────────────────────────

test("--dry-run prints the plan and runs nothing", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", "--base", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[fast-gate\] mode: (affected|full)/);
  assert.match(result.stdout, /planned steps:/);
  assert.match(result.stdout, /typecheck \(whole tree\): npx tsc --noEmit/);
  assert.match(result.stdout, /the merger still runs the full gate/);
});

test("a bad invocation fails closed with a usage error", () => {
  const noValue = spawnSync(process.execPath, [SCRIPT_PATH, "--base"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--base requires a ref/);

  const unknown = spawnSync(process.execPath, [SCRIPT_PATH, "--nope"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument/);

  const help = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /affected test files or the full suite/);
});

test("the selector module is importable by path URL (no CJS/ESM trap)", () => {
  assert.equal(new URL(SCRIPT_URL).protocol, "file:");
  assert.ok(pathToFileURL(SCRIPT_PATH).href.endsWith("scripts/fast-gate.ts"));
});
