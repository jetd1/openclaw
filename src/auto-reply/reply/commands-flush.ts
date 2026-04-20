import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { logVerbose } from "../../globals.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { CommandHandler } from "./commands-types.js";

let flushRuntimePromise: Promise<typeof import("./commands-flush.runtime.js")> | null = null;

function loadFlushRuntime(): Promise<typeof import("./commands-flush.runtime.js")> {
  flushRuntimePromise ??= import("./commands-flush.runtime.js");
  return flushRuntimePromise;
}

/**
 * `/flush` — manually trigger a memory flush turn.
 *
 * Unlike the auto path (`runMemoryFlushIfNeeded`), this command:
 *   - skips the `shouldRunMemoryFlush` token-threshold gate
 *   - skips the `hasAlreadyFlushedForCurrentCompaction` dedupe gate
 *   - uses a "session continues" framing instead of "near auto-compaction"
 *   - does NOT trigger a subsequent compaction
 *
 * See src/auto-reply/reply/manual-memory-flush.ts for the reusable core and
 * the exact prompt framing.
 */
export const handleFlushCommand: CommandHandler = async (params, allowTextCommands) => {
  const body = params.command.commandBodyNormalized;
  const flushRequested = body === "/flush" || body.startsWith("/flush ");
  if (!flushRequested) {
    return null;
  }
  if (!allowTextCommands) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /flush from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "🧠 Manual flush unavailable (missing session id)." },
    };
  }

  const runtime = await loadFlushRuntime();
  let activeSessionEntry = targetSessionEntry;
  let sessionId = activeSessionEntry.sessionId;

  // Preflight: confirm /flush is actually actionable in this session config
  // BEFORE aborting any in-flight run. If the memory capability is disabled
  // or the session is sandboxed read-only, runManualMemoryFlush() will
  // immediately short-circuit — aborting the user's active work first would
  // drop that work for nothing.
  const preflightSkipReason = runtime.manualMemoryFlushSkipReason({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    provider: params.provider,
  });
  if (preflightSkipReason) {
    return {
      shouldContinue: false,
      reply: { text: `🧠 Manual flush skipped: ${preflightSkipReason}` },
    };
  }

  // Let any in-flight pi run finish (or abort) before we dispatch the flush turn;
  // mirrors /compact's behavior so we don't race the same session.
  if (runtime.isEmbeddedPiRunActive(sessionId)) {
    runtime.abortEmbeddedPiRun(sessionId);
    const drained = await runtime.waitForEmbeddedPiRunEnd(sessionId, 15_000);
    if (!drained) {
      return {
        shouldContinue: false,
        reply: {
          text: "🧠 Manual flush skipped: the current run is still shutting down. Try again once it finishes.",
        },
      };
    }
    // The drained run may have rotated the transcript (compaction / session
    // rotation) while we were waiting. Re-read the session store so we target
    // the new sessionId / sessionFile and don't summarize a stale transcript.
    const refreshedEntry = params.sessionStore?.[params.sessionKey];
    if (refreshedEntry?.sessionId) {
      activeSessionEntry = refreshedEntry;
      sessionId = refreshedEntry.sessionId;
    }
  }

  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const sessionAgentDir =
    sessionAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, sessionAgentId);

  const sessionFile = runtime.resolveSessionFilePath(
    sessionId,
    activeSessionEntry,
    runtime.resolveSessionFilePathOptions({
      agentId: sessionAgentId,
      storePath: params.storePath,
    }),
  );

  const result = await runtime.runManualMemoryFlush({
    cfg: params.cfg,
    kind: "manual",
    context: {
      sessionId,
      sessionKey: params.sessionKey,
      sessionFile,
      sessionEntry: activeSessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: sessionAgentId,
      agentDir: sessionAgentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      model: params.model,
      verboseLevel: params.resolvedVerboseLevel,
      messageChannel: params.command.channel,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      senderIsOwner: params.command.senderIsOwner,
      groupId: activeSessionEntry.groupId,
      groupChannel: activeSessionEntry.groupChannel,
      groupSpace: activeSessionEntry.space,
      spawnedBy: activeSessionEntry.spawnedBy,
      authProfileId: activeSessionEntry.authProfileOverride,
      authProfileIdSource: activeSessionEntry.authProfileOverrideSource,
      extraSystemPrompt: params.extraSystemPrompt,
      enforceFinalTag: isReasoningTagProvider(params.provider, {
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        modelId: params.model,
      }),
      reasoningLevel: params.resolvedReasoningLevel,
      execOverrides: params.execOverrides,
      bashElevated: {
        enabled: params.elevated.enabled,
        allowed: params.elevated.allowed,
        defaultLevel: params.resolvedElevatedLevel ?? "off",
      },
    },
  });

  if (!result.ok) {
    const reason = result.reason ?? "unknown error";
    if (result.compactedDuringFlush) {
      // Flush actually ran and rotated the transcript, but the new sessionId
      // could not be persisted. Treat as a failed flush with extra context
      // so the user knows the session is in a bad state.
      return {
        shouldContinue: false,
        reply: { text: `🧠 Manual flush failed after session rotation: ${reason}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `🧠 Manual flush skipped: ${reason}` },
    };
  }

  const target = result.relativePath ?? "memory/";
  const replyText = result.compactedDuringFlush
    ? `🧠 Memory flushed to ${target} (session was near context limit — a compaction ran during the flush; followup turns use the rotated session)`
    : `🧠 Memory flushed to ${target}`;
  return {
    shouldContinue: false,
    reply: { text: replyText },
  };
};
