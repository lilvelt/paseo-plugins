import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * One LAST OBSERVED completed turn per Paseo agent, never a lifetime total.
 * Plugin hooks are live/best-effort: a missed turn is not reconstructed.
 * This database belongs ONLY to the staging plugin and is isolated from the
 * published Session usage transcript index.
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
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Do not follow attacker-controlled symlinks to an unrelated DB.
      const info = lstatSync(directory);
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
      console.warn("[session-usage] Antigravity persistent observations unavailable:",
        err instanceof Error ? err.message : String(err));
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
  /** Count only, for staged post-reload diagnostics; no identifiers or usage values. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM antigravity_observed_turn").get() as
      { n: number } | undefined;
    return row?.n ?? 0;
  }
  close(): void { this.db.close(); }
}
