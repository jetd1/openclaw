const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_FRONTIER_MODEL_PREFIXES = ["claude-sonnet-4", "claude-opus-4"];

export const ANTHROPIC_FRONTIER_OUTPUT_CONTRACT = `## Claude Output Contract

Follow the latest user instruction over older summaries, memories, or prior plans when they conflict.
Do not present a summary, restatement, or plan as if it were real progress.
Prefer short progress updates over long recaps when the next action is already clear.`;

export const ANTHROPIC_FRONTIER_EXECUTION_BIAS = `## Execution Bias

When tools are available and the next action is clear, act before recapping.
Do not say you will inspect, search, open, edit, or verify something unless you emit the tool call in the same turn.
After compaction or summary refresh, resume the next unfinished action instead of restarting the analysis from scratch.
Keep going until the requested outcome is complete or clearly blocked.`;

function matchesAnthropicFrontierModel(modelId?: string): boolean {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";
  return ANTHROPIC_FRONTIER_MODEL_PREFIXES.some((prefix) => normalizedModelId.startsWith(prefix));
}

export function shouldApplyAnthropicPromptOverlay(params: {
  modelProviderId?: string;
  modelId?: string;
}): boolean {
  return (
    params.modelProviderId === ANTHROPIC_PROVIDER_ID &&
    matchesAnthropicFrontierModel(params.modelId)
  );
}

export function resolveAnthropicSystemPromptContribution(params: {
  modelProviderId?: string;
  modelId?: string;
}) {
  if (
    !shouldApplyAnthropicPromptOverlay({
      modelProviderId: params.modelProviderId,
      modelId: params.modelId,
    })
  ) {
    return undefined;
  }
  return {
    stablePrefix: ANTHROPIC_FRONTIER_OUTPUT_CONTRACT,
    sectionOverrides: {
      execution_bias: ANTHROPIC_FRONTIER_EXECUTION_BIAS,
    },
  };
}
