/**
 * Focused coverage for approvals.ts (bead pi-chaos-relay-eg1): the outstanding
 * approval queue, and the payload-safe summary shown in the approval question.
 *
 * These are the two units whose failures are worst — a queue that resolves the
 * wrong request turns "no" into "yes", and a summary that echoes a value ships a
 * secret to the channel that is asking to be trusted. Both are exercised here
 * directly, without the 2,400-line extension, so a failure names the primitive.
 *
 * The summarizeToolCall tests at the end were MOVED here from
 * test/index.test.ts when the function was extracted; their assertions are
 * unchanged, they simply no longer import the entry point to reach it.
 */
import { test } from "node:test";
import { parseInboundMessage } from "../inbound-message.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalQueue,
  controlPlaneApprovalHint,
  shortId,
  summarizeToolCall,
} from "../approvals.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── an answer is bound to one request, one channel and one sender ────────────

test("a nonce answer resolves exactly the request it names", async () => {
  const queue = new ApprovalQueue(5_000);
  const a = queue.add({ channelId: "chanA", from: "alice", toolName: "relay_reply" });
  const b = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
  assert.equal(queue.size, 2);
  assert.notEqual(a.nonce, b.nonce, "each request owns its own unguessable token");
  assert.notEqual(a.ref, b.ref);

  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${a.nonce}` }), true);
  assert.equal(await a.promise, true);
  assert.equal(queue.size, 1, "only the named request is consumed");

  // A's answer must not have resolved B, which is still answerable on its own.
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `no ${b.nonce}` }), true);
  assert.equal(await b.promise, false);
  assert.equal(queue.size, 0);
});

test("a nonce answer from another sender or channel answers nothing", async () => {
  const queue = new ApprovalQueue(5_000);
  const a = queue.add({ channelId: "chanA", from: "alice", toolName: "relay_reply" });

  assert.equal(queue.settle({ channelId: "chanA", from: "bob", content: `yes ${a.nonce}` }), false);
  assert.equal(queue.settle({ channelId: "chanB", from: "alice", content: `yes ${a.nonce}` }), false);
  assert.equal(queue.size, 1, "the request still waits for its own answer");

  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${a.nonce}` }), true);
  assert.equal(await a.promise, true);
});

test("a nonce that names no pending request is forwarded, never consent", async () => {
  const queue = new ApprovalQueue(5_000);
  const a = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: "yes deadbeef" }), false);
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: "no deadbeef" }), false);
  assert.equal(queue.size, 1);
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${a.nonce}` }), true);
  assert.equal(await a.promise, true);
});

test("the #ref form answers, with punctuation tolerated", async () => {
  for (const [answer, expected] of [
    ["#1: yes", true],
    ["#1 - no", false],
    ["#1, yes", true],
    ["#1 yes", true],
  ] as const) {
    const queue = new ApprovalQueue(5_000);
    const a = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
    assert.equal(a.ref, 1);
    assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: answer }), true, `"${answer}" is an answer`);
    assert.equal(await a.promise, expected, `"${answer}" means ${expected ? "approved" : "denied"}`);
  }
});

test("a bare yes/ok is never consent (it is forwarded to the agent)", async () => {
  const queue = new ApprovalQueue(5_000);
  const a = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
  for (const content of ["yes", "ok", "do it", "yep", "sure"]) {
    assert.equal(queue.settle({ channelId: "chanA", from: "alice", content }), false, `"${content}"`);
  }
  assert.equal(queue.size, 1, "the request is untouched");
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${a.nonce}` }), true);
  assert.equal(await a.promise, true);
});

test("a #ref naming another sender's or channel's request is not consumed", async () => {
  const queue = new ApprovalQueue(5_000);
  const a = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
  assert.equal(queue.settle({ channelId: "chanA", from: "bob", content: "#1: yes" }), false);
  assert.equal(queue.settle({ channelId: "chanB", from: "alice", content: "#1: yes" }), false);
  assert.equal(queue.size, 1);
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${a.nonce}` }), true);
  assert.equal(await a.promise, true);
});

test("two requests time out independently: one answer cannot satisfy the other", async () => {
  const logs: string[] = [];
  const queue = new ApprovalQueue(60, (line) => logs.push(line));
  const answered = queue.add({ channelId: "chanA", from: "alice", toolName: "relay_reply" });
  const abandoned = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });

  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${answered.nonce}` }), true);
  assert.equal(await answered.promise, true);
  assert.equal(await abandoned.promise, false, "the unanswered request denies on its own timer");
  assert.equal(queue.size, 0, "both requests are gone");
  assert.ok(
    logs.some((line) => line.includes("#2") && line.includes("timed out")),
    `the timeout names the request it denied: ${logs.join(" | ")}`,
  );
  assert.ok(
    logs.some((line) => line.includes("#1") && line.includes("approved")),
    `the answer is logged against its own request: ${logs.join(" | ")}`,
  );
});

test("cancel() drops a request that never reached the user", async () => {
  const queue = new ApprovalQueue(5_000);
  const neverSent = queue.add({ channelId: "chanA", from: "alice", toolName: "bash" });
  assert.equal(queue.size, 1);
  neverSent.cancel();
  assert.equal(queue.size, 0);
  // A late answer for the dropped request is not consent for anything…
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: `yes ${neverSent.nonce}` }), false);
  // …and the promise is left unresolved rather than resolved by someone else.
  assert.equal(await Promise.race([neverSent.promise, delay(30).then(() => "still-pending")]), "still-pending");
});

test("an empty queue settles nothing", () => {
  const queue = new ApprovalQueue(5_000);
  assert.equal(queue.size, 0);
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: "yes" }), false);
  assert.equal(queue.settle({ channelId: "chanA", from: "alice", content: "#1: yes" }), false);
});

// ── the control-plane hint, and the fingerprint helper it relies on ──────────

test("controlPlaneApprovalHint is carried only by control-plane calls", () => {
  for (const tool of [
    "relay_connect",
    "relay_register_telegram",
    "relay_register_discord",
    "relay_register_email",
    "relay_register_webhook",
    "relay_switch_profile",
  ]) {
    const hint = controlPlaneApprovalHint(tool);
    assert.match(hint, /changes where this session connects or who can drive it/, tool);
    assert.match(hint, /shown as a fingerprint/, tool);
    assert.match(hint, /deny it if you did not ask for it/, tool);
  }
  for (const tool of ["relay_reply", "relay_check_messages", "relay_list_profiles", "bash", "write", "edit", ""]) {
    assert.equal(controlPlaneApprovalHint(tool), "", `an ordinary call carries no hint: ${tool}`);
  }
});

test("shortId is a stable, short, non-reversible fingerprint", () => {
  const channel = "telegram:1234567890";
  const id = shortId(channel);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(shortId(channel), id, "stable across calls");
  assert.notEqual(shortId("other"), id);
  assert.ok(!id.includes("1234567890"), "cannot be read back as the identifier");
});

// ── informed approval summaries (unit, moved here with the code) ───────────

test("summarizeToolCall shows a redacted bash command and never the secret", () => {
  const secret = "ghp_supersecrettoken1234567890abcdef";
  const summary = summarizeToolCall("bash", {
    command: `curl -s -H "Authorization: Bearer ${secret}" https://api.example.com/repos`,
  });
  assert.ok(summary.startsWith("bash: "), `names the tool: ${summary}`);
  assert.ok(summary.includes("curl"), `keeps the command: ${summary}`);
  assert.ok(summary.includes("api.example.com"), `keeps the target origin: ${summary}`);
  assert.ok(summary.includes("<redacted>"), `shows the redaction: ${summary}`);
  assert.ok(!summary.includes(secret), `must not leak the token: ${summary}`);
});

test("summarizeToolCall keeps relay_reply payload-free (channel + size only)", () => {
  const body = "root:x:0:0:root:/root:/bin/bash";
  const summary = summarizeToolCall("relay_reply", {
    channelType: "telegram",
    channelId: "chanA",
    content: body,
  });
  assert.ok(summary.startsWith("relay_reply: channel telegram"), `names the channel: ${summary}`);
  assert.ok(summary.includes(`${body.length} chars`), `shows the size: ${summary}`);
  assert.ok(!summary.includes(body), `must not echo the reply body: ${summary}`);
});

test("summarizeToolCall names every relay_reply attachment, with its size", () => {
  // The operator approves an OUTBOUND send from this line, so a bare count is
  // not enough: `2 attachment(s)` cannot be told apart from shipping ~/.ssh/id_rsa.
  // Names and sizes are shown; the file CONTENTS never are.
  const dir = mkdtempSync(join(tmpdir(), "chaos-relay-attach-"));
  try {
    const notes = join(dir, "notes.md");
    writeFileSync(notes, "hello"); // 5 bytes
    const key = join(dir, "id_rsa");
    writeFileSync(key, "PRIVATE-KEY-BYTES");

    const summary = summarizeToolCall("relay_reply", {
      channelType: "telegram",
      channelId: "chanA",
      content: "see attached",
      files: [notes, key, dir, join(dir, "missing.bin"), 42],
    });

    assert.ok(summary.startsWith("relay_reply: channel telegram"), `names the channel: ${summary}`);
    assert.ok(summary.includes("4 attachment(s)"), `counts the real paths only: ${summary}`);
    assert.ok(summary.includes("notes.md (5 bytes)"), `names and sizes the first: ${summary}`);
    assert.ok(summary.includes("id_rsa (17 bytes)"), `a sensitive name is visible: ${summary}`);
    assert.ok(summary.includes("(not a regular file)"), `flags a directory: ${summary}`);
    assert.ok(summary.includes("missing.bin (unreadable)"), `flags an unreadable path: ${summary}`);
    assert.ok(!summary.includes("PRIVATE-KEY-BYTES"), `must never echo attachment contents: ${summary}`);
    assert.ok(!summary.includes(dir), `must not echo the absolute directory: ${summary}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeToolCall shows write/edit paths as paths plus a content size, not a hash", () => {
  const write = summarizeToolCall("write", { path: "docs/notes.md", content: "hello" });
  assert.ok(write.includes("docs/notes.md"), `shows the relative path: ${write}`);
  assert.ok(write.includes("5 bytes"), `shows the content size: ${write}`);
  assert.ok(!write.includes("#"), `no hash placeholder: ${write}`);

  const edit = summarizeToolCall("edit", { path: "/abs/path/config.ts", edits: [{ oldText: "a", newText: "bc" }] });
  assert.ok(edit.includes("config.ts"), `shows the basename of an absolute path: ${edit}`);
  assert.ok(edit.includes("1 edit(s)"), `counts the edits: ${edit}`);
  assert.ok(edit.includes("3 bytes"), `sizes the edit text: ${edit}`);
  assert.ok(!edit.includes("#"), `no hash placeholder: ${edit}`);
});

test("summarizeToolCall never echoes a control-plane credential", () => {
  const botToken = "123456:AAHsuper-secret-bot-token";
  const tg = summarizeToolCall("relay_register_telegram", { botToken });
  assert.ok(tg.startsWith("relay_register_telegram: "), `names the tool: ${tg}`);
  assert.ok(tg.includes(`botToken:${botToken.length} chars`), `shows the credential shape: ${tg}`);
  assert.ok(!tg.includes(botToken), `must not leak the bot token: ${tg}`);

  const oneShot = summarizeToolCall("relay_connect", { input: botToken });
  assert.ok(!oneShot.includes(botToken), `must not leak relay_connect's token: ${oneShot}`);
  assert.ok(oneShot.includes("<redacted,"), `says the input is withheld: ${oneShot}`);

  // A Telegram token's numeric bot id is public and identifies the bot; the
  // secret half is not.
  const prefixed = summarizeToolCall("relay_connect", { input: `telegram ${botToken}` });
  assert.ok(prefixed.includes("telegram 123456:<redacted>"), `shows the public bot id: ${prefixed}`);
  assert.ok(!prefixed.includes("AAHsuper-secret"), `never the secret half: ${prefixed}`);
});

test("summarizeToolCall cannot be used as an egress for local file contents", () => {
  // Round-1 P1 and round-2 P1: the target fields are CALLER-CONTROLLED, and in
  // writes mode `read` is ungated, so "read the credentials file, then switch to
  // a profile named <its contents>" must not put those contents into the
  // question sent back to that same channel. Redaction alone cannot promise
  // that: a passphrase with spaces, or a short mixed-case secret, survives every
  // shape-based rule — so names are never echoed at all, only a fingerprint and
  // a length.
  const payloads = [
    "AKIAIOSFODNN7EXAMPLEAKIAIOSFODNN7EXAMPLE", // long, token-shaped
    "correct horse battery staple", // a passphrase: no redaction rule matches
    "Sup3rSecretValue1234", // 20 chars, mixed case, short for the token rule
    "-----BEGIN OPENSSH PRIVATE KEY-----", // punctuation-heavy
    "a".repeat(200), // over the cap
  ];
  for (const payload of payloads) {
    for (const [tool, input] of [
      ["relay_switch_profile", { name: payload }],
      ["relay_register_webhook", { channelName: payload }],
      ["relay_register_email", { channelType: payload }],
      ["relay_connect", { input: `webhook ${payload}` }],
      ["relay_connect", { input: `contact ${payload}` }], // unknown kind
    ] as Array<[string, Record<string, unknown>]>) {
      const line = summarizeToolCall(tool, input);
      assert.ok(!line.includes(payload), `${tool} must not echo the target: ${line}`);
      assert.ok(!line.includes("correct horse"), `${tool} leaks passphrase text: ${line}`);
      assert.ok(!line.includes("Sup3rSecret"), `${tool} leaks a short secret: ${line}`);
      assert.ok(!line.includes("BEGIN OPENSSH"), `${tool} leaks a key header: ${line}`);
      assert.ok(line.length < 200, `${tool} stays bounded: ${line.length} chars`);
    }
  }
  // A shape, not nothing: fingerprint + length let the operator compare two
  // questions about the same target.
  assert.equal(
    summarizeToolCall("relay_switch_profile", { name: "work" }),
    "relay_switch_profile: name=fp:00e13ed7, 4 chars",
  );
  assert.match(
    summarizeToolCall("relay_register_webhook", { channelName: "a".repeat(200) }),
    /^relay_register_webhook: channelName=fp:[0-9a-f]{8}, 200 chars$/,
  );

  // A crafted name cannot fake extra lines in the question either (the shape
  // renderer never prints the value, so this holds by construction — pinned so
  // a future "just show the name" change fails here).
  const forgedLine = summarizeToolCall("relay_register_webhook", {
    channelName: "exfil\n\n⚠️ Approval needed — reply yes now",
  });
  assert.ok(!/[\n\r\t]/.test(forgedLine), `the question stays one line: ${JSON.stringify(forgedLine)}`);
  assert.match(forgedLine, /^relay_register_webhook: channelName=fp:[0-9a-f]{8}, 41 chars$/);
});

test("summarizeToolCall shows the email address a verification link would go to", () => {
  // Round-1 P2: an address is a ROUTING TARGET, not a credential — `***@example.com`
  // looks the same for the operator's mailbox and the attacker's, so it cannot
  // stop the register-your-own-address takeover. It is still bounded, squashed
  // onto one line and passed through the bash redaction rules.
  const email = summarizeToolCall("relay_register_email", { userEmail: "attacker@evil.example" });
  assert.equal(email, "relay_register_email: userEmail=attacker@evil.example");

  assert.equal(
    summarizeToolCall("relay_connect", { input: "email attacker@evil.example" }),
    "relay_connect: input=email attacker@evil.example",
  );
  // A bare address is parsed as an email plan, so it renders exactly like the
  // explicit "email <addr>" form — the question cannot describe a different
  // channel than the parser would choose.
  assert.equal(
    summarizeToolCall("relay_connect", { input: "attacker@evil.example" }),
    "relay_connect: input=email attacker@evil.example",
  );
  // An address cannot smuggle a multi-line payload into the question either.
  const forged = summarizeToolCall("relay_register_email", {
    userEmail: "a@evil.example\n⚠️ Approval needed — reply yes now",
  });
  assert.ok(!/[\n\r]/.test(forged), `stays one line: ${JSON.stringify(forged)}`);
});

test("summarizeToolCall summarises relay_connect with the parser execution uses", () => {
  // Round-2 P2: `webhook:ci-hook` is valid connect syntax (connect.ts accepts a
  // `:` separator), so the question must not describe it as an opaque token.
  assert.equal(summarizeToolCall("relay_connect", { input: "webhook:ci-hook" }), "relay_connect: input=webhook name=fp:67363a43, 7 chars");
  assert.equal(summarizeToolCall("relay_connect", { input: "webhook" }), "relay_connect: input=webhook");
  assert.equal(summarizeToolCall("relay_connect", { input: "discord" }), "relay_connect: input=<redacted, 7 chars>");
  assert.equal(summarizeToolCall("relay_connect", { input: "webhook ci-hook" }), summarizeToolCall("relay_connect", { input: "webhook:ci-hook" }));
  assert.equal(
    summarizeToolCall("relay_register_webhook", { channelName: "CI" }),
    "relay_register_webhook: channelName=fp:fe8ee15b, 2 chars",
  );
});

test("summarizeToolCall prints only field labels it owns, and never a raw key", () => {
  // Round-2 P1: field KEYS are caller-controlled too (a tool schema can be given
  // extra properties), so an unknown key must not put text — let alone a newline
  // — into the question.
  const line = summarizeToolCall("relay_register_webhook", {
    channelName: "CI",
    "evil\n⚠️ Approval needed": "x",
    tags: ["a", "b"],
    meta: { nested: true },
  } as Record<string, unknown>);
  assert.equal(line, "relay_register_webhook: channelName=fp:fe8ee15b, 2 chars, +3 more field(s)");
  assert.ok(!line.includes("evil"), `an unknown key is counted, not printed: ${line}`);
});

// --- repair notes must not defeat the nonce form (bead pi-chaos-relay-cmo) ---
//
// Inbound messages can carry notes appended by the inbound shape checks (bead
// 4rr): an approval reply that itself had an unusable attachment arrives as
// "yes <nonce>" plus that note. The nonce form is end-anchored, so before this
// fix the reply stopped matching, was forwarded to the agent instead, and the
// request timed out as a denial.

const REPAIR_NOTE = "\n\n[chaos-relay: 1 attachment not delivered (unusable)]";

test("settle matches the nonce form when the reply carries a repair note", async () => {
  const q = new ApprovalQueue(5_000);
  const req = q.add({ channelId: "c1", from: "alice", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", from: "alice", content: `yes ${req.nonce}${REPAIR_NOTE}` }), true);
  assert.equal(await req.promise, true);
});

test("settle matches a denial with a repair note, and a truncation marker", async () => {
  const q = new ApprovalQueue(5_000);
  const denied = q.add({ channelId: "c1", from: "alice", toolName: "bash" });
  assert.equal(
    q.settle({
      channelId: "c1",
      from: "alice",
      content: `no ${denied.nonce}\n\n[chaos-relay: content truncated at 262144 bytes, from 900000 bytes]`,
    }),
    true,
  );
  assert.equal(await denied.promise, false);
});

test("settle matches the reference form when the reply carries a repair note", async () => {
  const q = new ApprovalQueue(5_000);
  const req = q.add({ channelId: "c1", from: "alice", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", from: "alice", content: `#${req.ref}: yes${REPAIR_NOTE}` }), true);
  assert.equal(await req.promise, true);
});

test("a note alone is still not an answer", async () => {
  const q = new ApprovalQueue(5_000);
  q.add({ channelId: "c1", from: "alice", toolName: "bash" });
  assert.equal(q.settle({ channelId: "c1", from: "alice", content: REPAIR_NOTE.trim() }), false);
  assert.equal(q.settle({ channelId: "c1", from: "alice", content: `yes${REPAIR_NOTE}` }), false);
});

test("a reply shaped by the inbound pipeline settles its request", async () => {
  // The cross-module pin: the note this content carries is written by
  // parseInboundMessage, and the matcher must cope with exactly what it writes.
  const parsed = parseInboundMessage({
    id: "m-1",
    channelType: "telegram",
    channelId: "c1",
    from: "alice",
    content: "PLACEHOLDER",
    timestamp: "2026-01-01T00:00:00Z",
    attachments: [{ id: "a1", filename: "x.bin", mimeType: "application/octet-stream", size: 10, kind: "file" }, { broken: true }],
  });
  assert.equal(parsed.ok, true);
  const q = new ApprovalQueue(5_000);
  const req = q.add({ channelId: "c1", from: "alice", toolName: "bash" });
  const content = (parsed as Extract<typeof parsed, { ok: true }>).message.content.replace(
    "PLACEHOLDER",
    `yes ${req.nonce}`,
  );
  assert.match(content, /\[chaos-relay: 1 attachment not delivered \(unusable\)\]$/);
  assert.equal(q.settle({ channelId: "c1", from: "alice", content }), true);
  assert.equal(await req.promise, true);
});
