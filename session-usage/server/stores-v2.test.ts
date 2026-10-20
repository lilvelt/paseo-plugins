import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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

test("OpenCode v2 wins when legacy session table coexists; it never double counts", () => {
  const db = fixture();
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('legacy');");
    const items = readOpenCodeStore(db, { mtimeMs: 0 });
    assert.deepEqual(items.map((s) => s.nativeId), ["v2-one", "v2-child"]);
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
