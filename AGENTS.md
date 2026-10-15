# Repository instructions

This file is the canonical source of agent guidance for this repository. `CLAUDE.md` imports it;
update rules here only. The public overview, screenshots, and install commands live in
[`README.md`](./README.md). Each plugin keeps its screenshots under `images/` and
embeds them in its own README.

## Repository overview

This npm-workspaces monorepo contains trusted local Paseo plugins. Each top-level plugin directory is
independently installable and has its own `paseo-plugin.json`, package metadata, README, TypeScript
configuration, client entrypoint, and optional server entrypoint.

Current plugins:

- `agent-heartbeats`: adds a compact heartbeat-count composer pill and an agent-scoped panel for
  listing, creating, editing, and deleting heartbeats.
- `agents-dash-list`: adds an "Agents dash" sidebar surface that lists workspaces and their agents
  from every configured host in one feed, grouped by status (waiting, unread, in progress, failing,
  approved, idle, closed), with a host filter, per-row host labels, and quick archive and
  mark-as-unread actions. Reads other hosts through `useHosts` / `getPaseoClient`; its own RPCs
  (project icons, label catalog, unread marks, settings) still only run on the host it was opened
  on, because plugin RPC has no cross-host form.
- `agents-history`: adds an "Agents history" sidebar surface that lists every workspace and agent,
  archived ones included, with archived/provider/project/period filters and a search that ranks the
  providers' on-disk conversation transcripts through a SQLite FTS5 index (names, titles, branches,
  and paths weighted above what was said; grep in regex mode) and shows matching lines under each
  agent. Reads daemon state from disk; writes only its own index under `$PASEO_HOME/plugin-data`.
- `task-link`: adds a composer pill for task IDs extracted with a configurable regular expression
  and opens a link template; includes a native plugin settings screen.
- `chat-resume`: adds pills that continue a quota-exhausted chat now, schedule one resume
  after provider allowance renewal, or prepare an editable handover to another ready provider.
  Also offers a plain continue for an agent that went idle mid-turn — a daemon restart or a
  provider exit — read from the tail of its timeline.
- `schedule-runs`: adds a "Schedule runs" sidebar surface that lists every run of every schedule
  with status, workspace, agent, archived state, and final response, filterable by schedule,
  status, archived state, and keyword. Reads daemon state from disk; makes no schedule changes.
- `session-usage`: reads active and archived Claude/Codex transcripts, OpenCode/Kilo/Devin CLI/Cursor
  session stores, and Paseo metadata for every provider in use, with a
  sortable statistics table, filtered provider charts, token/cache accounting, cost estimates,
  session details, and CSV export. Subscription allowance cards pair Paseo's
  `providers.listUsage` limits with clickable hourly/daily token charts and a pace projection.
  Reads local files; writes only its own SQLite index under `$PASEO_HOME/plugin-data`; changes no
  provider or daemon state.
- `skills-usage`: adds a "Skills" composer pill whose popover lists the skills available to the
  agent, groups the ones already loaded in this chat on top with a used badge and count, offers a
  search, marks each skill's location (user, project, project-local, plugin, built-in) with an
  icon, and inserts `/skill-name` into the composer. Reads the provider command list and the agent
  timeline through the SDK; the server entry scans skill directories and runs `git ls-files`.
- `vscode-open-remote`: adds a remote-editor pill, editor settings, desktop URI handling, and tablet
  `vscode.dev` support. It intentionally hides the pill on phones.
- `profile-routing`: a provider plugin with a settings screen. An agent on a configured model
  (default `profile-routing/claude`) runs that model's shell script with `EFFORT` from the thinking
  option, creates a delegate from the JSON it prints in the same workspace, and either relays that
  answer or detaches/handoffs. Routing notes link to the delegate; the router auto-archives when
  every agent it started has been archived, and then the workspace if nothing else is still running
  there.

## Runtime boundaries

- `index.client.tsx` and `client/` run inside the Paseo app.
- `index.server.ts` and `server/` run in an unsandboxed subprocess on the Paseo daemon machine.
- `shared/` is imported by both runtimes. Keep it limited to schemas, contracts, types, and plain
  values; do not import Node or React Native runtime APIs there.
- Keep filesystem access, processes, credentials, and machine-local work in server files.
- Use React Native primitives in client UI. Take text and surface colors from the supplied theme and
  account for compact/mobile layouts.
- Gate browser globals and provide native behavior where required. Paseo client code runs on web,
  desktop, iOS, and Android.

Do not run a daemon-side shell command to open an application on the user's computer: for remote
hosts, that command runs on the daemon instead. Paseo's desktop `opener.openUrl` bridge accepts only
HTTP(S) URLs; custom schemes such as `vscode:` and `cursor:` need a client-side protocol handoff.

A `getPaseoClient(serverId)` handle is valid only for the connection it was borrowed on: once that
host reconnects it throws "Paseo connection changed" (Paseo `packages/app/src/plugins/hosts/index.ts`).
Borrow it per use or per render and never cache it. To exercise multi-host UI without touching real
hosts, seed `localStorage["@paseo:daemon-registry"]` with a second, unreachable host in a throwaway
Playwright context.

## Working conventions

- Read the root README and the affected plugin README before changing behavior.
- Follow the current Paseo plugin documentation and the `paseo-plugin` skill when it is available.
- Preserve unrelated and pre-existing work. Do not assume an untracked or modified file is disposable.
- Use npm and keep `package-lock.json` authoritative. Do not introduce another package manager.
- Keep changes scoped to the affected workspace. Update its README when behavior, configuration, or
  installation steps change.
- Do not commit generated output, dependency directories, local settings, credentials, or logs.
- Treat plugin server code as trusted, unsandboxed code. Validate RPC inputs and never log secrets.

## Verification

During iteration, typecheck one plugin:

```bash
npm run typecheck --workspace=<plugin-name>
```

Before finishing, typecheck every workspace:

```bash
npm run typecheck
```

Source edits are not live until the installed runtime is reloaded:

```bash
paseo plugin reload <plugin-id>
paseo plugin ls
paseo plugin logs <plugin-id>
```

Use `--host <target>` for a non-default daemon. Never restart the daemon just to load plugin source;
it may terminate the agent doing the work. If the daemon is unavailable, report that the source and
typecheck are complete but reload verification remains pending.

For UI changes, verify desktop and the relevant compact/mobile form factors, plus light and dark
themes. For composer pills, confirm registration, removal, accessible title, press behavior, and
cleanup on disconnect or plugin reload.
