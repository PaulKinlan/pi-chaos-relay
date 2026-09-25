// Tests for the reply-confirmation honesty layer (journal-xk4).
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatReplyConfirmation,
  formatReplyRefusal,
} from "../reply-format.ts";

const requested = { channelType: "telegram", channelId: "0885fd1e-426b" };

test("resolved-channel ack confirms against the relay's observation", () => {
  const text = formatReplyConfirmation(
    {
      ok: true,
      responseId: "resp-1",
      channel: { id: "0885fd1e-426b", type: "telegram", label: "@paul_bot" },
    },
    requested,
    "WebSocket",
  );
  assert.match(text, /dispatched by relay to telegram channel "@paul_bot"/);
  assert.match(text, /0885fd1e-426b/);
  assert.match(text, /via WebSocket/);
  assert.match(text, /response resp-1/);
  assert.doesNotMatch(text, /echo/i, "a resolved ack must not carry echo warnings");
});

test("legacy relay-echo fields are used but flagged as not a resolved identity", () => {
  const text = formatReplyConfirmation(
    { ok: true, channelType: "telegram", channelId: "0885fd1e-426b" },
    requested,
    "HTTP",
  );
  assert.match(text, /accepted by relay for telegram channel 0885fd1e-426b/);
  assert.match(text, /did not return the resolved channel identity/);
  assert.match(text, /relay echoed/);
});

test("an ack naming nothing says it only echoes the request", () => {
  const text = formatReplyConfirmation({ ok: true }, requested, "WebSocket");
  assert.match(text, /WARNING/);
  assert.match(text, /only echoes the requested id/);
  assert.match(text, /NOT proof of delivery/);
  assert.match(text, /telegram channel 0885fd1e-426b/);
});

test("a refusal quotes the relay's reason verbatim and says nothing was sent", () => {
  const reason =
    'Unknown channel 0885fd1e-426c: no telegram channel with that id is registered for this session. Refused — nothing was sent.';
  const text = formatReplyRefusal({ ok: false, error: reason });
  assert.match(text, /REFUSED by relay — Unknown channel 0885fd1e-426c/);
  assert.match(text, /Nothing was sent\./);
});

test("a refusal without a reason admits it", () => {
  const text = formatReplyRefusal({ ok: false });
  assert.match(text, /no reason given/);
});
