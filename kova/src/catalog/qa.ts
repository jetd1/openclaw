import { readQaScenarioPack } from "../../../extensions/qa-lab/api.js";
import { requireKovaCapabilityIds } from "../capabilities/registry.js";
import type { KovaScenarioResult } from "../contracts/run-artifact.js";

export type KovaQaScenarioCatalogEntry = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  sourcePath: string;
  capabilities: string[];
};

export type KovaQaSurfaceSummary = {
  surface: string;
  scenarioCount: number;
};

export function listKovaQaScenarios(): KovaQaScenarioCatalogEntry[] {
  const pack = readQaScenarioPack();
  return pack.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    surface: scenario.surface,
    objective: scenario.objective,
    sourcePath: scenario.sourcePath,
    capabilities: buildKovaQaCapabilities(scenario.surface),
  }));
}

export function buildKovaQaCapabilities(surface?: string) {
  const capabilities = new Set<string>(["workflow.behavior", "lane.qa"]);
  const normalizedSurface = surface?.trim();
  switch (normalizedSurface) {
    case "channel":
      capabilities.add("channel.shared");
      break;
    case "character":
      capabilities.add("character.roleplay");
      break;
    case "config":
      capabilities.add("config.apply");
      capabilities.add("config.restart-recovery");
      break;
    case "cron":
      capabilities.add("automation.cron");
      break;
    case "discovery":
      capabilities.add("discovery.source-docs");
      break;
    case "dm":
      capabilities.add("channel.direct");
      break;
    case "harness":
      capabilities.add("lane.qa");
      break;
    case "image-generation":
      capabilities.add("image.generation");
      break;
    case "image-understanding":
      capabilities.add("image.understanding");
      break;
    case "inventory":
      capabilities.add("inventory.runtime");
      break;
    case "mcp":
      capabilities.add("mcp.tools");
      break;
    case "memory":
      capabilities.add("memory.core");
      break;
    case "message-actions":
      capabilities.add("messages.lifecycle");
      break;
    case "models":
      capabilities.add("models.switching");
      break;
    case "skills":
      capabilities.add("skills.workspace");
      break;
    case "subagents":
      capabilities.add("subagents.coordination");
      break;
    case "thread":
      capabilities.add("threads.routing");
      break;
    case "workspace":
      capabilities.add("workspace.mutation");
      break;
    default:
      break;
  }
  return requireKovaCapabilityIds([...capabilities].toSorted());
}

export function findMissingKovaQaScenarioIds(selectedIds: string[]) {
  const knownIds = new Set(listKovaQaScenarios().map((scenario) => scenario.id));
  return selectedIds.filter((scenarioId) => !knownIds.has(scenarioId));
}

export function selectKovaQaScenarios(selectedIds?: string[]) {
  const catalog = listKovaQaScenarios();
  if (!selectedIds || selectedIds.length === 0) {
    return catalog;
  }
  const selectedSet = new Set(selectedIds);
  return catalog.filter((scenario) => selectedSet.has(scenario.id));
}

export function summarizeKovaQaSurfaces(): KovaQaSurfaceSummary[] {
  const counts = new Map<string, number>();
  for (const scenario of listKovaQaScenarios()) {
    counts.set(scenario.surface, (counts.get(scenario.surface) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([surface, scenarioCount]) => ({ surface, scenarioCount }))
    .toSorted((left, right) => left.surface.localeCompare(right.surface));
}

export function buildKovaCoverageFromScenarioResults(scenarioResults: KovaScenarioResult[]) {
  const capabilities = new Set<string>();
  const scenarioIds: string[] = [];
  const surfaces = new Set<string>();
  for (const scenario of scenarioResults) {
    scenarioIds.push(scenario.id);
    for (const capability of scenario.capabilities) {
      capabilities.add(capability);
    }
    if (scenario.surface) {
      surfaces.add(scenario.surface);
    }
  }
  return {
    scenarioIds,
    capabilities: [...capabilities].toSorted(),
    surfaces: [...surfaces].toSorted(),
  };
}

export function buildKovaCoverageFromQaCatalog(selectedIds?: string[]) {
  const scenarios = selectKovaQaScenarios(selectedIds);
  return {
    scenarioIds: scenarios.map((scenario) => scenario.id),
    capabilities: [...new Set(scenarios.flatMap((scenario) => scenario.capabilities))].toSorted(),
    surfaces: [...new Set(scenarios.map((scenario) => scenario.surface))].toSorted(),
  };
}
