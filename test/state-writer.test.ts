import { test } from "node:test";
import assert from "node:assert/strict";
import { DebouncedStateWriter, DEFAULT_FLUSH_INTERVAL_MS } from "../state-writer.ts";

/** A writer over a counter-shaped state, counting what actually reached disk. */
function makeWriter(opts: { intervalMs?: number; failFirst?: boolean } = {}) {
  const written: number[] = [];
  const errors: unknown[] = [];
  let fail = opts.failFirst ?? false;
  const writer = new DebouncedStateWriter<number>({
    write: (state) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      written.push(state);
    },
    intervalMs: opts.intervalMs ?? 60_000, // long enough not to fire in most tests
    onError: (err) => errors.push(err),
  });
  return { writer, written, errors };
}

test("a burst of staged states collapses into one write of the newest state", () => {
  const { writer, written } = makeWriter();
  writer.stage(1);
  writer.stage(2);
  writer.stage(3);
  assert.equal(writer.writeCount, 0, "nothing is written until a flush point");
  writer.flushNow();
  assert.deepEqual(written, [3], "one write, and it is the newest state — never a drift back");
  assert.equal(writer.writeCount, 1);
  writer.dispose();
});

test("flushNow with nothing staged writes nothing", () => {
  const { writer, written } = makeWriter();
  writer.flushNow();
  writer.flushNow();
  assert.deepEqual(written, []);
  assert.equal(writer.writeCount, 0);
  writer.dispose();
});

test("the interval flushes staged state without an explicit call", async () => {
  const { writer, written } = makeWriter({ intervalMs: 5 });
  writer.stage(7);
  const start = Date.now();
  while (written.length === 0) {
    if (Date.now() - start > 2000) throw new Error("the timer never flushed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(written, [7]);
  writer.dispose();
});

test("stageUrgent writes synchronously, for state another process will read", () => {
  const { writer, written } = makeWriter();
  writer.stageUrgent(42);
  assert.deepEqual(written, [42], "no flush point needed: the hand-back must be durable now");
  assert.equal(writer.writeCount, 1);
  writer.dispose();
});

test("a failed write stays dirty, is reported, and is retried by the next flush", () => {
  const { writer, written, errors } = makeWriter({ failFirst: true });
  writer.stage(5);
  writer.flushNow();
  assert.deepEqual(written, [], "the first attempt failed");
  assert.equal(errors.length, 1, "and it was reported rather than thrown at the message path");
  assert.ok(writer.hasPending, "the state is still pending, so nothing is silently lost");
  writer.flushNow();
  assert.deepEqual(written, [5], "the retry wrote it");
  assert.equal(errors.length, 1, "with no second error");
  writer.dispose();
});

test("dispose refuses to write state that was staged before it (a superseded instance)", async () => {
  const { writer, written } = makeWriter({ intervalMs: 5 });
  // Staged but not yet flushed: this is the dangerous case, because the state is
  // older than the replacement session's and would clobber it.
  writer.stage(8);
  writer.dispose();
  writer.flushNow();
  writer.stage(9);
  writer.flushNow();
  writer.stageUrgent(10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(written, [], "an older instance must not flush over the replacement's state");
  assert.equal(writer.hasPending, false);
});

test("the default flush interval is a safety net, not the main flush point", () => {
  assert.equal(DEFAULT_FLUSH_INTERVAL_MS, 2000);
});
