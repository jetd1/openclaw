import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  updateSessionStoreEntryMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  resolveAgentTimeoutMsMock: vi.fn(() => 30_000),
  resolveRunModelFallbacksOverrideMock: vi.fn((_: unknown) => undefined),
  resolveProviderScopedAuthProfileMock: vi.fn((_: unknown) => ({})),
  refreshQueuedFollowupSessionMock: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStoreEntry: (params: unknown) => state.updateSessionStoreEntryMock(params),
  };
});

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    registerAgentRunContext: (params: unknown) => state.registerAgentRunContextMock(params),
  };
});

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: () => state.resolveAgentTimeoutMsMock(),
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveRunModelFallbacksOverride: (params: unknown) =>
      state.resolveRunModelFallbacksOverrideMock(params),
  };
});

vi.mock("./agent-runner-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  return {
    ...actual,
    resolveProviderScopedAuthProfile: (params: unknown) =>
      state.resolveProviderScopedAuthProfileMock(params),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    refreshQueuedFollowupSession: (params: unknown) =>
      state.refreshQueuedFollowupSessionMock(params),
  };
});

vi.mock("./session-updates.js", async () => {
  const actual =
    await vi.importActual<typeof import("./session-updates.js")>("./session-updates.js");
  return {
    ...actual,
    incrementCompactionCount: (params: unknown) => state.incrementCompactionCountMock(params),
  };
});

import {
  __testables__,
  buildManualMemoryFlushPlan,
  manualMemoryFlushSkipReason,
  runManualMemoryFlush,
  type ManualMemoryFlushKind,
} from "./manual-memory-flush.js";

// Register a stub memory capability so resolveMemoryFlushPlan returns a plan
// during the test run. We re-register per test to isolate plan output.
function installStubMemoryCapability(overrides?: {
  relativePath?: string;
  prompt?: string;
  systemPrompt?: string;
  disabled?: boolean;
}): void {
  registerMemoryCapability("test-manual-flush", {
    flushPlanResolver: () => {
      if (overrides?.disabled) {
        return null;
      }
      return {
        softThresholdTokens: 4000,
        forceFlushTranscriptBytes: 2 * 1024 * 1024,
        reserveTokensFloor: 20000,
        relativePath: overrides?.relativePath ?? "memory/2026-04-20.md",
        prompt:
          overrides?.prompt ??
          "Pre-compaction memory flush. Write to memory/2026-04-20.md. Follow custom safety rules X, Y, Z.",
        systemPrompt:
          overrides?.systemPrompt ?? "Pre-compaction memory flush turn. Custom plugin system rule.",
      };
    },
  });
}

describe("buildManualMemoryFlushPlan", () => {
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    // Memory capabilities live on a singleton; without this, our stub would
    // leak into any later test running in the same vitest worker (this repo
    // keeps --isolate=false green).
    clearMemoryPluginState();
  });

  it("returns null when the memory capability has no plan", () => {
    installStubMemoryCapability({ disabled: true });
    expect(buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" })).toBeNull();
  });

  it("prepends a 'session continues' preamble for kind=manual", () => {
    installStubMemoryCapability();
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(plan).not.toBeNull();
    expect(plan!.prompt).toContain("User-triggered memory flush.");
    expect(plan!.prompt).toContain("session will continue");
    expect(plan!.systemPrompt).toContain("Manual memory flush turn");
    expect(plan!.systemPrompt).toContain("session continues");
  });

  it("prepends a 'session destroyed' preamble for kind=reset", () => {
    installStubMemoryCapability();
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "reset" });
    expect(plan).not.toBeNull();
    expect(plan!.prompt).toContain("Pre-reset memory flush.");
    expect(plan!.prompt).toContain("about to be destroyed");
    expect(plan!.systemPrompt).toContain("destroyed immediately");
  });

  it("preserves the plugin-provided prompt body verbatim (kind=manual)", () => {
    // Use a plugin body with no conflicting 'Pre-compaction' / 'near auto-compaction'
    // framing so sanitization is a no-op and we can assert verbatim pass-through.
    const pluginPrompt =
      "Write to memory/custom.md. Follow custom safety rules X, Y, Z. JSONL format.";
    const pluginSystemPrompt = "Custom plugin system rule, non-conflicting.";
    installStubMemoryCapability({
      relativePath: "memory/custom.md",
      prompt: pluginPrompt,
      systemPrompt: pluginSystemPrompt,
    });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(plan!.prompt).toContain(pluginPrompt);
    expect(plan!.systemPrompt).toContain(pluginSystemPrompt);
    // And the preserved text is clearly delimited from the preamble.
    expect(plan!.prompt).toContain("--- memory-plugin instructions");
    expect(plan!.systemPrompt).toContain("--- memory-plugin instructions");
  });

  it("preserves the plugin-provided prompt body verbatim (kind=reset)", () => {
    const pluginPrompt = "Use memory/rescue.md — append-only JSONL, not markdown.";
    installStubMemoryCapability({
      relativePath: "memory/rescue.md",
      prompt: pluginPrompt,
    });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "reset" });
    expect(plan!.prompt).toContain(pluginPrompt);
    expect(plan!.prompt).toContain("Pre-reset memory flush.");
  });

  it("preserves non-prompt fields from the base plan", () => {
    installStubMemoryCapability({ relativePath: "memory/2026-04-20.md" });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(plan!.relativePath).toBe("memory/2026-04-20.md");
    expect(plan!.softThresholdTokens).toBe(4000);
    expect(plan!.forceFlushTranscriptBytes).toBe(2 * 1024 * 1024);
    expect(plan!.reserveTokensFloor).toBe(20000);
  });

  it("honors any relativePath the plugin chose (including non-date / nested)", () => {
    // Sanity-check: the preamble doesn't encode the path itself; the plugin's
    // prompt is what teaches the agent about the target file. We still verify
    // that relativePath flows through untouched.
    for (const p of [
      "memory/active.md",
      "memory/sessions/2026-04-20/notes.md",
      "memory/flush.jsonl",
    ]) {
      installStubMemoryCapability({ relativePath: p });
      const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
      expect(plan!.relativePath).toBe(p);
    }
  });

  it("keeps the silent-reply safety tail on prompt and systemPrompt", () => {
    installStubMemoryCapability();
    const manual = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(manual!.prompt).toContain("NO_REPLY");
    expect(manual!.systemPrompt).toContain("NO_REPLY");
    const reset = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "reset" });
    expect(reset!.prompt).toContain("NO_REPLY");
    expect(reset!.systemPrompt).toContain("NO_REPLY");
  });

  it("produces distinct preamble bodies for each kind", () => {
    const kinds: ManualMemoryFlushKind[] = ["manual", "reset"];
    const preambles = kinds.map((kind) => __testables__.buildPreambles(kind).prompt);
    expect(new Set(preambles).size).toBe(kinds.length);
  });

  it("never leaks 'Pre-compaction' / 'auto-compaction' framing into the preamble", () => {
    for (const kind of ["manual", "reset"] as ManualMemoryFlushKind[]) {
      const { prompt, systemPrompt } = __testables__.buildPreambles(kind);
      expect(prompt).not.toContain("Pre-compaction");
      expect(prompt).not.toContain("auto-compaction");
      expect(systemPrompt).not.toContain("Pre-compaction");
      expect(systemPrompt).not.toContain("auto-compaction");
    }
  });

  it("strips 'Pre-compaction' / 'near auto-compaction' framing from the plugin body", () => {
    // Simulate the real default memory-core prompts.
    const defaultPluginPrompt =
      "Pre-compaction memory flush. Store durable memories only in memory/2026-04-20.md. Treat MEMORY.md as read-only.";
    const defaultPluginSystemPrompt =
      "Pre-compaction memory flush turn. The session is near auto-compaction; capture durable memories to disk. Store durable memories only in memory/2026-04-20.md.";
    installStubMemoryCapability({
      prompt: defaultPluginPrompt,
      systemPrompt: defaultPluginSystemPrompt,
    });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(plan!.prompt).not.toContain("Pre-compaction memory flush");
    expect(plan!.systemPrompt).not.toContain("Pre-compaction memory flush");
    expect(plan!.systemPrompt).not.toContain("near auto-compaction");
    // Concrete plugin rules must still survive.
    expect(plan!.prompt).toContain("memory/2026-04-20.md");
    expect(plan!.prompt).toContain("MEMORY.md as read-only");
    expect(plan!.systemPrompt).toContain("memory/2026-04-20.md");
  });

  it("falls back to preamble-only when sanitization empties the plugin body", () => {
    // Every sentence in this plugin body is conflicting framing — after
    // stripping there is nothing plugin-specific left to attach.
    installStubMemoryCapability({
      prompt: "Pre-compaction memory flush.",
      systemPrompt:
        "Pre-compaction memory flush turn. The session is near auto-compaction; capture durable memories to disk.",
    });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    expect(plan!.prompt).not.toContain("--- memory-plugin instructions");
    expect(plan!.systemPrompt).not.toContain("--- memory-plugin instructions");
    expect(plan!.prompt).not.toContain("Pre-compaction");
    expect(plan!.systemPrompt).not.toContain("near auto-compaction");
  });

  it("falls back to preamble-only when the plugin returns an empty prompt", () => {
    // Capability type allows empty strings; make sure we don't crash or emit a
    // confusing separator followed by nothing.
    installStubMemoryCapability({ prompt: "", systemPrompt: "   " });
    const plan = buildManualMemoryFlushPlan({ cfg, nowMs: 0, kind: "manual" });
    // No separator when there is no plugin body to delimit.
    expect(plan!.prompt).not.toContain("--- memory-plugin instructions");
    expect(plan!.systemPrompt).not.toContain("--- memory-plugin instructions");
    // Preamble + NO_REPLY tail should still be present.
    expect(plan!.prompt).toContain("User-triggered memory flush.");
    expect(plan!.systemPrompt).toContain("Manual memory flush turn");
  });

  it("manualMemoryFlushSkipReason returns null when plan is available", () => {
    installStubMemoryCapability();
    expect(manualMemoryFlushSkipReason({ cfg })).toBeNull();
  });

  it("manualMemoryFlushSkipReason returns 'memory plugin disabled' when no plan", () => {
    installStubMemoryCapability({ disabled: true });
    expect(manualMemoryFlushSkipReason({ cfg })).toBe("memory plugin disabled");
  });

  it("manualMemoryFlushSkipReason skips CLI-backed providers", () => {
    installStubMemoryCapability();
    const reason = manualMemoryFlushSkipReason({ cfg, provider: "claude-cli" });
    expect(reason).toContain("CLI-backed provider claude-cli");
  });

  it("manualMemoryFlushSkipReason does not skip non-CLI providers", () => {
    installStubMemoryCapability();
    expect(manualMemoryFlushSkipReason({ cfg, provider: "anthropic" })).toBeNull();
  });
});

describe("runManualMemoryFlush metadata persistence", () => {
  afterEach(() => {
    clearMemoryPluginState();
    vi.restoreAllMocks();
    state.runEmbeddedPiAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.updateSessionStoreEntryMock.mockReset();
    state.incrementCompactionCountMock.mockReset();
    state.registerAgentRunContextMock.mockReset();
    state.resolveAgentTimeoutMsMock.mockReset();
    state.resolveAgentTimeoutMsMock.mockReturnValue(30_000);
    state.resolveRunModelFallbacksOverrideMock.mockReset();
    state.resolveRunModelFallbacksOverrideMock.mockReturnValue(undefined);
    state.resolveProviderScopedAuthProfileMock.mockReset();
    state.resolveProviderScopedAuthProfileMock.mockReturnValue({});
    state.refreshQueuedFollowupSessionMock.mockReset();
  });

  it("does not mark the compaction cycle flushed when manual /flush does not compact", async () => {
    installStubMemoryCapability({
      prompt: "Write durable memories to memory/2026-04-20.md.",
      systemPrompt: "Custom plugin system rule.",
    });

    state.runWithModelFallbackMock.mockImplementation(async ({ run }) => ({
      result: await run("anthropic", "claude-3-7-sonnet"),
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      attempts: [],
    }));
    state.runEmbeddedPiAgentMock.mockResolvedValue({
      meta: {
        agentMeta: { sessionId: "sess-1" },
      },
    });
    state.updateSessionStoreEntryMock.mockImplementation(async ({ update }) => await update({}));
    state.incrementCompactionCountMock.mockResolvedValue(4);

    const result = await runManualMemoryFlush({
      cfg: {} as OpenClawConfig,
      kind: "manual",
      context: {
        sessionId: "sess-1",
        sessionKey: "main",
        sessionFile: "/tmp/sess-1.jsonl",
        sessionEntry: {
          sessionId: "sess-1",
          compactionCount: 3,
        } as never,
        sessionStore: {
          main: {
            sessionId: "sess-1",
            compactionCount: 3,
          } as never,
        },
        storePath: "/tmp/sessions.json",
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp",
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        verboseLevel: "off",
      },
    });

    expect(result.ok).toBe(true);
    expect(state.updateSessionStoreEntryMock).toHaveBeenCalledTimes(1);
    const update = state.updateSessionStoreEntryMock.mock.calls[0]?.[0]?.update;
    expect(update).toBeTypeOf("function");
    const patch = await update({ sessionId: "sess-1", compactionCount: 3 });
    expect(patch).toEqual({ memoryFlushAt: expect.any(Number) });
    expect(patch).not.toHaveProperty("memoryFlushCompactionCount");
  });
});
