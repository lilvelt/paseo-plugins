import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { readAllowances } from "./server/allowances";
import { addAntigravityLatestUsage } from "./server/antigravity";
import { paseoHome } from "./server/paseo-home";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  // Fork-only staging installation: do not open the production session-usage SQLite
  // cache. The stock plugin can delete/rebuild it on a schema version mismatch.
  // Install this fork with --id session-usage-antigravity-test.
  const isolatedIndexPath = join(paseoHome(), "plugin-data", "session-usage-antigravity-test", "index.sqlite");
  const index = new UsageIndex(defaultRoots(), isolatedIndexPath);
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
