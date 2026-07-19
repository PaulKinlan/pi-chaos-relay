import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupStaleInboundAttachments,
  materializeInboundAttachments,
  safeInboundFilename,
} from "../inbound-attachments.ts";
import type {
  ChannelMessage,
  DownloadedAttachment,
  InboundAttachment,
  RelayClient,
} from "../relay-client.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function attachment(overrides: Partial<InboundAttachment> = {}): InboundAttachment {
  return {
    id: "att-1",
    filename: "image.png",
    mimeType: "image/png",
    size: PNG.length,
    kind: "image",
    ...overrides,
  };
}

function message(attachments = [attachment()]): ChannelMessage {
  return {
    id: "message-1",
    channelType: "telegram",
    channelId: "channel-1",
    from: "Paul",
    content: "look at this",
    timestamp: new Date().toISOString(),
    attachments,
  };
}

function fakeClient(
  implementation: (attachment: InboundAttachment) => Promise<DownloadedAttachment>,
): RelayClient {
  return {
    downloadAttachment: async (_messageId: string, value: InboundAttachment) =>
      implementation(value),
  } as unknown as RelayClient;
}

test("sanitizes traversal and control characters from inbound names", () => {
  assert.equal(safeInboundFilename("../../etc/passwd"), "passwd");
  assert.equal(safeInboundFilename("..\\..\\evil\u0000.png"), "evil.png");
  assert.equal(safeInboundFilename(".."), "attachment");
});

test("materializes a private file and emits a verified Pi image", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const client = fakeClient(async (item) => ({
    bytes: PNG,
    filename: item.filename,
    mimeType: item.mimeType,
  }));
  const result = await materializeInboundAttachments(client, [message()], root);
  assert.equal(result.files.length, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.match(result.messages[0].content, /saved to \/.*image\.png/);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(result.files[0])).mode & 0o777, 0o600);
  assert.ok(result.files[0].startsWith(root + "/"));
});

test("refuses a symlink attachment root and preserves the message text", async () => {
  const base = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const target = join(base, "target");
  const root = join(base, "root-link");
  await mkdir(target);
  await symlink(target, root);
  const client = fakeClient(async (item) => ({
    bytes: PNG,
    filename: item.filename,
    mimeType: item.mimeType,
  }));
  const result = await materializeInboundAttachments(client, [message()], root);
  assert.equal(result.files.length, 0);
  assert.match(result.messages[0].content, /Attachment unavailable/);
  assert.equal((await stat(target)).isDirectory(), true);
});

test("does not inject bytes as an image when magic does not match MIME", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const client = fakeClient(async (item) => ({
    bytes: new Uint8Array([1, 2, 3, 4]),
    filename: item.filename,
    mimeType: "image/png",
  }));
  const result = await materializeInboundAttachments(client, [message()], root);
  assert.equal(result.files.length, 1);
  assert.equal(result.images.length, 0);
});

test("attachment failure preserves and annotates the text message", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const client = fakeClient(async () => {
    throw new Error("expired");
  });
  const result = await materializeInboundAttachments(client, [message()], root);
  assert.equal(result.files.length, 0);
  assert.equal(result.images.length, 0);
  assert.match(result.messages[0].content, /^look at this/);
  assert.match(result.messages[0].content, /Attachment unavailable: image\.png — expired/);
});

test("materializer refuses more than three descriptors per message", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  let calls = 0;
  const client = fakeClient(async (item) => {
    calls++;
    return { bytes: PNG, filename: item.filename, mimeType: item.mimeType };
  });
  const many = Array.from({ length: 5 }, (_, index) =>
    attachment({ id: `att-${index}`, filename: `${index}.png` })
  );
  await materializeInboundAttachments(client, [message(many)], root);
  assert.equal(calls, 3);
});

test("cleanup removes stale owned directories but leaves fresh and unrelated entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const stale = join(root, "a".repeat(24));
  const fresh = join(root, "b".repeat(24));
  const unrelated = join(root, "do-not-touch");
  await mkdir(stale);
  await mkdir(fresh);
  await mkdir(unrelated);
  await writeFile(join(stale, "x"), "x");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await cleanupStaleInboundAttachments(root);
  await assert.rejects(stat(stale));
  assert.equal((await stat(fresh)).isDirectory(), true);
  assert.equal((await stat(unrelated)).isDirectory(), true);
});
