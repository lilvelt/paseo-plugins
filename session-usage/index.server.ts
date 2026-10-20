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
import { readAllowances } from "./server/allowances";
import { addAntigravityLatestUsage } from "./server/antigravity";
import { AntigravityObservationStore, normalizeObservedUsage, observationPathForIndex, usageChangedSinceStart, type ObservedUsage } from "./server/antigravity-observations";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { defaultIndexPath } from "./server/index-store";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  // The production plugin preserves the established Session usage index path.
  // Keep durable observations in a distinct private directory, never inside
  // the disposable transcript index (which can be rebuilt on schema changes).
  const indexPath = defaultIndexPath();
  const index = new UsageIndex(defaultRoots(), indexPath);
  const observations = AntigravityObservationStore.open(observationPathForIndex(indexPath));
  // Snapshot the previous lastUsage at turn start. Paseo can keep that old
  // value when turn_completed lacks a usage report, so never attribute a
  // byte-identical snapshot to the next turn without new evidence.
  const turnStarts = new Map<string, {
    turnId: string;
    prior: Promise<ObservedUsage | null | undefined>;
  }>();
  const isAntigravity = (provider: string) =>
    provider === "antigravity" || provider.startsWith("antigravity/");

  if (typeof (server as Partial<LifecycleServer>).on !== "function") {
    throw new Error("Antigravity observation persistence requires Paseo lifecycle hooks");
  }
  const lifecycle = server as LifecycleServer;
  const offStarted = lifecycle.on("agent.turn_started", ({ agent, turnId }, { paseo }) => {
    if (!isAntigravity(agent.provider) || !turnId || !observations) return;
    const prior = paseo.agents.ref(agent.id).refresh()
      .then((snapshot) => normalizeObservedUsage(snapshot?.agent?.lastUsage))
      .catch(() => undefined);
    turnStarts.set(agent.id, { turnId, prior });
  });
  const offEnded = lifecycle.on("agent.turn_ended", async (event, { paseo }) => {
    const { agent, turnId } = event;
    const started = turnStarts.get(agent.id);
    if (!started || !turnId || started.turnId !== turnId) return;
    if (!observations || !isAntigravity(agent.provider) || event.outcome.kind !== "completed") {
      turnStarts.delete(agent.id);
      return;
    }
    try {
      const before = await started.prior;
      if (turnStarts.get(agent.id) !== started) return;
      const observedAt = new Date().toISOString();
      const refreshed = (await paseo.agents.ref(agent.id).refresh())?.agent;
      if (turnStarts.get(agent.id) !== started || !refreshed ||
          !isAntigravity(refreshed.provider) || refreshed.activeTurn) return;
      const after = normalizeObservedUsage(refreshed.lastUsage);
      if (!usageChangedSinceStart(before, after) || !after) return;
      observations.save({
        agentId: agent.id, provider: refreshed.provider, turnId,
        model: refreshed.runtimeInfo?.model ?? null,
        observedAt, usage: after,
      });
    } catch {
      // Unknown is safer than linking stale usage to a completed turn.
      console.warn("[session-usage] Antigravity usage observation unavailable");
    } finally {
      if (turnStarts.get(agent.id) === started) turnStarts.delete(agent.id);
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
