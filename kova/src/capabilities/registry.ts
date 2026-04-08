export type KovaCapabilityDefinition = {
  id: string;
  title: string;
  area: string;
  description: string;
};

const kovaCapabilityDefinitions = [
  {
    id: "workflow.behavior",
    title: "Behavior Workflow",
    area: "workflow",
    description: "Multi-step product behavior remains coherent across a full OpenClaw workflow.",
  },
  {
    id: "lane.qa",
    title: "QA Lane",
    area: "verification",
    description: "The QA scenario lane is healthy and produces usable behavioral evidence.",
  },
  {
    id: "channel.shared",
    title: "Shared Channel Routing",
    area: "channels",
    description: "Shared-channel conversations route and respond correctly under group semantics.",
  },
  {
    id: "channel.direct",
    title: "Direct Message Routing",
    area: "channels",
    description: "Direct-message conversations route and respond correctly in one-to-one flows.",
  },
  {
    id: "character.roleplay",
    title: "Character Performance",
    area: "behavior",
    description: "Character-driven multi-turn responses stay natural and on-role.",
  },
  {
    id: "config.apply",
    title: "Config Apply",
    area: "config",
    description:
      "Configuration mutations apply safely and leave the runtime in a consistent state.",
  },
  {
    id: "config.restart-recovery",
    title: "Restart Recovery",
    area: "runtime",
    description: "Restart-triggering changes recover cleanly and resume expected behavior.",
  },
  {
    id: "automation.cron",
    title: "Scheduled Automation",
    area: "automation",
    description: "Time-based automation and follow-up scheduling execute reliably.",
  },
  {
    id: "discovery.source-docs",
    title: "Source And Docs Discovery",
    area: "discovery",
    description: "Repo and documentation discovery succeeds before action or reporting.",
  },
  {
    id: "image.generation",
    title: "Image Generation",
    area: "media",
    description: "Image generation produces usable media artifacts and follow-up access to them.",
  },
  {
    id: "image.understanding",
    title: "Image Understanding",
    area: "media",
    description: "Image inputs reach the model correctly and can be interpreted accurately.",
  },
  {
    id: "inventory.runtime",
    title: "Runtime Inventory",
    area: "runtime",
    description: "Runtime inventory and exposed capability surfaces stay aligned with behavior.",
  },
  {
    id: "mcp.tools",
    title: "MCP Tool Surface",
    area: "integrations",
    description: "Plugin-owned tools are exposed and callable through the MCP surface.",
  },
  {
    id: "memory.core",
    title: "Memory Core",
    area: "memory",
    description: "Memory search, retrieval, and fallback behavior remain correct across contexts.",
  },
  {
    id: "messages.lifecycle",
    title: "Message Lifecycle Actions",
    area: "messages",
    description: "Reactions, edits, and deletes execute and propagate correctly.",
  },
  {
    id: "models.switching",
    title: "Model Switching",
    area: "models",
    description: "Model transitions preserve context and expected runtime behavior.",
  },
  {
    id: "skills.workspace",
    title: "Workspace Skills",
    area: "skills",
    description: "Workspace skill visibility, installation, and invocation remain healthy.",
  },
  {
    id: "subagents.coordination",
    title: "Subagent Coordination",
    area: "subagents",
    description: "Subagent delegation and synthesis complete correctly under bounded tasks.",
  },
  {
    id: "threads.routing",
    title: "Thread Routing",
    area: "threads",
    description: "Thread-local context and reply routing remain isolated and correct.",
  },
  {
    id: "workspace.mutation",
    title: "Workspace Mutation",
    area: "workspace",
    description: "Workspace reads and writes produce the intended artifact or change outcome.",
  },
] as const satisfies readonly KovaCapabilityDefinition[];

const capabilityById = new Map(
  kovaCapabilityDefinitions.map((capability) => [capability.id, capability]),
);

export function listKovaCapabilities() {
  return [...kovaCapabilityDefinitions];
}

export function readKovaCapability(id: string) {
  return capabilityById.get(id);
}

export function requireKovaCapabilityIds(ids: string[]) {
  const missingIds = ids.filter((id) => !capabilityById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`unknown Kova capability id(s): ${missingIds.join(", ")}`);
  }
  return ids;
}
