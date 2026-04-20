import type { EmbeddedFullAccessBlockedReason } from "../../agents/pi-embedded-runner/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TemplateContext } from "../templating.js";
import type { ElevatedLevel } from "../thinking.js";
import { buildExecOverridePromptHint } from "./get-reply-run.js";
import { buildInboundMetaSystemPrompt } from "./inbound-meta.js";

export interface ExtraSystemPromptParams {
  /** Outer message context (root dispatch). */
  rootCtx: TemplateContext;
  /** Session-scoped template context. */
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  isNewSession: boolean;
  useFastReplyRuntime: boolean;
  execOverrides: Record<string, string> | undefined;
  resolvedElevatedLevel: ElevatedLevel | undefined;
  fullAccessAvailable: boolean;
  fullAccessBlockedReason: EmbeddedFullAccessBlockedReason | undefined;
  /** Pre-built group chat context string (from buildGroupChatContext). */
  groupChatContext?: string;
  /** Pre-built group intro string (from buildGroupIntro). */
  groupIntro?: string;
}

/**
 * Build the assembled extra system prompt from session context.
 * Shared between get-reply-run.ts (normal turns) and
 * get-reply-inline-actions.ts (command handlers like /flush) so that
 * embedded runs receive identical policy context.
 */
export function buildExtraSystemPrompt(params: ExtraSystemPromptParams): string | undefined {
  const {
    sessionCtx,
    isNewSession,
    useFastReplyRuntime,
    execOverrides,
    resolvedElevatedLevel,
    fullAccessAvailable,
    fullAccessBlockedReason,
    groupChatContext,
    groupIntro,
  } = params;

  const groupSystemPrompt = (sessionCtx.GroupSystemPrompt as string) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
    { includeFormattingHints: !useFastReplyRuntime },
  );
  const execHint = buildExecOverridePromptHint({
    execOverrides,
    elevatedLevel: resolvedElevatedLevel ?? "off",
    fullAccessAvailable,
    fullAccessBlockedReason,
  });

  const parts = [
    inboundMetaPrompt,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    execHint,
  ].filter(Boolean);

  return parts.join("\n\n") || undefined;
}
