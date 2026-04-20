/**
 * Manual memory flush support.
 *
 * The existing pre-compaction memory flush (`runMemoryFlushIfNeeded`) is gated on
 * token thresholds and hard-codes a "near auto-compaction" framing that misleads
 * the agent in other contexts (see #6877). This module exposes a reusable, gate-free
 * entry point that dispatches the same embedded pi agent turn under different
 * framings — today for user-triggered `/flush`, later for pre-reset flush.
 *
 * The surface is intentionally small:
 *   - PromptKind — which framing to use: "manual" (session continues) | "reset"
 *     (session about to be destroyed). "auto" is reserved for the existing
 *     pre-compaction path; callers should use `runMemoryFlushIfNeeded` there.
 *   - buildManualMemoryFlushPlan — wraps `resolveMemoryFlushPlan` and overrides
 *     `prompt` / `systemPrompt` with the correct framing while reusing the
 *     plan's `relativePath` and safety rules.
 *   - runManualMemoryFlush — runs the embedded pi agent turn using the override
 *     plan and updates `memoryFlushAt`; it only advances
 *     `memoryFlushCompactionCount` when the flush itself actually compacted the
 *     session.
 *
 * Note: manual flush does NOT trigger a subsequent compaction. The session
 * continues after the memory is persisted.
 */

import crypto from "node:crypto";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { type SessionEntry, updateSessionStoreEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveMemoryFlushPlan, type MemoryFlushPlan } from "../../plugins/memory-state.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveProviderScopedAuthProfile } from "./agent-runner-utils.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

/**
 * Which framing to use for the flush turn.
 *
 * - "manual": user-triggered; explicitly state the session continues, focus the
 *   agent on durable artifacts without sprint-mode urgency.
 * - "reset": session will be destroyed after this turn (pre-reset flush); used
 *   by the future async reset-flush path.
 */
export type ManualMemoryFlushKind = "manual" | "reset";

/**
 * Build the kind-specific reframing preamble that is prepended to the plugin's
 * own flush prompt. We intentionally do NOT re-state where/how to write the
 * memory file here — that belongs to the memory capability (which may be the
 * default `memory-core` plugin, a user override via
 * `agents.defaults.compaction.memoryFlush.prompt`, or a third-party capability
 * such as `memory-wiki` with completely different formatting rules).
 *
 * The preamble only replaces the "Pre-compaction / session-ending" framing
 * that causes sprint-mode behavior (see issue #6877) with either:
 *   - "session continues" (kind=manual), or
 *   - "session about to be destroyed" (kind=reset, for the future async
 *     pre-reset flush path).
 */
function buildPreambles(kind: ManualMemoryFlushKind): {
  prompt: string;
  systemPrompt: string;
} {
  if (kind === "reset") {
    return {
      prompt: [
        "Pre-reset memory flush.",
        "This session is about to be destroyed via /new, /reset, or equivalent teardown.",
        "Persist anything durable that would otherwise be lost: decisions, open questions, ongoing state, context for the next session.",
        "Follow the memory-plugin instructions below for file location, formatting, and safety rules.",
        `When done, reply with ${SILENT_REPLY_TOKEN}.`,
      ].join(" "),
      systemPrompt: [
        "Pre-reset memory flush turn.",
        "The session will be destroyed immediately after this turn; rescue durable context before it is lost.",
        "Follow the memory-plugin instructions below for file location, formatting, and safety rules.",
        `Reply with ${SILENT_REPLY_TOKEN} when complete.`,
      ].join(" "),
    };
  }

  // kind === "manual"
  return {
    prompt: [
      "User-triggered memory flush.",
      "The session will continue after this turn — this is NOT triggered by compaction pressure and NOT session-ending.",
      "Review the current session and persist durable memories worth keeping across sessions.",
      "Focus on: decisions, facts, corrections, lessons learned, ongoing state, open questions. Skip transient chitchat and intermediate reasoning.",
      "Follow the memory-plugin instructions below for file location, formatting, and safety rules.",
      `When done, reply with ${SILENT_REPLY_TOKEN}.`,
    ].join(" "),
    systemPrompt: [
      "Manual memory flush turn requested by the user.",
      "The session continues after this turn — do NOT behave as if it is ending.",
      "Follow the memory-plugin instructions below for file location, formatting, and safety rules.",
      `Reply with ${SILENT_REPLY_TOKEN} when complete.`,
    ].join(" "),
  };
}

/**
 * Default memory-plugin prompts (memory-core) are written for the
 * pre-auto-compaction path and include framing like "Pre-compaction memory
 * flush" / "near auto-compaction". When we reuse them for a manual /flush or
 * a pre-reset flush, those phrases contradict our own preamble ("the session
 * continues" / "about to be destroyed"). Strip just those conflicting
 * sentences; every concrete rule the plugin wants to enforce (target path,
 * append-only, read-only bootstrap files, variant-file ban, reply guidance,
 * current-time line) is left intact.
 */
const CONFLICTING_FRAMING_PATTERNS: RegExp[] = [
  /Pre-compaction memory flush turn\.?/gi,
  /Pre-compaction memory flush\.?/gi,
  /The session is near auto-compaction;?\s*capture durable memories to disk\.?/gi,
];

function sanitizePluginPrompt(pluginText: string | undefined): string {
  let next = pluginText ?? "";
  for (const pattern of CONFLICTING_FRAMING_PATTERNS) {
    next = next.replace(pattern, "");
  }
  // Only clean up blank lines left by the sentence removal. Do NOT collapse
  // spaces or strip indentation on content lines — third-party plugins may
  // include fenced code blocks, YAML examples, or indented bullets that
  // would be corrupted by aggressive whitespace normalization. A stray
  // double-space or leading space where a sentence was removed is harmless;
  // corrupted formatting is not.
  return next.replace(/^\s*\n/gm, "\n").trim();
}

/**
 * Prepend the reframing preamble to the plugin's own prompt, with a visible
 * separator so the agent can distinguish the reframing from the plugin's
 * binding rules. Falls back to preamble-only when the plugin provided no
 * (or only-conflicting) text for that field.
 */
function reframePrompt(preamble: string, pluginPrompt: string | undefined): string {
  const sanitized = sanitizePluginPrompt(pluginPrompt);
  if (!sanitized) {
    return preamble;
  }
  return `${preamble}\n\n--- memory-plugin instructions (follow these for file location, formatting, safety rules) ---\n${sanitized}`;
}

function ensureSilentHintTail(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

/**
 * Resolve the base memory-flush plan and REFRAME its `prompt` / `systemPrompt`
 * with a kind-specific preamble (session-continues vs pre-reset). The plugin's
 * original text is preserved in full so any custom file location, formatting,
 * or safety rules from `agents.defaults.compaction.memoryFlush.*` or a
 * third-party memory capability (e.g. `memory-wiki`) remain authoritative.
 *
 * Returns `null` when the memory capability is disabled.
 */
export function buildManualMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
  kind: ManualMemoryFlushKind;
}): MemoryFlushPlan | null {
  const basePlan = resolveMemoryFlushPlan({ cfg: params.cfg, nowMs: params.nowMs });
  if (!basePlan) {
    return null;
  }
  const preambles = buildPreambles(params.kind);
  return {
    ...basePlan,
    prompt: ensureSilentHintTail(reframePrompt(preambles.prompt, basePlan.prompt)),
    systemPrompt: ensureSilentHintTail(
      reframePrompt(preambles.systemPrompt, basePlan.systemPrompt),
    ),
  };
}

/**
 * Returns true when durable memory writes are possible for the given session.
 *
 * Mirrors the `memoryFlushWritable` check in `runMemoryFlushIfNeeded`: a
 * session running in a sandbox with `workspaceAccess !== "rw"` would have its
 * embedded pi run redirected to the sandbox workspace, so the memory file
 * would land in the transient sandbox dir instead of the real project
 * workspace — a silent data loss from the user's perspective.
 */
export function canWriteManualMemoryFlush(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!params.sessionKey) {
    return true;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) {
    return true;
  }
  const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
  return sandboxCfg.workspaceAccess === "rw";
}

/**
 * Return a human-readable reason when a manual flush would be rejected in the
 * given session config, or `null` when it can run. Mirrors the short-circuit
 * checks at the top of `runManualMemoryFlush` but without starting a run, so
 * callers can decide (e.g. /flush) whether aborting an in-flight run is even
 * worth it.
 */
export function manualMemoryFlushSkipReason(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  /** Session's active provider; checked against the CLI-provider allowlist. */
  provider?: string;
}): string | null {
  if (!canWriteManualMemoryFlush({ cfg: params.cfg, sessionKey: params.sessionKey })) {
    return "session workspace is sandboxed read-only; memory flush would be written to the transient sandbox workspace and lost";
  }
  // Mirror the auto-flush path (agent-runner-memory.ts): CLI-backed sessions
  // are deliberately excluded from embedded memory-flush turns because their
  // agent loop is driven by an external CLI process instead of the embedded
  // pi runner.
  if (params.provider && isCliProvider(params.provider, params.cfg)) {
    return `memory flush is not supported for CLI-backed provider ${params.provider}`;
  }
  // Resolve the plan with a stable nowMs so identical calls are idempotent for
  // tests; the plan itself is not used here, only its presence / absence.
  const plan = resolveMemoryFlushPlan({ cfg: params.cfg });
  if (!plan) {
    return "memory plugin disabled";
  }
  return null;
}

export type ManualMemoryFlushRunContext = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  model: string;
  verboseLevel: VerboseLevel;
  messageChannel?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner?: boolean;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  /** Session-scoped auth profile binding; see `resolveRunAuthProfile`. */
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  /** Session's accumulated extra system prompt (AGENTS.md, refresh guidance, etc.).
   *  When available (e.g. from a followup-run-bound context), prepended to the
   *  flush plan's system prompt so policy guidance is consistent with the auto
   *  memory-flush path.  When undefined, only the plan's own system prompt is
   *  used — this is a minor fidelity gap but does not affect correctness. */
  extraSystemPrompt?: string;
  /** Embedded run flags from buildEmbeddedRunBaseParams. */
  enforceFinalTag?: boolean;
  reasoningLevel?: import("../thinking.js").ReasoningLevel;
  execOverrides?: Record<string, string>;
  bashElevated?: import("../../agents/bash-tools.exec-types.js").ExecElevatedDefaults;
  replyOperation?: ReplyOperation;
  abortSignal?: AbortSignal;
};

export type ManualMemoryFlushResult = {
  ok: boolean;
  reason?: string;
  relativePath?: string;
  /** True if an implicit compaction rotated the session during the flush run. */
  compactedDuringFlush?: boolean;
};

/**
 * Run a manual memory flush turn. Skips the token-threshold and "already-flushed"
 * gates used by the auto path, and does NOT trigger a subsequent compaction —
 * the session continues normally afterward.
 */
export async function runManualMemoryFlush(params: {
  cfg: OpenClawConfig;
  kind: ManualMemoryFlushKind;
  context: ManualMemoryFlushRunContext;
}): Promise<ManualMemoryFlushResult> {
  const skipReason = manualMemoryFlushSkipReason({
    cfg: params.cfg,
    sessionKey: params.context.sessionKey,
    provider: params.context.provider,
  });
  if (skipReason) {
    return { ok: false, reason: skipReason };
  }

  const nowMs = Date.now();
  const plan = buildManualMemoryFlushPlan({ cfg: params.cfg, nowMs, kind: params.kind });
  if (!plan) {
    // Defensive: skip-reason already caught this, but keep the check so the
    // non-null assertion downstream is statically justified.
    return { ok: false, reason: "memory plugin disabled" };
  }

  const { context } = params;
  const runId = crypto.randomUUID();
  if (context.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: context.sessionKey,
      verboseLevel: context.verboseLevel,
    });
  }

  const timeoutMs = resolveAgentTimeoutMs({ cfg: params.cfg });

  logVerbose(
    `manualMemoryFlush: starting kind=${params.kind} sessionKey=${context.sessionKey} ` +
      `sessionId=${context.sessionId} model=${context.provider}/${context.model} ` +
      `writePath=${plan.relativePath}`,
  );

  // Track implicit compaction that the memory-flush turn can trigger when the
  // session is already near its context limit (which is *exactly* when users
  // are likely to type /flush). runEmbeddedPiAgent emits a compaction/end event
  // on rotation and returns the rotated sessionId in meta.agentMeta.sessionId.
  // If we ignore both, sessions.json stays pinned to the pre-rotation sessionId
  // and subsequent turns read/write the stale session file.
  let memoryCompactionCompleted = false;
  let postCompactionSessionId: string | undefined;

  // Resolve configured fallbacks for this agent/session so a failing primary
  // model doesn't drop the whole flush; mirrors the auto-path's behavior.
  const fallbacksOverride = resolveRunModelFallbacksOverride({
    cfg: params.cfg,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
  });

  try {
    await runWithModelFallback({
      cfg: params.cfg,
      provider: context.provider,
      model: context.model,
      runId,
      agentDir: context.agentDir,
      fallbacksOverride,
      run: async (provider, model, runOptions) => {
        // Resolve the session-scoped auth profile per fallback candidate: only
        // the primary provider keeps its pinned profile id, any fallback
        // provider should fall back to its own default profile (matches
        // resolveRunAuthProfile used by the auto path).
        const authProfile = resolveProviderScopedAuthProfile({
          provider,
          primaryProvider: context.provider,
          authProfileId: context.authProfileId,
          authProfileIdSource: context.authProfileIdSource,
        });
        const result = await runEmbeddedPiAgent({
          sessionId: context.sessionId,
          sessionKey: context.sessionKey,
          agentId: context.agentId,
          sessionFile: context.sessionFile,
          workspaceDir: context.workspaceDir,
          agentDir: context.agentDir,
          config: params.cfg,
          skillsSnapshot: context.sessionEntry?.skillsSnapshot,
          prompt: plan.prompt,
          extraSystemPrompt: [context.extraSystemPrompt, plan.systemPrompt]
            .filter(Boolean)
            .join("\n\n"),
          provider,
          model,
          ...authProfile,
          enforceFinalTag: context.enforceFinalTag,
          reasoningLevel: context.reasoningLevel,
          execOverrides: context.execOverrides,
          bashElevated: context.bashElevated,
          verboseLevel: context.verboseLevel,
          timeoutMs,
          runId,
          trigger: "memory",
          memoryFlushWritePath: plan.relativePath,
          silentExpected: true,
          allowGatewaySubagentBinding: true,
          messageChannel: context.messageChannel,
          senderId: context.senderId ?? undefined,
          senderName: context.senderName ?? undefined,
          senderUsername: context.senderUsername ?? undefined,
          senderE164: context.senderE164 ?? undefined,
          senderIsOwner: context.senderIsOwner,
          groupId: context.groupId,
          groupChannel: context.groupChannel,
          groupSpace: context.groupSpace,
          spawnedBy: context.spawnedBy,
          replyOperation: context.replyOperation,
          abortSignal: context.abortSignal,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        if (result.meta?.agentMeta?.sessionId) {
          postCompactionSessionId = result.meta.agentMeta.sessionId;
        }
        return result;
      },
    });
  } catch (err) {
    const message = normalizeOptionalString(err instanceof Error ? err.message : String(err));
    logVerbose(`manualMemoryFlush: run failed: ${message}`);
    return { ok: false, reason: message ?? "flush run failed", relativePath: plan.relativePath };
  }

  // If compaction fired mid-flush, rotate the session bindings in the store and
  // queue exactly like the auto path does. This keeps sessions.json, the
  // followup-run queue, and reply operations pointing at the new sessionId and
  // sessionFile produced by the rotation.
  //
  // IMPORTANT: if this rotation cannot be persisted, we MUST fail the whole
  // flush. The transcript has already rotated to a new sessionId; leaving
  // session bindings pinned to the old id would silently send subsequent
  // turns to the wrong session file.
  if (memoryCompactionCompleted && context.sessionKey && context.sessionStore) {
    const sessionKey = context.sessionKey;
    const previousSessionId = context.sessionEntry?.sessionId ?? context.sessionId;
    try {
      const nextCount = await incrementCompactionCount({
        cfg: params.cfg,
        sessionEntry: context.sessionEntry,
        sessionStore: context.sessionStore,
        sessionKey,
        storePath: context.storePath,
        newSessionId: postCompactionSessionId,
      });
      const updatedEntry = context.sessionStore[sessionKey];
      if (updatedEntry) {
        if (updatedEntry.sessionId !== previousSessionId) {
          logVerbose(
            `manualMemoryFlush: session rotated during flush sessionKey=${sessionKey} ` +
              `old=${previousSessionId} new=${updatedEntry.sessionId} compactionCount=${nextCount ?? "?"}`,
          );
          refreshQueuedFollowupSession({
            key: sessionKey,
            previousSessionId,
            nextSessionId: updatedEntry.sessionId,
            nextSessionFile: updatedEntry.sessionFile,
          });
          if (context.replyOperation) {
            context.replyOperation.updateSessionId(updatedEntry.sessionId);
          }
        }
      }
    } catch (err) {
      const message = normalizeOptionalString(err instanceof Error ? err.message : String(err));
      logVerbose(`manualMemoryFlush: failed to apply post-compaction rotation: ${message}`);
      return {
        ok: false,
        reason: `flush compacted the session but the new sessionId could not be persisted (${message ?? "unknown error"}); please run /new or /reset before continuing`,
        relativePath: plan.relativePath,
        compactedDuringFlush: true,
      };
    }
  }

  if (context.storePath && context.sessionKey) {
    try {
      // Always record when the manual flush happened, but only mark the
      // current compaction cycle as flushed when this /flush itself actually
      // compacted/rotated the session. Otherwise a user-triggered early /flush
      // would suppress the later automatic pre-compaction flush for the rest of
      // the cycle, and durable context added afterwards could be lost.
      const sessionStoreEntry = context.sessionStore?.[context.sessionKey];
      const latestCompactionCount =
        sessionStoreEntry?.compactionCount ?? context.sessionEntry?.compactionCount ?? 0;
      await updateSessionStoreEntry({
        storePath: context.storePath,
        sessionKey: context.sessionKey,
        update: async () => ({
          memoryFlushAt: Date.now(),
          ...(memoryCompactionCompleted
            ? { memoryFlushCompactionCount: latestCompactionCount }
            : {}),
        }),
      });
    } catch (err) {
      logVerbose(`manualMemoryFlush: failed to persist memoryFlushAt: ${String(err)}`);
    }
  }

  return {
    ok: true,
    relativePath: plan.relativePath,
    compactedDuringFlush: memoryCompactionCompleted,
  };
}

// Exported for tests only.
export const __testables__ = {
  buildPreambles,
  reframePrompt,
};
