import type { PluginServerContext } from "@getpaseo/plugin/server";

// The Plugin's dev SDK can predate lifecycle hooks even when the installed
// Paseo daemon exposes them. Keep the runtime contract narrow and typed.
type HookAgent = { id: string; provider: string };
type HookContext = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1];
type LifecycleEvents = {
  "agent.turn_started": { agent: HookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: HookAgent;
    turnId: string | null;
    outcome: { kind: "completed" | "failed" | "canceled" };
  };
};
type LifecycleServer = PluginServerContext & {
  on<K extends keyof LifecycleEvents>(
    name: K,
    handler: (event: LifecycleEvents[K], context: HookContext) => void | Promise<void>,
  ): () => void;
};
import { join } from "node:path";
import { readAllowances } from "./server/allowances";
import { addAntigravityLatestUsage } from "./server/antigravity";
import { AntigravityObservationStore, normalizeObservedUsage } from "./server/antigravity-observations";
import { paseoHome } from "./server/paseo-home";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  // Fork-only staging installation: do not open the production session-usage SQLite
  // cache. The stock plugin can delete/rebuild it on a schema version mismatch.
  // Install this fork with --id session-usage-antigravity-test.
  const isolatedIndexPath = join(paseoHome(), "plugin-data", "session-usage-antigravity-test", "index.sqlite");
  const index = new UsageIndex(defaultRoots(), isolatedIndexPath);
  // Isolated from production and from the disposable transcript index.
  const observations = AntigravityObservationStore.open(
    join(paseoHome(), "plugin-data", "session-usage-antigravity-test", "private-observations", "antigravity-observed.sqlite"),
  );
  // Staging diagnostics reveal only record count, never tokens, agent IDs or prompts.
  console.log("[session-usage] Antigravity observation records on startup:", observations?.count() ?? "unknown");
  const turnStarts = new Map<string, string>();
  const isAntigravity = (provider: string) =>
    provider === "antigravity" || provider.startsWith("antigravity/");

  if (typeof (server as Partial<LifecycleServer>).on !== "function") {
    throw new Error("Antigravity observation persistence requires Paseo lifecycle hooks");
  }
  const lifecycle = server as LifecycleServer;
  const offStarted = lifecycle.on("agent.turn_started", ({ agent, turnId }) => {
    if (isAntigravity(agent.provider) && turnId) turnStarts.set(agent.id, turnId);
  });
  const offEnded = lifecycle.on("agent.turn_ended", async (event, { paseo }) => {
    const { agent, turnId } = event;
    if (!observations || !isAntigravity(agent.provider) || !turnId ||
        event.outcome.kind !== "completed" || turnStarts.get(agent.id) !== turnId) return;
    // No replay for the hook: the observed turn ID must match the live started
    // turn and no newer turn may have started while awaiting the snapshot.
    try {
      const startedAt = new Date().toISOString();
      const refreshed = (await paseo.agents.ref(agent.id).refresh())?.agent;
      if (turnStarts.get(agent.id) !== turnId || !refreshed ||
          !isAntigravity(refreshed.provider) || refreshed.activeTurn) return;
      const usage = normalizeObservedUsage(refreshed.lastUsage);
      if (!usage) return; // Missing usage is unknown, never write zeros.
      if (observations.save({
        agentId: agent.id, provider: refreshed.provider, turnId,
        model: refreshed.runtimeInfo?.model ?? null,
        observedAt: startedAt, usage,
      })) {
        // Do not log conversations, agent identifiers or token counts.
        console.log("[session-usage] Antigravity latest observed turn persisted");
      }
    } catch (err) {
      console.warn("[session-usage] could not record Antigravity usage:",
        err instanceof Error ? err.message : String(err));
    } finally {
      if (turnStarts.get(agent.id) === turnId) turnStarts.delete(agent.id);
    }
  });
  // Start from the persistent index right away, so the first visit finds a fresh snapshot.
  index.snapshot();
  server.handle(listUsage, async ({ refresh, revision }, { paseo }) => {
    index.snapshot(refresh);
    await index.firstScan(1_500);
    // The local index cannot read Antigravity transcripts. Query only the
    // matching Paseo agent snapshots and label their last-turn data partial.
    return addAntigravityLatestUsage(
      index.view(),
      async (agentId) => (await paseo.agents.ref(agentId).refresh())?.agent ?? null,
      revision,
      (agentId) => observations?.get(agentId) ?? null,
    );
  });
  server.handle(listAllowances, ({ refresh }, { paseo }) => readAllowances(paseo, refresh));
  return () => {
    offStarted();
    offEnded();
    turnStarts.clear();
    index.dispose();
    observations?.close();
  };
}
