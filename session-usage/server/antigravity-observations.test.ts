import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AntigravityObservationStore, normalizeObservedUsage } from "./antigravity-observations";
import { addAntigravityLatestUsage } from "./antigravity";
import type { Session, Snapshot } from "../shared/schema";

const build = (agentId: string): Session => ({
  id: "antigravity/gemini-4-argon-medium:" + agentId,
  nativeId: agentId, provider: "antigravity/gemini-4-argon-medium",
  providerLabel: "Antigravity", kind: "main", parentId: null,
  title: "E2E", agentId, workspaceId: null, workspace: "", projectId: null,
  project: "", cwd: "", branch: "", labels: [], archived: false,
  status: "closed", startedAt: null, endedAt: null, bytes: 0,
  coverage: "missing", warnings: [], buckets: [],
});
const report = (s: Session): Snapshot => ({
  sessions: [s], scanning: false, completed: 0, total: 0,
  generatedAt: null, warnings: [], revision: "original",
});

test("SQLite observation survives close and reopen and fallback does not fabricate cache write", async () => {
  const parent = mkdtempSync(join(process.cwd(), ".antigravity-observation-fixture-"));
  const path = join(parent, "private", "observed.sqlite");
  try {
    const store = AntigravityObservationStore.open(path);
    assert.ok(store);
    assert.equal(store.save({
      agentId: "a1", provider: "antigravity/gemini-4-argon-medium",
      turnId: "turn-1", observedAt: "2026-10-20T01:00:00.000Z",
      model: "gemini-4-argon-medium",
      usage: { inputTokens: 16901, outputTokens: 46, cachedInputTokens: 0 },
    }), true);
    store.close();
    const next = AntigravityObservationStore.open(path);
    assert.ok(next);
    const saved = next.get("a1");
    assert.ok(saved);
    assert.equal(saved.turnId, "turn-1");
    assert.equal(saved.usage.inputTokens, 16901);
    const generated = await addAntigravityLatestUsage(report(build("a1")), async () => ({
      provider: "antigravity", lastUsage: null,
    }), undefined, (id) => next.get(id));
    const row = generated.sessions[0]!;
    assert.equal(row.coverage, "partial");
    assert.equal(row.buckets[0]!.metrics.inputTokens, 16901);
    assert.equal(row.buckets[0]!.metrics.outputTokens, 46);
    assert.equal(row.buckets[0]!.metrics.cacheReadTokens, 0);
    assert.equal(row.buckets[0]!.metrics.cacheWriteTokens, null);
    assert.equal(row.buckets[0]!.metrics.uncachedTokens, null);
    assert.match(row.warnings.join(" "), /Persisted last OBSERVED/);
    next.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(parent, "private")).mode & 0o777, 0o700);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("store rejects duplicate, stale and invalid records without clobbering observed usage", () => {
  const db = new DatabaseSync(":memory:");
  const store = new AntigravityObservationStore(db);
  const first = {
    agentId: "one", provider: "antigravity", turnId: "a",
    model: "model", observedAt: "2026-10-20T01:00:00.000Z",
    usage: { inputTokens: 100 },
  };
  assert.equal(store.save(first), true);
  store.save({ ...first, usage: { inputTokens: 9000 } });
  store.save({ ...first, turnId: "older", observedAt: "2026-10-20T00:00:00.000Z", usage: { inputTokens: 8000 } });
  assert.equal(store.get("one")?.usage.inputTokens, 100);
  store.save({ ...first, turnId: "new", observedAt: "2026-10-20T02:00:00.000Z", usage: { inputTokens: 200 } });
  assert.equal(store.get("one")?.usage.inputTokens, 200);
  assert.equal(store.save({ ...first, turnId: "", usage: { inputTokens: 22 } }), false);
  assert.equal(store.save({ ...first, agentId: "another", provider: "antigravity-fake" }), false);
  assert.equal(store.save({ ...first, agentId: "invalid", usage: { inputTokens: Number.NaN } }), false);
  assert.equal(store.get("invalid"), null);
  store.close();
});

test("unreadable, mismatched or missing observations stay unknown", async () => {
  const s = build("one");
  const fromStore = async (savedProvider: string) =>
    addAntigravityLatestUsage(report(s), async () => null, undefined, () => ({
      agentId: "one", provider: savedProvider, turnId: "a",
      observedAt: "2026-10-20T01:00:00.000Z", model: null, usage: { outputTokens: 46 },
    }));
  assert.equal((await fromStore("codex")).sessions[0]!.coverage, "missing");
  assert.equal((await fromStore("antigravity")).sessions[0]!.coverage, "partial");
  const missing = await addAntigravityLatestUsage(report(s), async () => null, undefined, () => null);
  assert.equal(missing.sessions[0]!.coverage, "missing");
  const offline = await addAntigravityLatestUsage(report(s), async () => {
    throw new Error("daemon offline");
  }, undefined, () => ({
    agentId: "one", provider: "antigravity", turnId: "a",
    observedAt: "2026-10-20T01:00:00.000Z", model: null, usage: { outputTokens: 46 },
  }));
  assert.equal(offline.sessions[0]!.coverage, "partial");
  assert.equal(offline.sessions[0]!.buckets[0]!.metrics.outputTokens, 46);
  const failed = await addAntigravityLatestUsage(report(s), async () => { throw new Error("offline"); }, undefined, () => {
    throw new Error("sqlite failure");
  });
  assert.equal(failed.sessions[0]!.coverage, "missing");
});

test("nulls are not coerced into zeros", () => {
  assert.deepEqual(normalizeObservedUsage({ inputTokens: Number.NaN, cachedInputTokens: -1 }), null);
  assert.deepEqual(normalizeObservedUsage({ outputTokens: 0 }), { outputTokens: 0 });
});

test("observation file symlinks are rejected fail-closed", () => {
  const parent = mkdtempSync(join(process.cwd(), ".antigravity-symlink-fixture-"));
  try {
    mkdirSync(join(parent, "private"), { mode: 0o700 });
    const target = join(parent, "target.sqlite");
    symlinkSync(target, join(parent, "private", "observed.sqlite"));
    assert.equal(AntigravityObservationStore.open(join(parent, "private", "observed.sqlite")), null);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
