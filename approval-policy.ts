/**
 * Pure tool-approval policy for channel-driven turns.
 *
 * The approval gate is the control that keeps an untrusted channel participant
 * from driving dangerous tools with no human in the loop. This module is the
 * single source of truth for WHICH tools a given approvalMode gates, and is
 * deliberately pure and side-effect-free so the full mode x tool matrix is
 * unit-testable (see test/approval-policy.test.ts).
 */

import type { ApprovalMode } from "./config.ts";

/** Tools that write to the local machine — gated in "writes" mode. */
const RISKY_WRITE_TOOLS = new Set(["bash", "edit", "write"]);

/**
 * Tools whose execution can surface local file contents into the agent's
 * context. `read`/`grep` return file contents directly; `bash` can run
 * arbitrary local inspection (cat a file, print a secret, …). Running any of
 * these — gated or ungated — marks the SESSION as having inspected local
 * content, so a text-only `relay_reply` from a later channel turn is then
 * gated (see `approvalDecision`). That closes the inspect → text-reply
 * exfiltration path without prompting on every read. Exported so the extension
 * marks sessions using the SAME single source of truth the policy gates on.
 */
export const LOCAL_INSPECTION_TOOLS = new Set(["read", "grep", "bash"]);

/** Read-only relay plumbing — never gated (gating it would deadlock the very
 *  channel the approval question is asked over). */
const RELAY_READ_ONLY_TOOLS = new Set(["relay_check_messages", "relay_list_profiles"]);

/** Session-scoped context the approval gate needs beyond the tool call itself. */
export interface SessionApprovalState {
  /** True once the session has inspected local content (read/grep/bash); it
   *  stays set until the session ends so a later channel turn cannot text-reply
   *  it out without approval. */
  hasReadLocalFile?: boolean;
}

/**
 * Decide whether a tool call on a channel-driven turn needs approval.
 *
 * - `off`: nothing is gated (explicit opt-out).
 * - `writes`: non-relay write-class tools (`bash`/`edit`/`write`) are gated.
 *   In the relay namespace the read-only plumbing (`relay_check_messages`,
 *   `relay_list_profiles`) stays open, `relay_reply` follows its own rule —
 *   gated when it carries outbound file attachments (it ships local bytes out)
 *   or when the session has already inspected local content — and every
 *   control-plane tool (`relay_connect`, `relay_register_*`,
 *   `relay_switch_profile`, plus any future `relay_*` name) is gated too. The
 *   control plane is what decides where this session talks and who may drive
 *   it: a channel-borne injection that registers the attacker's own channel,
 *   or switches to a profile whose gate is off, takes the session over AND
 *   self-approves the gate itself, because the next approval question is then
 *   delivered to the attacker's channel. Gating it keeps a human in that loop.
 * - `all`: everything is gated EXCEPT the read-only relay plumbing
 *   (`relay_check_messages`, `relay_list_profiles`). Any `relay_*` name not in
 *   that allowlist — including a FUTURE tool — is gated (default-deny for the
 *   namespace).
 */
export function approvalDecision(
  mode: ApprovalMode,
  toolName: string,
  input?: Record<string, unknown>,
  session?: SessionApprovalState,
): boolean {
  if (mode === "off") return false;
  if (!toolName.startsWith("relay_")) {
    // Non-relay tools keep the pre-existing behaviour.
    if (mode === "all") return true;
    return RISKY_WRITE_TOOLS.has(toolName); // "writes"
  }
  // relay_* namespace.
  if (mode === "all") {
    return !RELAY_READ_ONLY_TOOLS.has(toolName);
  }
  // "writes": the relay namespace is default-deny too, exactly like "all" —
  // only the read-only plumbing is open. `relay_reply` keeps its own rule
  // first, so the ordinary conversation stays ungated until it carries a file
  // or the session has read local content; every other relay_* name is
  // write-class control plane (see the doc comment above for the takeover and
  // self-approval chain this closes).
  if (RELAY_READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName === "relay_reply") {
    const files = input?.files;
    if (Array.isArray(files) && files.length > 0) return true;
    return session?.hasReadLocalFile === true;
  }
  return true;
}
