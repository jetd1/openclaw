import { listKovaBackends, listKovaTargets } from "../backends/registry.js";
import type { KovaRunTarget } from "../backends/types.js";
import { listKovaCapabilities } from "../capabilities/registry.js";
import { listKovaQaScenarios, summarizeKovaQaSurfaces } from "../catalog/qa.js";

function parseListArgs(args: string[]) {
  const json = args.includes("--json");
  const filteredArgs = args.filter((arg) => arg !== "--json");
  const [subject, maybeTarget] = filteredArgs;
  const target = maybeTarget === "qa" ? maybeTarget : undefined;
  return {
    subject: subject ?? "inventory",
    target,
    json,
  };
}

function renderTargetLines() {
  return ["Targets:", ...listKovaTargets().map((target) => `  - ${target}`)];
}

function renderBackendLines(target?: KovaRunTarget) {
  const heading = target ? `Backends (${target}):` : "Backends:";
  return [
    heading,
    ...listKovaBackends(target).map((backend) => `  - ${backend.id}: ${backend.title}`),
  ];
}

function renderScenarioLines(target?: KovaRunTarget) {
  const resolvedTarget: "qa" = target ?? "qa";
  const scenarios = listKovaQaScenarios();
  return [
    `Scenarios (${resolvedTarget}):`,
    ...scenarios.map(
      (scenario) =>
        `  - ${scenario.id}: ${scenario.title} [${scenario.surface}] (${scenario.sourcePath})`,
    ),
  ];
}

function renderSurfaceLines(target?: KovaRunTarget) {
  const resolvedTarget: "qa" = target ?? "qa";
  return [
    `Surfaces (${resolvedTarget}):`,
    ...summarizeKovaQaSurfaces().map(
      (surface) => `  - ${surface.surface}: ${surface.scenarioCount} scenario(s)`,
    ),
  ];
}

function renderCapabilityLines() {
  return [
    "Capabilities:",
    ...listKovaCapabilities().map(
      (capability) => `  - ${capability.id}: ${capability.title} [${capability.area}]`,
    ),
  ];
}

export async function listCommand(args: string[]) {
  const options = parseListArgs(args);

  if (options.subject === "targets") {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ targets: listKovaTargets() }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderTargetLines().join("\n")}\n`);
    return;
  }

  if (options.subject === "backends") {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            target: options.target ?? null,
            backends: listKovaBackends(options.target).map((backend) => ({
              id: backend.id,
              title: backend.title,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${renderBackendLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "scenarios") {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            target: options.target ?? "qa",
            scenarios: listKovaQaScenarios(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${renderScenarioLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "surfaces") {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            target: options.target ?? "qa",
            surfaces: summarizeKovaQaSurfaces(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${renderSurfaceLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "capabilities") {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            capabilities: listKovaCapabilities(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${renderCapabilityLines().join("\n")}\n`);
    return;
  }

  if (options.subject === "inventory") {
    const scenarioCount = listKovaQaScenarios().length;
    const surfaceCount = summarizeKovaQaSurfaces().length;
    const capabilityCount = listKovaCapabilities().length;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            targets: listKovaTargets(),
            backends: listKovaBackends().map((backend) => ({
              id: backend.id,
              title: backend.title,
            })),
            qaCatalog: {
              scenarioCount,
              surfaceCount,
            },
            capabilityRegistry: {
              count: capabilityCount,
            },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const lines = [
      ...renderTargetLines(),
      "",
      ...renderBackendLines(),
      "",
      `QA Catalog: ${scenarioCount} scenario(s) across ${surfaceCount} surface(s)`,
      `Capability Registry: ${capabilityCount} capability id(s)`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  throw new Error(`unsupported kova list subject: ${options.subject}`);
}
