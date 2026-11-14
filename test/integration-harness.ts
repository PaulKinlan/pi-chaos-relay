/**
 * Shared harness for the index.ts integration suites (bead pi-chaos-relay-h1t,
 * ADR pi-chaos-relay-mpf).
 *
 * The monolithic test/index.test.ts was partitioned into behavior-owned suites
 * (test/index-*.test.ts) so that independent lanes stop colliding on one file
 * and a test-only change can run just its own suite in the fast gate. Every
 * suite drives the REAL extension the same way: instantiate the default export
 * with a fake ExtensionAPI, capture the handlers/commands it registers, drive
 * them, and assert on observable effects (files on disk, the notification the
 * user would see, the config path the process is bound to).
 *
 * THIS MODULE IS INERT AT IMPORT: nothing here touches process.env, the
 * filesystem outside a call, or the modules under test. config.ts resolves
 * CONFIG_DIR from homedir() at import and index.ts resolves lock files from
 * homedir() at call time, so each suite calls createSandbox() BEFORE its
 * dynamic imports of ../config.ts and ../index.ts — a static (or pre-sandbox
 * dynamic) import of either would bind the real ~/.pi, and
 * test/fast-gate.test.ts guards exactly that ordering. No test reads or writes
 * the real ~/.pi/chaos-relay.json.
 */

import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionBinding } from "../config.ts";
import type { ChannelMessage, GetMessagesResult, RelayClient } from "../relay-client.ts";

export const OFFLINE_RELAY_URL = "http://127.0.0.1:9"; // refused instantly; keeps every connect local

export interface Sandbox {
  HOME_DIR: string;
  PI_DIR: string;
  RUNTIME_DIR: string;
}

/**
 * Redirect this process into a throwaway HOME and return its paths. MUST run
 * before the suite's dynamic imports of ../config.ts and ../index.ts. Each
 * suite file runs in its own node --test child process, so the env mutation is
 * process-local and the mkdtemp root is unique per suite.
 */
export function createSandbox(): Sandbox {
  const HOME_DIR = mkdtempSync(join(tmpdir(), "pi-chaos-relay-index-test-"));
  const PI_DIR = join(HOME_DIR, ".pi");
  mkdirSync(PI_DIR, { recursive: true });

  process.env.HOME = HOME_DIR;
  delete process.env.CHAOS_RELAY_CONFIG;
  delete process.env.CHAOS_RELAY_PROFILE;
  delete process.env.CHAOS_RELAY_API_KEY;
  // Also clear the approval mode: this machine's shell environment (the fleet's
  // ~/.fleet/env) exports CHAOS_RELAY_APPROVAL_MODE=off, and resolveConfig gives the
  // environment precedence over the profile file, so every approval/attribution test
  // in this file silently ran with approvals disabled and failed (bead
  // pi-chaos-relay-wbj). A test suite must not depend on the operator's environment.
  delete process.env.CHAOS_RELAY_APPROVAL_MODE;
  // Inbound attachments are saved under $XDG_RUNTIME_DIR (else tmpdir()), read per
  // call by defaultInboundAttachmentRoot in inbound-attachments.ts — not under HOME.
  // Left unpinned, the image tests wrote into the operator's real runtime dir, and a
  // login shell exporting XDG_RUNTIME_DIR=/run/user/<uid> where that dir is missing
  // made them fail (bead pi-chaos-relay-eho). Keep it inside the sandbox.
  const RUNTIME_DIR = join(HOME_DIR, "run");
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  process.env.XDG_RUNTIME_DIR = RUNTIME_DIR;
  // env beats the persisted file in resolveConfig, so this pins the relay URL for
  // every connect attempt in this file (including doctor's reachability check).
  process.env.CHAOS_RELAY_URL = OFFLINE_RELAY_URL;

  return { HOME_DIR, PI_DIR, RUNTIME_DIR };
}

export type Handler = (event: unknown, ctx: unknown) => unknown;

export interface Notification {
  message: string;
  level?: string;
}

/**
 * Stub global fetch so any non-loopback request throws instead of reaching a
 * real host. The registration tests point CHAOS_RELAY_URL at a local loopback
 * relay, so a regression that ever ignores the configured URL and POSTs to the
 * production relay fails fast here instead of making a real network call first.
 * Returns the previous fetch for restoration in the test's `after`.
 */
export function blockNonLoopbackFetch(): typeof fetch {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    let host = "unparseable";
    try {
      host = new URL(href).hostname;
    } catch {
      /* leave unparseable → blocked below */
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(`blocked non-loopback fetch: ${href}`);
    }
    return (prev as unknown as (i: string, o?: unknown) => Promise<Response>)(href, init);
  }) as unknown as typeof fetch;
  return prev;
}

export function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const tools: Array<Record<string, unknown>> = [];
  const notifications: Notification[] = [];
  /**
   * Each delivered message, as { content, prompt }: `prompt` is the text the delivery
   * handed to pi, which the extension later sees as that turn's user message in
   * `message_start` — not via `before_agent_start`, which queued follow-ups never reach.
   * The SDK joins
   * a content array's text parts with "\n" and does not expand prompt templates
   * (dist/core/agent-session.js sendUserMessage), so this mirrors what the
   * extension matches on.
   */
  const sent: Array<{ content: unknown; prompt: string }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, def: { handler: Handler }) {
      commands.set(name, def);
    },
    registerTool(def: Record<string, unknown>) {
      tools.push(def);
    },
    sendUserMessage: (content: unknown, _opts?: unknown) => {
      sent.push({
        content,
        prompt:
          typeof content === "string"
            ? content
            : (Array.isArray(content) ? content : [])
                .filter((p): p is { type: string; text: string } =>
                  Boolean(p) && (p as { type?: string }).type === "text",
                )
                .map((p) => p.text)
                .join("\n"),
      });
    },
  };
  return { pi, handlers, commands, tools, notifications, sent };
}

export function makeCtx(sessionId: string, notifications: Notification[]) {
  return {
    model: { input: ["text"] },
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
  };
}

/**
 * Fire a lifecycle event the way pi does, whether or not the extension listens.
 *
 * `callHandler` asserts that a handler is registered, which is the right check for the
 * events an extension is supposed to handle — but pi emits lifecycle events regardless,
 * and bead pi-chaos-relay-a1j deliberately removed the extension's `agent_start`
 * handler (it used to start the typing indicator there, before turn provenance was
 * known). So turn-starting must not require a listener.
 */
export async function fireLifecycle(
  fake: ReturnType<typeof makeFakePi>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<void> {
  if (!fake.handlers.has(name)) return;
  await callHandler(fake.handlers, name, event, ctx);
}

/**
 * Simulate a fresh agent run: `agent_start`, then the turn's user `message_start`.
 * Queued follow-ups within an existing run emit no new `agent_start`, so this models the
 * start of a run rather than every turn in one.
 * Bead pi-chaos-relay-pl2: turn binding matches the prompt carried by that user message
 * rather than by `before_agent_start`, which the SDK emits only from its idle prompt path
 * (see the note below), so a test that fired only `agent_start` would not be testing the
 * real order.
 *
 * `prompt` defaults to the text of the most recent delivery — the turn that
 * delivery started. Pass a different string to simulate a turn the relay did not
 * drive, such as one typed in the terminal.
 */
export async function startTurn(
  fake: ReturnType<typeof makeFakePi>,
  ctx: unknown,
  prompt?: string,
): Promise<void> {
  const last = fake.sent[fake.sent.length - 1];
  const text = prompt ?? last?.prompt ?? "";
  // Deliberately no `before_agent_start`: the extension binds turn origins on
  // `message_start`, because `before_agent_start` is emitted only from the SDK's idle
  // `prompt()` path and a message delivered while the agent is streaming never reaches
  // it. Firing it here would model a lifecycle this extension must not depend on.
  // SDK order: agent_start, then the turn's user message (the exported event
  // declarations in types.d.ts carry the ordering contract; review round 3 corrected my
  // earlier reversal. It matters here for typing: agent_start has no handler since bead
  // pi-chaos-relay-a1j, so it neither starts nor clears the indicator — the timer left
  // running by the PREVIOUS run is what the user message clears.)
  await fireLifecycle(fake, "agent_start", {}, ctx);
  await callHandler(
    fake.handlers,
    "message_start",
    { type: "message_start", message: { role: "user", content: [{ type: "text", text }] } },
    ctx,
  );
}

/** Run every handler registered for a lifecycle event, like pi would. */
export async function callHandler(
  handlers: Map<string, Handler[]>,
  name: string,
  event: unknown,
  ctx: unknown,
): Promise<void> {
  const list = handlers.get(name) ?? [];
  assert.ok(list.length > 0, `extension registers a ${name} handler`);
  for (const handler of list) await handler(event, ctx);
}

/** Is `pid` a live process? (Matches index.ts's isProcessAlive.) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in WebSocket that can be forced to fail its handshake, so the
 * auth-recovery path (and the channel re-bind it triggers) can be driven. */
export class FailingWebSocket {
  static instances: FailingWebSocket[] = [];
  /** The URL this socket was constructed for — lets a test pick ITS OWN
   * instance out of the shared static registry by apiKey, instead of assuming
   * `instances[0]` belongs to it (stale clients from earlier tests can still
   * construct into the registry while this test is running). */
  readonly url: string;
  /** The upgrade headers: the apiKey travels here, not in the URL. */
  readonly headers: Record<string, string>;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(url: string, init?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = init?.headers ?? {};
    FailingWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {}
  failHandshake(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** A stand-in WebSocket that captures instances so a test can drive an inbound
 * push frame through the WS transport without a real socket. */
export class PushWebSocket {
  static instances: PushWebSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(url: string, init?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = init?.headers ?? {};
    PushWebSocket.instances.push(this);
  }
  url: string;
  /** The upgrade headers: the apiKey travels here, not in the URL. */
  headers: Record<string, string>;
  send(): void {}
  close(): void {}
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  pushFrame(data: string): void {
    this.onmessage?.({ data } as unknown as MessageEvent);
  }
}

/**
 * Does THIS socket carry the given apiKey, wherever ws-client put it?
 *
 * The shipping default is the relay's `?token=` query form (the relay's /ws
 * handler reads it and 401s without it), and `CHAOS_RELAY_WS_AUTH=header` puts the
 * key in the upgrade request instead. Matching either carrier keeps socket
 * selection deterministic without assuming a mode.
 */
export function socketCarries(socket: PushWebSocket | FailingWebSocket, apiKey: string): boolean {
  if (socket.headers.Authorization === `Bearer ${apiKey}`) return true;
  try {
    return new URL(socket.url).searchParams.get("token") === apiKey;
  } catch {
    return false;
  }
}

/**
 * The socket THIS test's extension opened. Matching on the apiKey — rather than
 * `instances[0]` — is what makes this deterministic: a still-reconnecting socket
 * left behind by an earlier test can construct into the shared registry while this
 * test runs, and that made the d8e regression tests flake.
 */
export function socketForProfile(apiKey: string): PushWebSocket {
  const socket = PushWebSocket.instances.find((s) => socketCarries(s, apiKey));
  assert.ok(socket, `no WebSocket was opened for api key ${apiKey}`);
  return socket;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Concurrency probe for the auth-recovery channel re-bind. `enter()` records
 * how many registrations are in flight at once and opens a barrier only once
 * `expected` of them have entered. A SERIAL re-bind never reaches the barrier,
 * so it times out here and the test fails on `maxInFlight()` instead of hanging.
 */
export function makeInflightProbe(expected: number, timeoutMs: number) {
  let inFlight = 0;
  let maxInFlight = 0;
  let openGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    maxInFlight: () => maxInFlight,
    async enter(): Promise<void> {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      if (inFlight >= expected) openGate?.();
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
      inFlight -= 1;
    },
  };
}

/**
 * The state helpers that need the config module and the sandbox's ~/.pi. A
 * factory (not module scope) because the harness must stay inert at import: the
 * suite hands over its dynamically imported config and its sandbox PI_DIR, and
 * gets back the same helpers the monolith had as file-scope functions.
 */
export function createStateHelpers(config: typeof import("../config.ts"), PI_DIR: string) {
  const SESSIONS_PATH = join(PI_DIR, "chaos-relay-sessions.json");

  /** Lock path index.ts uses: ~/.pi/chaos-relay-<profile>.lock (homedir() at call time). */
  function lockPath(profile: string): string {
    const path = config.profilePathForName(profile);
    const canonical = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    return join(PI_DIR, `chaos-relay-${basename(canonical)}-${hash}.lock`);
  }

  function readSessionMap(): Record<string, SessionBinding> {
    if (!existsSync(SESSIONS_PATH)) return {};
    return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8")) as Record<string, SessionBinding>;
  }

  /** Relay-owned files directly under ~/.pi (config files, locks, session map). */
  function relayStateFiles(): string[] {
    return readdirSync(PI_DIR).filter((f) => f.startsWith("chaos-relay")).sort();
  }

  /** Clear per-test state and re-point the process at the default config. */
  function resetState(): void {
    for (const f of relayStateFiles()) {
      if (f.endsWith(".lock") || f.startsWith("chaos-relay-sessions.json")) {
        try {
          unlinkSync(join(PI_DIR, f));
        } catch {
          /* already gone */
        }
      }
    }
    delete process.env.CHAOS_RELAY_PROFILE;
    delete process.env.CHAOS_RELAY_CONFIG;
    config.setActiveConfigPath(join(PI_DIR, "chaos-relay.json"));
  }

  /**
   * Write an already-provisioned config file for a profile. Only the persistence
   * shape matters here (an apiKey makes the profile "configured" so no session is
   * ever registered against a relay); the tests never speak to a server.
   */
  function writeProfileConfig(profile: string, apiKey: string): string {
    const path =
      profile === "default"
        ? join(PI_DIR, "chaos-relay.json")
        : join(PI_DIR, `chaos-relay.${profile}.json`);
    writeFileSync(path, JSON.stringify({ relayUrl: OFFLINE_RELAY_URL, apiKey }) + "\n");
    return path;
  }

  return { SESSIONS_PATH, lockPath, readSessionMap, relayStateFiles, resetState, writeProfileConfig };
}

/**
 * A real, live process standing in for another pi session holding a profile
 * lock (checkProfileLock ignores a pid that is dead, so the holder must be
 * alive). Killed when the test ends.
 */
export function startOtherLiveSession(t: TestContext): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0, "spawned a stand-in session");
  assert.notEqual(pid, process.pid);
  return pid;
}

// ── a replaced session runtime must not deliver, and must not eat the batch ───
//
// pi replaces the session runtime for /new, /resume, /fork and /reload: it emits
// session_shutdown, disposes the session, and invalidates the WHOLE extension
// instance, so every later `pi.*` call throws the SDK's stale-runtime error. The
// poller has already persisted the cursor by then, so before this fix the batch
// was both reported as "attachment delivery failed" and lost. These tests drive
// the real extension with the SDK's own error text.

/** pi's exact words once an instance is invalidated (dist/core/extensions/loader.js). */
export const STALE_RUNTIME_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

export function pushMessage(socket: InstanceType<typeof PushWebSocket>, id: string, timestamp: string, content = "hi"): void {
  socket.pushFrame(
    JSON.stringify({
      type: "message",
      message: { id, channelType: "telegram", channelId: "ch-stale", from: "alice", content, timestamp },
    }),
  );
}

/**
 * A client that filters like the relay's `since` cursor under the STRICT reading
 * (only messages strictly after the cursor), which is the case the one-second
 * rewind exists for: an inclusive cursor would have replayed the dropped message
 * anyway, a strict one would have skipped it forever.
 */
export function windowedClient(messages: ChannelMessage[]): { client: RelayClient; asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  const client = {
    async getMessages(since?: string): Promise<GetMessagesResult> {
      asked.push(since);
      return { messages: messages.filter((m) => !since || (m.timestamp ?? "") > since), since: "" };
    },
  } as unknown as RelayClient;
  return { client, asked };
}

// --- plaintext relay URLs are refused unless deliberately opted in (8qv) -----
//
// An http:// URL outside loopback carries the bearer apiKey in the clear in every
// request AND in the WebSocket `?token=` query string. isValidRelayUrl now refuses
// it, so this lane must (a) refuse to auto-provision over it, (b) say WHICH problem
// it is (a well-formed plaintext URL is not a malformed one), and (c) warn loudly
// when the opt-in is what lets such a URL through.

/** A tool call in the shape the extension's tools are registered with. */
export function callTool(
  tool: { execute: unknown },
  params: Record<string, unknown>,
  notifications: Notification[],
  sessionId: string,
): Promise<unknown> {
  return (
    tool.execute as (
      id: string,
      params: Record<string, unknown>,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>
  )("t-insecure", params, undefined, undefined, {
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionId: () => sessionId },
  });
}

/**
 * Drive one auto-provisioning tool call with CHAOS_RELAY_URL/opt-in pinned. A
 * factory because the harness must not import the extension: the suite passes
 * its dynamically imported default export in.
 */
export function createWithRelayEnv<ExtensionPi>(chaosRelayExtension: (pi: ExtensionPi) => void) {
  return async function withRelayEnv<T>(
    t: TestContext,
    env: { url?: string; allowInsecure?: string },
    sessionId: string,
    run: (fake: ReturnType<typeof makeFakePi>, notifications: Notification[]) => Promise<T>,
  ): Promise<T> {
    const prevUrl = process.env.CHAOS_RELAY_URL;
    const prevOptIn = process.env.CHAOS_RELAY_ALLOW_INSECURE_HTTP;
    if (env.url === undefined) delete process.env.CHAOS_RELAY_URL;
    else process.env.CHAOS_RELAY_URL = env.url;
    if (env.allowInsecure === undefined) delete process.env.CHAOS_RELAY_ALLOW_INSECURE_HTTP;
    else process.env.CHAOS_RELAY_ALLOW_INSECURE_HTTP = env.allowInsecure;
    const prevFetch = blockNonLoopbackFetch();
    // Also stand in for the WebSocket: without this the extension dials the real
    // stack and a "no socket was opened" assertion would be vacuously true.
    const prevWs = globalThis.WebSocket;
    PushWebSocket.instances = [];
    globalThis.WebSocket = PushWebSocket as unknown as typeof WebSocket;
    t.after(() => {
      if (prevUrl === undefined) delete process.env.CHAOS_RELAY_URL;
      else process.env.CHAOS_RELAY_URL = prevUrl;
      if (prevOptIn === undefined) delete process.env.CHAOS_RELAY_ALLOW_INSECURE_HTTP;
      else process.env.CHAOS_RELAY_ALLOW_INSECURE_HTTP = prevOptIn;
      globalThis.fetch = prevFetch;
      globalThis.WebSocket = prevWs;
    });
    const fake = makeFakePi();
    chaosRelayExtension(fake.pi as unknown as ExtensionPi);
    t.after(() => callHandler(fake.handlers, "session_shutdown", {}, makeCtx(sessionId, fake.notifications)));
    const notifications: Notification[] = [];
    return run(fake, notifications);
  };
}

// --- inbound image acceptance (bead pi-chaos-relay-oap) ----------------------
//
// Paul's report from the hub: with v0.17.36 the agent saw "[Received 1
// attachment.]" instead of the image, and after a session replacement inbound
// images died while text still arrived. These tests drive the real inbound path —
// a relay-pushed frame for an EMAIL channel, a REAL local HTTP relay serving the
// attachment, real PNG bytes, the real magic-byte hydration — and assert what the
// agent is actually handed, including through a replacement session.

/** A genuine 1x1 PNG: the delivery must carry exactly these bytes, not a note. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
export const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
export const EMAIL_IMAGE_MESSAGE_ID = "m-email-image";

export interface ImageRelay {
  url: string;
  attachmentRequests: () => number;
  blockDownloads: () => void;
  waitForDownloadStart: () => Promise<void>;
  releaseDownload: () => void;
  close: () => Promise<void>;
}

/** A real relay on 127.0.0.1: an email message with one image attachment. */
export async function startImageRelay(): Promise<ImageRelay> {
  let requests = 0;
  let started = false;
  // Only the FIRST download is held open (the mid-flight replacement scenario);
  // the replacement session's own download must be answered normally.
  let blockNext = 0;
  let release: (() => void) | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sendJson = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith("/attachments/att-1")) {
      requests += 1;
      started = true;
      const respond = () => {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(ONE_PIXEL_PNG.length) });
        res.end(ONE_PIXEL_PNG);
      };
      // Held open on request, so a test can replace the session mid-download.
      if (blockNext > 0) {
        blockNext -= 1;
        release = respond;
      } else {
        respond();
      }
      return;
    }
    if (url.pathname === "/messages") {
      return sendJson({
        messages: [emailImageMessage("2026-10-10T00:00:01.000Z")],
        since: "2026-10-10T00:00:01.000Z",
      });
    }
    if (url.pathname === "/health") return sendJson({ status: "ok" });
    return sendJson({});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    attachmentRequests: () => requests,
    blockDownloads: () => {
      blockNext = 1;
    },
    waitForDownloadStart: () => waitFor(() => started),
    releaseDownload: () => release?.(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The email the relay pushes: body text plus one PNG attachment. */
export function emailImageMessage(timestamp: string, id = EMAIL_IMAGE_MESSAGE_ID) {
  return {
    id,
    channelType: "email",
    channelId: "inbox-1",
    from: "alice@example.com",
    content: "Here is the photo you asked for.",
    timestamp,
    attachments: [
      { id: "att-1", filename: "photo.png", mimeType: "image/png", size: ONE_PIXEL_PNG.length, kind: "image" },
    ],
  };
}

export function pushEmailImage(
  socket: InstanceType<typeof PushWebSocket>,
  id: string,
  timestamp: string,
): void {
  socket.pushFrame(JSON.stringify({ type: "message", message: emailImageMessage(timestamp, id) }));
}

/** Every send this instance made, with the content parts pulled out. */
export function imagePartsOf(sends: unknown[]): Array<{ type: string; mimeType?: string; data?: string; text?: string }> {
  const out: Array<{ type: string; mimeType?: string; data?: string; text?: string }> = [];
  for (const send of sends) {
    if (Array.isArray(send)) {
      for (const part of send) out.push(part as { type: string });
    } else if (typeof send === "object" && send !== null) {
      out.push(send as { type: string });
    }
  }
  return out;
}
