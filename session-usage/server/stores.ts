import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { estimateCost } from "../shared/pricing";
import { emptyMetrics, type Bucket, type Metrics, type MetricKey } from "../shared/schema";
import { COUNT_KEYS, compareBuckets, object, type ParsedTranscript } from "./parser";

/** A session read from a provider's SQLite store. `messages` lets the indexer skip empty sessions. */
export interface StoreSession { nativeId: string; parentId: string | null; archived: boolean; bytes: number; messages: number; parsed: ParsedTranscript }
export type StoreReader = (db: DatabaseSync, file: { mtimeMs: number }) => StoreSession[];

type SqliteModule = typeof import("node:sqlite");
type Row = Record<string, unknown>;

export function loadSqlite(): SqliteModule | null {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const loaded = getBuiltin.call(process, "node:sqlite") as SqliteModule | undefined;
    return loaded && typeof loaded.DatabaseSync === "function" ? loaded : null;
  } catch { return null; }
}

/** Opens the store read-only and closes it before returning; the provider may be writing to it. */
export function readStore(path: string, read: StoreReader, file: { mtimeMs: number }): StoreSession[] {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error("node:sqlite is unavailable");
  const db = new sqlite.DatabaseSync(path, { readOnly: true, timeout: 2_000 });
  try { return read(db, file); } finally { db.close(); }
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
/** ISO strings, epoch seconds or epoch milliseconds. */
function iso(value: unknown): string | null {
  let ms = typeof value === "string" ? Date.parse(value) : num(value) ?? NaN;
  if (typeof value === "number" && ms < 1e12) ms *= 1000;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

/** Both stores record uncached input with disjoint cache reads and writes. */
function usage(model: string, input: number | null, output: number | null, read: number | null, write: number | null, reasoning: number | null): Metrics | null {
  if (input === null && output === null) return null;
  const m = emptyMetrics();
  m.uncachedTokens = input;
  m.cacheReadTokens = read ?? (input === null ? null : 0);
  m.cacheWriteTokens = write ?? (input === null ? null : 0);
  m.inputTokens = input === null ? null : input + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
  m.outputTokens = output;
  m.reasoningTokens = reasoning;
  m.requests = 1;
  m.estimatedCostUsd = estimateCost(model, m);
  return m;
}

class SessionBuilder {
  private buckets = new Map<string, Bucket>();
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  bytes = 0;
  messages = 0;
  constructor(private countKeys: readonly MetricKey[]) {}

  time(at: string | null): void {
    if (!at) return;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    if (!this.endedAt || at > this.endedAt) this.endedAt = at;
  }
  add(at: string | null, model: string, effort: string | null, metrics: Partial<Metrics>, tool?: string): void {
    const day = at?.slice(0, 10) ?? "unknown";
    const hour = at ? Number(at.slice(11, 13)) : null;
    const key = JSON.stringify([day, hour, model, effort]);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { day, hour, model, effort, metrics: emptyMetrics(), tools: Object.create(null) as Record<string, number> };
      // Absence of a recorded event is a known zero only for measurements the store records.
      for (const metric of this.countKeys) bucket.metrics[metric] = 0;
      this.buckets.set(key, bucket);
    }
    for (const [metric, value] of Object.entries(metrics) as [MetricKey, number | null | undefined][]) {
      if (typeof value === "number") bucket.metrics[metric] = (bucket.metrics[metric] ?? 0) + value;
    }
    if (tool) bucket.tools[tool] = (bucket.tools[tool] ?? 0) + 1;
  }
  finish(base: Pick<ParsedTranscript, "nativeId" | "parentId" | "cwd" | "title" | "branch">, created: string | null, updated: string | null, missingTokens = "No token usage records found; token and cost measurements are unknown."): ParsedTranscript {
    const buckets = [...this.buckets.values()].sort(compareBuckets);
    const warnings = buckets.some((bucket) => bucket.metrics.inputTokens !== null) ? [] : [missingTokens];
    return { ...base, startedAt: this.startedAt ?? created, endedAt: this.endedAt ?? updated ?? created, buckets, warnings };
  }
}

/** SQLite v1 and v2 may coexist while OpenCode migrates sessions by ID. */
const hasTable = (db: DatabaseSync, table: string): boolean =>
  Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table));

/**
 * OpenCode v2 (2026): session_v2 stores session-lifetime cumulative counters.
 * It no longer has the v1 session/message/part storage contract.
 * Counters are NOT turn/day/model-attributable, so keep the activity bucket
 * undated and report no per-request count or API-rate cost estimate.
 */
export const readOpenCodeV2Store: StoreReader = (db) => {
  const required = ["id", "parent_id", "directory", "title", "time_created", "time_updated",
    "cost", "tokens_input", "tokens_output", "tokens_reasoning",
    "tokens_cache_read", "tokens_cache_write"];
  const columns = new Set((db.prepare("PRAGMA table_info(session_v2)").all() as Row[]).map((column) => str(column.name)));
  if (required.some((column) => !columns.has(column))) throw new Error("unsupported OpenCode v2 session_v2 schema");
  const sessions = db.prepare(`SELECT id, parent_id AS parentId, directory, title,
    time_created AS created, time_updated AS updated,
    ${columns.has("time_archived") ? "time_archived" : "NULL"} AS archived,
    cost, tokens_input AS input, tokens_output AS output,
    tokens_reasoning AS reasoning, tokens_cache_read AS cacheRead,
    tokens_cache_write AS cacheWrite FROM session_v2`).all() as Row[];
  // Count records, not content; v2 no longer uses the v1 message/part tables.
  const counts = new Map<string, { count: number; bytes: number }>();
  if (hasTable(db, "session_message")) {
    const records = db.prepare(`SELECT session_id AS sessionId, COUNT(*) AS n,
      COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes
      FROM session_message GROUP BY session_id`).all() as Row[];
    for (const row of records) counts.set(str(row.sessionId),
      { count: num(row.n) ?? 0, bytes: num(row.bytes) ?? 0 });
  }
  return sessions.map((row) => {
    const input = num(row.input), output = num(row.output), reasoning = num(row.reasoning);
    const metrics = usage("unknown", input,
      output === null ? null : output + (reasoning ?? 0), num(row.cacheRead), num(row.cacheWrite), reasoning);
    // Cumulative counters have no request identity; the session may have used
    // multiple models, so a single-model cost estimate would be misleading.
    if (metrics) { metrics.requests = null; metrics.estimatedCostUsd = null; }
    const builder = new SessionBuilder([]);
    builder.time(iso(row.created));
    builder.time(iso(row.updated));
    builder.add(null, "unknown", null, { ...(metrics ?? {}),
      reportedCostUsd: num(row.cost) });
    const nativeId = str(row.id), parentId = str(row.parentId) || null;
    const base = { nativeId, parentId, cwd: str(row.directory),
      title: str(row.title).slice(0, 300), branch: "" };
    const parsed = builder.finish(base, iso(row.created), iso(row.updated));
    parsed.warnings.push("OpenCode v2: session-lifetime cumulative usage only; per-turn dates, request count, tool counts and model attribution are unknown.");
    const countsFor = counts.get(nativeId);
    const positiveTokens = (metrics?.inputTokens ?? 0) + (metrics?.outputTokens ?? 0) > 0;
    return {
      nativeId, parentId, archived: row.archived !== null && row.archived !== undefined,
      bytes: countsFor?.bytes ?? 0,
      messages: Math.max(countsFor?.count ?? 0, positiveTokens ? 1 : 0),
      parsed,
    };
  });
};

/**
 * The upstream V1 -> V2 copier walks IDs in DESC order, updating the cursor
 * atomically with each copied session. Above the cursor, an absent v2 ID may
 * have been explicitly deleted in v2 and must not be resurrected from v1.
 * A completed migration has no surviving cursor: v1-only rows then remain
 * fundamentally ambiguous (stranded migration vs. deleted v2 session).
 * Missing/unreadable state is likewise not evidence that those rows are live.
 */
type OpenCodeMigrationState =
  | { phase: "sessions"; cursor?: string }
  | { phase: "completed" }
  | { phase: "unverified" };

function openCodeMigrationState(db: DatabaseSync): OpenCodeMigrationState {
  // The status itself is auxiliary data: an unreadable kv table must not
  // prevent otherwise valid v2 sessions from being reported.
  try {
    if (!hasTable(db, "kv")) return { phase: "unverified" };
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get("migration.v1-v2") as Row | undefined;
    if (!row || typeof row.value !== "string") return { phase: "unverified" };
    const value: unknown = JSON.parse(row.value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { phase: "unverified" };
    const state = value as Record<string, unknown>;
    if (state.phase === "completed") return { phase: "completed" };
    if (state.phase === "sessions" &&
        (state.cursor === undefined || (typeof state.cursor === "string" && state.cursor.length > 0))) {
      return { phase: "sessions", ...(state.cursor === undefined ? {} : { cursor: state.cursor }) };
    }
  } catch { /* Malformed JSON, incomplete kv schema, or unavailable metadata. */ }
  return { phase: "unverified" };
}

/** Legacy OpenCode v1 reader. Excludes IDs already represented in v2. */
const readOpenCodeV1Store = (
  db: DatabaseSync, file: { mtimeMs: number }, v2Ids: ReadonlySet<string>,
  migration: OpenCodeMigrationState | null,
): StoreSession[] => {
  const columns = new Set((db.prepare("PRAGMA table_info(session)").all() as Row[]).map((column) => str(column.name)));
  const sessions = (db.prepare(`SELECT id, parent_id AS parentId, directory, title, time_created AS created, time_updated AS updated,
    ${columns.has("time_archived") ? "time_archived" : "NULL"} AS archived FROM session`).all() as Row[])
    .filter((row) => {
      const id = str(row.id);
      if (v2Ids.has(id)) return false;
      // The cursor is the last copied ID. A missing v2 record on or above
      // that boundary can represent a user-deleted v2 session.
      return migration?.phase !== "sessions" || migration.cursor === undefined || id < migration.cursor;
    });
  // During migration, skip old records already copied to v2, including all
  // their token/part counters. No legacy-only rows means no v1 query is needed.
  if (!sessions.length) return [];
  if (!hasTable(db, "message") || !hasTable(db, "part")) {
    throw new Error("OpenCode legacy sessions exist without readable message/part tables");
  }
  const messages = db.prepare(`SELECT id, session_id AS sessionId, time_created AS created,
    json_extract(data, '$.role') AS role, json_extract(data, '$.parentID') AS parentId,
    coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS model,
    json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
    json_extract(data, '$.tokens.reasoning') AS reasoning, json_extract(data, '$.tokens.cache.read') AS cacheRead,
    json_extract(data, '$.tokens.cache.write') AS cacheWrite, json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.time.completed') AS completed, length(CAST(data AS BLOB)) AS bytes
    FROM message ORDER BY time_created, id`).all() as Row[];
  const parts = db.prepare(`SELECT message_id AS messageId, json_extract(data, '$.type') AS type, json_extract(data, '$.tool') AS tool,
    json_extract(data, '$.state.status') AS status, length(json_extract(data, '$.text')) AS textLength,
    length(json_extract(data, '$.state.input')) AS inputLength,
    length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'))) AS outputLength,
    length(CAST(data AS BLOB)) AS bytes FROM part`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(COUNT_KEYS)]));
  const byMessage = new Map<string, { builder: SessionBuilder; at: string | null; model: string; role: string }>();
  const turns = new Map<string, { builder: SessionBuilder; start: number; end: number | null; model: string }>();
  for (const message of messages) {
    const builder = builders.get(str(message.sessionId));
    if (!builder) continue;
    const at = iso(message.created);
    const role = str(message.role);
    const model = str(message.model) || "unknown";
    builder.time(at);
    builder.time(iso(message.completed));
    builder.bytes += num(message.bytes) ?? 0;
    byMessage.set(str(message.id), { builder, at, model, role });
    if (role === "user") {
      builder.messages++;
      builder.add(at, model, null, { userMessages: 1 });
      const start = num(message.created);
      if (start !== null) turns.set(str(message.id), { builder, start, end: null, model });
    }
    if (role === "assistant") {
      builder.messages++;
      // OpenCode records reasoning separately from output; normalized output includes it.
      const output = num(message.output), reasoning = num(message.reasoning);
      const tokens = usage(model, num(message.input), output === null ? null : output + (reasoning ?? 0), num(message.cacheRead), num(message.cacheWrite), reasoning);
      const recorded = tokens && (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) > 0;
      builder.add(at, model, null, { ...(recorded ? tokens : {}), assistantMessages: 1, reportedCostUsd: num(message.cost) });
      // A turn runs from the user message to its last completed reply.
      const turn = turns.get(str(message.parentId));
      const completed = num(message.completed);
      if (turn && completed !== null) { turn.end = Math.max(turn.end ?? 0, completed); turn.model = model; }
    }
  }
  for (const turn of turns.values()) {
    if (turn.end !== null && turn.end >= turn.start) turn.builder.add(iso(turn.end), turn.model, null, { activeMs: turn.end - turn.start });
  }
  for (const part of parts) {
    const message = byMessage.get(str(part.messageId));
    if (!message) continue;
    const { builder, at, model, role } = message;
    builder.bytes += num(part.bytes) ?? 0;
    if (part.type === "text" && role === "user") builder.add(at, model, null, { userCharacters: num(part.textLength) ?? 0 });
    if (part.type === "text" && role === "assistant") builder.add(at, model, null, { assistantCharacters: num(part.textLength) ?? 0 });
    if (part.type === "tool") builder.add(at, model, null, { toolCalls: 1, toolErrors: part.status === "error" ? 1 : 0, toolInputCharacters: num(part.inputLength) ?? 0, toolOutputCharacters: num(part.outputLength) ?? 0 }, str(part.tool) || "unknown");
    if (part.type === "compaction") builder.add(at, model, null, { compactions: 1 });
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: str(row.parentId) || null, cwd: str(row.directory), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: base.parentId, archived: row.archived !== null && row.archived !== undefined, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};

/**
 * Prefer v2 for identical IDs but include legacy-only sessions during the
 * official incremental v1→v2 migration. Reading either table alone silently
 * loses history in the interval between the first and last migrated session.
 */
export const readOpenCodeStore: StoreReader = (db, file) => {
  const v2 = hasTable(db, "session_v2");
  const v1 = hasTable(db, "session");
  if (!v1 && !v2) throw new Error("unsupported OpenCode session schema: no session or session_v2 table");
  const newer = v2 ? readOpenCodeV2Store(db, file) : [];
  if (!v1) return newer;
  const migration = v2 ? openCodeMigrationState(db) : null;
  let older: StoreSession[];
  try {
    older = readOpenCodeV1Store(db, file, new Set(newer.map((row) => row.nativeId)), migration);
  } catch (error) {
    // A broken legacy table must not throw away otherwise readable v2 usage.
    // If no v2 sessions exist, retain the explicit read error rather than
    // falsely reporting an empty or complete store.
    if (!newer.length) throw error;
    const warning = "OpenCode legacy v1 rows could not be read; v2 usage is preserved but legacy usage may be missing.";
    for (const row of newer) row.parsed.warnings.push(warning);
    return newer;
  }
  if (migration && migration.phase !== "sessions") {
    // Retain legacy session identity/metadata, but never let unverified
    // v1-only counters contaminate charts, CSV, group totals or token costs.
    // Once upstream marks migration completed, its cursor is gone. The same
    // uncertainty applies if migration metadata cannot be read or is absent.
    const warning = migration.phase === "completed"
      ? "OpenCode completed v1-v2 migration: legacy-only session may be unmigrated history OR deleted in v2; usage withheld from totals (unknown)."
      : "OpenCode v1-v2 migration state is missing or unreadable: legacy-only session may have been deleted in v2; usage withheld from totals (unknown).";
    for (const row of older) {
      row.parsed.buckets = [];
      row.parsed.warnings.push(warning);
    }
  }
  return [...newer, ...older];
};

const DEVIN_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
const EFFORT_SUFFIX = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/;
/** Devin CLI: a message forest per session. Compaction copies nodes, so messages and calls are deduplicated by ID. */
export const readDevinStore: StoreReader = (db) => {
  const sessions = db.prepare("SELECT id, working_directory AS cwd, title, created_at AS created, last_activity_at AS updated FROM sessions").all() as Row[];
  const nodes = db.prepare(`SELECT row_id AS rowId, session_id AS sessionId, created_at AS stored,
    json_extract(chat_message, '$.message_id') AS id, json_extract(chat_message, '$.role') AS role,
    json_extract(chat_message, '$.metadata.created_at') AS created,
    json_extract(chat_message, '$.metadata.generation_model') AS model,
    json_extract(chat_message, '$.metadata.telemetry.source') AS source,
    json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input,
    json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output,
    json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
    json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite,
    json_extract(chat_message, '$.metadata.extensions."chisel/tool_result_meta".success') AS success,
    length(json_extract(chat_message, '$.content')) AS contentLength,
    length(CAST(chat_message AS BLOB)) AS bytes
    FROM message_nodes ORDER BY row_id`).all() as Row[];
  const calls = db.prepare(`SELECT n.session_id AS sessionId, json_extract(n.chat_message, '$.message_id') AS messageId,
    json_extract(t.value, '$.id') AS id, json_extract(t.value, '$.name') AS name, length(json_extract(t.value, '$.arguments')) AS inputLength
    FROM message_nodes n, json_each(n.chat_message, '$.tool_calls') t`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(DEVIN_COUNT_KEYS)]));
  const contexts = new Map<string, { at: string | null; model: string; effort: string | null }>();
  const seen = new Set<string>();
  for (const node of nodes) {
    const sessionId = str(node.sessionId);
    const builder = builders.get(sessionId);
    if (!builder) continue;
    builder.bytes += num(node.bytes) ?? 0;
    const key = `${sessionId} ${str(node.id) || `row:${node.rowId}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = iso(node.created) ?? iso(node.stored);
    const context = { ...(contexts.get(sessionId) ?? { model: "unknown", effort: null }), at };
    builder.time(at);
    if (node.role === "assistant") {
      // Generation models carry the effort level as a suffix, e.g. "gpt-6-astra-medium".
      const model = str(node.model), match = EFFORT_SUFFIX.exec(model);
      if (model) { context.model = match ? match[1] : model; context.effort = match ? match[2] : null; }
      builder.messages++;
      const tokens = usage(context.model, num(node.input), num(node.output), num(node.cacheRead), num(node.cacheWrite), null);
      builder.add(at, context.model, context.effort, { ...tokens, assistantMessages: 1, assistantCharacters: num(node.contentLength) ?? 0 });
    }
    // Keepalive pings refresh the prompt cache; they are not user messages.
    if (node.role === "user" && node.source !== "cache_keepalive") {
      builder.messages++;
      builder.add(at, context.model, context.effort, { userMessages: 1, userCharacters: num(node.contentLength) ?? 0 });
    }
    if (node.role === "tool") builder.add(at, context.model, context.effort, { toolOutputCharacters: num(node.contentLength) ?? 0, toolErrors: node.success === 0 ? 1 : 0 });
    contexts.set(sessionId, context);
    contexts.set(key, context);
  }
  const seenCalls = new Set<string>();
  for (const call of calls) {
    const sessionId = str(call.sessionId);
    const builder = builders.get(sessionId);
    const key = `${sessionId} ${str(call.id) || `${str(call.messageId)}:${str(call.name)}`}`;
    if (!builder || seenCalls.has(key)) continue;
    seenCalls.add(key);
    const context = contexts.get(`${sessionId} ${str(call.messageId)}`);
    builder.add(context?.at ?? null, context?.model ?? "unknown", context?.effort ?? null, { toolCalls: 1, toolInputCharacters: num(call.inputLength) ?? 0 }, str(call.name) || "unknown");
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: null, cwd: str(row.cwd), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: null, archived: false, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};

/** Length-delimited and varint fields of a protobuf message; null when the bytes are not one. */
function protobufFields(bytes: Uint8Array): { field: number; value: Uint8Array | number }[] | null {
  const fields: { field: number; value: Uint8Array | number }[] = [];
  let i = 0;
  const varint = () => {
    let value = 0, scale = 1;
    while (i < bytes.length) {
      const byte = bytes[i++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw new Error("truncated varint");
  };
  try {
    while (i < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key % 8;
      if (wire === 0) fields.push({ field, value: varint() });
      else if (wire === 2) { const length = varint(); if (i + length > bytes.length) return null; fields.push({ field, value: bytes.subarray(i, i + length) }); i += length; }
      else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4;
      else return null;
    }
  } catch { return null; }
  return fields;
}

const CURSOR_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
const CURSOR_MODEL = /^(.+)-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/;
/**
 * Cursor agent: one store per session with content-addressed `blobs`. The latest root blob (protobuf) lists the
 * conversation's message IDs in order; older roots and edited-away messages stay in the table and are ignored.
 * Messages carry no timestamps or token usage.
 */
export const readCursorStore: StoreReader = (db, file) => {
  let meta: Record<string, unknown>;
  try { meta = object(JSON.parse(Buffer.from(str((db.prepare("SELECT value FROM meta WHERE key = '0'").get() as Row | undefined)?.value), "hex").toString("utf8"))); }
  catch { return []; }
  const nativeId = str(meta.agentId);
  if (!nativeId) return [];
  const root = (db.prepare("SELECT data FROM blobs WHERE id = ?").get(str(meta.latestRootBlobId)) as Row | undefined)?.data;
  const fields = root instanceof Uint8Array ? protobufFields(root) ?? [] : [];
  const text = (value: Uint8Array | number) => typeof value === "number" ? "" : Buffer.from(value).toString("utf8");
  const ids = fields.filter((f) => f.field === 1 && typeof f.value !== "number" && f.value.length === 32).map((f) => Buffer.from(f.value as Uint8Array).toString("hex"));
  const uri = fields.filter((f) => f.field === 9).map((f) => text(f.value)).find((value) => value.startsWith("file://"));
  let cwd = "";
  try { if (uri) cwd = fileURLToPath(uri); } catch { /* Not a local path. */ }
  const parts = db.prepare(`SELECT ids.key AS position, length(CAST(b.data AS BLOB)) AS bytes, json_extract(CAST(b.data AS TEXT), '$.role') AS role,
    iif(p.type = 'object', json_extract(p.value, '$.type'), 'text') AS type, iif(p.type = 'object', json_extract(p.value, '$.toolName'), NULL) AS tool,
    iif(p.type = 'object', json_extract(p.value, '$.providerOptions.cursor.modelName'), NULL) AS model,
    length(iif(p.type = 'text', p.value, iif(p.type = 'object', json_extract(p.value, '$.text'), NULL))) AS textLength,
    iif(p.type = 'object', length(json_extract(p.value, '$.args')), NULL) AS inputLength,
    iif(p.type = 'object', length(json_extract(p.value, '$.result')), NULL) AS outputLength,
    coalesce(json_type(CAST(b.data AS TEXT), '$.providerOptions.cursor.highLevelToolCallResult.output.error'),
      json_type(CAST(b.data AS TEXT), '$.providerOptions.cursor.highLevelToolCallResult.output.failure')) IS NOT NULL AS failed
    FROM json_each(?) ids JOIN blobs b ON b.id = ids.value,
    json_each(iif(json_valid(CAST(b.data AS TEXT)), CAST(b.data AS TEXT), '{}'), '$.content') p
    ORDER BY ids.key, p.id`).all(JSON.stringify(ids)) as Row[];

  const builder = new SessionBuilder(CURSOR_COUNT_KEYS);
  const created = iso(meta.createdAt);
  builder.time(created);
  builder.time(iso(file.mtimeMs));
  // Messages are undated, so everything lands on the session's start day. Early user messages take the first model.
  const modelOf = (value: string) => { const match = CURSOR_MODEL.exec(value); return match ? { model: `${match[1]}${match[3] ?? ""}`, effort: match[2] } : { model: value, effort: null }; };
  let context = modelOf(str(parts.find((part) => str(part.model))?.model) || str(meta.lastUsedModel) || "unknown");
  let position: unknown = null;
  for (const part of parts) {
    const role = str(part.role);
    if (part.model) context = modelOf(str(part.model));
    const { model, effort } = context;
    if (part.position !== position) {
      position = part.position;
      builder.bytes += num(part.bytes) ?? 0;
      if (role === "user") { builder.messages++; builder.add(created, model, effort, { userMessages: 1 }); }
      if (role === "assistant") { builder.messages++; builder.add(created, model, effort, { assistantMessages: 1 }); }
    }
    if (part.type === "text" && role === "user") builder.add(created, model, effort, { userCharacters: num(part.textLength) ?? 0 });
    if (part.type === "text" && role === "assistant") builder.add(created, model, effort, { assistantCharacters: num(part.textLength) ?? 0 });
    if (part.type === "tool-call") builder.add(created, model, effort, { toolCalls: 1, toolInputCharacters: num(part.inputLength) ?? 0 }, str(part.tool) || "unknown");
    if (part.type === "tool-result") builder.add(created, model, effort, { toolOutputCharacters: num(part.outputLength) ?? 0, toolErrors: part.failed ? 1 : 0 });
  }
  const base = { nativeId, parentId: null, cwd, title: str(meta.name).slice(0, 300), branch: "" };
  return [{ nativeId, parentId: null, archived: false, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, created, iso(file.mtimeMs), "Cursor keeps no token usage records locally; token and cost measurements are unknown.") }];
};
