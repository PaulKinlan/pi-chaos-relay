/**
 * Publish-shape guard: every local `.ts` module reachable from index.ts (via
 * relative imports) must be listed in package.json `files`, or an install from
 * the packed tarball breaks at import time. This is the third time this class
 * of bug has bitten this repo (reply-format.ts, url-redact.ts), so this fails
 * closed whenever a newly imported module is left out of the allowlist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// `import … from "./x.ts"` and `export … from "./x.ts"`.
const FROM_RE = /\bfrom\s*["'](\.[^"']+)["']/g;
// `import("./x.ts")`.
const DYNAMIC_RE = /\bimport\s*\(\s*["'](\.[^"']+)["']/g;

function relativeImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(FROM_RE)) out.push(m[1]);
  for (const m of source.matchAll(DYNAMIC_RE)) out.push(m[1]);
  return out;
}

/** Resolve a relative import spec against the importing file (both repo-relative). */
function resolveModule(fromFile: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(fromFile), spec));
}

/** Walk the relative import graph from index.ts and return every .ts module. */
function reachableTsModules(): Set<string> {
  const seen = new Set<string>(["index.ts"]);
  const queue = ["index.ts"];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(join(ROOT, file), "utf-8");
    for (const spec of relativeImports(source)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const resolved = resolveModule(file, spec);
      if (!resolved.endsWith(".ts")) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

test("every local module reachable from index.ts ships in package.json files", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    files?: string[];
  };
  const shipped = new Set(pkg.files ?? []);
  const missing = [...reachableTsModules()].filter((m) => !shipped.has(m)).sort();
  assert.deepEqual(
    missing,
    [],
    "these modules are imported but missing from the publish allowlist",
  );
});
