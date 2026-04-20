import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleFlushCommand } from "./commands-flush.js";

const runtimeMocks = vi.hoisted(() => ({
  manualMemoryFlushSkipReason: vi.fn((_: unknown) => null),
  isEmbeddedPiRunActive: vi.fn((_: unknown) => true),
  abortEmbeddedPiRun: vi.fn((_: unknown) => undefined),
  waitForEmbeddedPiRunEnd: vi.fn(async (_: unknown, __: unknown) => false),
  resolveSessionFilePath: vi.fn((_: unknown, __: unknown, ___: unknown) => "/tmp/test.jsonl"),
  resolveSessionFilePathOptions: vi.fn((_: unknown) => ({})),
  runManualMemoryFlush: vi.fn(async (_: unknown) => ({ ok: true, relativePath: "memory/test.md" })),
}));

vi.mock("./commands-flush.runtime.js", () => runtimeMocks);
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));
vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn(() => true),
}));

describe("handleFlushCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.manualMemoryFlushSkipReason.mockReturnValue(null);
    runtimeMocks.isEmbeddedPiRunActive.mockReturnValue(true);
    runtimeMocks.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
    runtimeMocks.runManualMemoryFlush.mockResolvedValue({
      ok: true,
      relativePath: "memory/test.md",
    });
  });

  it("returns a retry reply when the previous embedded run does not drain", async () => {
    const sessionEntry = {
      sessionId: "sess-123",
      sessionFile: "/tmp/test.jsonl",
    } as SessionEntry;

    const result = await handleFlushCommand(
      {
        cfg: {} as OpenClawConfig,
        ctx: {
          SenderName: "Jet",
          SenderUsername: "jetd1",
          SenderE164: undefined,
        } as never,
        command: {
          commandBodyNormalized: "/flush",
          isAuthorizedSender: true,
          senderId: "276014738",
          senderIsOwner: true,
          channel: "telegram",
          ownerList: [],
          rawBodyNormalized: "/flush",
          surface: "telegram",
        },
        directives: {} as never,
        elevated: { enabled: false, allowed: false, failures: [] },
        sessionEntry,
        sessionStore: { test: sessionEntry },
        sessionKey: "test",
        workspaceDir: "/tmp",
        defaultGroupActivation: () => "mention",
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        contextTokens: 0,
        isGroup: false,
      },
      true,
    );

    expect(runtimeMocks.abortEmbeddedPiRun).toHaveBeenCalledWith("sess-123");
    expect(runtimeMocks.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("sess-123", 15_000);
    expect(runtimeMocks.runManualMemoryFlush).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "🧠 Manual flush skipped: the current run is still shutting down. Try again once it finishes.",
      },
    });
  });

  it("forwards provider-based final-tag enforcement and exec overrides into the flush run", async () => {
    const sessionEntry = {
      sessionId: "sess-456",
      sessionFile: "/tmp/test.jsonl",
    } as SessionEntry;
    runtimeMocks.isEmbeddedPiRunActive.mockReturnValue(false);

    await handleFlushCommand(
      {
        cfg: {} as OpenClawConfig,
        ctx: {
          SenderName: "Jet",
          SenderUsername: "jetd1",
          SenderE164: undefined,
        } as never,
        command: {
          commandBodyNormalized: "/flush",
          isAuthorizedSender: true,
          senderId: "276014738",
          senderIsOwner: true,
          channel: "telegram",
          ownerList: [],
          rawBodyNormalized: "/flush",
          surface: "telegram",
        },
        directives: {} as never,
        elevated: { enabled: true, allowed: true, failures: [] },
        sessionEntry,
        sessionStore: { test: sessionEntry },
        sessionKey: "test",
        workspaceDir: "/tmp",
        defaultGroupActivation: () => "mention",
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        provider: "google",
        model: "gemini-2.5-pro",
        execOverrides: { ask: "always", host: "node" },
        contextTokens: 0,
        isGroup: false,
      },
      true,
    );

    expect(runtimeMocks.runManualMemoryFlush).toHaveBeenCalledTimes(1);
    const firstCall = runtimeMocks.runManualMemoryFlush.mock.calls[0] as [unknown] | undefined;
    const call = firstCall?.[0] as
      | { context?: { enforceFinalTag?: boolean; execOverrides?: Record<string, string> } }
      | undefined;
    expect(call?.context?.enforceFinalTag).toBe(true);
    expect(call?.context?.execOverrides).toEqual({ ask: "always", host: "node" });
  });

  it("re-reads the session store after draining a run that rotated the transcript", async () => {
    const beforeEntry = {
      sessionId: "sess-old",
      sessionFile: "/tmp/old.jsonl",
    } as SessionEntry;
    const afterEntry = {
      sessionId: "sess-new",
      sessionFile: "/tmp/new.jsonl",
      authProfileOverride: "profile-b",
    } as SessionEntry;
    const sessionStore: Record<string, SessionEntry> = { test: beforeEntry };
    runtimeMocks.isEmbeddedPiRunActive.mockReturnValue(true);
    runtimeMocks.waitForEmbeddedPiRunEnd.mockImplementation(async () => {
      // Simulate the previous run rotating the session right before it ends.
      sessionStore.test = afterEntry;
      return true;
    });
    runtimeMocks.resolveSessionFilePath.mockImplementation(
      (sid: unknown) => `/tmp/${String(sid)}.jsonl`,
    );

    await handleFlushCommand(
      {
        cfg: {} as OpenClawConfig,
        ctx: {
          SenderName: "Jet",
          SenderUsername: "jetd1",
          SenderE164: undefined,
        } as never,
        command: {
          commandBodyNormalized: "/flush",
          isAuthorizedSender: true,
          senderId: "276014738",
          senderIsOwner: true,
          channel: "telegram",
          ownerList: [],
          rawBodyNormalized: "/flush",
          surface: "telegram",
        },
        directives: {} as never,
        elevated: { enabled: false, allowed: false, failures: [] },
        sessionEntry: beforeEntry,
        sessionStore,
        sessionKey: "test",
        workspaceDir: "/tmp",
        defaultGroupActivation: () => "mention",
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        contextTokens: 0,
        isGroup: false,
      },
      true,
    );

    expect(runtimeMocks.abortEmbeddedPiRun).toHaveBeenCalledWith("sess-old");
    expect(runtimeMocks.runManualMemoryFlush).toHaveBeenCalledTimes(1);
    const firstCall = runtimeMocks.runManualMemoryFlush.mock.calls[0] as [unknown] | undefined;
    const call = firstCall?.[0] as
      | {
          context?: {
            sessionId?: string;
            sessionFile?: string;
            sessionEntry?: SessionEntry;
            authProfileId?: string;
          };
        }
      | undefined;
    expect(call?.context?.sessionId).toBe("sess-new");
    expect(call?.context?.sessionFile).toBe("/tmp/sess-new.jsonl");
    expect(call?.context?.sessionEntry).toBe(afterEntry);
    expect(call?.context?.authProfileId).toBe("profile-b");
  });
});
