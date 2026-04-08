import path from "node:path";
import { kovaRunArtifactSchema } from "../contracts/run-artifact.js";
import { ensureDir, resolveKovaRunDir, writeJsonFile } from "../lib/fs.js";
import { resolveGitCommit, resolveGitDirty } from "../lib/git.js";
import { updateKovaRunIndex } from "../lib/run-index.js";
import type { KovaBackend } from "./types.js";

export const multipassBackend: KovaBackend = {
  id: "multipass",
  title: "Multipass VM",
  supportsTarget(target): target is "qa" {
    return target === "qa";
  },
  async run(selection) {
    const startedAt = new Date();
    const runDir = resolveKovaRunDir(selection.repoRoot, selection.runId);
    await ensureDir(runDir);
    const finishedAt = new Date();
    const reason = `multipass backend is not implemented yet for target ${selection.target}; use --backend host for now`;
    const artifact = kovaRunArtifactSchema.parse({
      schemaVersion: 1,
      runId: selection.runId,
      selection: {
        command: "run",
        target: selection.target,
      },
      scenario: {
        id: selection.target,
        title: "QA suite",
        category: "behavior",
        capabilities: ["behavior", "qa"],
      },
      backend: {
        kind: "multipass",
      },
      environment: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        gitCommit: await resolveGitCommit(selection.repoRoot),
        gitDirty: await resolveGitDirty(selection.repoRoot),
      },
      status: "infra_failed",
      verdict: "blocked",
      classification: {
        domain: "backend",
        reason,
      },
      timing: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
      counts: {
        total: 0,
        passed: 0,
        failed: 0,
      },
      scenarioResults: [],
      evidence: {
        sourceArtifactPaths: [runDir, path.join(runDir, "run.json")],
      },
      notes: ["backend=multipass", "state=scaffold"],
    });
    await writeJsonFile(path.join(runDir, "run.json"), artifact);
    await updateKovaRunIndex(selection.repoRoot, artifact);
    return artifact;
  },
};
