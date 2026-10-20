import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { UsageStore, type IndexChanges, type IndexedFile, type IndexedStore } from "./index-store";
import { paseoHome } from "./paseo-home";
import { object, string, parseTranscript, type ParsedTranscript } from "./parser";
import { readCursorStore, readDevinStore, readOpenCodeStore, readStore, type StoreReader, type StoreSession } from "./stores";
import type { Session, Snapshot } from "../shared/schema";

interface Source {
  path: string;
  provider: string;
  /** Paseo provider ID that owns the source's directory; falls back to `provider`. */
  providerId?: string;
  nativeId: string;
  parentId: string | null;
  kind: "main" | "subagent";
  archived: boolean;
  size: number;
  mtimeMs: number;
}
interface FileSource extends Source { provider: "claude" | "codex"; providerId: string }
interface Metadata {
  agents: Map<string, Agent>;
  workspaces: Map<string, Workspace>;
  projects: Map<string, Project>;
  providerLabels: Map<string, string>;
  profiles: ProfileRoot[];
}
/** A Claude or Codex configuration directory owned by one Paseo provider, e.g. a second account. */
export interface ProfileRoot { id: string; kind: "claude" | "codex"; root: string }
interface Agent { id: string; nativeId: string; provider: string; workspaceId: string; cwd: string; title: string; archived: boolean; status: string; createdAt: string; model: string }
interface Workspace { id: string; projectId: string; cwd: string; title: string; branch: string; labels: string[]; archived: boolean }
interface Project { id: string; root: string; name: string; archived: boolean }
/** `profiles` overrides the provider profiles read from Paseo's config.json; tests set it, production leaves it undefined. */
export interface Roots { paseo: string; claude: string; codex: string; data: string; cursor: string[]; profiles?: ProfileRoot[] }

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot", opencode: "OpenCode", pi: "Pi", omp: "Oh My Pi", kilo: "Kilo", devin: "Devin", cursor: "Cursor" };
function providerLabel(metadata: Metadata, provider: string): string {
  return metadata.providerLabels.get(provider) ?? PROVIDER_LABELS[provider] ?? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}
/** SQLite session stores, grouped per provider with the provider ID Paseo uses by default. Cursor keeps one store per session. */
async function sessionStores(roots: Roots, warnings: Set<string>): Promise<{ provider: string; paths: string[]; read: StoreReader }[]> {
  const cursor: string[] = [];
  for (const root of roots.cursor) {
    for (const session of await entries(join(root, "acp-sessions"), warnings)) if (session.isDirectory()) cursor.push(join(root, "acp-sessions", session.name, "store.db"));
    for (const workspace of await entries(join(root, "chats"), warnings)) {
      if (!workspace.isDirectory()) continue;
      for (const session of await entries(join(root, "chats", workspace.name), warnings)) if (session.isDirectory()) cursor.push(join(root, "chats", workspace.name, session.name, "store.db"));
    }
  }
  return [
    { provider: "opencode", paths: [join(roots.data, "opencode", "opencode.db")], read: readOpenCodeStore },
    { provider: "kilo", paths: [join(roots.data, "kilo", "kilo.db")], read: readOpenCodeStore },
    { provider: "devin", paths: [join(roots.data, "devin", "cli", "sessions.db")], read: readDevinStore },
    { provider: "cursor", paths: cursor, read: readCursorStore },
  ];
}
/** Cursor's config directory: CURSOR_CONFIG_DIR, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`. The daemon may not share the agent's XDG setting, so both defaults are read. */
function cursorRoots(): string[] {
  const configured = process.env.CURSOR_CONFIG_DIR?.trim();
  if (configured) return [configured];
  return [...new Set([join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "cursor"), join(homedir(), ".cursor")])];
}

async function entries(path: string, warnings: Set<string>) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warnings.add(`Cannot read directory: ${path}`);
    return [];
  }
}
async function json(path: string, warnings: Set<string>): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.add(`Cannot read metadata: ${basename(path)}`);
    return null;
  }
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export async function readMetadata(root: string, warnings: Set<string>): Promise<Metadata> {
  const metadata: Metadata = { agents: new Map(), workspaces: new Map(), projects: new Map(), providerLabels: new Map(), profiles: [] };
  const [projects, workspaces, config] = await Promise.all([json(join(root, "projects", "projects.json"), warnings), json(join(root, "projects", "workspaces.json"), warnings), json(join(root, "config.json"), warnings)]);
  for (const raw of array(projects)) {
    const p = object(raw);
    const id = string(p.projectId);
    if (id) metadata.projects.set(id, { id, root: string(p.rootPath), name: string(p.customName) || string(p.displayName) || basename(string(p.rootPath)), archived: Boolean(p.archivedAt) });
  }
  for (const raw of array(workspaces)) {
    const w = object(raw);
    const id = string(w.workspaceId);
    if (id) metadata.workspaces.set(id, { id, cwd: string(w.cwd), projectId: string(w.projectId), title: string(w.title) || string(w.displayName) || basename(string(w.cwd)), branch: string(w.branch), labels: array(w.labels).filter((label): label is string => typeof label === "string"), archived: Boolean(w.archivedAt) });
  }
  // Only display labels and the two configuration-directory variables are read from provider
  // settings; commands and the rest of the environment may hold credentials.
  for (const [id, provider] of Object.entries(object(object(object(config).agents).providers))) {
    const label = string(object(provider).label).trim();
    if (label) metadata.providerLabels.set(id, label.slice(0, 80));
    const env = object(object(provider).env);
    const claudeRoot = string(env.CLAUDE_CONFIG_DIR).trim();
    const codexRoot = string(env.CODEX_HOME).trim();
    if (claudeRoot) metadata.profiles.push({ id, kind: "claude", root: expandHome(claudeRoot) });
    if (codexRoot) metadata.profiles.push({ id, kind: "codex", root: expandHome(codexRoot) });
  }
  const directories = await entries(join(root, "agents"), warnings);
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const path = join(root, "agents", directory.name);
    for (const file of await entries(path, warnings)) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const a = object(await json(join(path, file.name), warnings));
      const provider = string(a.provider);
      if (!provider) continue;
      // Explicit allowlist: persistence.metadata contains credentials and is never retained.
      const p = object(a.persistence);
      const nativeId = provider === "codex" ? string(p.nativeHandle) || string(p.sessionId) : string(p.sessionId) || string(p.nativeHandle);
      const id = string(a.id);
      if (!id) continue;
      const key = `${provider}:${nativeId || `missing:${id}`}`;
      const value: Agent = { id, nativeId, provider, cwd: string(a.cwd), workspaceId: string(a.workspaceId), title: string(a.title), archived: Boolean(a.archivedAt), status: string(a.lastStatus) || "unknown", createdAt: string(a.createdAt), model: string(object(a.runtimeInfo).model) || string(object(a.config).model) };
      // Resuming the same provider session in multiple Paseo records must not multiply usage.
      const previous = metadata.agents.get(key);
      if (!previous || (previous.archived && !value.archived) || (previous.archived === value.archived && value.createdAt > previous.createdAt)) metadata.agents.set(key, value);
    }
  }
  return metadata;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
async function physical(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}
/**
 * Every Claude and Codex configuration directory to scan: the daemon's own defaults plus one per
 * Paseo provider whose environment sets CLAUDE_CONFIG_DIR or CODEX_HOME (separate accounts). A
 * profile that points at the default directory claims it, so a session is indexed once and
 * attributed to that provider.
 */
export async function profileRoots(roots: Roots, profiles: ProfileRoot[]): Promise<ProfileRoot[]> {
  const result: ProfileRoot[] = [];
  const claimed = new Set<string>();
  for (const profile of profiles) {
    const key = `${profile.kind}:${await physical(profile.root)}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    result.push(profile);
  }
  for (const [kind, root] of [["claude", roots.claude], ["codex", roots.codex]] as const) {
    const key = `${kind}:${await physical(root)}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    result.push({ id: kind, kind, root });
  }
  return result;
}

async function discover(roots: Roots, profiles: ProfileRoot[], warnings: Set<string>, signal: AbortSignal): Promise<FileSource[]> {
  const sources = new Map<string, FileSource>();
  const trees: [string, "claude" | "codex", string, boolean][] = [];
  for (const profile of profiles) {
    if (profile.kind === "claude") trees.push([join(profile.root, "projects"), "claude", profile.id, false]);
    else trees.push([join(profile.root, "sessions"), "codex", profile.id, false], [join(profile.root, "archived_sessions"), "codex", profile.id, true]);
  }
  for (const [root, provider, providerId, archived] of trees) {
    const queue = [root];
    while (queue.length) {
      if (signal.aborted) throw new Error("Scan cancelled");
      const directory = queue.pop()!;
      for (const entry of await entries(directory, warnings)) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        let nativeId: string;
        let parentId: string | null = null;
        if (provider === "codex") {
          const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(entry.name);
          if (!match) continue;
          nativeId = match[1];
        } else {
          nativeId = entry.name.slice(0, -6);
          const segments = path.split(sep);
          const subagentIndex = segments.lastIndexOf("subagents");
          if (subagentIndex >= 1) parentId = segments[subagentIndex - 1];
          if (parentId) nativeId = `${parentId}/${nativeId}`;
        }
        try {
          const info = await stat(path);
          const source: FileSource = { path, nativeId, provider, providerId, archived, parentId, kind: parentId ? "subagent" : "main", size: info.size, mtimeMs: info.mtimeMs };
          const key = `${provider}:${nativeId}`;
          const previous = sources.get(key);
          // A copied/moved rollout in both trees is one session. Prefer the fullest copy.
          if (!previous || previous.size < source.size || (previous.size === source.size && source.mtimeMs > previous.mtimeMs)) sources.set(key, source);
          if (previous?.archived) sources.get(key)!.archived = true;
          if (archived) sources.get(key)!.archived = true;
        } catch { warnings.add("A transcript disappeared or could not be inspected during the scan."); }
      }
    }
  }
  return [...sources.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function joinSession(source: Source, parsed: ParsedTranscript, metadata: Metadata): Session {
  // A transcript found in a provider profile's directory belongs to that Paseo provider unless a
  // Paseo agent recorded it under another ID (e.g. the base provider before profiles existed).
  const candidates = [...new Set([source.providerId, source.provider].filter((id): id is string => Boolean(id)))];
  const lookup = (nativeId: string) => { for (const id of candidates) { const agent = metadata.agents.get(`${id}:${nativeId}`); if (agent) return agent; } return undefined; };
  const agent = lookup(source.nativeId);
  const parentId = source.parentId ?? parsed.parentId;
  const parent = parentId ? lookup(parentId) : undefined;
  const owner = agent ?? parent;
  const provider = agent?.provider ?? parent?.provider ?? source.providerId ?? source.provider;
  const key = `${provider}:${source.nativeId}`;
  const cwd = parsed.cwd || owner?.cwd || "";
  const workspace = metadata.workspaces.get(owner?.workspaceId ?? "") ?? [...metadata.workspaces.values()].filter((w) => cwd && resolve(w.cwd) === resolve(cwd)).sort((a, b) => Number(a.archived) - Number(b.archived))[0];
  const project = metadata.projects.get(workspace?.projectId ?? "") ?? [...metadata.projects.values()].filter((p) => p.root && cwd && (resolve(cwd) === resolve(p.root) || resolve(cwd).startsWith(`${resolve(p.root)}${sep}`))).sort((a, b) => b.root.length - a.root.length)[0];
  const label = providerLabel(metadata, provider);
  return {
    id: key, nativeId: source.nativeId, provider, providerLabel: label,
    kind: parentId || parsed.isSubagent ? "subagent" : source.kind, parentId: parentId ? `${provider}:${parentId}` : null,
    title: agent?.title || parsed.title || `${label} ${source.nativeId.slice(-12)}`,
    agentId: agent?.id ?? null, workspaceId: workspace?.id ?? null, workspace: workspace?.title ?? "",
    projectId: project?.id ?? null, project: project?.name ?? "Outside Paseo / unknown project",
    cwd, branch: workspace?.branch || parsed.branch, labels: workspace?.labels ?? [],
    archived: source.archived || Boolean(owner?.archived || workspace?.archived || project?.archived),
    status: agent?.status ?? "untracked", startedAt: parsed.startedAt, endedAt: parsed.endedAt,
    bytes: source.size, coverage: parsed.warnings.length ? "partial" : "available", warnings: parsed.warnings, buckets: parsed.buckets,
  };
}

export function defaultRoots(): Roots {
  return { paseo: paseoHome(), claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), codex: process.env.CODEX_HOME ?? join(homedir(), ".codex"), data: process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), cursor: cursorRoots() };
}

/**
 * One background scan per installation, four streams at once. Parse results are cached by
 * size/mtime (stores: database and WAL) in memory and, given a database path, in a persistent
 * index, so only new or changed sources are read after a restart.
 */
export class UsageIndex {
  private cache = new Map<string, IndexedFile>();
  private storeCache = new Map<string, IndexedStore>();
  private store: UsageStore | null = null;
  private loaded = false;
  private state: Snapshot = { sessions: [], scanning: false, completed: 0, total: 0, generatedAt: null, warnings: [], revision: "" };
  private controller = new AbortController();
  private running: Promise<void> | null = null;
  private lastScan = 0;
  constructor(private roots: Roots = defaultRoots(), private databasePath: string | null = null) {}

  snapshot(refresh = false): Snapshot {
    if (!this.controller.signal.aborted && !this.running && (refresh || !this.lastScan || Date.now() - this.lastScan > 30_000)) {
      this.state = { ...this.state, scanning: true, completed: 0, total: 0 };
      this.running = this.scan().catch(() => {
        if (!this.controller.signal.aborted) this.state = { ...this.state, warnings: ["Session scan failed. Refresh to retry."], scanning: false };
      }).finally(() => { this.running = null; this.lastScan = Date.now(); });
    }
    return this.state;
  }
  async settled(): Promise<Snapshot> { await this.running; return this.state; }
  /** Waits up to `timeoutMs` for the first scan, which is quick when the persistent index is warm. */
  async firstScan(timeoutMs: number): Promise<void> {
    if (this.state.generatedAt || !this.running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.running, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }
  /** The current state, without sessions when the caller already has this revision. */
  view(revision?: string): Snapshot {
    return revision && revision === this.state.revision ? { ...this.state, sessions: [], unchanged: true } : this.state;
  }
  dispose(): void { this.controller.abort(); this.store?.close(); this.store = null; this.cache.clear(); this.storeCache.clear(); this.state.sessions = []; }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.databasePath) return;
    this.store = UsageStore.open(this.databasePath);
    if (!this.store) return;
    try {
      const contents = this.store.load();
      this.cache = contents.files;
      this.storeCache = contents.stores;
    } catch (error) { console.warn(`[session-usage] cannot load usage index: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async scan(): Promise<void> {
    this.load();
    const changes: IndexChanges = { files: new Map(), stores: new Map(), removedFiles: [], removedStores: [] };
    const warnings = new Set<string>();
    const metadata = await readMetadata(this.roots.paseo, warnings);
    const profiles = await profileRoots(this.roots, this.roots.profiles ?? metadata.profiles);
    const sources = await discover(this.roots, profiles, warnings, this.controller.signal);
    this.state = { ...this.state, total: sources.length };
    const sessions: Session[] = [];
    let next = 0;
    const livePaths = new Set(sources.map((s) => s.path));
    const worker = async () => {
      while (next < sources.length) {
        if (this.controller.signal.aborted) throw new Error("Scan cancelled");
        const source = sources[next++];
        try {
          const signature = `${source.size}:${source.mtimeMs}`;
          let entry = this.cache.get(source.path);
          if (entry?.signature !== signature) {
            entry = { signature, parsed: await parseTranscript(source.path, source.provider, this.controller.signal) };
            this.cache.set(source.path, entry);
            changes.files.set(source.path, entry);
          }
          sessions.push(joinSession(source, entry.parsed, metadata));
        } catch {
          if (this.controller.signal.aborted) return;
          const session = joinSession(source, { nativeId: source.nativeId, parentId: source.parentId, cwd: "", title: "", branch: "", startedAt: null, endedAt: null, buckets: [], warnings: ["Transcript could not be read."] }, metadata);
          session.coverage = "missing";
          sessions.push(session);
        }
        this.state = { ...this.state, completed: this.state.completed + 1 };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
    if (this.controller.signal.aborted) throw new Error("Scan cancelled");
    const readable = new Set(["claude", "codex", ...profiles.map((profile) => profile.id)]);
    sessions.push(...await this.readStores(metadata, warnings, readable, changes));
    const seen = new Set(sessions.map((s) => s.id));
    for (const [key, agent] of metadata.agents) {
      if (seen.has(key)) continue;
      const source: Source = { nativeId: agent.nativeId || `missing:${agent.id}`, provider: agent.provider, parentId: null, kind: "main", path: "", size: 0, mtimeMs: 0, archived: agent.archived };
      const warning = !agent.nativeId ? "Agent has no recorded provider session." : readable.has(agent.provider) ? "Transcript is missing from the provider's local records." : "This provider keeps no local usage records that Session usage can read.";
      const session = joinSession(source, { nativeId: source.nativeId, parentId: null, cwd: agent.cwd, title: agent.title, branch: "", startedAt: agent.createdAt || null, endedAt: null, buckets: [], warnings: [warning] }, metadata);
      session.coverage = "missing";
      sessions.push(session);
    }
    for (const path of this.cache.keys()) if (!livePaths.has(path)) { this.cache.delete(path); changes.removedFiles.push(path); }
    this.persist(changes);
    sessions.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "") || a.id.localeCompare(b.id));
    const revision = createHash("sha256").update(JSON.stringify(sessions)).digest("base64url").slice(0, 22);
    this.state = { sessions: revision === this.state.revision ? this.state.sessions : sessions, scanning: false, completed: sources.length, total: sources.length, generatedAt: new Date().toISOString(), warnings: [...warnings], revision };
  }

  private persist(changes: IndexChanges): void {
    if (!this.store || this.controller.signal.aborted) return;
    if (!changes.files.size && !changes.stores.size && !changes.removedFiles.length && !changes.removedStores.length) return;
    try { this.store.save(changes); }
    catch (error) { console.warn(`[session-usage] cannot update usage index: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Each store is reread only when its database or WAL file changes. Adds the provider IDs it resolves to `readable`. */
  private async readStores(metadata: Metadata, warnings: Set<string>, readable: Set<string>, changes: IndexChanges): Promise<Session[]> {
    const sessions: Session[] = [];
    const agentsByNativeId = new Map<string, Agent>();
    for (const agent of metadata.agents.values()) if (agent.nativeId && agent.provider !== "claude" && agent.provider !== "codex") agentsByNativeId.set(agent.nativeId, agent);
    const live = new Set<string>();
    for (const group of await sessionStores(this.roots, warnings)) {
      // A session copied into several stores counts once, from its largest copy.
      const stored = new Map<string, { path: string; session: StoreSession }>();
      let found = false;
      for (const path of group.paths) {
        if (this.controller.signal.aborted) throw new Error("Scan cancelled");
        live.add(path);
        let signature: string, mtimeMs: number;
        try {
          const [database, wal] = await Promise.all([stat(path), stat(`${path}-wal`).catch(() => null)]);
          signature = `${database.size}:${database.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
          mtimeMs = Math.max(database.mtimeMs, wal?.mtimeMs ?? 0);
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warnings.add(`Cannot read session store: ${path}`);
          if (this.storeCache.delete(path)) changes.removedStores.push(path);
          continue;
        }
        let cached = this.storeCache.get(path);
        if (cached?.signature !== signature) {
          try {
            cached = { signature, sessions: readStore(path, group.read, { mtimeMs }) };
            this.storeCache.set(path, cached);
            changes.stores.set(path, cached);
          } catch (error) {
            warnings.add(`Cannot read session store: ${path}`);
            // Diagnose read-only provider DB failures without modifying the
            // DB, logging paths, or including any session content.
            // An exception can include SQL, paths, or user-provided content.
            // Classify it without copying exception text into daemon logs.
            const message = error instanceof Error ? error.message : "";
            const reason = /no such table:/i.test(message) ? "schema-mismatch"
              : /(?:locked|busy)/i.test(message) ? "busy"
              : /(?:permission denied|readonly|access denied)/i.test(message) ? "access-denied"
              : "unclassified";
            console.warn(`[session-usage] read-only store scan failed for ${group.provider}: ${reason}`);
          }
        }
        if (!cached) continue;
        found = true;
        for (const session of cached.sessions) {
          const previous = stored.get(session.nativeId);
          if (!previous || previous.session.bytes < session.bytes) stored.set(session.nativeId, { path, session });
        }
      }
      if (!found) continue;
      // Custom provider IDs are user-chosen, so unlinked sessions take the ID most linked sessions use.
      const linked = new Map<string, number>();
      for (const { session } of stored.values()) {
        const provider = agentsByNativeId.get(session.nativeId)?.provider;
        if (provider) linked.set(provider, (linked.get(provider) ?? 0) + 1);
      }
      const storeProvider = [...linked].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.provider;
      readable.add(storeProvider);
      for (const { path, session } of stored.values()) {
        const agent = agentsByNativeId.get(session.nativeId);
        // Sessions without messages are skipped unless a Paseo agent owns them.
        if (!session.messages && !agent) continue;
        const provider = agent?.provider ?? storeProvider;
        readable.add(provider);
        sessions.push(joinSession({ path, provider, nativeId: session.nativeId, parentId: session.parentId, kind: session.parentId ? "subagent" : "main", archived: session.archived, size: session.bytes, mtimeMs: 0 }, session.parsed, metadata));
      }
    }
    for (const path of this.storeCache.keys()) if (!live.has(path)) { this.storeCache.delete(path); changes.removedStores.push(path); }
    return sessions;
  }
}
