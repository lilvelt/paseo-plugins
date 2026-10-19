import { createHash } from "node:crypto";
import { emptyMetrics, type Bucket, type Session, type Snapshot } from "../shared/schema";

/**
 * Antigravity currently reports per-turn usage to Paseo, but neither its local
 * transcripts nor a lifetime usage counter are available to Session usage.
 * An agent snapshot therefore describes AT MOST its latest observed turn.
 * Do not present that snapshot as a complete session total.
 */
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalCostUsd?: number;
}
export interface AntigravityAgentSnapshot {
  provider: string;
  activeTurn?: { turnId: string } | null;
  lastUsage?: Usage | null;
  runtimeInfo?: { model?: string | null } | null;
}
export type ReadAntigravityAgent = (id: string) => Promise<AntigravityAgentSnapshot | null>;

/** Paseo persists the provider/model selection, e.g. antigravity/gemini-4-argon-medium. */
const isAntigravity = (provider: string): boolean =>
  provider === "antigravity" || provider.startsWith("antigravity/");

const measured = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const UNAVAILABLE = "This provider keeps no local usage records that Session usage can read.";
const LATEST_ONLY =
  "Antigravity: observed usage is from the last available Paseo turn only, NOT this session's lifetime. " +
  "Earlier turns, cache writes, true uncached input, and usage outside Paseo are unknown.";

function latestTurn(session: Session, agent: AntigravityAgentSnapshot | null): Session {
  if (!agent || !isAntigravity(agent.provider) || agent.activeTurn || !agent.lastUsage) return session;

  const usage = agent.lastUsage;
  const input = measured(usage.inputTokens);
  const cacheRead = measured(usage.cachedInputTokens);
  const output = measured(usage.outputTokens);
  const cost = measured(usage.totalCostUsd);
  if (input === null && cacheRead === null && output === null && cost === null) return session;

  const metrics = emptyMetrics();
  // The agy input_tokens field may or may not include cached reads. Until its
  // accounting contract is established, do not publish a "normalized" total,
  // uncached input, hit rate or estimated API cost from this snapshot.
  // When cache reads are explicitly zero, raw reported input can be
  // displayed; "uncached" still is unknown because agy does not report
  // whether/how many input tokens were written to cache.
  if (cacheRead === 0) {
    metrics.inputTokens = input;
  }
  metrics.cacheReadTokens = cacheRead;
  metrics.outputTokens = output;
  metrics.reportedCostUsd = cost;

  const bucket: Bucket = {
    day: "unknown", // No authoritative timestamp for the last usage snapshot.
    hour: null,
    model: agent.runtimeInfo?.model || "unknown",
    effort: null,
    metrics,
    tools: {},
  };

  return {
    ...session,
    coverage: "partial",
    warnings: [...session.warnings.filter((w) => w !== UNAVAILABLE), LATEST_ONLY],
    buckets: [bucket],
  };
}

/**
 * Preserve snapshot revision semantics when a live agent's latest usage changes
 * without any local transcript changing. RPC failures remain missing, never zero.
 */
export async function addAntigravityLatestUsage(
  snapshot: Snapshot,
  read: ReadAntigravityAgent,
  revision?: string,
): Promise<Snapshot> {
  const sessions = await Promise.all(snapshot.sessions.map(async (session) => {
    if (!isAntigravity(session.provider) || !session.agentId) return session;
    try {
      return latestTurn(session, await read(session.agentId));
    } catch {
      return session; // Optional live read must never break other providers.
    }
  }));
  const nextRevision = createHash("sha256").update(JSON.stringify(sessions)).digest("base64url").slice(0, 22);
  return {
    ...snapshot,
    revision: nextRevision,
    sessions: revision === nextRevision ? [] : sessions,
    ...(revision === nextRevision ? { unchanged: true } : { unchanged: false }),
  };
}
