import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageSurface } from "./client/usage-surface";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSurface("session-usage", UsageSurface),
    client.addSidebarItem({ id: "session-usage", title: "Session usage", icon: "ChartColumn", surface: "session-usage" }),
    client.addCommandCenterItem({ id: "open-session-usage", title: "Open session usage", icon: "ChartColumn", context: "global", keywords: ["tokens", "cost", "statistics", "claude", "codex", "providers", "analytics"], onSelect({ openSurface }) { openSurface("session-usage"); } }),
  ];
  return () => { for (const remove of removers) void remove(); };
}
