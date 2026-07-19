import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelMessage,
  DownloadedAttachment,
  InboundAttachment,
  RelayClient,
} from "./relay-client.ts";
import { base64FromBytes } from "./relay-client.ts";

const MAX_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENTS_PER_MESSAGE = 3;

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface MaterializedMessages {
  messages: ChannelMessage[];
  images: PiImageContent[];
  files: string[];
}

export function defaultInboundAttachmentRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(runtime, `pi-chaos-relay-inbound-${uid}`);
}

function opaqueDirectory(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 24);
}

export function safeInboundFilename(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").pop() || "attachment";
  const cleaned = leaf
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe attachment directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Attachment directory is owned by another user: ${path}`);
  }
  await chmod(path, 0o700);
}

async function savePrivateAttachment(
  root: string,
  messageId: string,
  attachment: DownloadedAttachment,
): Promise<string> {
  await ensurePrivateDirectory(root);
  const dir = join(root, opaqueDirectory(messageId));
  await ensurePrivateDirectory(dir);
  const nonce = randomBytes(6).toString("hex");
  const path = join(dir, `${nonce}-${safeInboundFilename(attachment.filename)}`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(attachment.bytes);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return path;
}

function imageMimeFromMagic(bytes: Uint8Array, claimed: string): string | undefined {
  const mime = claimed.toLowerCase().split(";", 1)[0].trim();
  if (
    mime === "image/png" && bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return mime;
  if (
    mime === "image/jpeg" && bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  ) return mime;
  if (
    mime === "image/gif" && bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))
  ) return mime;
  if (
    mime === "image/webp" && bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return mime;
  return undefined;
}

/** Remove only stale children from the extension-owned private temp root. */
export async function cleanupStaleInboundAttachments(
  root = defaultInboundAttachmentRoot(),
  now = Date.now(),
): Promise<void> {
  let entries;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) return;
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > MAX_ATTACHMENT_AGE_MS) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or process may already have removed it.
    }
  }
}

async function materializeOne(
  client: RelayClient,
  root: string,
  message: ChannelMessage,
  attachment: InboundAttachment,
): Promise<{ path: string; image?: PiImageContent }> {
  const downloaded = await client.downloadAttachment(message.id, attachment);
  const path = await savePrivateAttachment(root, message.id, downloaded);
  const imageMime = imageMimeFromMagic(downloaded.bytes, downloaded.mimeType);
  return {
    path,
    ...(imageMime
      ? {
        image: {
          type: "image" as const,
          mimeType: imageMime,
          data: base64FromBytes(downloaded.bytes),
        },
      }
      : {}),
  };
}

/**
 * Download inbound descriptors without allowing a failed file to discard its
 * text message. Returned message copies include absolute local paths/errors.
 */
export async function materializeInboundAttachments(
  client: RelayClient,
  messages: ChannelMessage[],
  root = defaultInboundAttachmentRoot(),
): Promise<MaterializedMessages> {
  const images: PiImageContent[] = [];
  const files: string[] = [];
  const hydrated: ChannelMessage[] = [];

  for (const message of messages) {
    const annotations: string[] = [];
    const attachments = (message.attachments || []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    const results = await Promise.allSettled(
      attachments.map((attachment) => materializeOne(client, root, message, attachment)),
    );
    for (let index = 0; index < results.length; index++) {
      const attachment = attachments[index];
      const settled = results[index];
      if (settled.status === "fulfilled") {
        files.push(settled.value.path);
        if (settled.value.image) images.push(settled.value.image);
        annotations.push(
          `Attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.size || "unknown"} bytes) saved to ${settled.value.path}`,
        );
      } else {
        const reason = settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
        annotations.push(`Attachment unavailable: ${attachment.filename} — ${reason}`);
      }
    }
    hydrated.push({
      ...message,
      content: annotations.length
        ? `${message.content}\n\n${annotations.join("\n")}`
        : message.content,
    });
  }
  return { messages: hydrated, images, files };
}
