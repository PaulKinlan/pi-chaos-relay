import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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

function withEnv(env: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return body().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fakeImageClient(): RelayClient {
  return fakeClient(async (item) => ({
    bytes: PNG,
    filename: item.filename,
    mimeType: item.mimeType,
  }));
}

test("zh9: an unusable XDG_RUNTIME_DIR falls back to the temp dir instead of dropping the image", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-zh9-"));
  // Hermetic: a path that CANNOT exist because its parent is a regular file, rather
  // than a name that merely happens not to exist on this machine.
  const blocker = join(sandbox, "blocker");
  await writeFile(blocker, "not a directory");
  await withEnv({ XDG_RUNTIME_DIR: join(blocker, "run"), TMPDIR: sandbox }, async () => {
    const result = await materializeInboundAttachments(fakeImageClient(), [message()]);
    assert.equal(result.images.length, 1, "the image must survive an unusable runtime dir");
    assert.equal(result.files.length, 1);
    assert.ok(result.files[0].startsWith(`${sandbox}/`), result.files[0]);
    assert.doesNotMatch(result.messages[0].content, /Attachment unavailable/);
    assert.match(result.messages[0].content, /saved to \/.*image\.png/);
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const fallbackRoot = join(sandbox, `pi-chaos-relay-inbound-${uid}`);
    assert.equal((await stat(fallbackRoot)).mode & 0o777, 0o700, "the fallback root must be private");
  });
});

test("zh9: when NO root can be created the message still arrives, with its text and a note", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-zh9-both-"));
  const blocker = join(sandbox, "blocker");
  await writeFile(blocker, "not a directory");
  // Preferred AND fallback are unusable: this used to reject the whole batch, which made
  // index.ts drop the queued delivery entirely (review round 1, P1).
  await withEnv({ XDG_RUNTIME_DIR: join(blocker, "run"), TMPDIR: join(blocker, "tmp") }, async () => {
    const result = await materializeInboundAttachments(fakeImageClient(), [message()]);
    assert.equal(result.images.length, 0);
    assert.equal(result.files.length, 0);
    assert.equal(result.messages.length, 1, "the message itself must survive");
    assert.match(result.messages[0].content, /look at this/, "the text must survive");
    assert.match(result.messages[0].content, /Attachment unavailable/);
  });
});

test("zh9: a usable XDG_RUNTIME_DIR is still used as-is, with no fallback", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-zh9-ok-"));
  await withEnv({ XDG_RUNTIME_DIR: sandbox }, async () => {
    const result = await materializeInboundAttachments(fakeImageClient(), [message()]);
    assert.equal(result.images.length, 1);
    assert.ok(result.files[0].startsWith(`${sandbox}/`), result.files[0]);
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    assert.equal((await stat(join(sandbox, `pi-chaos-relay-inbound-${uid}`))).mode & 0o777, 0o700);
  });
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

test("attachment failure annotation redacts URL secrets from the reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const secret = "attachment-download-secret";
  const client = fakeClient(async () => {
    throw new Error(
      `download failed: https://relay.example.com/files/a.png?token=${secret}#part2`,
    );
  });
  const result = await materializeInboundAttachments(client, [message()], root);
  assert.equal(result.files.length, 0);
  assert.match(result.messages[0].content, /Attachment unavailable: image\.png — download failed/);
  assert.ok(!result.messages[0].content.includes(secret), `must not leak the query token: ${result.messages[0].content}`);
  assert.ok(!result.messages[0].content.includes("token="), `must not leak the query string: ${result.messages[0].content}`);
  assert.ok(!result.messages[0].content.includes("/files"), `must not leak the path: ${result.messages[0].content}`);
  assert.ok(!result.messages[0].content.includes("part2"), `must not leak the fragment: ${result.messages[0].content}`);
  assert.ok(result.messages[0].content.includes("https://relay.example.com"), `keeps the origin: ${result.messages[0].content}`);
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

test("0p3: cleanup removes stale children in both roots while preserving fresh children", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-0p3-"));
  const runtime = join(sandbox, "runtime");
  const temp = join(sandbox, "temp");
  await mkdir(runtime);
  await mkdir(temp);
  try {
    await withEnv({ XDG_RUNTIME_DIR: runtime, TMPDIR: temp }, async () => {
      const uid = typeof process.getuid === "function" ? process.getuid() : "user";
      const preferred = join(runtime, `pi-chaos-relay-inbound-${uid}`);
      const fallback = join(temp, `pi-chaos-relay-inbound-${uid}`);
      const now = Date.now();
      const old = new Date(now - 25 * 60 * 60 * 1000);
      for (const root of [preferred, fallback]) {
        await mkdir(root);
        await mkdir(join(root, "a".repeat(24)));
        await utimes(join(root, "a".repeat(24)), old, old);
        await mkdir(join(root, "b".repeat(24)));
        await mkdir(join(root, "do-not-touch"));
      }
      await cleanupStaleInboundAttachments(undefined, now);
      for (const root of [preferred, fallback]) {
        await assert.rejects(stat(join(root, "a".repeat(24))), { code: "ENOENT" });
        assert.equal((await stat(join(root, "b".repeat(24)))).isDirectory(), true);
        assert.equal((await stat(join(root, "do-not-touch"))).isDirectory(), true);
      }
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("0p3: cleanup does not create an unused fallback root", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-0p3-empty-"));
  const runtime = join(sandbox, "runtime");
  const temp = join(sandbox, "temp");
  await mkdir(runtime);
  await mkdir(temp);
  try {
    await withEnv({ XDG_RUNTIME_DIR: runtime, TMPDIR: temp }, async () => {
      const uid = typeof process.getuid === "function" ? process.getuid() : "user";
      const fallback = join(temp, `pi-chaos-relay-inbound-${uid}`);
      await cleanupStaleInboundAttachments();
      await assert.rejects(stat(fallback), { code: "ENOENT" });
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("cleanup removes stale owned directories but leaves fresh and unrelated entries", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "relay-inbound-test-"));
  const runtime = join(sandbox, "runtime");
  const temp = join(sandbox, "temp");
  await mkdir(runtime);
  await mkdir(temp);
  try {
    await withEnv({ XDG_RUNTIME_DIR: runtime, TMPDIR: temp }, async () => {
      const root = join(runtime, "custom-root");
      await mkdir(root);
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
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
