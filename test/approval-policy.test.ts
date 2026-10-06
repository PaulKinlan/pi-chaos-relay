import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalDecision } from "../approval-policy.ts";

test("off gates nothing (explicit opt-out)", () => {
  assert.equal(approvalDecision("off", "bash"), false);
  assert.equal(approvalDecision("off", "edit"), false);
  assert.equal(approvalDecision("off", "write"), false);
  assert.equal(approvalDecision("off", "relay_reply", { files: ["/x"] }), false);
  assert.equal(approvalDecision("off", "relay_connect"), false);
  assert.equal(approvalDecision("off", "relay_switch_profile"), false);
});

test("writes gates non-relay write-class tools only", () => {
  assert.equal(approvalDecision("writes", "bash"), true);
  assert.equal(approvalDecision("writes", "edit"), true);
  assert.equal(approvalDecision("writes", "write"), true);
  assert.equal(approvalDecision("writes", "read"), false);
  assert.equal(approvalDecision("writes", "grep"), false);
});

test("writes: relay_reply is gated only with outbound files", () => {
  assert.equal(approvalDecision("writes", "relay_reply"), false, "text-only reply is the conversation");
  assert.equal(approvalDecision("writes", "relay_reply", {}), false);
  assert.equal(approvalDecision("writes", "relay_reply", { files: [] }), false);
  assert.equal(
    approvalDecision("writes", "relay_reply", { files: ["/x"] }),
    true,
    "shipping a file is write-class",
  );
});

test("writes: other relay tools stay ungated", () => {
  for (const tool of [
    "relay_check_messages",
    "relay_list_profiles",
    "relay_connect",
    "relay_register_telegram",
    "relay_register_discord",
    "relay_register_email",
    "relay_register_webhook",
    "relay_switch_profile",
  ]) {
    assert.equal(approvalDecision("writes", tool), false, `${tool} ungated in writes`);
  }
});

test("all: read-only relay plumbing is ungated", () => {
  assert.equal(approvalDecision("all", "relay_check_messages"), false);
  assert.equal(approvalDecision("all", "relay_list_profiles"), false);
});

test("all: everything else in the relay namespace is gated", () => {
  assert.equal(approvalDecision("all", "relay_reply"), true);
  assert.equal(approvalDecision("all", "relay_reply", { files: ["/x"] }), true);
  assert.equal(approvalDecision("all", "relay_connect"), true);
  assert.equal(approvalDecision("all", "relay_register_telegram"), true);
  assert.equal(approvalDecision("all", "relay_register_discord"), true);
  assert.equal(approvalDecision("all", "relay_register_email"), true);
  assert.equal(approvalDecision("all", "relay_register_webhook"), true);
  assert.equal(approvalDecision("all", "relay_switch_profile"), true);
});

test("all: non-relay tools are gated", () => {
  assert.equal(approvalDecision("all", "bash"), true);
  assert.equal(approvalDecision("all", "read"), true);
});

test("all: a brand-new relay_* name is gated (default-deny for the namespace)", () => {
  assert.equal(
    approvalDecision("all", "relay_some_future_tool"),
    true,
    "a future relay tool must not silently bypass the gate",
  );
});
