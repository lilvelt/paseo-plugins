# session-usage

Adds **Session usage** to Paseo's sidebar and Command Center. It reads Claude Code and Codex
transcripts and the OpenCode, Kilo, Devin CLI, and Cursor session stores on the selected daemon, including
archived sessions, subagents, and sessions started outside Paseo, then joins them with Paseo's
project, workspace, and agent records. Agents of other providers are listed from Paseo's records
with unknown usage, except Paseo-managed Antigravity agents whose latest-turn snapshot is available (partial, not lifetime). Subscription allowance cards show how much of each provider's limits is used,
where the tokens went, and how long the allowance lasts at the current pace.

![Session usage](./images/session-usage.png)

## Isolated fork test install

This development fork is meant to coexist with the published Session usage plugin. Install it as
`session-usage-antigravity-test` and pin the tested revision. It deliberately keeps its SQLite index in
`$PASEO_HOME/plugin-data/session-usage-antigravity-test/index.sqlite`, **not** the stock Plugin's
`session-usage/index.sqlite`. A third-party Plugin still runs as trusted code on the Paseo daemon.
The fork and original Plugin both display a Session usage sidebar entry, under separate Plugin IDs.
Do not merge this staging-only index choice into upstream as a normal production default.

## Antigravity usage (experimental, partial)

When an **Antigravity Agent was launched inside Paseo**, the Plugin may display the **last available turn's** token usage from the live Paseo Agent snapshot. Its data is **not historical or a complete session total**, and is shown as `partial` with a warning.

- Cache read and output tokens are displayed when reported; cache write and historical spend are **unknown**, not zero. To avoid misleading normalized input/cache hit rates when `agy`'s raw `input_tokens`/cache accounting is ambiguous, total and uncached input remain unknown when nonzero cache reads are reported.
- If cache read is explicitly zero, the Provider's raw input is shown but true uncached input is still unknown because cache writes are not reported. The last-turn snapshot has no authoritative occurrence timestamp, so the report does not attribute it to a UTC activity date.
- **New observations made while this experimental Plugin is enabled**: a completed Antigravity turn may be durably recorded in a separate, private SQLite file, with only the Agent ID, turn ID, provider/model, capture time, and available token/cost scalars. On Plugin reload or Paseo restart, the latest *observed* turn can be displayed even when the live snapshot is gone; it remains `partial` and never a lifetime total.
- Hooks are **live, best effort**. A restart during a turn, failure to read usage at turn end, missing turn IDs, or a period when the Plugin was disabled can leave gaps. Older usage lost **before** this recorder was installed is not reconstructed. Antigravity runs **outside Paseo** remain unknown.
- The staging-only SQLite observation file is isolated at `$PASEO_HOME/plugin-data/session-usage-antigravity-test/private-observations/antigravity-observed.sqlite` (directory 0700 / DB file 0600, no conversation content). Missing/unreadable records stay unknown.
- The Plugin only reads the Agent snapshot; it does not launch `agy`, inspect credentials, modify sessions, or scan unrelated local Antigravity files. This is not the Antigravity account quota/allowance meter.

## Using the surface

- The **sortable table** is grouped by workspace by default; choose **Sessions** under **Table
  grouping** for one row per provider session. Choose **Columns** to show any
  measurement, press a heading to sort in either direction, and press a session name for all
  measurements, its tool-call breakdown, and a link to its agent or workspace. Missing values
  sort last in both directions. The session column stays fixed while the other columns scroll
  horizontally, on desktop and mobile. The table pages through 40 rows at a time.
- **Table grouping** independently switches between Sessions, provider, project, workspace,
  label, model, effort, day, week, and month. It preserves the selected metric columns and does
  not change Compare providers or the calendar. Group rows show metric totals, weighted
  percentages, session counts, and coverage for partially known measurements. Click a group
  for all metrics and its member sessions; session details show that member's activity in the group.
  Sessions with multiple labels appear once in each label group, so label totals can overlap.
  Unlabeled sessions get their own group. Date/model/effort groups split recorded activity;
  session span and transcript size remain unknown there because they cannot be divided across
  those groups. Other groupings sum those lifetime values once per member within each group.
  Numeric cell backgrounds scale independently per metric across all filtered table rows,
  including other pages. Zero and unknown values have no tint.
- **Effort**, beside Models, shows the recorded levels for the selected activity (for example,
  `low` or `xhigh`). A session that changed effort lists each level; sorting uses its highest
  recorded level. Details and CSV include effort too. An em dash means effort was not recorded;
  provider defaults and current agent settings are not inferred for historical usage.
- **Subscription allowances**, at the top of the page, has a card for each provider that Paseo
  reports allowance limits for and that has sessions on this host. The cards stay on one line and
  scroll horizontally when they do not fit. Each limit (for example Claude's
  session, weekly, and weekly Fable limits) is a narrow column with:
  - a 50 px token chart for the current window, by UTC hour for windows up to a day and by UTC
    day otherwise. Input tokens (including cache reads and writes) rise above the baseline in
    blue and output tokens hang below it in orange. Each half is scaled to its own maximum.
    Future slots are dimmed. A slot's total can include activity from shortly before the window
    opened.
  - Paseo's used percentage and reset time, with a mark for the share of the window that has
    already passed. Usage to the right of the mark is ahead of time.
  - a two-line pace projection with the values in bold: "Lasts **4h 8m**" over "**17%** at
    reset", or, in yellow, "Runs out in **3d 6h**" over "**15h** before reset". A used-up
    allowance says "Used up" in red. The projection extrapolates the used percentage over the
    elapsed time; token counts are not used, because how they map to a provider's allowance is
    unknown.

  Choosing a bar focuses the whole report on that hour or day and on the provider; for a
  model-scoped limit such as Fable, it also selects that limit's models. Choosing it again clears
  the period. The cards always cover every session on the host and ignore the report filters.

  Paseo reports reset times but not window lengths, so the length is inferred:
  - from the limit's name: session and five-hour windows are 5 h, daily 24 h, weekly 7 days, and
    monthly one calendar month;
  - otherwise, or when the time left exceeds the named length, from the shortest of 5 h, 24 h,
    7 days, or one month that covers the time left. A Codex "Session" limit that resets in two
    days is treated as weekly.

  Limits that local records cannot be attributed to (surface-scoped limits, code review, Cursor's
  model pools) and providers without local token records show a short note instead of a chart.
  Allowances refresh every five minutes and with **Refresh**. Provider balances are not shown.

![Subscription allowances](./images/allowances.png)

- **Compare providers** shows a bar for each provider in the filtered sessions, all on the same
  zero-based scale. A provider keeps its color while filters change. Choose a
  metric, total or average per known session, and group by provider, day, week, month, project,
  or model. Weeks start on Monday. Large charts initially show 14 groups; **Show more** reveals
  the rest. Time charts initially show the latest groups.
- **Daily activity**, below the bars, shows a GitHub-style calendar for the last 12 months on
  desktop or one month on compact/narrow screens. Previous/next controls browse older periods.
  It uses the bars' selected metric and total/average setting, combining the selected providers.
  Each day's color is normalized against the highest value across the visible calendar.
  Selecting a day filters the summary cards, bars, table, details and CSV to that UTC day; selecting the
  same day again clears the date filter. The calendar
  ignores date filters so its days and color scale stay visible; all other filters still apply.
  **Clear date filter** restores the report's full date range. Empty days remain selectable;
  future days are disabled. Hover or focus a day to see its value and measurement coverage.
  Dashed cells mark unknown measurements. Lifetime session span and file size leave the calendar
  uncolored because those measurements cannot be attributed to individual days.
- Filters include provider, project, workspace, label, model, active/archived state, source
  (Paseo linked/outside Paseo), main/subagent, data availability, and UTC calendar dates.
  Custom dates also accept UTC hours as `YYYY-MM-DD HH:00`; allowance charts set these. The model
  filter opens automatically when a chart sets it.
  Search matches session metadata, titles, directories, branches, labels, models, and effort.
  The provider filter lists only providers with sessions on this host, using the labels from
  Paseo's provider settings.
  Filter, column, table grouping, and sort choices survive navigation per host until the app restarts.
- **Export CSV** exports every filtered row in the current sort order, with all measurements
  as raw numbers (durations in milliseconds, ratios from 0 to 1, USD, bytes). On native clients
  it uses the platform share sheet. Spreadsheet formulas in text fields are neutralized.
  When the table is grouped, the export contains grouped totals and per-metric known-session counts.
- **Refresh** scans for new or changed files and asks Paseo for fresh allowances. The surface
  also refreshes every 30 seconds and polls scan progress every two seconds. The sessions are
  only transferred again when they have changed since the last response. A previous completed
  snapshot stays visible during refresh, and a spinner with the scan progress appears beside the
  title without moving the page; data from a different host is never used as a placeholder.

## Measurements

| Category | Measurements |
| --- | --- |
| Tokens | Total input, uncached input, cache reads, cache writes, Claude 1-hour cache writes, output, reported reasoning/thinking, total input + output, weighted cache hit percentage |
| Calls and messages | Model responses, user messages, assistant messages, model tool calls, explicit tool errors, tool error percentage, named tool-call counts |
| Executions | Codex completed command, MCP, file-change and search events, and their explicit failures, including operations inside an `exec` call |
| Length and time | User/assistant/tool input/tool output character counts, first/last timestamps, lifetime session span, recorded completed/aborted turn time, transcript bytes, compactions |
| Cost | Explicitly reported USD where present; standard short-context API token cost estimate for known models |

**Token categories are normalized.** Claude's base input excludes cache reads/writes, so those
categories are added to produce total input. Codex's input already includes them, so they are
subtracted to obtain uncached input. OpenCode, Kilo, and Devin CLI record uncached input and cache
reads/writes separately, like Claude; OpenCode and Kilo record reasoning outside output, so it is
added to output. Cache writes include the 1-hour subset. Reasoning is a subset
of output and is never added a second time to total tokens. Character counts use Unicode code
points, exclude images, and are not estimates of token counts.

**Dates filter activity, not session creation.** Activity is recorded per UTC hour, model, and
effort. A session spanning several days contributes only the buckets selected. Date presets include today and the preceding 6, 29, or 89 UTC
calendar days. Unknown-date buckets appear only without date bounds; activity without a recorded
hour is included by an hour filter only when the filter covers its whole day. Recorded turn duration is
attributed to the completion day. Session span and transcript size always cover the entire file;
those two metrics can be charted only by provider or project. Model filters omit activity that
cannot be attributed to the selected model, such as initial prompts before a model is recorded.

**Unknown is different from zero.** An em dash means a measurement is absent. Cards and bars
show the number of sessions with that measurement. Aggregates are known subtotals, and averages
divide by known sessions. Cache/error percentages use the ratio of sums for sessions with both
values. A partially readable session can contribute known values; its badge and details explain
the missing coverage. Token totals cannot recover deleted requests or unrecorded usage.

## Cost estimates

The **Base API estimate** uses a fixed price table checked on **2026-09-23** against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Each usage record is priced using its recorded model, including separate read/write rates and
Claude's reported 1-hour cache-write rate. Without a recorded cache TTL, writes use the 5-minute
rate. Supported families are listed explicitly in `shared/pricing.ts`; unknown/private models
(including `codex-auto-review` and Kilo's `kilo-auto/*`) remain unpriced. Dated model IDs, router
IDs such as `anthropic/claude-sonnet-4.5`, and Devin model names with an effort suffix use the
corresponding base model rate. Historical usage is valued at this price snapshot, not historical prices.

This is a **standard, short-context API equivalent**, not a bill or subscription allowance meter.
It excludes priority/fast processing, long-context and regional premiums, tool fees, negotiated
discounts, tax, and plan charges. It does not infer what you paid for Claude Pro/Max or ChatGPT.
**Reported cost** is separate. OpenCode and Kilo record a USD cost per message; Claude transcripts
rarely contain the SDK's `result.total_cost_usd` events, and Codex, Devin CLI, and Cursor record none. The plugin contacts
no pricing or provider account API. Subscription allowances come from Paseo, whose daemon queries
the provider accounts.

## Data sources and accounting

| Source | Location |
| --- | --- |
| Claude | `<config dir>/projects/**/*.jsonl`, including nested `subagents` files, for every Claude configuration directory (see below); default `$CLAUDE_CONFIG_DIR` or `~/.claude` |
| Codex | `<home>/sessions/**/rollout-*.jsonl` and `<home>/archived_sessions/**/rollout-*.jsonl` for every Codex home (see below); default `$CODEX_HOME` or `~/.codex` |
| OpenCode, Kilo | `$XDG_DATA_HOME/opencode/opencode.db` and `$XDG_DATA_HOME/kilo/kilo.db`, default `~/.local/share`; only the `session`, `message`, and `part` tables |
| Devin CLI | `$XDG_DATA_HOME/devin/cli/sessions.db`, default `~/.local/share`; only the `sessions` and `message_nodes` tables |
| Cursor | `$CURSOR_CONFIG_DIR/{acp-sessions/*,chats/*/*}/store.db`; without it, both `$XDG_CONFIG_HOME/cursor` (default `~/.config/cursor`) and `~/.cursor`; only the `meta` and `blobs` tables |
| Paseo | `$PASEO_HOME/projects/{projects,workspaces}.json`, `$PASEO_HOME/agents/*/*.json`, and provider labels from `$PASEO_HOME/config.json`, default `~/.paseo` |
| Allowances | Paseo's provider usage report (`paseo.providers.listUsage`), which the daemon caches for five minutes; only window names, percentages, reset times, and plan labels are kept |
| Index | Written by this plugin: `$PASEO_HOME/plugin-data/session-usage/index.sqlite`, or `$PASEO_SESSION_USAGE_DB` |

- **Provider profiles (several accounts).** Paseo providers that extend Claude or Codex and set
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in their `env` (for example `claude-work` and `claude-personal`)
  each contribute their directory to the scan. Sessions found there are attributed to that provider
  ID and label, so the Provider filter and charts separate the accounts. A profile that points at
  the daemon's default directory claims it; only those two variables are read from a provider's
  environment. Without profiles the daemon's own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` defaults apply.
- No transcript, registry, configuration, or provider state is changed. The only file written is
  the plugin's own index. Only metadata, numeric
  statistics, tool names and coverage notices are sent to the client. Message text, tool arguments,
  tool results, and provider credentials never leave the parser. Session titles are metadata.
- SQLite stores are opened read-only and closed after each read. Account and credential tables are
  never queried, and JSON fields are reduced to numbers, tool names, and text lengths inside
  SQLite. A store is reread when its database or WAL file changes. Sessions without messages are
  skipped unless a Paseo agent owns them. Reading stores needs the daemon Node's built-in
  `node:sqlite`; otherwise the scan shows a warning.
- Store sessions join Paseo agents by session ID. A custom provider ID, such as a configured `kilo`
  ACP provider, comes from the matching agent records; unlinked sessions in the same store use the
  ID most linked sessions use, or the store's name.
- OpenCode/Kilo: one model response per assistant message with usage. Turn time runs from each
  user message to its last completed reply. Tool errors use the tool's `error` status, and
  compaction parts count as compactions. Child sessions are subagents of their parent session;
  archived state follows the store's archive time.
- Devin CLI: compaction copies message nodes, so messages and tool calls count once per ID. Effort
  comes from the generation model suffix (`gpt-6-astra-medium` is `gpt-6-astra` at `medium`).
  Cache keepalive pings are not user messages. Tool errors use the recorded tool result status.
  Turn time, reasoning, and compactions are unknown.
- Cursor: one store per session. Only messages listed by the latest root blob count; older roots and
  edited-away messages in the store are ignored. Cursor records no token usage or message times
  locally, so tokens, cost, and turn time are unknown, sessions show partial coverage, and all
  activity falls on the session's start day. Effort comes from the model name suffix
  (`cursor-grok-4.6-high-fast` is `cursor-grok-4.6-fast` at `high`). Tool errors use the recorded
  tool result's `error` or `failure` output. Stores without a root or messages are skipped unless a
  Paseo agent owns them.
- Agents of providers without readable local usage records are listed as missing with a notice.
- A provider session referenced by several Paseo agents is counted once; an active agent record
  wins over an archived one. Duplicate active/archive Codex files use the largest copy, then the
  newest on a tie. Claude subagent files are separate rows linked to their parent's workspace.
  Codex subagent metadata identifies child/review sessions, even without a recorded parent ID.
- Project matching uses the recorded workspace first, then directory matches and the most specific
  project root. Active/archived state includes the agent, workspace, project, or Codex archive
  directory. “Active” means not archived; it does not mean currently running. Untracked Claude
  sessions have no provider archive flag and are considered active.
- Missing transcripts stay listed when Paseo still has an agent record. If both the transcript
  and registry record were deleted, there is nothing to recover. A missing environment directory
  is empty; inaccessible or malformed metadata produces a visible scan warning.
- Claude usage snapshots are merged per assistant message ID, using the highest reported value
  per token category to handle repeated content blocks/final updates. Tool calls use call IDs.
- Effort comes from Claude assistant records, Codex turn contexts or applied thread settings, and
  Devin CLI model names. OpenCode and Kilo record none.
  Changes split activity buckets without changing token totals. Missing effort stays unknown.
- Modern Codex `token_usage_record` entries are deduplicated by response ID and are authoritative
  once present. Their lifetime counters differ from legacy `token_count` counters after compaction;
  the two counter streams are never summed. Earlier legacy-only sections use positive cumulative
  differences, with repeated totals ignored and resets counted as separate segments and flagged.
  Legacy response counts mean observed nonzero increments, not necessarily individual API calls.
  Explicit token records belonging to another thread are excluded.
- Codex canonical `response_item` messages take precedence over mirrored `event_msg` messages.
  Model tool calls and completed execution events are separate metrics: one model `exec` call
  can run several commands. Error detection uses explicit flags/status/exit codes, not a search
  for the word “error”. Calls with unstructured or missing outcomes may have unobserved errors.
- Recorded user messages may include injected instructions, automated prompts and compaction
  context. Copied conversation context without stable identities may affect message/character
  counts. These are transcript statistics, not a count of human keystrokes.
- Four file streams run at once. Each JSONL line is capped at 16 MiB. Oversized, malformed, and
  unfinished lines are skipped with a partial-data notice. Scan errors retain the previous
  snapshot. Plugin cleanup aborts active streams and clears the cache.
- Parse results are kept in a SQLite index, so after a daemon restart or plugin reload only new or
  changed sources are read. The scan starts when the plugin loads, and a warm index makes the
  first visit near-instant.
  - Transcripts are keyed by path, size, and modification time; stores by their database and WAL
    files. A changed file is reparsed whole, and deleted sources are dropped.
  - The index holds the same data the surface receives (session metadata, per-hour counters, tool
    names, and notices), never message text or tool payloads.
  - A version change or a corrupt file rebuilds the index from the sources.
  - Without `node:sqlite`, the cache stays in memory only.

## Limitations

- Measures Claude, Codex, OpenCode, Kilo, and Devin CLI from local records. Cursor sessions include
  messages, tool calls, and models but no token usage. Other providers appear only through Paseo's
  agent records, with unknown usage.
- Cost figures are a standard short-context API equivalent from a fixed price table, not a bill
  or subscription meter. The plugin contacts no pricing or provider account API.
- Allowance percentages and reset times are whatever Paseo reports; window lengths are inferred,
  and the pace projection assumes usage continues at the average rate so far.
- Message text, tool arguments, tool results, and credentials never leave the daemon parser.
- An em dash means a measurement is absent; averages divide by known sessions only.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:session-usage
```

From a checkout on the daemon host (Node 22.13+ for the test runner and `node:sqlite`):

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/session-usage
paseo plugin ls
```

After editing, typecheck and run `paseo plugin reload session-usage`. Use `--host <target>` for
another daemon.

## Development

```bash
npm test --workspace=session-usage
```

The plugin registers a sidebar surface and a global Command Center action; both registrations
are removed on plugin cleanup, and the server index is closed. The UI uses React Native primitives and
theme colors. Filters use anchored popovers on desktop and Paseo sheets on compact clients; the
statistics table and the allowance cards remain horizontally scrollable.

Regression tests cover provider accounting, SQLite store accounting, custom provider IDs and labels,
duplicate events, compaction counters, child metadata,
malformed/oversized records, active/archive copies, missing files, metadata joins, changed-file
refresh, credential/content exclusion, date/model filters, weighted aggregation, chart totals,
effort changes and missing levels, calendar date selection and normalization, leap-year/month
boundaries, calendar deselection, table group accounting, overlapping labels, sorting, CSV escaping,
hourly buckets and hour filters, index persistence across restarts, version rebuilds, snapshot
revisions, allowance window lengths and scopes, token series, pace projection, and chart filters.
