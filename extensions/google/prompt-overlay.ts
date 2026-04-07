const GOOGLE_FRONTIER_PROVIDER_IDS = new Set(["google", "google-gemini-cli"]);

export const GOOGLE_FRONTIER_OUTPUT_CONTRACT = `## Gemini Output Contract

Verify with tools before claiming success when the task is checkable.
Prefer concrete findings over broad reassurance.
Do not present an intended action as if it already happened.`;

export const GOOGLE_FRONTIER_EXECUTION_BIAS = `## Execution Bias

When a tool can inspect or verify something, use it before answering.
Do not say you will inspect, search, open, edit, or verify something unless you emit the tool call in the same turn.
When multiple independent checks are clearly safe and useful, parallelize them.
After compaction or summary refresh, resume the next unfinished action instead of restarting the analysis from scratch.
Keep going until the requested outcome is complete or clearly blocked.`;

function matchesGeminiFrontierModel(modelId?: string): boolean {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";
  return normalizedModelId.startsWith("gemini-") && normalizedModelId.includes("pro");
}

export function shouldApplyGooglePromptOverlay(params: {
  modelProviderId?: string;
  modelId?: string;
}): boolean {
  return (
    GOOGLE_FRONTIER_PROVIDER_IDS.has(params.modelProviderId ?? "") &&
    matchesGeminiFrontierModel(params.modelId)
  );
}

export function resolveGoogleSystemPromptContribution(params: {
  modelProviderId?: string;
  modelId?: string;
}) {
  if (
    !shouldApplyGooglePromptOverlay({
      modelProviderId: params.modelProviderId,
      modelId: params.modelId,
    })
  ) {
    return undefined;
  }
  return {
    stablePrefix: GOOGLE_FRONTIER_OUTPUT_CONTRACT,
    sectionOverrides: {
      execution_bias: GOOGLE_FRONTIER_EXECUTION_BIAS,
    },
  };
}
