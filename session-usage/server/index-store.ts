import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ParsedTranscript } from "./parser";
import { paseoHome } from "./paseo-home";
import { loadSqlite, type StoreSession } from "./stores";

/**
 * Parse results persisted between plugin runs: one row per transcript file and per provider store,
 * keyed by the source's change signature. Rows hold exactly what the scan returns (counters,
 * metadata, tool names and warnings), never transcript content. The sources stay the truth; a
 * database from another version, or one SQLite reports as corrupt, is deleted and rebuilt.
 */

/** Bump whenever parser or store reader output changes, or shared/pricing.ts rates change (costs are
 * stored per row), so no stale shape or estimate is served. */
export const INDEX_VERSION = 6; // Exclude unverified legacy-only usage from persisted session aggregates
const LOG_PREFIX = "[session-usage]";

export interface IndexedFile { signature: string; parsed: ParsedTranscript }
export interface IndexedStore { signature: string; sessions: StoreSession[] }
export interface IndexChanges {
  files: Map<string, IndexedFile>;
  stores: Map<string, IndexedStore>;
  removedFiles: string[];
  removedStores: string[];
}

export function defaultIndexPath(): string {
  return process.env.PASEO_SESSION_USAGE_DB || join(paseoHome(), "plugin-data", "session-usage", "index.sqlite");
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

export class UsageStore {
  private constructor(private db: DatabaseSync) {}

  /** Null when `node:sqlite` is missing or the file cannot be opened; the caller keeps a memory-only cache. */
  static open(path: string): UsageStore | null {
    const sqlite = loadSqlite();
    if (!sqlite) return null;
    try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    catch (error) { console.warn(`${LOG_PREFIX} cannot create ${dirname(path)}: ${describe(error)}`); return null; }
    for (let attempt = 0; attempt < 2; attempt++) {
      let db: DatabaseSync | null = null;
      try {
        db = new sqlite.DatabaseSync(path, { timeout: 5_000 });
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
        const version = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
        if (version !== 0 && version !== INDEX_VERSION) {
          console.log(`${LOG_PREFIX} usage index version ${version} is not ${INDEX_VERSION}; rebuilding`);
          db.close();
          removeDatabase(path);
          continue;
        }
        db.exec(`CREATE TABLE IF NOT EXISTS sources (
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          signature TEXT NOT NULL,
          data TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (kind, path)
        ) WITHOUT ROWID`);
        db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
        return new UsageStore(db);
      } catch (error) {
        try { db?.close(); } catch { /* Already unusable. */ }
        if (attempt === 0 && /malformed|not a database|corrupt/i.test(describe(error))) {
          console.warn(`${LOG_PREFIX} usage index is unusable (${describe(error)}); rebuilding`);
          removeDatabase(path);
          continue;
        }
        console.warn(`${LOG_PREFIX} cannot open usage index ${path}: ${describe(error)}`);
        return null;
      }
    }
    return null;
  }

  load(): { files: Map<string, IndexedFile>; stores: Map<string, IndexedStore> } {
    const files = new Map<string, IndexedFile>();
    const stores = new Map<string, IndexedStore>();
    for (const row of this.db.prepare("SELECT kind, path, signature, data FROM sources").iterate() as Iterable<{ kind: string; path: string; signature: string; data: string }>) {
      try {
        if (row.kind === "file") files.set(row.path, { signature: row.signature, parsed: JSON.parse(row.data) as ParsedTranscript });
        if (row.kind === "store") stores.set(row.path, { signature: row.signature, sessions: JSON.parse(row.data) as StoreSession[] });
      } catch { /* An unreadable row is reparsed from its source. */ }
    }
    return { files, stores };
  }

  save(changes: IndexChanges): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare("INSERT OR REPLACE INTO sources (kind, path, signature, data, indexed_at) VALUES (?, ?, ?, ?, ?)");
    const remove = this.db.prepare("DELETE FROM sources WHERE kind = ? AND path = ?");
    this.db.exec("BEGIN");
    try {
      for (const [path, entry] of changes.files) upsert.run("file", path, entry.signature, JSON.stringify(entry.parsed), now);
      for (const [path, entry] of changes.stores) upsert.run("store", path, entry.signature, JSON.stringify(entry.sessions), now);
      for (const path of changes.removedFiles) remove.run("file", path);
      for (const path of changes.removedStores) remove.run("store", path);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    try { this.db.close(); } catch (error) { console.warn(`${LOG_PREFIX} closing the usage index failed: ${describe(error)}`); }
  }
}
