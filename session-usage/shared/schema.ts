import { z } from "zod";

const measurement = z.number().finite().nonnegative().nullable();
export const MetricsSchema = z.object({
  inputTokens: measurement,
  uncachedTokens: measurement,
  cacheReadTokens: measurement,
  cacheWriteTokens: measurement,
  cacheWrite1hTokens: measurement,
  outputTokens: measurement,
  reasoningTokens: measurement,
  requests: measurement,
  userMessages: measurement,
  assistantMessages: measurement,
  toolCalls: measurement,
  toolErrors: measurement,
  toolExecutions: measurement,
  executionErrors: measurement,
  userCharacters: measurement,
  assistantCharacters: measurement,
  toolInputCharacters: measurement,
  toolOutputCharacters: measurement,
  compactions: measurement,
  activeMs: measurement,
  reportedCostUsd: measurement,
  estimatedCostUsd: measurement,
});
export type Metrics = z.infer<typeof MetricsSchema>;
export type MetricKey = keyof Metrics;
export const METRIC_KEYS = Object.keys(MetricsSchema.shape) as MetricKey[];
export function emptyMetrics(): Metrics {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Metrics;
}
/** Null is unknown. Aggregates are known subtotals; callers display coverage. */
export function addMetrics(target: Metrics, source: Metrics): Metrics {
  for (const key of METRIC_KEYS) {
    if (source[key] !== null) target[key] = (target[key] ?? 0) + source[key]!;
  }
  return target;
}
export const BucketSchema = z.object({
  day: z.string(), // UTC YYYY-MM-DD, or "unknown" for undated records.
  dateBasis: z.enum(["observed"]).optional(), // Staging Antigravity: plugin observation time, NOT provider event time.
  hour: z.number().int().min(0).max(23).nullable().optional(), // UTC hour of the day; null for undated records.
  model: z.string(),
  effort: z.string().nullable().optional(), // Omitted by older snapshots; null when unrecorded.
  metrics: MetricsSchema,
  tools: z.record(z.string(), z.number().int().nonnegative()),
});
export type Bucket = z.infer<typeof BucketSchema>;
export const SessionSchema = z.object({
  id: z.string(),
  nativeId: z.string(),
  provider: z.string(), // Paseo provider ID, including custom providers.
  providerLabel: z.string(),
  kind: z.enum(["main", "subagent"]),
  parentId: z.string().nullable(),
  title: z.string(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspace: z.string(),
  projectId: z.string().nullable(),
  project: z.string(),
  cwd: z.string(),
  branch: z.string(),
  labels: z.array(z.string()),
  archived: z.boolean(),
  status: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  bytes: z.number().nonnegative(),
  coverage: z.enum(["available", "partial", "missing"]),
  warnings: z.array(z.string()),
  buckets: z.array(BucketSchema),
});
export type Session = z.infer<typeof SessionSchema>;
export const SnapshotSchema = z.object({
  sessions: z.array(SessionSchema),
  scanning: z.boolean(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  generatedAt: z.string().nullable(),
  warnings: z.array(z.string()),
  revision: z.string(), // Changes whenever the sessions change; empty before the first completed scan.
  unchanged: z.boolean().optional(), // Sessions are omitted because the caller already has this revision.
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
