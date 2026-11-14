/**
 * Selector tests for scripts/fast-gate.ts (bead pi-chaos-relay-a1x).
 *
 * The fast gate is only safe if its narrowing is conservative: a changed path
 * that is not PROVABLY isolated must send the run to the full suite. These tests
 * pin that matrix and the map's hygiene, so a new module cannot silently become
 * an unmapped hole (the guard tells the author to add it to MODULE_TESTS or to
 * FULL_TESTS_TRIGGERS), and so the fast tier can never quietly become the full
 * tier by pulling in the index.ts integration suites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FULL_TESTS_TRIGGERS,
  ISOLATED_INTEGRATION_SUITES,
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
  // approval-policy.ts and profile-lock.ts import config.ts, so their tests
  // can catch a config change.
  assert.deepEqual(selection.tests, ["test/approval-policy.test.ts", "test/config.test.ts", "test/profile-lock.test.ts"]);

  // relay-client is imported by poller, ws-client, inbound-attachments and
  // inbound-message, so a change there can change their behaviour too — all five
  // come along.
  const client = selectTests(["relay-client.ts"]);
  assert.equal(client.mode, "affected");
  assert.deepEqual(client.tests, [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/relay-client.test.ts",
    "test/ws-client.test.ts",
  ]);
  // A new module joins the tier on the same terms: its own tests plus every test
  // whose import closure reaches it (the inbound shape checks are imported by the
  // poller, the WebSocket transport and the attachment downloader).
  const shape = selectTests(["inbound-message.ts"]);
  assert.equal(shape.mode, "affected");
  assert.deepEqual(shape.tests, [
    "test/approvals.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/ws-client.test.ts",
  ]);
});

test("several isolated modules union their tests, sorted and deduped", () => {
  const selection = selectTests(["config.ts", "url-redact.ts", "connect.ts", "config.ts"]);
  assert.equal(selection.mode, "affected");
  // url-redact fans out to every module that imports it (relay-client, ws-client,
  // inbound-attachments and poller through relay-client); config reaches
  // approval-policy and profile-lock. The closure guard test proves these edges are complete:
  // it is what caught the two new edges when approvals.ts extracted the summary
  // (approvals.ts imports parseConnectInput and redactCommandSecrets, so connect
  // and url-redact changes can now affect the approvals tests).
  assert.deepEqual(selection.tests, [
    "test/approval-policy.test.ts",
    "test/approvals.test.ts",
    "test/config.test.ts",
    "test/connect.test.ts",
    "test/inbound-attachments.test.ts",
    "test/inbound-message.test.ts",
    "test/poller.test.ts",
    "test/profile-lock.test.ts",
    "test/relay-client.test.ts",
    "test/url-redact.test.ts",
    "test/ws-client.test.ts",
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

test("any test file — or anything else under test/ — forces the full suite, except an isolated integration suite", () => {
  for (const path of ["test/config.test.ts", "test/integration-harness.ts", "test/helpers.ts", "test/fixtures/a.json"]) {
    const selection = selectTests([path]);
    assert.equal(selection.mode, "full", `${path} must not be narrowed`);
    assert.match(selection.reason, /suite|harness/);
  }
  // The selector's own test is one exception: it exercises the selector.
  assert.deepEqual(selectTests(["test/fast-gate.test.ts"]).tests, ["test/fast-gate.test.ts"]);
  // …and each isolated integration suite is the other: it selects ITSELF,
  // because its process, sandbox and imports are provably its own (guarded below).
  for (const suite of ISOLATED_INTEGRATION_SUITES) {
    const selection = selectTests([suite]);
    assert.equal(selection.mode, "affected", `${suite} selects itself`);
    assert.deepEqual(selection.tests, [suite]);
  }
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
  assert.deepEqual(selectTests(["./config.ts"]).tests, [
    "test/approval-policy.test.ts",
    "test/config.test.ts",
    "test/profile-lock.test.ts",
  ]);
  // A Windows-style separator still lands under test/ and must force the full suite.
  assert.equal(selectTests(["test\\config.test.ts"]).mode, "full");
});

test("the map is a SUPERSET of the real import closure (the guard that matters)", () => {
  // This is the check that would have caught the first draft of the map: it
  // hand-listed url-redact -> [url-redact.test] while relay-client, ws-client and
  // inbound-attachments all import it. Derive who-imports-what from the files
  // themselves, so a new edge cannot silently escape the fast tier's coverage.
  const modules = discoverSourcePaths();
  // The integration suites are excluded exactly like the old monolith was: the
  // entry point imports every module, so holding modules to the suites would
  // make every module change run them all. Their OWN changes self-select.
  const tests = discoverTestFiles().filter((t) => !ISOLATED_INTEGRATION_SUITES.includes(t));
  const closureOf = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const dep of relativeImportsOf(file)) closureOf(dep, seen);
    return seen;
  };
  const missing = findMissingMapEdges(modules, tests, closureOf, MODULE_TESTS);
  assert.deepEqual(
    missing,
    [],
    `MODULE_TESTS under-covers the import graph for:\n  ${missing.join("\n  ")}\n` +
      `Add each test file to that module's list in scripts/fast-gate.ts.`,
  );
});

test("every test file that exists is accounted for by the affected tier", () => {
  // The real condition: no test file may be an unaccounted hole. Either some
  // mapped module selects it, or it is an isolated integration suite (which
  // self-selects), or it is one of the files only the full tier runs.
  const selected = new Set(Object.values(MODULE_TESTS).flat());
  const unaccounted = discoverTestFiles().filter(
    (test) => !selected.has(test) && !ISOLATED_INTEGRATION_SUITES.includes(test) && !FULL_TIER_ONLY_TESTS.includes(test),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `add each to a MODULE_TESTS entry, to ISOLATED_INTEGRATION_SUITES (a new index-* integration suite), or to FULL_TIER_ONLY_TESTS with a reason: ${unaccounted.join(", ")}`,
  );
  // …and the full-tier-only list is not a dumping ground: those files must exist.
  for (const test of FULL_TIER_ONLY_TESTS) {
    assert.ok(discoverTestFiles().includes(test), `full-tier-only test is missing: ${test}`);
  }
});

test("the import parser understands every form the guard claims to cover", () => {
  const source = [
    'import { a } from "./binding.ts";',
    'import "./side-effect.ts";',
    'const c = await import("./dynamic.ts");',
    "const d = await import(`./template.ts`);",
    'const e = await import(`./interpolated-${x}.ts`);',
    'import { fs } from "node:fs";',
    'import { z } from "../outside.ts";',
  ].join("\n");
  // Order follows the three patterns (binding/from first, then side-effect, then
  // dynamic); the guard only ever asks set membership.
  assert.deepEqual(importSpecifiersFrom(source), [
    "./binding.ts",
    "../outside.ts",
    "./side-effect.ts",
    "./dynamic.ts",
    "./template.ts",
    "./interpolated-${x}.ts",
  ]);
  // A side-effect edge is a real edge: the guard must fail when a module's map
  // entry exists (so its changes NARROW) but omits a test that imports it — the
  // exact shape of the round-1 coverage miss.
  const modules = ["a.ts", "side-effect.ts"];
  const closureOf = (file: string) => new Set(file === "test/a.test.ts" ? modules : []);
  const underCovering = { "a.ts": ["test/a.test.ts"], "side-effect.ts": ["test/b.test.ts"] };
  assert.deepEqual(findMissingMapEdges(modules, ["test/a.test.ts"], closureOf, underCovering), [
    "side-effect.ts <- test/a.test.ts",
  ]);
  assert.deepEqual(
    findMissingMapEdges(modules, ["test/a.test.ts"], closureOf, {
      "a.ts": ["test/a.test.ts"],
      "side-effect.ts": ["test/a.test.ts"],
    }),
    [],
  );
});

test("the affected tier never selects an integration suite from a module change, and a suite change selects itself", () => {
  // The boundary is deliberate (the entry point imports every module, so
  // mapping the suites onto modules would make the fast tier the full tier),
  // which is why it is asserted rather than assumed: no mapped module may
  // select any integration suite…
  for (const module of Object.keys(MODULE_TESTS)) {
    const selection = selectTests([module]);
    if (selection.mode === "affected") {
      for (const suite of ISOLATED_INTEGRATION_SUITES) {
        assert.ok(
          !selection.tests.includes(suite),
          `${module} must not select ${suite} in the affected tier`,
        );
      }
    }
  }
  // …and changing the entry point they drive, or the shared harness, routes to FULL.
  assert.equal(selectTests(["index.ts"]).mode, "full");
  assert.equal(selectTests(["test/integration-harness.ts"]).mode, "full");
  // The suites exist and are discovered — a renamed suite must not silently
  // become an unnarrowed path (the list and the disk have to agree).
  const discovered = discoverTestFiles();
  for (const suite of ISOLATED_INTEGRATION_SUITES) {
    assert.ok(discovered.includes(suite), `integration suite must exist and be discovered: ${suite}`);
  }
});

test("each isolated integration suite is PROVABLY isolated (the property the narrowing relies on)", () => {
  // Self-selecting a changed suite is only sound while all of these hold:
  //   1. it applies its own sandbox BEFORE importing the modules under test —
  //      config.ts binds homedir() at import, so a static (or pre-sandbox
  //      dynamic) import of ../config.ts or ../index.ts would leak the real
  //      ~/.pi into the test process;
  //   2. it imports no other test file (no shared mutable test scope);
  //   3. the shared harness is inert at import (checked by the harness guard
  //      below) so importing it cannot bind the environment either.
  // A suite that breaks one of these must be dropped from
  // ISOLATED_INTEGRATION_SUITES, not narrowed anyway.
  // The spec strings are built by concatenation so THIS file's own import-graph
  // closure (re-derived by the guard above) does not pick them up as real edges.
  const INDEX_SPEC = "../index" + ".ts";
  const CONFIG_SPEC = "../config" + ".ts";
  for (const suite of ISOLATED_INTEGRATION_SUITES) {
    const source = readFileSync(join(ROOT, suite), "utf8");
    assert.ok(!staticRuntimeImportOf(source, INDEX_SPEC), `${suite}: ${INDEX_SPEC} must be imported dynamically, after the sandbox`);
    assert.ok(!staticRuntimeImportOf(source, CONFIG_SPEC), `${suite}: ${CONFIG_SPEC} must be imported dynamically, after the sandbox`);
    const sandboxAt = source.indexOf("createSandbox(");
    const indexImportAt = source.indexOf(`await import("${INDEX_SPEC}")`);
    const configImportAt = source.indexOf(`await import("${CONFIG_SPEC}")`);
    assert.ok(sandboxAt !== -1, `${suite}: must call createSandbox()`);
    assert.ok(indexImportAt !== -1, `${suite}: must drive the real extension entry point`);
    assert.ok(sandboxAt < indexImportAt, `${suite}: the sandbox must precede the index.ts import`);
    assert.ok(configImportAt === -1 || sandboxAt < configImportAt, `${suite}: the sandbox must precede the config.ts import`);
    // Cross-test imports in ANY form — static (including multi-line specifier
    // lists), side-effect, or dynamic (`await import("./x.test.ts")`), and from
    // any relative root (`./x.test.ts`, `../test/x.test.ts`) — via the same
    // specifier parser the import-closure guard uses. Bead pi-chaos-relay-9tp:
    // the line-anchored regex this replaces missed the multi-line, dynamic and
    // parent-relative forms.
    const crossTest = importSpecifiersFrom(source).filter((spec) => spec.endsWith(".test.ts"));
    assert.deepEqual(crossTest, [], `${suite}: must not import another test file (${crossTest.join(", ")})`);
  }
});

test("the shared integration harness is inert at import and bound only by call", () => {
  const harness = "test/integration-harness.ts";
  const source = readFileSync(join(ROOT, harness), "utf8");
  // No runtime import of the modules under test, in ANY static form
  // (multi-line specifier lists included): type-only imports are erased, so
  // they cannot bind the pre-sandbox environment. The spec strings are built
  // by concatenation so THIS file's own import-graph closure does not pick
  // them up as real edges.
  assert.ok(
    !staticRuntimeImportOf(source, "../index" + ".ts"),
    `${harness}: runtime import of the entry point`,
  );
  assert.ok(
    !staticRuntimeImportOf(source, "../config" + ".ts"),
    `${harness}: runtime import of config`,
  );
  assert.ok(!/await\s+import\(/.test(source), `${harness}: no dynamic imports at all`);
  // The environment redirect must live INSIDE createSandbox, not at module
  // scope — otherwise importing the harness would already bind this process.
  const sandboxAt = source.indexOf("export function createSandbox");
  const envAt = source.indexOf("process.env.HOME =");
  assert.ok(sandboxAt !== -1 && envAt > sandboxAt, `${harness}: the HOME redirect belongs to createSandbox()`);
  // And only the isolated suites may import the harness, in any import form:
  // a unit test that imported it would be an unaccounted path the fast tier
  // could not reason about (it forces the full suite today, which is safe but
  // hides drift). Parsed, not substringed: this file legitimately NAMES the
  // harness path, and a multi-line or dynamic import must not slip past (9tp).
  for (const testFile of discoverTestFiles()) {
    if (ISOLATED_INTEGRATION_SUITES.includes(testFile)) continue;
    const testSource = readFileSync(join(ROOT, testFile), "utf8");
    assert.ok(
      !importSpecifiersFrom(testSource).includes("./integration-harness.ts"),
      `${testFile}: only the isolated integration suites may use the shared harness`,
    );
  }
});

test("the discovered test list is what the full suite would run", () => {
  const discovered = discoverTestFiles();
  assert.ok(discovered.length >= 20, `expected the repo's test files, got ${discovered.length}`);
  for (const suite of ISOLATED_INTEGRATION_SUITES) assert.ok(discovered.includes(suite), `missing ${suite}`);
  assert.ok(discovered.every((f) => f.startsWith("test/") && f.endsWith(".test.ts")));
});

test("the base resolution names what it used, and the change list is real", () => {
  const base = resolveBase();
  assert.match(base.note, /base (refs\/|HEAD)/);
  assert.match(base.mergeBase, /^[0-9a-f]{40}$/);
  // In this worktree the selector must see the branch's own changes, whatever
  // they are — an empty list here would mean the base was resolved wrongly.
  const diff = changedFiles(base.mergeBase);
  assert.equal(diff.ok, true, "the selector must be able to read its own branch history");
  assert.ok(Array.isArray(diff.files));
  // An explicit base is honoured as given (that is how a lane compares against a
  // pinned sha), and HEAD resolves to this commit.
  const head = resolveBase("HEAD");
  assert.equal(head.ref, "HEAD");
  assert.match(head.note, /requested/);
  const thisCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  assert.equal(head.mergeBase, thisCommit);
});

/**
 * Static-import detection for the isolation guards, covering EVERY static form
 * — including a multi-line specifier list (bead pi-chaos-relay-9tp: the
 * line-anchored check this replaces let a static import whose `from` clause
 * sits on a later line slip past). `import type` is exempt: it is erased at
 * compile time and cannot bind the pre-sandbox environment. Dynamic
 * `await import(...)` is deliberately NOT matched — the suites import the
 * modules under test that way, after the sandbox redirect. (This comment must
 * not contain a literal `from "../<module>"` — the import-closure guard above
 * parses comments too.)
 */
function staticRuntimeImportOf(source: string, spec: string): boolean {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\bimport\\s+(?!type\\b)[^;]*?\\bfrom\\s*["']${escaped}["']`, "s").test(source) ||
    new RegExp(`\\bimport\\s*["']${escaped}["']`).test(source) // side-effect form
  );
}

test("staticRuntimeImportOf catches every static form (and exempts type-only and dynamic)", () => {
  // The spec and every fixture are built through $S substitution so THIS
  // file's own import-graph closure (re-derived by the guard above) does not
  // read the fixtures as real import edges.
  const spec = "../index" + ".ts";
  const fixture = (form: string) => form.replaceAll("$S", spec);
  assert.ok(staticRuntimeImportOf(fixture('import x from "$S";'), spec));
  assert.ok(
    staticRuntimeImportOf(fixture('import {\n  default as ext,\n} from "$S";'), spec),
    "a multi-line specifier list is still a static import",
  );
  assert.ok(staticRuntimeImportOf(fixture('import "$S";'), spec), "the side-effect form");
  assert.ok(!staticRuntimeImportOf(fixture('import type { X } from "$S";'), spec), "type-only is erased");
  assert.ok(
    !staticRuntimeImportOf(fixture('const m = await import("$S");'), spec),
    "dynamic import is what the suites legitimately use, after the sandbox",
  );
  assert.ok(!staticRuntimeImportOf(fixture('import x from "$S.bak";'), spec), "the dot in .ts is not a wildcard");
});

/**
 * Every relative module specifier in a source string. Three forms, because the
 * round-2 review pointed out that a guard which only understands `from "…"`
 * cannot honour the claim that a new edge cannot escape it:
 *   import x from "./a.ts"      — binding import
 *   import "./b.ts"             — side-effect import
 *   import("./c.ts") / import(`./d.ts`) — dynamic import
 * `import(`./${x}.ts`)` matches too, and is then dropped because the path does
 * not exist, which is the conservative direction.
 */
function importSpecifiersFrom(source: string): string[] {
  const specs: string[] = [];
  for (const re of [
    /\bfrom\s*["'](\.[^"']+)["']/g,
    /\bimport\s*["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'`](\.\.?\/[^"'`]+)["'`]/g,
  ]) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/** Every root .ts module and every scripts/*.ts|mjs, repo-relative. */
function discoverSourcePaths(): string[] {
  const roots = (readdirSync(ROOT) as string[]).filter((f: string) => f.endsWith(".ts"));
  const scripts = existsSync(join(ROOT, "scripts"))
    ? (readdirSync(join(ROOT, "scripts")) as string[])
        .filter((f: string) => f.endsWith(".ts") || f.endsWith(".mjs"))
        .map((f: string) => `scripts/${f}`)
    : [];
  return [...roots, ...scripts].sort();
}

/** Relative .ts imports of a repo-relative file, keeping only real files (tests
 *  name fake modules in string fixtures). */
function relativeImportsOf(file: string): string[] {
  return importSpecifiersFrom(readFileSync(join(ROOT, file), "utf8"))
    .map((spec) => posix.normalize(posix.join(posix.dirname(file), spec)))
    .filter((path) => path.endsWith(".ts") && existsSync(join(ROOT, path)));
}

/** The guard itself, as a pure function so it can be tested against synthetic
 *  graphs (a guard whose only test is "the real map happens to pass" is not a
 *  guard). Returns every `<module> <- <test>` edge the map fails to cover. */
function findMissingMapEdges(
  modules: string[],
  tests: string[],
  closureOf: (file: string) => Set<string>,
  map: Record<string, string[]>,
): string[] {
  const missing: string[] = [];
  for (const module of modules) {
    if (!(module in map)) continue; // unmapped modules fall back to the full suite
    for (const test of tests) {
      if (closureOf(test).has(module) && !map[module].includes(test)) {
        missing.push(`${module} <- ${test}`);
      }
    }
  }
  return missing;
}

/** Test files that only the FULL tier runs, and why. `pack-files.test.ts` guards
 *  the published file list in package.json, and the manifest is a full-tier
 *  trigger, so it has no module to hang off. The integration suites are NOT
 *  here: they self-select (see ISOLATED_INTEGRATION_SUITES). */
const FULL_TIER_ONLY_TESTS = ["test/pack-files.test.ts"];

test("the type-check cache is incremental, worktree-local, and gitignored", () => {
  // tsconfig carries incremental + a root-level tsBuildInfoFile so EVERY tsc
  // invocation (fast gate, full gate, local runs) reuses it (bead
  // pi-chaos-relay-eu4). The cache must never be committed (machine-local
  // state) and must not live under node_modules (the fleet hard-links that
  // from a shared store — a cache there would be written by every lane at
  // once).
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.compilerOptions.incremental, true, "tsconfig keeps the incremental type-check");
  assert.equal(tsconfig.compilerOptions.tsBuildInfoFile, ".tsbuildinfo", "the cache is worktree-local, not in node_modules");
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.ok(
    gitignore.split("\n").some((line) => line.trim() === "/.tsbuildinfo"),
    ".gitignore must exclude the tsbuildinfo cache",
  );
});

test("an explicit --base that does not resolve is fatal, never a silent fallback", () => {
  const result = resolveBase("definitely-not-a-ref-in-this-repo");
  assert.equal(result.ok, false);
  assert.match(result.note, /does not resolve/);
  // The CLI must refuse it (exit 2) rather than testing the wrong range.
  const cli = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", "--base", "definitely-not-a-ref"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /does not resolve/);
});

test("without a default branch the CLI fails closed to the full suite", () => {
  // End to end in a real checkout that HAS no origin/master, origin/main or
  // master branch: resolveBase must report failure and main() must run the full
  // suite rather than diffing against HEAD (which in a clean checkout would
  // report "no changes" while knowing nothing).
  const dir = mkdtempSync(join(tmpdir(), "fast-gate-nobase-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(SCRIPT_PATH, join(dir, "scripts", "fast-gate.ts"));
    const gitIn = (args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    gitIn(["init", "-q", "-b", "work"]);
    gitIn(["add", "."]);
    gitIn(["commit", "-q", "-m", "init"]);
    const result = spawnSync(process.execPath, ["scripts/fast-gate.ts", "--dry-run"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no default branch resolves in this checkout/);
    assert.match(result.stdout, /mode: full/);
    assert.match(result.stdout, /tests \(full suite\): node --test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable change list is never read as an empty one", () => {
  const failure = changedFiles("not-a-commit-at-all");
  assert.equal(failure.ok, false, "git failures must be reported, not ignored");
  const good = changedFiles(resolveBase().mergeBase);
  assert.equal(good.ok, true);
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
  if (/\[fast-gate\] mode: affected/.test(result.stdout)) {
    assert.match(result.stdout, /a PASS here is not a landing verdict/);
  }
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
