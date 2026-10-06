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

/** Read-only relay plumbing — never gated (gating it would deadlock the very
 *  channel the approval question is asked over). */
const RELAY_READ_ONLY_TOOLS = new Set(["relay_check_messages", "relay_list_profiles"]);

/**
 * Decide whether a tool call on a channel-driven turn needs approval.
 *
 * - `off`: nothing is gated (explicit opt-out).
 * - `writes`: non-relay write-class tools (`bash`/`edit`/`write`) are gated;
 *   among the relay tools, only `relay_reply` carrying outbound file
 *   attachments is gated (it ships local bytes out — write-class); the rest of
 *   the namespace stays ungated.
 * - `all`: everything is gated EXCEPT the read-only relay plumbing
 *   (`relay_check_messages`, `relay_list_profiles`). Any `relay_*` name not in
 *   that allowlist — including a FUTURE tool — is gated (default-deny for the
 *   namespace).
 */
export function approvalDecision(
  mode: ApprovalMode,
  toolName: string,
  input?: Record<string, unknown>,
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
  // "writes": only relay_reply with outbound file attachments is write-class.
  if (toolName === "relay_reply") {
    const files = input?.files;
    return Array.isArray(files) && files.length > 0;
  }
  return false;
}
