import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Keep observations sibling to, not inside, the disposable usage index. */
export function observationPathForIndex(indexPath: string): string {
  return join(dirname(indexPath), "private-observations", "antigravity-observed.sqlite");
}

export interface ObservedUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}
export interface AntigravityObservation {
  agentId: string;
  provider: string;
  turnId: string;
  model: string | null;
  observedAt: string;
  usage: ObservedUsage;
}

const metric = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export function normalizeObservedUsage(value: ObservedUsage | null | undefined): ObservedUsage | null {
  if (!value) return null;
  const usage: ObservedUsage = {};
  for (const k of ["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"] as const) {
    const number = metric(value[k]);
    if (number !== undefined) usage[k] = number;
  }
  return Object.keys(usage).length ? usage : null;
}

/**
 * A completed turn may leave previous lastUsage intact when Paseo receives no
 * turn-specific usage event. Do not persist an indistinguishable stale value.
 * undefined baseline means the start-time read failed, not a known empty one.
 */
export function usageChangedSinceStart(
  before: ObservedUsage | null | undefined,
  after: ObservedUsage | null,
): boolean {
  if (before === undefined || after === null) return false;
  if (before === null) return true;
  return (["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"] as const)
    .some((key) => before[key] !== after[key]);
}

/**
 * One LAST OBSERVED completed turn per Paseo agent, never a lifetime total.
 * Plugin hooks are live/best-effort: a missed turn is not reconstructed.
 * The observation store is distinct from the disposable usage transcript
 * index and is not cleared on an index schema rebuild.
 */
export class AntigravityObservationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS antigravity_observed_turn (
      agent_id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      model TEXT,
      observed_at TEXT NOT NULL,
      observed_ms INTEGER NOT NULL,
      usage_json TEXT NOT NULL
    )`);
  }

  static open(path: string): AntigravityObservationStore | null {
    let db: DatabaseSync | null = null;
    try {
      const directory = resolve(dirname(path));
      // Validate all existing ancestor components BEFORE any mkdir: recursive
      // mkdir would otherwise follow an ancestor symlink and create a directory
      // outside the configured plugin tree before the later validation failed.
      for (let current = directory; ; current = dirname(current)) {
        try {
          const ancestor = lstatSync(current);
          if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
            throw new Error("observation path traverses an invalid ancestor");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (dirname(current) === current) break;
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      // Also reject symlinks in ancestor components, not only the final
      // private directory. This is a best-effort boundary against other UIDs;
      // a malicious process sharing the daemon UID is not isolated by this.
      if (realpathSync(directory) !== resolve(directory)) {
        throw new Error("observation directory traverses a symlink");
      }
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new Error("private plugin directory is not owned and mode 0700");
      }
      try {
        const existing = lstatSync(path);
        if (!existing.isFile() || existing.isSymbolicLink() ||
            (typeof process.getuid === "function" && existing.uid !== process.getuid())) {
          throw new Error("observation DB path not a private regular file");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      db = new DatabaseSync(path, { timeout: 5000 });
      chmodSync(path, 0o600);
      return new AntigravityObservationStore(db);
    } catch (err) {
      try { db?.close(); } catch { /* failed open */ }
      // Exception messages can contain user paths. The partial/unknown report
      // is the definitive fallback; log no exception body.
      console.warn("[session-usage] Antigravity persistent observations unavailable");
      return null; // Never fake durability.
    }
  }

  /** Returns true for a stored record; duplicate turn IDs are idempotent. */
  save(input: AntigravityObservation): boolean {
    const usage = normalizeObservedUsage(input.usage);
    if (!usage || !input.agentId || !input.turnId ||
        !(input.provider === "antigravity" || input.provider.startsWith("antigravity/"))) return false;
    const ms = Date.parse(input.observedAt);
    if (!Number.isFinite(ms)) return false;
    this.db.prepare(`INSERT INTO antigravity_observed_turn
      (agent_id, provider, turn_id, model, observed_at, observed_ms, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        provider=excluded.provider, turn_id=excluded.turn_id, model=excluded.model,
        observed_at=excluded.observed_at, observed_ms=excluded.observed_ms, usage_json=excluded.usage_json
      WHERE excluded.observed_ms > antigravity_observed_turn.observed_ms
        AND excluded.turn_id <> antigravity_observed_turn.turn_id`).run(
      input.agentId, input.provider, input.turnId, input.model,
      input.observedAt, ms, JSON.stringify(usage),
    );
    return true;
  }

  get(agentId: string): AntigravityObservation | null {
    const row = this.db.prepare(
      "SELECT agent_id, provider, turn_id, model, observed_at, usage_json FROM antigravity_observed_turn WHERE agent_id = ?",
    ).get(agentId) as {
      agent_id: string; provider: string; turn_id: string;
      model: string | null; observed_at: string; usage_json: string;
    } | undefined;
    if (!row) return null;
    try {
      const usage = normalizeObservedUsage(JSON.parse(row.usage_json) as ObservedUsage);
      if (!usage) return null;
      return { agentId: row.agent_id, provider: row.provider, turnId: row.turn_id,
        model: row.model, observedAt: row.observed_at, usage };
    } catch { return null; }
  }
  close(): void { this.db.close(); }
}
