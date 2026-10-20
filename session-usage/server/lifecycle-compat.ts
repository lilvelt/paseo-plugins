/**
 * Paseo 0.7.x remains supported, but the lifecycle API arrived later.
 * Missing hooks disable new Antigravity recordings, not existing usage RPCs.
 */
export function hasLifecycleHooks(server: { on?: unknown }): boolean {
  return typeof server.on === "function";
}
