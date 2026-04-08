import { kovaRunArtifactSchema, type KovaRunArtifact } from "../contracts/run-artifact.js";
import {
  ensureDir,
  readJsonFile,
  resolveKovaRunDir,
  resolveKovaRoot,
  resolveKovaRunIndexPath,
  writeJsonFile,
} from "./fs.js";

const kovaRunIndexSchema = kovaRunArtifactSchema
  .pick({
    runId: true,
    selection: true,
    backend: true,
    verdict: true,
    status: true,
    timing: true,
  })
  .extend({
    scenario: kovaRunArtifactSchema.shape.scenario.default({
      id: "unknown",
      title: "Unknown scenario",
      category: "unknown",
      capabilities: [],
    }),
    classification: kovaRunArtifactSchema.shape.classification.default({
      domain: "unknown",
      reason: "legacy Kova run index entry",
    }),
    counts: kovaRunArtifactSchema.shape.counts.default({
      total: 0,
      passed: 0,
      failed: 0,
    }),
    coverage: kovaRunArtifactSchema.shape.coverage.default({
      scenarioIds: [],
      capabilities: [],
      capabilityAreas: [],
      surfaces: [],
    }),
    execution: kovaRunArtifactSchema.shape.execution.default({
      state: "planned",
      availability: "unknown",
      cleanup: {
        status: "unknown",
      },
      paths: {},
    }),
    updatedAt: kovaRunArtifactSchema.shape.timing.shape.finishedAt,
  });

const kovaRunIndexFileSchema = kovaRunArtifactSchema.pick({}).extend({
  latestRunId: kovaRunArtifactSchema.shape.runId.optional(),
  runs: kovaRunIndexSchema.array().default([]),
});

type KovaRunIndexEntry = typeof kovaRunIndexSchema._type;
type KovaRunIndexFile = typeof kovaRunIndexFileSchema._type;

function createKovaRunIndexEntry(artifact: KovaRunArtifact): KovaRunIndexEntry {
  return {
    runId: artifact.runId,
    selection: artifact.selection,
    scenario: artifact.scenario,
    backend: artifact.backend,
    verdict: artifact.verdict,
    status: artifact.status,
    classification: artifact.classification,
    timing: artifact.timing,
    counts: artifact.counts,
    coverage: artifact.coverage,
    execution: artifact.execution,
    updatedAt: artifact.timing.finishedAt,
  };
}

function needsHydration(entry: KovaRunIndexEntry) {
  return (
    entry.scenario.id === "unknown" ||
    entry.classification.domain === "unknown" ||
    entry.execution.state === "planned" ||
    entry.coverage.capabilityAreas.length === 0
  );
}

export async function readKovaRunIndex(repoRoot: string): Promise<KovaRunIndexFile> {
  const indexPath = resolveKovaRunIndexPath(repoRoot);
  const current = await readJsonFile<KovaRunIndexFile>(indexPath).catch(() => ({
    latestRunId: undefined,
    runs: [],
  }));
  return kovaRunIndexFileSchema.parse(current);
}

export async function hydrateKovaRunIndex(repoRoot: string): Promise<KovaRunIndexFile> {
  const current = await readKovaRunIndex(repoRoot);
  let changed = false;
  const runs = await Promise.all(
    current.runs.map(async (entry) => {
      if (!needsHydration(entry)) {
        return entry;
      }
      const artifactPath = `${resolveKovaRunDir(repoRoot, entry.runId)}/run.json`;
      const artifact = await readJsonFile<KovaRunArtifact>(artifactPath)
        .then((value) => kovaRunArtifactSchema.parse(value))
        .catch(() => null);
      if (!artifact) {
        return entry;
      }
      changed = true;
      return createKovaRunIndexEntry(artifact);
    }),
  );
  if (!changed) {
    return current;
  }
  const next = kovaRunIndexFileSchema.parse({
    latestRunId: current.latestRunId,
    runs: runs.toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
  });
  await writeJsonFile(resolveKovaRunIndexPath(repoRoot), next);
  return next;
}

export async function updateKovaRunIndex(repoRoot: string, artifact: KovaRunArtifact) {
  const rootDir = resolveKovaRoot(repoRoot);
  await ensureDir(rootDir);
  const indexPath = resolveKovaRunIndexPath(repoRoot);
  const current = await readKovaRunIndex(repoRoot);
  const nextEntry = createKovaRunIndexEntry(artifact);
  const filteredRuns = current.runs.filter((entry) => entry.runId !== artifact.runId);
  const runs = [...filteredRuns, nextEntry].toSorted((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt),
  );
  await writeJsonFile(indexPath, {
    latestRunId: artifact.runId,
    runs,
  } satisfies KovaRunIndexFile);
}
