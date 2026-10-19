import assert from "node:assert/strict";
import { test } from "node:test";
import { addAntigravityLatestUsage, type AntigravityAgentSnapshot } from "./antigravity";
import type { Session, Snapshot } from "../shared/schema";

function session(provider: string, id: string, agentId: string | null = id): Session {
  return {
    id: `${provider}:${id}`, nativeId: id, provider, providerLabel: provider,
    kind: "main", parentId: null, title: "Test", agentId,
    workspaceId: null, workspace: "", projectId: null, project: "",
    cwd: "", branch: "", labels: [], archived: false, status: "idle",
    startedAt: null, endedAt: null, bytes: 0, coverage: "missing",
    warnings: ["This provider keeps no local usage records that Session usage can read."],
    buckets: [],
  };
}
function snapshot(...sessions: Session[]): Snapshot {
  return { sessions, scanning: false, completed: 0, total: 0, generatedAt: "2026-10-20T00:00:00Z", warnings: [], revision: "base" };
}

test("Antigravity last-turn usage is partial and never misrepresented as a session total", async () => {
  const first = snapshot(session("antigravity", "one"), session("claude", "two"));
  const calls: string[] = [];
  const got = await addAntigravityLatestUsage(first, async (id) => {
    calls.push(id);
    return {
      provider: "antigravity",
      activeTurn: null,
      runtimeInfo: { model: "gemini-3.1" },
      lastUsage: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 12 },
    };
  });
  assert.deepEqual(calls, ["one"]);
  const ag = got.sessions[0]!;
  assert.equal(ag.coverage, "partial");
  assert.equal(ag.buckets.length, 1);
  assert.equal(ag.buckets[0]!.metrics.inputTokens, null);
  assert.equal(ag.buckets[0]!.metrics.uncachedTokens, null);
  assert.equal(ag.buckets[0]!.metrics.cacheReadTokens, 30);
  assert.equal(ag.buckets[0]!.metrics.cacheWriteTokens, null);
  assert.equal(ag.buckets[0]!.metrics.outputTokens, 12);
  assert.equal(ag.buckets[0]!.metrics.reportedCostUsd, null);
  assert.equal(ag.buckets[0]!.day, "unknown");
  assert.match(ag.warnings.join(" "), /last available Paseo turn only/);
  assert.equal(got.sessions[1], first.sessions[1]);
  assert.notEqual(got.revision, first.revision);
  assert.equal(got.unchanged, false);
  const again = await addAntigravityLatestUsage(first, async () => ({
    provider: "antigravity", runtimeInfo: { model: "gemini-3.1" },
    lastUsage: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 12 },
  }), got.revision);
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.sessions, []);
});

test("Antigravity zero cache reads permit unambiguous input; unknown cache write stays missing", async () => {
  const got = await addAntigravityLatestUsage(snapshot(session("antigravity", "one")), async () => ({
    provider: "antigravity",
    lastUsage: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 7, totalCostUsd: 0 },
  }));
  const m = got.sessions[0]!.buckets[0]!.metrics;
  assert.equal(m.inputTokens, 42);
  assert.equal(m.uncachedTokens, null);
  assert.equal(m.cacheReadTokens, 0);
  assert.equal(m.outputTokens, 7);
  assert.equal(m.reportedCostUsd, 0);
  assert.equal(m.cacheWriteTokens, null);
});

test("missing, malformed, busy, or mismatched snapshots never invent usage", async () => {
  const cases: (AntigravityAgentSnapshot | null)[] = [
    null, { provider: "claude", lastUsage: { inputTokens: 10 } },
    { provider: "antigravity", lastUsage: null },
    { provider: "antigravity", activeTurn: { turnId: "running" }, lastUsage: { inputTokens: 1 } },
    { provider: "antigravity", lastUsage: { inputTokens: -5, outputTokens: Number.NaN } },
  ];
  for (const agent of cases) {
    const original = session("antigravity", "one");
    const got = await addAntigravityLatestUsage(snapshot(original), async () => agent);
    assert.deepEqual(got.sessions[0], original);
  }
  const original = session("antigravity", "one");
  const failed = await addAntigravityLatestUsage(snapshot(original), async () => { throw new Error("offline"); });
  assert.deepEqual(failed.sessions[0], original);
});

test("sessions not linked to a Paseo Agent remain unknown", async () => {
  let called = false;
  const s = session("antigravity", "outside", null);
  const got = await addAntigravityLatestUsage(snapshot(s), async () => { called = true; return null; });
  assert.equal(called, false);
  assert.equal(got.sessions[0]!.coverage, "missing");
});

test("changes in last-turn snapshot invalidate cached revision", async () => {
  const first = snapshot(session("antigravity", "one"));
  const a = await addAntigravityLatestUsage(first, async () => ({ provider: "antigravity", lastUsage: { outputTokens: 1 } }));
  const b = await addAntigravityLatestUsage(first, async () => ({ provider: "antigravity", lastUsage: { outputTokens: 2 } }), a.revision);
  assert.notEqual(a.revision, b.revision);
  assert.equal(b.unchanged, false);
});
