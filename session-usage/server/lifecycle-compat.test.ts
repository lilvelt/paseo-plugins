import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLifecycleHooks } from "./lifecycle-compat";

test("legacy Paseo host without lifecycle hooks keeps usage RPC registration eligible", () => {
  assert.equal(hasLifecycleHooks({}), false);
  assert.equal(hasLifecycleHooks({ on: undefined }), false);
  assert.equal(hasLifecycleHooks({ on: null }), false);
  assert.equal(hasLifecycleHooks({ on: "unsupported" }), false);
});

test("newer Paseo hosts with lifecycle hooks enable Antigravity observations", () => {
  assert.equal(hasLifecycleHooks({ on: () => () => {} }), true);
});
