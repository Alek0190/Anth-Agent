import { SharedState } from "./shared-state.js";
import type { StateChange } from "../../anth-sdk/src/app-state.js";
import type {
  AgentDetail,
  AgentExtensions,
  AgentRef,
  AgentSummary,
  ClientSummary,
  CreateSessionBody,
  DeviceInfo,
  EnvironmentName,
  DeviceTree,
  DirListing,
  InboxItem,
  ModelInfo,
  Page,
  SendResult,
  SessionSummary,
  TaskNode,
  TaskOutcome,
  ThinkingLevel,
  UsageTotals,
  WhenBusy,
  Incident,
  ProjectSummary,
  TeamInfo,
  WatchEvent,
  TeamRoleId,
  UpdateSessionBody,
  UpdateTeamBody,
  WireEntry,
} from "../../anth-sdk/src/api.js";
import {
  ENVIRONMENTS,
  isSlug,
  compactionFits,
  DEFAULT_COMPACTION,
  defaultCompaction,
  THINKING_LEVELS,
  type CompactionSettings,
} from "../../anth-sdk/src/api.js";
import { lastAssistantText, messageText, toMarkdown, toTranscript } from "../../anth-sdk/src/transcript.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, realpath, rename as renamePath, rm, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { curatedModels, defaultModelId, missingCurated, withNewerModels } from "./model-catalog.js";
import { fauxModels, installFaux } from "./faux.js";
import {
  Harness,
  createRegistry,
  InboxDoc,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type ModelRef,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AgentExecutionEnv, agentShellEnv } from "./agent-env.js";
import { attachmentMessage, parseAttachments, saveAttachments, withoutImageData } from "./attachments.js";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createPlayground, Workspace, type SpawnSession } from "./extensions.js";
import { createJobs, JobRuns, JOB_DEFS, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { ADDON_INFO, createAddons, PROMPTS, PromptChecklist, type Addons } from "./addons.js";
import { createTeam, roleDef, ROLES, type TeamNote, type TeamSettings } from "./team.js";
import { Watcher } from "./watch.js";
import { createIncidentExtension, incidentBrief, prepareWorktree } from "./incident.js";
import { JOB_RUNS_DOC, type JobRun } from "../../anth-sdk/src/jobs.js";

export const DURABLE_VERSION = "1.0.3";

/**
 * Tools that create, update or delete: shell, files, App State, job runs, sessions, pages and subagents. "Read only"
 * means none of these: the agent cannot change the project, App State, jobs or anything outside. The team log is the
 * one exception: team_note only adds a note to the session's log, which is how read-only reviewers hand over their
 * findings, so it is not a write tool and stays offered to read-only agents.
 */
/** The output token cap per model call: ANTH_MAX_OUTPUT_TOKENS, default 32000, at least 1024. */
export function maxOutputTokens(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.ANTH_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 32000;
}

export const WRITE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "update_state",
  "run_durable_job",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
  "delegate",
]);

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  dbPath: string;
  createdAt: number;
  model: string;
  provider: string;
  /** `<client>/<project>` or null; env is set whenever project is. */
  project: string | null;
  env: EnvironmentName | null;
};

export interface StoreOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
  provider: "openrouter" | "faux";
}

/** Agent documents a client may read or stream, by kind. */
/** apps/anth-backend/src → the checkout root. */
const CODE_DIR = resolve(import.meta.dirname, "../../..");
const AGENT_DOCS = { [JOB_RUNS_DOC]: JobRuns, "demo.workspace": Workspace } as const;
export const AGENT_DOC_KINDS = Object.keys(AGENT_DOCS);
export const DEVICE_DOC_KINDS = ["app.shared-state"];

export function lockFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
    }
    if (alive && pid !== process.pid) throw Error(`Database already owned by process ${pid}: ${path}`);
    unlinkSync(path);
    take();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}

type Opened = {
  harness: Harness;
  unlock: () => void;
  unsubscribe: () => void;
  jobs: Jobs;
  addons: Addons;
  team: ReturnType<typeof createTeam>;
  incident: ReturnType<typeof createIncidentExtension>;
};
type Resolved = { row: SessionRow; h: Harness; c: Conversation };

const encodeCursor = (cursor: unknown) =>
  cursor === undefined ? undefined : Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor?: string) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Invalid cursor");
  }
};

export class Store {
  readonly models = createModels();
  readonly opened = new Map<string, Opened>();
  readonly errors = new Map<string, string>();
  readonly catalog: DatabaseSync;
  readonly startedAt = Date.now();
  shared!: SharedState;
  uid!: string;
  modelList: ModelInfo[] = [];
  private unlockCatalog: () => void;
  private unlockShared?: () => void;
  private listeners = new Set<() => void>();
  /** Saved thresholds per session; null when the session uses the defaults for its model. */
  private compactions = new Map<string, Partial<CompactionSettings> | null>();
  /** Watch and fix: production signals, Jev triage and incidents for the projects this device watches. */
  readonly watcher: Watcher;
  /** Model overrides per team role, per session. */
  private teams = new Map<string, TeamSettings["models"]>();
  /** Task labels never change once known: tool names of pi.tool tasks, job titles of job runs. */
  private taskLabels = new Map<string, { label?: string; callId?: string }>();

  get catalogPath() {
    return join(this.options.dataDir, "catalog.sqlite");
  }
  get sharedStatePath() {
    return join(this.options.dataDir, "app-state.sqlite");
  }
  get sessionsDir() {
    return join(this.options.dataDir, "sessions");
  }
  get archiveDir() {
    return join(this.options.dataDir, "archive");
  }
  get name() {
    return this.options.name;
  }
  get startDirs() {
    return this.options.startDirs;
  }

  private constructor(readonly options: StoreOptions) {
    if (options.provider === "faux") installFaux(this.models);
    else {
      const provider = openrouterProvider();
      const catalog = withNewerModels(provider.getModels());
      const missing = missingCurated(catalog);
      if (missing.length) throw Error(`OpenRouter catalog missing ${missing.join(", ")}`);
      this.models.setProvider({
        ...provider,
        getModels: () => catalog.filter((m) => curatedModels.some((c) => c.id === m.id)),
      });
    }
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.unlockCatalog = lockFile(`${this.catalogPath}.lock`);
    this.catalog = new DatabaseSync(this.catalogPath);
    this.catalog.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_notes(sessionId TEXT NOT NULL,key TEXT NOT NULL,at INTEGER NOT NULL,author TEXT NOT NULL,toRole TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(sessionId,key));
      CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_spawns(key TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compaction(sessionId TEXT PRIMARY KEY,settings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_team(sessionId TEXT PRIMARY KEY,models TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clients(slug TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(client TEXT NOT NULL REFERENCES clients(slug),slug TEXT NOT NULL,name TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(client,slug));`);
    // Catalogs from before projects: sessions gain a nullable project and environment.
    const columns = new Set(
      (this.catalog.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("project")) this.catalog.exec("ALTER TABLE sessions ADD COLUMN project TEXT");
    if (!columns.has("env")) this.catalog.exec("ALTER TABLE sessions ADD COLUMN env TEXT");
    const uid = this.catalog.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as
      | { value: string }
      | undefined;
    this.uid = uid?.value ?? randomUUID();
    if (!uid) this.catalog.prepare("INSERT INTO meta(key,value) VALUES('device_uid',?)").run(this.uid);
    this.catalog.prepare("DELETE FROM requests WHERE createdAt < ?").run(Date.now() - 24 * 3600_000);
    this.watcher = new Watcher({
      db: this.catalog,
      offline: options.provider === "faux",
      sessionCwd: (id) => (this.catalog.prepare("SELECT cwd FROM sessions WHERE id=?").get(id) as { cwd: string } | undefined)?.cwd,
      openIncident: (incident, samples) => this.openIncident(incident, samples),
      shipStatus: async (incident) => {
        const opened = this.opened.get(incident.sessionId);
        if (!opened || incident.conversationId === undefined || incident.shipTaskId === undefined) return undefined;
        const doc = await opened.harness.snapshot(JobRuns, incident.conversationId as ConversationId, ctx);
        return doc?.items[String(incident.shipTaskId)]?.status;
      },
      notify: () => this.notify(),
    });
  }

  static async open(options: StoreOptions) {
    const store = new Store({ ...options, dataDir: resolve(options.dataDir) });
    // Start dirs are where new sessions begin; create any that do not exist yet.
    await Promise.all(options.startDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => {})));
    try {
      store.unlockShared = lockFile(`${store.sharedStatePath}.lock`);
      store.shared = await SharedState.open(store.sharedStatePath);
      store.shared.harness.subscribeCommits(() => store.notify());
      for (const row of store.list()) {
        try {
          await store.openAgent(row);
        } catch (e) {
          store.errors.set(row.id, String(e instanceof Error ? e.message : e));
        }
      }
      if (!(await store.shared.initialized()))
        await store.shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
      store.modelList = await store.loadModels();
      store.watcher.start(Number(process.env.ANTH_WATCH_INTERVAL_MS ?? 60_000));
      for (const { harness } of store.opened.values()) harness.resume();
      return store;
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ change feed

  private problemListeners = new Set<(key: string, text: string) => void>();
  /** Problems only the owner can fix (the provider account), for Telegram. */
  onProblem(fn: (key: string, text: string) => void) {
    this.problemListeners.add(fn);
    return () => void this.problemListeners.delete(fn);
  }
  reportProblem(key: string, text: string) {
    console.log(`problem: ${text}`);
    for (const fn of this.problemListeners) fn(key, text);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  notify = () => {
    for (const fn of this.listeners) fn();
  };

  // ------------------------------------------------------------ device

  deviceInfo(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: hostname(),
      platform: `${platform()}-${process.arch} node ${process.version}`,
      apiVersion: 1,
      durableVersion: DURABLE_VERSION,
      startedAt: this.startedAt,
      startDirs: this.startDirs,
      models: this.modelList,
      defaultModel: this.defaultModel(),
      storage: { dataDir: this.options.dataDir, catalogPath: this.catalogPath, appStatePath: this.sharedStatePath },
      codeDir: CODE_DIR,
      capabilities: ["events", "docs", "demo", "jobs"],
      jobs: JOB_DEFS,
    };
  }

  private defaultModel() {
    return this.options.provider === "faux" ? fauxModels[0].id : defaultModelId;
  }

  private async loadModels(): Promise<ModelInfo[]> {
    if (this.options.provider === "faux")
      return fauxModels.map((m) => ({
        id: m.id,
        provider: "faux",
        name: m.name,
        tier: "T",
        icon: "lab.png",
        contextWindow: 128000,
        reasoning: false,
        cost: { input: 0, output: 0 },
      }));
    const available = await this.models.getAvailable("openrouter", { signal: AbortSignal.timeout(10000) });
    return curatedModels.flatMap((c) => {
      const m = available.find((m) => m.id === c.id);
      return m
        ? [
            {
              id: m.id,
              provider: "openrouter",
              name: c.name,
              tier: c.tier,
              icon: c.icon,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
              cost: { input: m.cost.input, output: m.cost.output },
            },
          ]
        : [];
    });
  }

  routedModel(model?: ModelRef): ModelRef {
    if (this.options.provider === "faux") {
      const id = fauxModels.some((m) => m.id === model?.modelId) ? model!.modelId : fauxModels[0].id;
      return { provider: "faux", modelId: id };
    }
    const exact = model?.provider === "openrouter" ? model.modelId : `${model?.provider}/${model?.modelId}`;
    return {
      provider: "openrouter",
      modelId: curatedModels.some((m) => m.id === exact) ? exact : defaultModelId,
    };
  }

  validateModel(model: unknown): ModelRef {
    const m = model as ModelRef | undefined;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string")
      throw invalid("model must be { provider, modelId }");
    const known =
      this.options.provider === "faux"
        ? m.provider === "faux" && fauxModels.some((f) => f.id === m.modelId)
        : m.provider === "openrouter" &&
          curatedModels.some((c) => c.id === m.modelId) &&
          !!this.models.getModel(m.provider, m.modelId);
    if (!known) throw invalid(`Unknown model ${m.provider}/${m.modelId}. Choose one from GET /v1/device models`);
    return { provider: m.provider, modelId: m.modelId };
  }

  // ------------------------------------------------------------ directories

  async directories(): Promise<DirListing> {
    const dirs: { name: string; path: string }[] = [];
    for (const root of this.startDirs) {
      try {
        dirs.push({ name: root, path: await realpath(root) });
      } catch {}
    }
    return { path: "", dirs };
  }

  async browse(path: string): Promise<DirListing> {
    if (!path) return this.directories();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(expanded));
      if (!(await stat(real)).isDirectory()) throw Error();
    } catch {
      throw notFound(`Not a directory on ${this.name}: ${path}`);
    }
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of await readdir(real, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ name: entry.name, path: join(real, entry.name) });
      }
    } catch (e) {
      throw new ApiFault("unavailable", `Cannot list ${real}: ${(e as Error).message}`);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: dirname(real) !== real ? dirname(real) : undefined, dirs: dirs.slice(0, 500) };
  }

  // ------------------------------------------------------------ sessions

  list(): SessionRow[] {
    return this.catalog.prepare("SELECT * FROM sessions ORDER BY createdAt DESC").all() as SessionRow[];
  }

  row(id: string): SessionRow {
    const row = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (!row) throw notFound(`No session ${id}`);
    return row;
  }

  /** A session by UUID or unique case-insensitive name. */
  resolveSession(ref: string): SessionRow {
    const byId = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(ref) as SessionRow | undefined;
    if (byId) return byId;
    const matches = this.catalog
      .prepare("SELECT * FROM sessions WHERE lower(name)=lower(?)")
      .all(ref) as SessionRow[];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new ApiFault("ambiguous", `${matches.length} sessions are named "${ref}"; use the session id`);
    throw notFound(`No session "${ref}" on ${this.name}`);
  }

  harness(row: SessionRow) {
    const h = this.opened.get(row.id)?.harness;
    if (!h) throw new ApiFault("unavailable", this.errors.get(row.id) ?? `Session ${row.name} is unavailable`);
    return h;
  }

  /** `spawnKey` records which tool call created the session, in the same transaction as the session row. */
  async create(body: CreateSessionBody, spawnKey?: string): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    const path = body.cwd.trim();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let cwd: string;
    try {
      cwd = await realpath(resolve(this.startDirs[0] ?? homedir(), expanded));
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      throw invalid(`cwd must be an existing folder on ${this.name}`);
    }
    const model = this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel))
      throw invalid("Invalid thinking level");
    const placement = this.placement(body.project, body.env);
    if (body.team !== undefined && typeof body.team !== "boolean") throw invalid("team must be a boolean");
    const withTeam = body.team ?? !!placement.project;
    const id = randomUUID();
    const row: SessionRow = {
      id,
      name: body.name.trim().slice(0, 100) || "Untitled session",
      cwd,
      dbPath: join(this.sessionsDir, id, "agent.sqlite"),
      createdAt: Date.now(),
      model: model.modelId,
      provider: model.provider,
      project: placement.project,
      env: placement.env,
    };
    await this.openAgent(row, true, body.thinkingLevel ?? "low");
    this.catalog.exec("BEGIN");
    try {
      // Checked again next to the insert: the project may have been removed while the agent opened. Both run
      // synchronously, so removeProject cannot land between them.
      if (row.project) this.project(...(row.project.split("/") as [string, string]));
      this.catalog
        .prepare(
          "INSERT INTO sessions(id,name,cwd,dbPath,createdAt,model,provider,project,env) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(id, row.name, cwd, row.dbPath, row.createdAt, row.model, row.provider, row.project, row.env);
      if (spawnKey) this.catalog.prepare("INSERT OR REPLACE INTO session_spawns VALUES(?,?)").run(spawnKey, id);
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      // The session never existed: close the agent opened for it and drop its new, empty folder.
      await this.closeHarness(id, false).catch(() => {});
      await rm(dirname(row.dbPath), { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    if (withTeam) await this.setTeam(row, { enabled: true });
    this.notify();
    return this.sessionSummary(row);
  }

  /**
   * The start_session tool. A replay of the same tool call (same `key`) finds the session it created, and the first
   * prompt reuses its requestId, so a crash never starts a second session or sends the prompt twice.
   */
  spawnSession: SpawnSession = async (input) => {
    const found = this.catalog.prepare("SELECT sessionId FROM session_spawns WHERE key=?").get(input.key) as
      | { sessionId: string }
      | undefined;
    const existing = found && this.list().find((r) => r.id === found.sessionId);
    const session = existing
      ? await this.sessionSummary(existing)
      : await this.create(
          { name: input.name, cwd: input.cwd, model: input.model, thinkingLevel: input.thinkingLevel },
          input.key,
        );
    if (!input.prompt) return { session };
    const { c } = await this.resolveAgent(session.id, "main");
    const submission = await this.send(c, { content: input.prompt, requestId: `${input.key}:prompt` });
    return { session, submissionId: submission.id as number };
  };

  rename(row: SessionRow, name: unknown) {
    return this.updateSession(row, { name: name as string });
  }

  /** PATCH /v1/sessions/:s: rename, move into or out of a project, or change environment. */
  updateSession(row: SessionRow, body: UpdateSessionBody) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.name === undefined && b.project === undefined && b.env === undefined)
      throw invalid("Nothing to change: send name, project or env");
    if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim())) throw invalid("A name is required");
    let placement = { project: row.project, env: row.env };
    if (b.project === null) {
      if (b.env !== undefined) throw invalid("env needs a project");
      placement = { project: null, env: null };
    } else if (b.project !== undefined || b.env !== undefined)
      placement = this.placement(b.project ?? row.project ?? undefined, b.env ?? (b.project === undefined ? undefined : row.env ?? undefined));
    this.catalog
      .prepare("UPDATE sessions SET name=?,project=?,env=? WHERE id=?")
      .run(typeof b.name === "string" ? b.name.trim().slice(0, 100) : row.name, placement.project, placement.env, row.id);
    this.notify();
    return this.sessionSummary(this.row(row.id));
  }

  // ------------------------------------------------------------ clients and projects

  /** Every client on this device, sorted by name. */
  clients(): ClientSummary[] {
    return this.catalog.prepare("SELECT slug,name,createdAt FROM clients ORDER BY name COLLATE NOCASE").all() as unknown as ClientSummary[];
  }

  /** Every project on this device, grouped by client and sorted by name. */
  projects(): ProjectSummary[] {
    const rows = this.catalog
      .prepare("SELECT client,slug,name,createdAt FROM projects ORDER BY client, name COLLATE NOCASE")
      .all() as unknown as ProjectSummary[];
    return rows.map((p) => {
      const watch = this.watcher.summary(`${p.client}/${p.slug}`);
      return watch ? { ...p, watch } : p;
    });
  }

  // ------------------------------------------------------------ incidents

  /**
   * Turn a new incident into an incident agent: a worktree on incident/inc-<n> from the default branch, a team Lead
   * conversation working in it, and the brief. Every step can be repeated: the worktree and conversation are reused,
   * and the brief's requestId makes a second submission a no-op.
   */
  async openIncident(incident: Incident, samples: WatchEvent[]) {
    const row = this.row(incident.sessionId);
    const opened = this.opened.get(row.id);
    if (!opened) throw Error(this.errors.get(row.id) ?? `Session ${row.name} is not open`);
    const watch = this.watcher.get(incident.project);
    const repo = resolve(row.cwd, watch.path);
    const wt = await prepareWorktree(repo, incident.id);
    this.watcher.updateIncident(incident.id, wt);
    let conversationId = this.watcher.incident(incident.id)?.conversationId;
    const h = opened.harness;
    if (conversationId === undefined) {
      const root = await (await h.root(ctx)).agent(ctx);
      const extensions = [...root.extensions.filter((e) => e.name !== "team"), opened.team.lead, opened.incident];
      const c = await h.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: root.model, cwd: wt.worktree, thinkingLevel: root.thinkingLevel },
        },
        ctx,
      );
      await c.configure({ extensions }, ctx);
      conversationId = c.id as number;
      this.watcher.updateIncident(incident.id, { conversationId });
      this.setAgentName(row, conversationId, `Incident #${incident.id}`);
    }
    const c = await h.conversation(conversationId as ConversationId, ctx);
    if (!c) throw Error(`Incident agent #${conversationId} is missing`);
    const current = this.watcher.incident(incident.id)!;
    await c.submit(
      { type: "input", content: incidentBrief(current, samples, watch.url), requestId: `incident:${incident.id}:brief`, whenBusy: "followUp" },
      ctx,
    );
    h.resume();
    this.notify();
  }

  /** One project by its client and project ids; `404` when this device does not have it. */
  project(client: string, slug: string): ProjectSummary {
    const found = this.catalog
      .prepare("SELECT client,slug,name,createdAt FROM projects WHERE client=? AND slug=?")
      .get(client, slug) as unknown as ProjectSummary | undefined;
    if (!found) throw notFound(`No project ${client}/${slug} on ${this.name}`);
    return found;
  }

  /** PUT /v1/clients/:client: create the client, or rename it. Repeating the call changes nothing. */
  upsertClient(slug: string, body: { name?: unknown }) {
    if (!isSlug(slug)) throw invalid("Client id must be lowercase letters, digits and dashes (max 48)");
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : undefined;
    const existing = this.catalog.prepare("SELECT slug FROM clients WHERE slug=?").get(slug);
    if (existing) {
      if (name) this.catalog.prepare("UPDATE clients SET name=? WHERE slug=?").run(name, slug);
    } else this.catalog.prepare("INSERT INTO clients VALUES(?,?,?)").run(slug, name ?? slug, Date.now());
    this.notify();
    return this.clients().find((c) => c.slug === slug)!;
  }

  /** PUT /v1/projects/:client/:project: create the project (and its client when missing), or rename it. */
  upsertProject(client: string, slug: string, body: { name?: unknown; clientName?: unknown }) {
    if (!isSlug(client)) throw invalid("Client id must be lowercase letters, digits and dashes (max 48)");
    if (!isSlug(slug)) throw invalid("Project id must be lowercase letters, digits and dashes (max 48)");
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : undefined;
    this.catalog.exec("BEGIN");
    try {
      if (!this.catalog.prepare("SELECT slug FROM clients WHERE slug=?").get(client)) {
        const clientName =
          typeof body?.clientName === "string" && body.clientName.trim() ? body.clientName.trim().slice(0, 100) : client;
        this.catalog.prepare("INSERT INTO clients VALUES(?,?,?)").run(client, clientName, Date.now());
      }
      if (this.catalog.prepare("SELECT slug FROM projects WHERE client=? AND slug=?").get(client, slug)) {
        if (name) this.catalog.prepare("UPDATE projects SET name=? WHERE client=? AND slug=?").run(name, client, slug);
      } else this.catalog.prepare("INSERT INTO projects VALUES(?,?,?,?)").run(client, slug, name ?? slug, Date.now());
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      throw e;
    }
    this.notify();
    return this.project(client, slug);
  }

  /**
   * DELETE /v1/projects/:client/:project: archive the project's sessions on this device (their files move to archive/,
   * nothing is deleted), stop watching it and drop it from the catalog; its client goes too once it has no projects.
   * Removing a project this device does not have is a no-op, so the hub can send it to every device and retry.
   */
  async removeProject(client: string, slug: string) {
    const ref = `${client}/${slug}`;
    // Not on this device: nothing to do, and its client (which may have been created on its own) stays.
    if (!this.catalog.prepare("SELECT 1 FROM projects WHERE client=? AND slug=?").get(client, slug))
      return { removed: ref, archivedSessions: [] as string[] };
    // Incident agents work in the watch session, which need not be one of the project's: stop them first.
    for (const incident of this.watcher.openIncidents(ref)) {
      if (incident.conversationId === undefined) continue;
      const c = await this.opened
        .get(incident.sessionId)
        ?.harness.conversation(incident.conversationId as ConversationId, ctx);
      if (c) await c.abort(ctx, { background: true }).catch(() => {});
    }
    const archived: string[] = [];
    for (const row of this.list().filter((r) => r.project === ref)) {
      await this.archive(row);
      archived.push(row.id);
    }
    this.watcher.forget(ref);
    this.catalog.exec("BEGIN");
    try {
      this.catalog.prepare("DELETE FROM projects WHERE client=? AND slug=?").run(client, slug);
      const left = this.catalog.prepare("SELECT 1 FROM projects WHERE client=? LIMIT 1").get(client);
      if (!left) this.catalog.prepare("DELETE FROM clients WHERE slug=?").run(client);
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      throw e;
    }
    this.notify();
    return { removed: ref, archivedSessions: archived };
  }

  /** Validate a session's project ref and environment. No project means no environment. */
  private placement(project: unknown, env: unknown): { project: string | null; env: EnvironmentName | null } {
    if (project === undefined || project === null || project === "") {
      if (env !== undefined && env !== null) throw invalid("env needs a project");
      return { project: null, env: null };
    }
    if (typeof project !== "string" || !/^[^/]+\/[^/]+$/.test(project))
      throw invalid("project must be <client>/<project>");
    const [client, slug] = project.split("/");
    this.project(client, slug);
    if (env !== undefined && !ENVIRONMENTS.includes(env as EnvironmentName))
      throw invalid(`env must be one of ${ENVIRONMENTS.join(", ")}`);
    return { project, env: (env as EnvironmentName | undefined) ?? "dev" };
  }

  /** Close a session's harness and release its lock; with `stop`, abort every conversation's work first. */
  private async closeHarness(id: string, stop: boolean) {
    const opened = this.opened.get(id);
    if (!opened) return;
    if (stop)
      for (const record of await this.scanAll(opened.harness)) {
        const c = await opened.harness.conversation(record.id, ctx);
        if (c) await c.abort(ctx, { background: true }).catch(() => {});
      }
    opened.unsubscribe();
    try {
      await opened.harness.close(ctx);
    } finally {
      opened.unlock();
    }
    this.opened.delete(id);
  }

  /** Stop all work, close the harness and move its files to archive/. Nothing is deleted. */
  async archive(row: SessionRow) {
    await this.closeHarness(row.id, true);
    await mkdir(this.archiveDir, { recursive: true });
    const target = join(this.archiveDir, `${row.id}-${Date.now()}`);
    try {
      await renamePath(dirname(row.dbPath), target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.catalog.prepare("DELETE FROM conversation_names WHERE sessionId=?").run(row.id);
    this.catalog.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
    this.errors.delete(row.id);
    this.notify();
    return { archived: target };
  }

  async openAgent(row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "low") {
    const current = this.opened.get(row.id);
    if (current) return current.harness;
    if (!create) await stat(row.dbPath);
    await mkdir(dirname(row.dbPath), { recursive: true });
    const unlock = lockFile(`${row.dbPath}.lock`);
    try {
      const shellEnv = agentShellEnv();
      const registry = createRegistry();
      registry.install(CodingTools);
      // Custom extensions are installed but not selected: an agent turns them on in its own selection.
      const addons = createAddons({ offline: this.options.provider === "faux" });
      for (const extension of addons.list) registry.install(extension);
      const team = createTeam({
        settings: () => ({ enabled: true, models: this.teamModels(row.id) }),
        notes: { add: (n) => this.addTeamNote(row.id, n), list: (opts) => this.teamNotes(row.id, opts) },
        route: (modelId) => this.routedModel({ provider: "openrouter", modelId }),
        problem: (key, text) => this.reportProblem(key, text),
        name: (conversationId, name) => {
          try {
            this.setAgentName(row, conversationId, name);
          } catch {}
        },
        // Read the catalog each time: a session can move to another project or environment while it runs.
        placement: () => {
          const current = this.catalog.prepare("SELECT project,env FROM sessions WHERE id=?").get(row.id) as
            | { project: string | null; env: EnvironmentName | null }
            | undefined;
          return { project: current?.project ?? undefined, env: current?.env ?? undefined };
        },
      });
      for (const extension of team.list) registry.install(extension);
      const incident = createIncidentExtension({
        incidentFor: (conversationId) => this.watcher.incidentForConversation(row.id, conversationId),
        update: (id, fields) => this.watcher.updateIncident(id, fields),
        sessionCwd: () => row.cwd,
        startShip: (tx, conversationId, input, toolCallId) => {
          const def = jobDef("ship")!;
          return jobs.start(tx, conversationId as ConversationId, {
            def,
            input: resolveJobInput(def, input),
            startedBy: "agent",
            toolCallId,
            now: Date.now(),
          });
        },
      });
      registry.install(incident);
      const jobs = createJobs({
        shared: this.shared,
        sessionId: row.id,
        cwd: () => row.cwd,
        notes: { add: (n) => this.addTeamNote(row.id, n), list: (opts) => this.teamNotes(row.id, opts) },
        team: {
          change: (role) => team.memberChange(role),
          title: (role) => roleDef(role)?.title ?? role,
          name: (conversationId, name) => {
            try {
              this.setAgentName(row, conversationId, name);
            } catch {}
          },
        },
      });
      const compaction = () => this.compactionOf(row.id);
      const playground = createPlayground(this.shared, row.id, this.spawnSession, jobs);
      registry.install(playground);
      const harness = await Harness.open(
        await openNodeSqliteStorage(row.dbPath),
        {
          models: this.models,
          registry,
          // Agents' commands see only an allowlisted environment: no device token, model key or deploy tokens.
          env: ({ cwd }) => new AgentExecutionEnv({ cwd: cwd ?? row.cwd, shellEnv }),
          conversationCreated: async (tx, c) => {
            await tx.doc(Workspace, c.id);
            await tx.doc(JobRuns, c.id);
          },
          settings: {
            extensions: [CodingTools, playground],
            // Read at every use, so a PATCH .../compaction applies from the next request.
            get compaction() {
              return compaction();
            },
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
            // Ask for at most this many output tokens per model call. Without it OpenRouter reserves the model's whole
            // output budget (128k for some), and a low balance refuses every call with 402 before it starts.
            stream: { maxTokens: maxOutputTokens() } as never,
          },
          onReport: (e) => console.error("[durable]", String(e)),
        },
        ctx,
      );
      await harness.root(ctx, {
        agent: {
          cwd: row.cwd,
          model: { provider: row.provider, modelId: row.model },
          thinkingLevel,
        },
      });
      // Route stored agent choices to this device's provider before recovery issues any request.
      for (const record of await this.scanAll(harness)) {
        const conversation = (await harness.conversation(record.id, ctx))!;
        const previous = (await conversation.agent(ctx)).model;
        const routed = this.routedModel(previous);
        if (previous?.provider !== routed.provider || previous.modelId !== routed.modelId)
          await conversation.configure({ model: routed }, ctx);
      }
      const rootModel = (await (await harness.root(ctx)).agent(ctx)).model!;
      row.provider = rootModel.provider;
      row.model = rootModel.modelId;
      this.catalog.prepare("UPDATE sessions SET provider=?,model=? WHERE id=?").run(row.provider, row.model, row.id);
      const unsubscribe = harness.subscribeCommits(() => this.notify());
      this.opened.set(row.id, { harness, unlock, unsubscribe, jobs, addons, team, incident });
      this.errors.delete(row.id);
      if (create) harness.resume();
      return harness;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  async scanAll(h: Harness): Promise<ConversationRecord[]> {
    return h.commit(async (tx) => {
      let page = await tx.scanConversations({}, 1000);
      const records = [...page.items];
      while (page.next) {
        page = await tx.scanConversations({}, 1000, page.next);
        records.push(...page.items);
      }
      return records;
    }, ctx);
  }

  // ------------------------------------------------------------ agents

  private names(sessionId: string) {
    return new Map(
      (
        this.catalog
          .prepare("SELECT conversationId,name FROM conversation_names WHERE sessionId=?")
          .all(sessionId) as { conversationId: number; name: string }[]
      ).map((r) => [r.conversationId, r.name]),
    );
  }

  private agentRef(record: ConversationRecord, names: Map<number, string>): AgentRef {
    const id = record.id as number;
    const kind = record.parent ? "fork" : record.owner ? "subagent" : "root";
    const custom = names.get(id);
    const derived =
      id === 1 ? "Main" : kind === "fork" ? `Fork #${id}` : kind === "subagent" ? `Subagent #${id}` : `Root #${id}`;
    return {
      id,
      name: custom ?? derived,
      named: custom !== undefined,
      kind,
      ...(record.parent ? { parentId: record.parent.conversationId as number, forkedAt: record.parent.at as number } : {}),
      ...(record.owner
        ? { ownerAgentId: record.owner.conversationId as number, ownerTaskId: record.owner.taskId as number }
        : {}),
    };
  }

  async agents(row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]> {
    const h = this.harness(row);
    const names = this.names(row.id);
    const records = await this.scanAll(h);
    const live = tasks ?? (await this.liveTasks(h));
    return records.map((record) => {
      const own = live.filter((t) => t.conversationId === (record.id as number));
      return {
        ...this.agentRef(record, names),
        busy: own.some((t) => !t.background),
        background: own.filter((t) => t.background).length,
      };
    });
  }

  async liveTasks(h: Harness): Promise<TaskNode[]> {
    const graph = await h.taskGraph(ctx);
    try {
      return await this.labelTasks(h, Object.values(graph.value.tasks).map((t) => this.taskNode(t)));
    } finally {
      graph.dispose();
    }
  }

  taskNode(t: unknown): TaskNode {
    const n = t as {
      id: number;
      kind: string;
      conversationId: number;
      owner?: number;
      background: boolean;
      abortRequested?: boolean;
      state: { status: string; phase?: string; on?: readonly number[]; policy?: string; outcome?: string };
      conversations?: readonly number[];
    };
    return {
      id: n.id,
      kind: n.kind,
      conversationId: n.conversationId,
      ...(n.owner !== undefined ? { owner: n.owner } : {}),
      background: !!n.background,
      ...(n.abortRequested ? { aborting: true } : {}),
      state: {
        status: n.state.status,
        ...(n.state.phase ? { phase: n.state.phase } : {}),
        ...(n.state.on ? { on: [...n.state.on] } : {}),
        ...(n.state.policy ? { policy: n.state.policy } : {}),
      },
      conversations: [...(n.conversations ?? [])],
    };
  }

  /** Agent by numeric id, `main`, or unique name (custom or derived, case-insensitive). */
  async resolveAgent(sessionRef: string, agentRef: string): Promise<Resolved> {
    const row = this.resolveSession(sessionRef);
    const h = this.harness(row);
    let id: number | undefined;
    if (/^\d+$/.test(agentRef)) id = Number(agentRef);
    else if (agentRef.toLowerCase() === "main") id = 1;
    else {
      const wanted = agentRef.toLowerCase();
      const names = this.names(row.id);
      const matches = (await this.scanAll(h))
        .map((r) => this.agentRef(r, names))
        .filter((a) => a.name.toLowerCase() === wanted);
      if (matches.length > 1) throw new ApiFault("ambiguous", `${matches.length} agents are named "${agentRef}"`);
      id = matches[0]?.id;
    }
    const c = id === undefined ? undefined : await h.conversation(id as ConversationId, ctx);
    if (!c) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    return { row, h, c };
  }

  async agentSummary(row: SessionRow, c: Conversation): Promise<AgentSummary> {
    const agents = await this.agents(row);
    return agents.find((a) => a.id === (c.id as number))!;
  }

  /** Every tool of the agent's selected extensions, first definition per name, and the names it is offered. */
  private async toolsOf(c: Conversation) {
    const agent = await c.agent(ctx);
    const all = new Map<string, ToolRegistration>();
    for (const extension of agent.extensions)
      for (const tool of extension.tools ?? []) if (!all.has(tool.name)) all.set(tool.name, tool as ToolRegistration);
    return { agent, all: [...all.values()], offered: new Set(agent.tools.map((t) => t.name)) };
  }

  async agentDetail(row: SessionRow, c: Conversation): Promise<AgentDetail> {
    const { agent, all, offered } = await this.toolsOf(c);
    const writers = all.filter((t) => WRITE_TOOLS.has(t.name));
    return {
      ...(await this.agentSummary(row, c)),
      sessionId: row.id,
      config: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
        instructions: agent.instructions,
        cwd: agent.cwd,
        readOnly: writers.length > 0 && writers.every((t) => !offered.has(t.name)),
      },
      tools: all.map((t) => ({
        name: t.name,
        description: t.description,
        replay: (t.replay ?? "unsafe") as "safe" | "unsafe",
        parameters: JSON.parse(JSON.stringify(t.parameters ?? {})),
        writes: WRITE_TOOLS.has(t.name),
        offered: offered.has(t.name),
      })),
      extensions: agent.extensions.map((e) => e.name),
    };
  }

  setAgentName(row: SessionRow, agentId: number, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    const clean = name.trim().slice(0, 100);
    if (/^\d+$/.test(clean) || clean.toLowerCase() === "main" && agentId !== 1)
      throw invalid("Agent names cannot be numbers or 'main'");
    this.catalog
      .prepare(
        "INSERT INTO conversation_names VALUES(?,?,?) ON CONFLICT(sessionId,conversationId) DO UPDATE SET name=excluded.name",
      )
      .run(row.id, agentId, clean);
    this.notify();
  }

  async createAgent(row: SessionRow, body: { from?: unknown; name?: unknown }) {
    const h = this.harness(row);
    const source = await this.resolveAgent(row.id, String(body.from ?? 1));
    const agent = await source.c.agent(ctx);
    const other = await h.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: agent.model,
          cwd: agent.cwd,
          thinkingLevel: agent.thinkingLevel,
          instructions: agent.instructions,
        },
      },
      ctx,
    );
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, other.id as number, body.name);
    this.notify();
    return this.agentSummary(row, other);
  }

  async fork(row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }) {
    const at = Number(body.entryId);
    if (!Number.isSafeInteger(at)) throw invalid("entryId is required");
    if (body.name !== undefined && typeof body.name !== "string") throw invalid("Invalid fork name");
    const fork = await c.fork(at as EntryId, { ownership: { kind: "ownerless" } }, ctx);
    const agent = await fork.agent(ctx);
    await fork.configure({ model: this.routedModel(agent.model) }, ctx);
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, fork.id as number, body.name);
    this.notify();
    return this.agentSummary(row, fork);
  }

  async configure(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    const model = body.model === undefined ? undefined : this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel))
      throw invalid("Invalid thinking level");
    if (body.instructions !== undefined && typeof body.instructions !== "string")
      throw invalid("instructions must be a string");
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") throw invalid("cwd must be a string");
      cwd = (await this.browse(body.cwd)).path;
    }
    if (body.readOnly !== undefined && typeof body.readOnly !== "boolean") throw invalid("readOnly must be a boolean");
    // Read only filters the agent's tools: the model is never offered the ones that create, update or delete.
    const tools =
      body.readOnly === true
        ? { tools: { remove: (await this.toolsOf(c)).all.filter((t) => WRITE_TOOLS.has(t.name)) } }
        : body.readOnly === false
          ? { tools: null }
          : {};
    await c.configure(
      {
        ...tools,
        ...(model ? { model } : {}),
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as ThinkingLevel } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 12000) } : {}),
        ...(cwd ? { cwd } : {}),
      },
      ctx,
    );
    if (model && (c.id as number) === 1)
      this.catalog.prepare("UPDATE sessions SET model=?,provider=? WHERE id=?").run(model.modelId, model.provider, row.id);
    // Thresholds are shared by the session's agents; refit them when this model's window is too small for them.
    const window = model ? this.windowOf(model.modelId) : 0;
    if (window && !compactionFits(window, this.compactionOf(row.id))) {
      const fitted = defaultCompaction(window);
      this.setCompaction(row, { reserveTokens: fitted.reserveTokens, backgroundTokens: fitted.backgroundTokens });
    }
    this.notify();
    return (await this.agentDetail(row, c)).config;
  }

  async send(c: Conversation, body: Record<string, unknown>, row?: SessionRow) {
    const attachments = parseAttachments(body.attachments);
    const text = body.content ?? "";
    if (typeof text !== "string" || text.length > 100000 || (!text.trim() && !attachments.length))
      throw invalid("content must be a message under 100,000 characters (it may be empty when it carries attachments)");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    let content: UserInput = text;
    if (attachments.length) {
      // Saved where this agent works, so it and the team it delegates to find the files with their own tools.
      const agent = await c.agent(ctx);
      const dir = agent.cwd ?? row?.cwd;
      if (!dir) throw invalid("This agent has no folder to save attachments in");
      const saved = await saveAttachments(dir, attachments);
      const model = agent.model ? this.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
      content = attachmentMessage(text, saved, !!(model as { input?: string[] } | undefined)?.input?.includes("image"));
    }
    return c.submit({ type: "input", content, requestId: body.requestId, whenBusy }, ctx);
  }

  async settled(h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> {
    const submission = await h.submission(submissionId as SubmissionId, ctx);
    if (!submission) throw notFound(`No submission ${submissionId}`);
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const timeout = AbortSignal.timeout(Math.min(waitMs, 300_000));
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        record = await submission.wait(withAbortSignal(stop, ctx));
      } catch (e) {
        if (!stop.aborted) throw e;
      }
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await h.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
      return { submissionId, status: "done", answer: { entryId: record.answer as number, text } };
    }
    if (record.status === "unanswered") return { submissionId, status: "unanswered", reason: record.reason };
    return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
  }

  async abort(c: Conversation, background: boolean) {
    await c.abort(ctx, { background });
    return { ok: true as const };
  }

  async withdraw(h: Harness, c: Conversation, submissionId: number) {
    return { status: await h.abortSubmission(submissionId as SubmissionId, ctx, c.id) };
  }

  async compact(c: Conversation, instructions?: unknown) {
    return { taskId: (await c.compact(typeof instructions === "string" && instructions.trim() ? instructions : undefined, ctx)) as number };
  }

  async reset(c: Conversation, note?: unknown) {
    await c.reset(typeof note === "string" && note.trim() ? note : undefined, ctx);
    return { ok: true as const };
  }

  async tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]> {
    const items = await h.commit(async (tx) => {
      let page = await tx.scanTasks({}, 500);
      let all = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({}, 500, page.next);
        all = [...all, ...page.items].slice(-2000);
      }
      return all;
    }, ctx);
    const wanted = items.filter((t) =>
      status === "terminal" ? t.state.status === "terminal" : t.state.status !== "terminal",
    );
    return wanted.slice(-Math.min(Math.max(limit, 1), 200)).reverse().map((t) => ({
      id: t.id as number,
      kind: (t as { kind?: string }).kind ?? (t as { definition?: string }).definition ?? "task",
      conversationId: (t as { conversationId?: number }).conversationId,
      state: JSON.parse(JSON.stringify(t.state)),
    }));
  }

  async abortTask(h: Harness, taskId: number) {
    const task = await h.getTask(taskId as TaskId, ctx);
    if (!task) throw notFound(`No task ${taskId}`);
    return { status: await h.abortTask(task.id, ctx) };
  }

  async inspect(h: Harness) {
    return h.inspect(ctx);
  }

  // Entries for clients carry no image data (see withoutImageData): attached files are in the project folder.
  async entries(c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> {
    const page = await c.entries({}, Math.min(Math.max(limit, 1), 2000), decodeCursor(cursor), ctx);
    return { items: withoutImageData(page.items) as unknown as WireEntry[], next: encodeCursor(page.next) };
  }

  async activeEntries(c: Conversation): Promise<WireEntry[]> {
    const view = await c.viewState(ctx);
    try {
      return withoutImageData(view.value.entries) as unknown as WireEntry[];
    } finally {
      view.dispose();
    }
  }

  async transcript(c: Conversation, format: string) {
    const items = toTranscript(await this.activeEntries(c));
    return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
  }

  async preview(row: SessionRow, agentId: number) {
    const h = this.opened.get(row.id)?.harness;
    const c = h ? await h.conversation(agentId as ConversationId, ctx) : undefined;
    if (!c) return undefined;
    return lastAssistantText(await this.activeEntries(c))?.slice(0, 200);
  }

  async inbox(h: Harness, c: Conversation): Promise<InboxItem[]> {
    const doc = await h.snapshot(InboxDoc, c.id, ctx);
    return (doc?.items ?? []).map((item) => {
      if (item.mode === "write") return { id: item.id as number, mode: "write" as const, content: "Context update" };
      const content = item.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("")
            : undefined;
      return { id: item.id as number, mode: item.mode, content: text };
    });
  }

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const token = AGENT_DOCS[kind as keyof typeof AGENT_DOCS];
    if (!token) throw notFound(`Unknown agent document ${kind}. Known: ${AGENT_DOC_KINDS.join(", ")}`);
    const value = await h.snapshot(token as typeof JobRuns, c.id, ctx);
    return JSON.parse(JSON.stringify(value ?? (kind === JOB_RUNS_DOC ? { counts: {}, items: {} } : {}))) as unknown;
  }

  async deviceDoc(kind: string) {
    if (kind !== "app.shared-state") throw notFound(`Unknown device document ${kind}`);
    const { value, revision } = await this.shared.snapshot();
    return { value, revision };
  }

  async usage(h: Harness): Promise<UsageTotals> {
    return JSON.parse(JSON.stringify(await h.usage(ctx))) as UsageTotals;
  }

  // ------------------------------------------------------------ custom extensions (per agent)

  async extensionsOf(row: SessionRow, c: Conversation): Promise<AgentExtensions> {
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const checked = (await this.harness(row).snapshot(PromptChecklist, c.id, ctx))?.enabled ?? [PROMPTS[0].id];
    return {
      builtIn: [...active].filter((name) => !ADDON_INFO.some((a) => a.name === name)),
      extensions: ADDON_INFO.map((info) => ({
        ...info,
        enabled: active.has(info.name),
        ...(info.name === "system-prompts"
          ? { prompts: PROMPTS.map(({ id, title, description, text }) => ({ id, title, description, text, enabled: checked.includes(id) })) }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async setExtension(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const enabled = body.enabled;
    if (typeof body.name === "string") {
      const extension = this.opened.get(row.id)?.addons.all[body.name];
      if (!extension) throw invalid(`Unknown extension ${body.name}. Known: ${ADDON_INFO.map((a) => a.name).join(", ")}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => ADDON_INFO.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== extension.name);
      const next = (enabled ? [...others, extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
    } else if (typeof body.prompt === "string") {
      const prompt = body.prompt;
      if (!PROMPTS.some((p) => p.id === prompt)) throw invalid(`Unknown prompt ${prompt}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
      await c.commit(async (tx) => {
        const doc = await tx.doc(PromptChecklist, c.id);
        const next = new Set(doc.enabled);
        if (enabled) next.add(prompt);
        else next.delete(prompt);
        doc.enabled = PROMPTS.map((p) => p.id).filter((id) => next.has(id));
      }, ctx);
    } else throw invalid("name or prompt is required");
    this.notify();
    return this.extensionsOf(row, c);
  }

  // ------------------------------------------------------------ the agent team (per session)

  /** Model overrides per role, saved in the catalog; empty when every role uses its default. */
  teamModels(sessionId: string): TeamSettings["models"] {
    if (!this.teams.has(sessionId)) {
      const saved = this.catalog.prepare("SELECT models FROM session_team WHERE sessionId=?").get(sessionId) as
        | { models: string }
        | undefined;
      this.teams.set(sessionId, saved ? (JSON.parse(saved.models) as TeamSettings["models"]) : {});
    }
    return this.teams.get(sessionId)!;
  }

  /** True when the session's root agent has the `team` extension selected. */
  async teamEnabled(row: SessionRow) {
    const opened = this.opened.get(row.id);
    if (!opened) return false;
    return (await (await opened.harness.root(ctx)).agent(ctx)).extensions.some((e) => e.name === "team");
  }

  /** GET /v1/sessions/:s/team: whether the root agent leads a team, and every role's tools and current model. */
  async team(row: SessionRow): Promise<TeamInfo> {
    const root = await this.harness(row).root(ctx);
    const agent = await root.agent(ctx);
    const models = this.teamModels(row.id);
    return {
      enabled: agent.extensions.some((e) => e.name === "team"),
      roles: ROLES.map((role) => ({
        id: role.id,
        title: role.title,
        summary: role.summary,
        tools: role.tools,
        writes: role.tools.some((t) => t !== "read" && t !== "bash") || role.id === "lead",
        defaultModel: role.defaultModel,
        custom: role.id !== "lead" && models[role.id] !== undefined,
        model: role.id === "lead" ? (agent.model?.modelId ?? row.model) : this.routedModel({ provider: "openrouter", modelId: models[role.id] ?? role.defaultModel }).modelId,
      })),
    };
  }

  /** PATCH /v1/sessions/:s/team: turn the team on or off, or change a role's model from the next delegation. */
  async setTeam(row: SessionRow, body: UpdateTeamBody) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.enabled === undefined && b.models === undefined) throw invalid("Nothing to change: send enabled or models");
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const known = (id: string) => this.modelList.some((m) => m.id === id);
    const changes = (b.models ?? {}) as Record<string, unknown>;
    if (typeof changes !== "object" || Array.isArray(changes)) throw invalid("models must be an object of role: model id");
    for (const [role, model] of Object.entries(changes)) {
      if (!roleDef(role)) throw invalid(`Unknown role ${role}. Roles: ${ROLES.map((r) => r.id).join(", ")}`);
      if (model !== null && (typeof model !== "string" || !known(model)))
        throw invalid(`Unknown model ${String(model)} for ${role}. Choose one from GET /v1/device models`);
      if (role === "lead" && model === null) throw invalid("The Lead's model is the root agent's model; choose one");
    }
    const opened = this.opened.get(row.id);
    if (!opened) throw new ApiFault("unavailable", this.errors.get(row.id) ?? `Session ${row.name} is unavailable`);
    const root = await opened.harness.root(ctx);
    if (typeof b.enabled === "boolean") {
      const others = (await root.agent(ctx)).extensions.filter((e) => e.name !== "team");
      await root.configure({ extensions: b.enabled ? [...others, opened.team.lead] : others }, ctx);
    }
    const next = { ...this.teamModels(row.id) };
    for (const [role, model] of Object.entries(changes)) {
      if (role === "lead") await root.configure({ model: this.validateModel({ provider: this.options.provider === "faux" ? "faux" : "openrouter", modelId: model as string }) }, ctx);
      else if (model === null) delete next[role as TeamRoleId];
      else next[role as TeamRoleId] = model as string;
    }
    if (Object.keys(changes).some((r) => r !== "lead")) {
      this.catalog
        .prepare("INSERT INTO session_team VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET models=excluded.models")
        .run(row.id, JSON.stringify(next));
      this.teams.set(row.id, next);
    }
    this.notify();
    return this.team(row);
  }

  // ------------------------------------------------------------ compaction settings (per session)

  private windowOf(modelId: string) {
    return this.modelList.find((m) => m.id === modelId)?.contextWindow ?? 0;
  }

  /** Saved thresholds, or the defaults for the session model's window (200k background, 250k wait when it fits). */
  compactionOf(sessionId: string): CompactionSettings {
    if (!this.compactions.has(sessionId)) {
      const row = this.catalog.prepare("SELECT settings FROM session_compaction WHERE sessionId=?").get(sessionId) as
        | { settings: string }
        | undefined;
      this.compactions.set(sessionId, row ? (JSON.parse(row.settings) as Partial<CompactionSettings>) : null);
    }
    const saved = this.compactions.get(sessionId);
    if (saved) return { ...DEFAULT_COMPACTION, ...saved };
    const session = this.catalog.prepare("SELECT model FROM sessions WHERE id=?").get(sessionId) as { model: string } | undefined;
    return defaultCompaction(this.windowOf(session?.model ?? ""));
  }

  /** Validate and store new thresholds; pi-durable reads them at its next use, so they apply from the next request. */
  setCompaction(row: SessionRow, body: Record<string, unknown>): CompactionSettings {
    const next = this.compactionOf(row.id);
    const int = (key: "reserveTokens" | "backgroundTokens" | "keepRecentTokens", min: number, max: number) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
      next[key] = n;
    };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
      next.enabled = body.enabled;
    }
    int("reserveTokens", 1024, 1_000_000);
    int("backgroundTokens", 0, 1_000_000);
    int("keepRecentTokens", 500, 200_000);
    this.catalog
      .prepare("INSERT INTO session_compaction VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET settings=excluded.settings")
      .run(row.id, JSON.stringify(next));
    this.compactions.set(row.id, next);
    this.notify();
    return { ...next };
  }

  /** Name every pi.tool task by its tool and every job run by its title, so a task list reads like the transcript. */
  async labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        const key = `${node.conversationId}:${node.id}`;
        let known = this.taskLabels.get(key);
        if (!known) {
          known = await this.taskLabel(h, node).catch(() => undefined);
          if (!known) return node;
          this.taskLabels.set(key, known);
          if (this.taskLabels.size > 5000) this.taskLabels.delete(this.taskLabels.keys().next().value!);
        }
        return { ...node, ...known };
      }),
    );
  }

  private async taskLabel(h: Harness, node: TaskNode): Promise<{ label?: string; callId?: string } | undefined> {
    if (node.kind.startsWith("demo.job.")) {
      const run = (await h.snapshot(JobRuns, node.conversationId as ConversationId, ctx))?.items[String(node.id)];
      const def = jobDef(node.kind.slice("demo.job.".length));
      return def ? { label: run ? `${def.title} #${run.run}` : def.title } : undefined;
    }
    if (node.kind !== "pi.tool") return undefined;
    const task = await h.getTask(node.id as TaskId, ctx);
    const input = task?.input as { assistant?: number; callId?: string } | undefined;
    if (!input?.callId || input.assistant === undefined) return undefined;
    const entry = await h.commit((tx) => tx.entry(input.assistant as EntryId), ctx);
    for (const m of (entry?.model ?? []) as unknown as { role: string; content?: { type: string; id?: string; name?: string }[] }[])
      for (const b of m.role === "assistant" ? (m.content ?? []) : [])
        if (b.type === "toolCall" && b.id === input.callId) return { label: b.name, callId: input.callId };
    return { callId: input.callId };
  }

  // ------------------------------------------------------------ tree

  sessionSummaryBase(row: SessionRow) {
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      compaction: this.compactionOf(row.id),
      ...(row.project ? { project: row.project, env: row.env ?? "dev" } : {}),
    };
  }

  async sessionSummary(row: SessionRow): Promise<SessionSummary> {
    if (!this.opened.has(row.id))
      return { ...this.sessionSummaryBase(row), busy: false, agents: [], error: this.errors.get(row.id) ?? "Session unavailable" };
    const agents = await this.agents(row);
    const team = await this.teamEnabled(row);
    return { ...this.sessionSummaryBase(row), busy: agents.some((a) => a.busy), agents, ...(team ? { team } : {}) };
  }

  async tree(): Promise<DeviceTree> {
    const sessions = await Promise.all(this.list().map((row) => this.sessionSummary(row)));
    return {
      uid: this.uid,
      name: this.name,
      sessions,
      clients: this.clients(),
      projects: this.projects(),
      at: Date.now(),
    };
  }

  // ------------------------------------------------------------ demo extension

  async demoState(c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared.snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared.change(
      change,
      undefined,
      typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    );
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "demo.state-change",
          data: { text: `Shared App State: ${change.operation} ${change.path || "/"}` },
        }),
      ctx,
    );
    return { ok: true as const, ...(await this.deviceDoc("app.shared-state")) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(row: SessionRow, h: Harness, c: Conversation, body: Record<string, unknown>) {
    const def = typeof body.job === "string" ? jobDef(body.job) : undefined;
    if (!def) throw invalid(`job must be one of ${JOB_DEFS.map((d) => d.id).join(", ")}`);
    let input;
    try {
      input = resolveJobInput(def, body.input ?? {});
    } catch (e) {
      throw invalid((e as Error).message);
    }
    const jobs = this.opened.get(row.id)?.jobs;
    if (!jobs) throw new ApiFault("unavailable", "Session is not open");
    const taskId = await c.commit(async (tx) => {
      const id = await jobs.start(tx, c.id, { def, input, startedBy: "you", now: Date.now() });
      await tx.appendEntry(c.id, { kind: "demo.job", data: { taskId: id as number, job: def.id, text: `Started ${def.title}` } });
      return id;
    }, ctx);
    h.resume();
    return { taskId: taskId as number };
  }

  /** Every job run in every open session, with where it lives: what Telegram alerts are built from. */
  async alertRuns(): Promise<{ session: SessionRow; conversationId: number; agent: string; run: JobRun }[]> {
    const out: { session: SessionRow; conversationId: number; agent: string; run: JobRun }[] = [];
    for (const [sessionId, opened] of this.opened) {
      const session = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as SessionRow | undefined;
      if (!session) continue;
      const names = this.names(sessionId);
      for (const record of await this.scanAll(opened.harness)) {
        const doc = await opened.harness.snapshot(JobRuns, record.id, ctx);
        for (const run of Object.values(doc?.items ?? {}))
          out.push({ session, conversationId: record.id as number, agent: names.get(record.id as number) ?? `#${record.id}`, run });
      }
    }
    return out;
  }

  /** Add a note to a session's team log once per key (a replayed tool call or job phase adds nothing). */
  addTeamNote(sessionId: string, n: { key: string; author: string; to: string; text: string }) {
    this.catalog
      .prepare("INSERT OR IGNORE INTO team_notes(sessionId,key,at,author,toRole,text) VALUES(?,?,?,?,?,?)")
      .run(sessionId, n.key, Date.now(), n.author, n.to, n.text);
  }

  /** The newest notes of a session's team log, oldest first; with `for`, only notes for everyone or for that role. */
  teamNotes(sessionId: string, opts: { limit: number; for?: string }): TeamNote[] {
    const rows = (
      opts.for
        ? this.catalog
            .prepare("SELECT at,author,toRole AS 'to',text FROM team_notes WHERE sessionId=? AND toRole IN ('all',?) ORDER BY at DESC, rowid DESC LIMIT ?")
            .all(sessionId, opts.for, opts.limit)
        : this.catalog.prepare("SELECT at,author,toRole AS 'to',text FROM team_notes WHERE sessionId=? ORDER BY at DESC, rowid DESC LIMIT ?").all(sessionId, opts.limit)
    ) as unknown as TeamNote[];
    return rows.reverse();
  }

  /** True when this conversation is the session's root agent and that agent leads a team (the autopilot's Lead). */
  async isLead(sessionId: string, conversationId: number) {
    const opened = this.opened.get(sessionId);
    if (!opened) return false;
    const root = await opened.harness.root(ctx);
    if ((root.id as number) !== conversationId) return false;
    return (await root.agent(ctx)).extensions.some((e) => e.name === "team");
  }

  /** Submit text to a conversation as a follow-up, idempotent by requestId (autopilot notices). */
  async submitTo(sessionId: string, conversationId: number, text: string, requestId: string) {
    const opened = this.opened.get(sessionId);
    const c = opened && (await opened.harness.conversation(conversationId as ConversationId, ctx));
    if (!c) throw Error(`Conversation ${conversationId} of session ${sessionId} is not open`);
    await c.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, ctx);
    opened.harness.resume();
  }

  /** Approve or decline a pending run by where it lives (Telegram buttons). */
  async approveRun(sessionId: string, conversationId: number, taskId: number, approved: boolean) {
    const opened = this.opened.get(sessionId);
    const c = opened && (await opened.harness.conversation(conversationId as ConversationId, ctx));
    if (!c) throw notFound("That session or agent is gone");
    return this.approveJob(c, taskId, approved);
  }

  async approveJob(c: Conversation, taskId: number, approved: unknown) {
    if (typeof approved !== "boolean") throw invalid("approved must be a boolean");
    await c.commit(async (tx) => {
      const run = (await tx.doc(JobRuns, c.id)).items[String(taskId)];
      if (!run || run.approval !== "pending") throw new ApiFault("conflict", "No pending approval for that run");
      run.approval = approved ? "approved" : "declined";
    }, ctx);
    return { ok: true as const };
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string) {
    const row = this.catalog.prepare("SELECT * FROM requests WHERE key=?").get(key) as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row) return undefined;
    if (row.route !== route) throw invalid("Idempotency-Key was already used for a different request");
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }

  remember(key: string, route: string, status: number, body: unknown) {
    this.catalog
      .prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)")
      .run(key, route, status, JSON.stringify(body), Date.now());
  }

  // ------------------------------------------------------------ lifecycle

  async close() {
    this.watcher?.stop();
    for (const { harness, unlock, unsubscribe } of this.opened.values()) {
      unsubscribe();
      try {
        await harness.close(ctx);
      } finally {
        unlock();
      }
    }
    this.opened.clear();
    await this.shared?.close();
    this.unlockShared?.();
    this.catalog.close();
    this.unlockCatalog();
  }
}

export type { Resolved };
