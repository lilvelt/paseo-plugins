import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { aggregate, EMPTY_FILTERS, filterSessions } from "../shared/model";
import type { Session } from "../shared/schema";
import { readOpenCodeStore } from "./stores";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER
    );
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT);
    INSERT INTO session_v2 VALUES
      ('v2-one', NULL, '/fixture/repo', 'One', 1760947200000, 1760950800000, NULL, 1.25, 100, 20, 5, 60, 10),
      ('v2-child', 'v2-one', '/fixture/repo', 'Child', 1760947200000, 1760950800000, 1760960000000, 0, 0, 0, 0, 0, 0);
    INSERT INTO session_message VALUES ('m1', 'v2-one', '{"type":"user"}');
    INSERT INTO session_message VALUES ('m2', 'v2-one', '{"type":"assistant"}');
    INSERT INTO session_message VALUES ('m3', 'v2-child', '{"type":"user"}');
  `);
  return db;
}

test("OpenCode v2 cumulative input/cache/output is parsed once as undated partial activity", () => {
  const db = fixture();
  try {
    const sessions = readOpenCodeStore(db, { mtimeMs: 1 });
    assert.equal(sessions.length, 2);
    const one = sessions.find((s) => s.nativeId === "v2-one")!;
    assert.ok(one);
    assert.equal(one.messages, 2);
    assert.equal(one.archived, false);
    assert.equal(one.parsed.cwd, "/fixture/repo");
    assert.equal(one.parsed.buckets.length, 1);
    const b = one.parsed.buckets[0]!;
    assert.equal(b.day, "unknown");
    assert.equal(b.hour, null);
    assert.equal(b.model, "unknown");
    assert.equal(b.metrics.inputTokens, 170); // 100 + 60 cache-read + 10 cache-write
    assert.equal(b.metrics.uncachedTokens, 100);
    assert.equal(b.metrics.cacheReadTokens, 60);
    assert.equal(b.metrics.cacheWriteTokens, 10);
    assert.equal(b.metrics.outputTokens, 25); // reasoning accounted for in output
    assert.equal(b.metrics.reasoningTokens, 5);
    assert.equal(b.metrics.requests, null); // aggregate is NOT one model request
    assert.equal(b.metrics.reportedCostUsd, 1.25);
    assert.equal(b.metrics.estimatedCostUsd, null); // session can span many models
    assert.match(one.parsed.warnings.join(" "), /session-lifetime cumulative usage only/);
    assert.equal(one.parsed.startedAt, "2025-10-20T08:00:00.000Z");

    const child = sessions.find((s) => s.nativeId === "v2-child")!;
    assert.equal(child.parentId, "v2-one");
    assert.equal(child.archived, true);
    assert.equal(child.messages, 1);
    assert.equal(child.parsed.buckets[0]!.metrics.inputTokens, 0);
  } finally { db.close(); }
});

/** Minimal real-schema legacy tables populated during OpenCode's incremental migration. */
function legacyFixtures(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    INSERT INTO session VALUES
      ('v1-only', NULL, '/fixture/repo', 'Legacy only', 1760947200000, 1760950800000, NULL),
      ('v2-one', NULL, '/fixture/repo', 'Already migrated', 1760947200000, 1760950800000, NULL);
    INSERT INTO message VALUES
      ('old-m1', 'v1-only', 1760947300000,
       '{"role":"assistant","modelID":"gpt-6","tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":3,"write":4}},"cost":0.12}'),
      ('old-duplicate', 'v2-one', 1760947300000,
       '{"role":"assistant","tokens":{"input":9000,"output":9000}}');
  `);
}

test("OpenCode in-progress migration before its first cursor unions distinct IDs", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"sessions"}');
    `);
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(rows.map((s) => s.nativeId), ["v2-one", "v2-child", "v1-only"]);
    const newer = rows.find((s) => s.nativeId === "v2-one")!;
    assert.equal(newer.parsed.buckets[0]!.metrics.inputTokens, 170);
    assert.equal(rows.filter((s) => s.nativeId === "v2-one").length, 1);
    const legacy = rows.find((s) => s.nativeId === "v1-only")!;
    assert.equal(legacy.messages, 1);
    assert.equal(legacy.parsed.buckets[0]!.metrics.inputTokens, 17); // input + cache read + write
    assert.equal(legacy.parsed.buckets[0]!.metrics.outputTokens, 3); // including reasoning
    assert.equal(legacy.parsed.buckets[0]!.day, "2025-10-20");
  } finally { db.close(); }
});

test("OpenCode in-progress cursor excludes v1 records already copied and deleted in v2", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"sessions","cursor":"ses_m"}');
      INSERT INTO session VALUES
        ('ses_a', NULL, '/fixture/repo', 'Uncopied', 1760947200000, 1760950800000, NULL),
        ('ses_z', NULL, '/fixture/repo', 'Deleted after copy', 1760947200000, 1760950800000, NULL);
      INSERT INTO message VALUES
        ('m-uncopied', 'ses_a', 1760947300000, '{"role":"assistant","tokens":{"input":8,"output":2}}'),
        ('m-deleted', 'ses_z', 1760947300000, '{"role":"assistant","tokens":{"input":9999,"output":9999}}');
    `);
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(rows.map((row) => row.nativeId), ["v2-one", "v2-child", "ses_a"]);
    assert.equal(rows.find((row) => row.nativeId === "ses_a")?.parsed.buckets[0]?.metrics.inputTokens, 8);
    assert.ok(!rows.some((row) => row.nativeId === "ses_z"));
  } finally { db.close(); }
});

test("completed v1-v2 migration retains metadata but withholds ambiguous usage from every aggregate", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"completed"}');
    `);
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    const legacy = rows.find((row) => row.nativeId === "v1-only");
    assert.ok(legacy); // Keep the known upstream stranded-v1 session visible.
    assert.equal(legacy.messages, 1);
    assert.equal(legacy.parsed.title, "Legacy only");
    assert.equal(legacy.parsed.startedAt, "2025-10-20T08:01:40.000Z"); // First recorded assistant message
    assert.deepEqual(legacy.parsed.buckets, []); // Tokens/cost/tool activity cannot enter any rollup.
    assert.match(legacy.parsed.warnings.join(" "), /usage withheld from totals \(unknown\)/);
    assert.equal(rows.find((row) => row.nativeId === "v2-one")?.parsed.buckets[0]?.metrics.inputTokens, 170);
    assert.equal(rows.filter((row) => row.nativeId === "v2-one").length, 1);

    // Exercise the real UI aggregation/CSV input path, not just raw buckets.
    const asSession = (record: (typeof rows)[number]): Session => ({
      id: `opencode:${record.nativeId}`, nativeId: record.nativeId,
      provider: "opencode", providerLabel: "OpenCode", kind: "main",
      parentId: null, title: record.parsed.title, agentId: null,
      workspaceId: null, workspace: "", projectId: null, project: "",
      cwd: record.parsed.cwd, branch: "", labels: [], archived: false,
      status: "untracked", startedAt: record.parsed.startedAt, endedAt: record.parsed.endedAt,
      bytes: record.bytes, coverage: "partial", warnings: record.parsed.warnings,
      buckets: record.parsed.buckets,
    });
    const selected = filterSessions([asSession(rows[0]!), asSession(legacy)], EMPTY_FILTERS);
    assert.equal(selected.length, 2);
    assert.equal(aggregate(selected, "inputTokens").value, 170);
    assert.equal(aggregate(selected, "reportedCostUsd").value, 1.25);
    assert.equal(aggregate(selected, "inputTokens").known, 1);
    assert.equal(aggregate(selected, "sessions").value, 2);
    assert.equal(aggregate(selected.filter((row) => row.session.nativeId === "v1-only"), "inputTokens").value, null);
  } finally { db.close(); }
});

test("v2 alongside v1 and missing migration state preserves history identity, not unverified usage", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    const legacy = rows.find((row) => row.nativeId === "v1-only");
    assert.ok(legacy);
    assert.deepEqual(legacy.parsed.buckets, []);
    assert.equal(legacy.messages, 1);
    assert.match(legacy.parsed.warnings.join(" "), /migration state is missing or unreadable/);
    assert.equal(rows.find((row) => row.nativeId === "v2-one")?.parsed.buckets[0]?.metrics.inputTokens, 170);
  } finally { db.close(); }
});

test("malformed migration metadata never hides readable v2 usage or admits ambiguous v1 totals", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv VALUES ('migration.v1-v2', 'not-json');
    `);
    for (const value of ["not-json", '{"phase":"sessions","cursor":23}', '{"phase":"unknown"}']) {
      db.prepare("UPDATE kv SET value = ? WHERE key = 'migration.v1-v2'").run(value);
      const rows = readOpenCodeStore(db, { mtimeMs: 0 });
      assert.deepEqual(rows.find((row) => row.nativeId === "v1-only")?.parsed.buckets, []);
      assert.equal(rows.find((row) => row.nativeId === "v2-one")?.parsed.buckets[0]?.metrics.inputTokens, 170);
    }
  } finally { db.close(); }
});

test("incomplete migration status table preserves v2 counters and treats legacy-only as uncertain", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, unexpected TEXT);");
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(rows.find((row) => row.nativeId === "v1-only")?.parsed.buckets, []);
    assert.equal(rows.find((row) => row.nativeId === "v2-one")?.parsed.buckets[0]?.metrics.inputTokens, 170);
  } finally { db.close(); }
});

test("OpenCode legacy-only schema continues to be readable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    legacyFixtures(db);
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(rows.map((s) => s.nativeId), ["v1-only", "v2-one"]);
  } finally { db.close(); }
});

test("coexisting v2 with incomplete legacy schema preserves v2 with an explicit warning", () => {
  const db = fixture();
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('stranded');");
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(rows.map((row) => row.nativeId), ["v2-one", "v2-child"]);
    assert.match(rows[0]!.parsed.warnings.join(" "), /legacy v1 rows could not be read/);
  } finally { db.close(); }
});

test("missing v1 message or part table does not mask valid v2 counters", () => {
  const db = fixture();
  try {
    legacyFixtures(db);
    db.exec("DROP TABLE part;");
    const rows = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.equal(rows.find((row) => row.nativeId === "v2-one")?.parsed.buckets[0]?.metrics.inputTokens, 170);
    assert.ok(rows.every((row) => row.parsed.warnings.some((w) => w.includes("legacy v1 rows could not be read"))));
  } finally { db.close(); }
});

test("missing v1 dependencies without any v2 data still fails closed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER
      );
      INSERT INTO session VALUES ('old', NULL, '/fixture', 'Old', 1760947200000, 1760950800000);
    `);
    assert.throws(() => readOpenCodeStore(db, { mtimeMs: 0 }), /message\/part/);
  } finally { db.close(); }
});

test("unknown SQLite schema is rejected rather than claiming zero usage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE random_data (x TEXT);");
    assert.throws(() => readOpenCodeStore(db, { mtimeMs: 0 }), /unsupported OpenCode session schema/);
    db.exec("CREATE TABLE session_v2 (id TEXT);");
    assert.throws(() => readOpenCodeStore(db, { mtimeMs: 0 }), /unsupported OpenCode v2 session_v2 schema/);
  } finally { db.close(); }
});

test("OpenCode v2 with missing session_message table retains only supported cumulative counters", () => {
  const db = fixture();
  try {
    db.exec("DROP TABLE session_message;");
    const one = readOpenCodeStore(db, { mtimeMs: 0 }).find((s) => s.nativeId === "v2-one")!;
    assert.equal(one.messages, 1); // token evidence, NOT estimated number of requests
    assert.equal(one.parsed.buckets[0]!.metrics.toolCalls, null);
  } finally { db.close(); }
});
