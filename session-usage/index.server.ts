import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readAllowances } from "./server/allowances";
import { addAntigravityLatestUsage } from "./server/antigravity";
import { defaultIndexPath } from "./server/index-store";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const index = new UsageIndex(defaultRoots(), defaultIndexPath());
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
    );
  });
  server.handle(listAllowances, ({ refresh }, { paseo }) => readAllowances(paseo, refresh));
  return () => index.dispose();
}
