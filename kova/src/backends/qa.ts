import { runQaAdapter } from "../adapters/qa.js";
import type { KovaBackend } from "./types.js";

export const qaBackend: KovaBackend = {
  id: "host",
  title: "Host runtime",
  supportsTarget(target): target is "qa" {
    return target === "qa";
  },
  async run(selection) {
    return await runQaAdapter({
      repoRoot: selection.repoRoot,
      runId: selection.runId,
      providerMode: selection.providerMode,
      scenarioIds: selection.scenarioIds,
    });
  },
};
