// Watch and fix: watch each live project, let Jev judge every event, and open an incident when judgments cluster.
//
// Code owns the sources, the thresholds and the side effects; Jev owns one bounded judgment per event. Sources, every
// tick (one minute by default):
//   vercel-log, vercel-request  `vercel logs` for production runtime errors and 5xx requests, since the last tick
//   uptime                      GET the production URL and each watched path
//   webhook                     events POSTed by other services to /hooks/<client>/<project>/<secret>, any time
//
// Rule: three incident verdicts with one fingerprint within ten minutes (two for uptime) open one incident. Later
// events with that fingerprint attach to it while it is unresolved. The store turns an incident into an incident agent.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Incident,
  IncidentStatus,
  UpsertWatchBody,
  WatchEvent,
  WatchInfo,
  WatchSource,
  WatchVerdict,
} from "../../anth-sdk/src/api.js";
import { askJev, type JevAnswer, type JevQuestion } from "./jev.js";
import { runEffect } from "./jobs.js";
import { invalid, notFound } from "./errors.js";

export const WINDOW_MS = 10 * 60_000;
const THRESHOLD = 3;
const UPTIME_THRESHOLD = 2;
const SLOW_MS = 8000;
const KEEP_EVENTS_MS = 7 * 24 * 3600_000;
const MAX_HOOK_EVENTS_PER_MIN = 120;

export const QUESTIONS: Record<string, JevQuestion> = {
  verdict: {
    type: "choice",
    instructions:
      "You watch the production of a small business's website or web app built by Anthward. Decide what this one event means for the engineer on call.",
    criteria: {
      normal:
        "Routine or expected: bots probing paths that do not exist, a single expected client error, deploy and build notices, debug output.",
      suspicious: "Worth a look but not clearly broken: a slow response, a recovered timeout, an unusual warning.",
      incident:
        "Our code or hosting is failing real visitors: unhandled exceptions, stack traces, 5xx responses, the site or a key page down, a form or checkout that cannot complete.",
    },
  },
  impact: {
    type: "noul",
    instructions: "How much does this event show real visitors or the business being hurt?",
    criteria: { true: "Visitors are blocked from a core flow or the site is down", false: "No visitor is affected" },
  },
};

type WatchRow = {
  project: string;
  sessionId: string;
  path: string;
  url: string;
  paths: string;
  vercel: number;
  secret: string;
  enabled: number;
  cursor: string | null;
  lastTickAt: number | null;
  lastError: string | null;
  createdAt: number;
};

/** What the watcher needs from the store: the catalog, sessions, and turning incidents into agents. */
export interface WatchHost {
  db: DatabaseSync;
  /** Judge with rules instead of Jev (the faux provider, tests). */
  offline: boolean;
  /** A session's working directory, or undefined when the session is gone. */
  sessionCwd(sessionId: string): string | undefined;
  /** Start (or resume) the incident agent for a new incident. */
  openIncident(incident: Incident, samples: WatchEvent[]): Promise<void>;
  /** The status of the ship run an incident started, if any. */
  shipStatus(incident: Incident): Promise<string | undefined>;
  notify(): void;
}

/** Groups events that share a cause: source, path and the message shape without numbers, ids and hashes. */
export function fingerprint(e: Pick<WatchEvent, "source" | "message" | "path" | "status">) {
  const shape = e.message
    .split("\n")[0]
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const where = e.path ? e.path.replace(/\/\d+(?=\/|$)/g, "/#").replace(/\?.*$/, "") : "";
  return [e.source === "vercel-request" || e.source === "vercel-log" ? "vercel" : e.source, where, e.status ? `HTTP ${e.status}` : shape]
    .filter(Boolean)
    .join(" · ");
}

/** Rules for when Jev is offline or unreachable: failures are incidents, warnings suspicious, the rest normal. */
export function judgeOffline(e: WatchEvent): { verdict: WatchVerdict; impact: number } {
  // A slow page is worth a look; a page that is down or failing is an incident.
  if (e.source === "uptime") return /^warn/i.test(e.level ?? "") ? { verdict: "suspicious", impact: 0.3 } : { verdict: "incident", impact: 0.9 };
  if (e.status !== undefined && e.status >= 500) return { verdict: "incident", impact: 0.7 };
  if (/^(error|fatal|critical)$/i.test(e.level ?? "")) return { verdict: "incident", impact: 0.6 };
  if (/^warn/i.test(e.level ?? "") || (e.status !== undefined && e.status >= 400)) return { verdict: "suspicious", impact: 0.2 };
  return { verdict: "normal", impact: 0 };
}

/** A short stable id for content without one. */
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
/** A number from a number or numeric string. */
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
/** A non-empty string, or undefined. */
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
/** Milliseconds from seconds, milliseconds or an ISO date; now when unreadable. */
const time = (v: unknown) => {
  const n = num(v);
  if (n !== undefined) return n < 1e12 ? n * 1000 : n;
  const parsed = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

/** One `vercel logs --json` line as an event, or undefined for the summary line and anything unreadable. */
export function vercelEvent(line: string): Omit<WatchEvent, "fingerprint"> | undefined {
  let parsed: { type?: string; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if ((parsed.type !== "log" && parsed.type !== "request") || !parsed.data) return undefined;
  const d = parsed.data;
  const status = num(d.httpStatus ?? d.statusCode ?? d.responseStatusCode ?? d.status);
  const path = str(d.requestPath ?? d.path ?? d.pathname ?? d.url);
  const method = str(d.requestMethod ?? d.method);
  const message =
    str(d.message) ?? (status !== undefined ? `${method ?? "GET"} ${path ?? "/"} → ${status}` : JSON.stringify(d).slice(0, 300));
  return {
    id: `vercel:${str(d.id) ?? str(d.requestId) ?? hash(line)}${parsed.type === "request" ? ":r" : ""}`,
    source: parsed.type === "request" ? "vercel-request" : "vercel-log",
    at: time(d.timestamp ?? d.time ?? d.date),
    level: str(d.level) ?? (status !== undefined && status >= 500 ? "error" : undefined),
    message: message.slice(0, 2000),
    ...(path ? { path } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** A webhook body (Sentry, a generic {message, level}, or anything else) as an event. */
export function webhookEvent(body: Record<string, unknown>, at = Date.now()): Omit<WatchEvent, "fingerprint"> {
  const data = (body.data ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const nested = data.event ?? data.issue ?? (body.event as Record<string, unknown> | undefined) ?? {};
  const message =
    str(body.message) ?? str(body.title) ?? str(nested.title) ?? str(nested.message) ?? str(body.text) ?? JSON.stringify(body).slice(0, 300);
  const path = str(body.path) ?? str(body.url) ?? str(nested.culprit) ?? str((nested.request as Record<string, unknown> | undefined)?.url);
  const status = num(body.status ?? body.statusCode);
  return {
    id: `webhook:${str(body.id) ?? str(nested.id) ?? str(nested.event_id) ?? hash(`${at}:${message}`)}`,
    source: "webhook",
    at,
    level: str(body.level) ?? str(nested.level) ?? "error",
    message: message.slice(0, 2000),
    ...(path ? { path } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** A watch_events row as a WatchEvent, without null columns. */
function toEvent(r: Record<string, unknown>): WatchEvent {
  const e: WatchEvent = { id: r.id as string, source: r.source as WatchSource, at: r.at as number, message: r.message as string, fingerprint: r.fingerprint as string };
  if (r.level) e.level = r.level as string;
  if (r.path) e.path = r.path as string;
  if (r.status !== null && r.status !== undefined) e.status = r.status as number;
  if (r.verdict) e.verdict = r.verdict as WatchVerdict;
  if (r.impact !== null && r.impact !== undefined) e.impact = r.impact as number;
  if (r.incident !== null && r.incident !== undefined) e.incident = r.incident as number;
  return e;
}

/** An incidents row as an Incident, without null columns. */
const toIncident = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as Incident;

/** Quote a value for bash. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export class Watcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private hookCounts = new Map<string, { minute: number; n: number }>();

  constructor(private readonly host: WatchHost) {
    host.db.exec(`CREATE TABLE IF NOT EXISTS watches(project TEXT PRIMARY KEY,sessionId TEXT NOT NULL,path TEXT NOT NULL,url TEXT NOT NULL,paths TEXT NOT NULL,vercel INTEGER NOT NULL,secret TEXT NOT NULL,enabled INTEGER NOT NULL,cursor TEXT,lastTickAt INTEGER,lastError TEXT,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_events(id TEXT NOT NULL,project TEXT NOT NULL,source TEXT NOT NULL,at INTEGER NOT NULL,level TEXT,message TEXT NOT NULL,path TEXT,status INTEGER,fingerprint TEXT NOT NULL,verdict TEXT,impact REAL,incident INTEGER,PRIMARY KEY(project,id));
      CREATE INDEX IF NOT EXISTS watch_events_at ON watch_events(project,at);
      CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT NOT NULL,fingerprint TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,openedAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,sessionId TEXT NOT NULL,conversationId INTEGER,worktree TEXT,branch TEXT,base TEXT,events INTEGER NOT NULL,shipTaskId INTEGER,note TEXT);`);
  }

  /** Tick every `intervalMs`; 0 leaves ticking to `tick()` calls (tests, the Check now button). */
  start(intervalMs: number) {
    if (intervalMs > 0) this.timer = setInterval(() => void this.tickAll(), intervalMs);
  }

  /** Stop ticking. */
  stop() {
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- configuration

  /** The stored watch row for a project. */
  private row(project: string) {
    return this.host.db.prepare("SELECT * FROM watches WHERE project=?").get(project) as WatchRow | undefined;
  }

  /** A watch row as the API shows it. */
  private info(r: WatchRow): WatchInfo {
    const [client, slug] = r.project.split("/");
    return {
      project: r.project,
      enabled: !!r.enabled,
      sessionId: r.sessionId,
      path: r.path,
      url: r.url,
      paths: JSON.parse(r.paths) as string[],
      vercel: !!r.vercel,
      webhookPath: `/hooks/${client}/${slug}/${r.secret}`,
      ...(r.lastTickAt ? { lastTickAt: r.lastTickAt } : {}),
      ...(r.lastError ? { lastError: r.lastError } : {}),
    };
  }

  /** The watch on a project; `404` when this device does not watch it. */
  get(project: string): WatchInfo {
    const r = this.row(project);
    if (!r) throw notFound(`${project} is not watched on this device`);
    return this.info(r);
  }

  /** Summary for the device tree: whether the project is watched and how many incidents are unresolved. */
  summary(project: string) {
    const r = this.row(project);
    if (!r) return undefined;
    const open = (
      this.host.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE project=? AND status!='resolved'").get(project) as { n: number }
    ).n;
    return { enabled: !!r.enabled, openIncidents: open };
  }

  /** PUT …/watch: start watching or change the settings; the webhook secret stays the same. */
  upsert(project: string, body: UpsertWatchBody) {
    const b = (body ?? {}) as unknown as Record<string, unknown>;
    const current = this.row(project);
    const sessionId = str(b.sessionId) ?? current?.sessionId;
    if (!sessionId || !this.host.sessionCwd(sessionId)) throw invalid("sessionId must be a session on this device");
    const url = str(b.url) ?? current?.url;
    if (!url || !/^https?:\/\//.test(url)) throw invalid("url must be the production URL, e.g. https://example.com");
    const paths = b.paths ?? (current ? JSON.parse(current.paths) : ["/"]);
    if (!Array.isArray(paths) || !paths.length || paths.length > 20 || !paths.every((p) => typeof p === "string" && p.startsWith("/")))
      throw invalid("paths must be 1 to 20 paths starting with /");
    const path = str(b.path) ?? current?.path ?? ".";
    if (path.includes("\0")) throw invalid("Invalid path");
    const vercel = b.vercel === undefined ? (current ? !!current.vercel : true) : b.vercel === true;
    const enabled = b.enabled === undefined ? (current ? !!current.enabled : true) : b.enabled === true;
    this.host.db
      .prepare(
        `INSERT INTO watches(project,sessionId,path,url,paths,vercel,secret,enabled,createdAt) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project) DO UPDATE SET sessionId=excluded.sessionId,path=excluded.path,url=excluded.url,paths=excluded.paths,vercel=excluded.vercel,enabled=excluded.enabled`,
      )
      .run(project, sessionId, path, url.replace(/\/+$/, ""), JSON.stringify(paths), vercel ? 1 : 0, current?.secret ?? randomBytes(18).toString("base64url"), enabled ? 1 : 0, Date.now());
    this.host.notify();
    return this.get(project);
  }

  /** DELETE …/watch: stop watching. Events and incidents stay. */
  remove(project: string) {
    this.host.db.prepare("DELETE FROM watches WHERE project=?").run(project);
    this.host.notify();
    return { removed: project };
  }

  /** The newest events of a project, newest first. */
  events(project: string, limit = 100): WatchEvent[] {
    const rows = this.host.db
      .prepare("SELECT * FROM watch_events WHERE project=? ORDER BY at DESC LIMIT ?")
      .all(project, Math.min(Math.max(1, limit), 500)) as Record<string, unknown>[];
    return rows.map(toEvent);
  }

  /** Incidents, newest first: one project's, or the whole device's. */
  incidents(project?: string): Incident[] {
    const rows = (
      project
        ? this.host.db.prepare("SELECT * FROM incidents WHERE project=? ORDER BY id DESC LIMIT 100").all(project)
        : this.host.db.prepare("SELECT * FROM incidents ORDER BY id DESC LIMIT 100").all()
    ) as Record<string, unknown>[];
    return rows.map(toIncident);
  }

  /** One incident by id. */
  incident(id: number): Incident | undefined {
    const r = this.host.db.prepare("SELECT * FROM incidents WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? toIncident(r) : undefined;
  }

  /** The incident an incident agent works on. */
  incidentForConversation(sessionId: string, conversationId: number): Incident | undefined {
    const r = this.host.db.prepare("SELECT * FROM incidents WHERE sessionId=? AND conversationId=?").get(sessionId, conversationId) as
      | Record<string, unknown>
      | undefined;
    return r ? toIncident(r) : undefined;
  }

  /** Change an incident's status or links and tell the clients. */
  updateIncident(id: number, fields: Partial<Pick<Incident, "status" | "conversationId" | "worktree" | "branch" | "base" | "shipTaskId" | "note">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.host.db
      .prepare(`UPDATE incidents SET ${keys.map((k) => `${k}=?`).join(",")},updatedAt=? WHERE id=?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null), Date.now(), id);
    this.host.notify();
  }

  // ---------------------------------------------------------------- events

  /** Store events, ignoring ones seen before. Returns how many were new. */
  record(project: string, events: Omit<WatchEvent, "fingerprint">[]) {
    const insert = this.host.db.prepare(
      "INSERT OR IGNORE INTO watch_events(id,project,source,at,level,message,path,status,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    let added = 0;
    for (const e of events)
      added += Number(
        insert.run(e.id, project, e.source, e.at, e.level ?? null, e.message, e.path ?? null, e.status ?? null, fingerprint(e)).changes,
      );
    return added;
  }

  /** POST /hooks/<client>/<project>/<secret>. Unknown project or wrong secret is a 404, so the URL reveals nothing. */
  hook(client: string, slug: string, secret: string, body: unknown) {
    const project = `${client}/${slug}`;
    const r = this.row(project);
    const given = Buffer.from(secret);
    const expected = Buffer.from(r?.secret ?? "");
    if (!r || given.length !== expected.length || !given.equals(expected)) throw notFound("Not found");
    const minute = Math.floor(Date.now() / 60_000);
    const count = this.hookCounts.get(project);
    const n = count?.minute === minute ? count.n : 0;
    const items = (Array.isArray(body) ? body : [body]).filter((b) => b && typeof b === "object") as Record<string, unknown>[];
    if (!items.length) throw invalid("Send a JSON object or an array of objects");
    if (n + items.length > MAX_HOOK_EVENTS_PER_MIN) throw invalid("Too many events this minute");
    this.hookCounts.set(project, { minute, n: n + items.length });
    const added = this.record(project, items.map((b) => webhookEvent(b)));
    // Judge right away instead of waiting for the next tick.
    void this.process(project).catch((e) => console.error("[watch]", e));
    return { accepted: items.length, new: added };
  }

  // ---------------------------------------------------------------- the tick

  /** One tick for every enabled watch, then drop events older than a week. */
  async tickAll() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = this.host.db.prepare("SELECT project FROM watches WHERE enabled=1").all() as { project: string }[];
      for (const { project } of rows) await this.tick(project).catch((e) => console.error("[watch]", project, e));
      this.host.db.prepare("DELETE FROM watch_events WHERE at < ?").run(Date.now() - KEEP_EVENTS_MS);
    } finally {
      this.running = false;
    }
  }

  /** One tick for one project: collect from every source, judge, apply the rule, follow incidents. */
  async tick(project: string) {
    const r = this.row(project);
    if (!r) throw notFound(`${project} is not watched on this device`);
    const started = Date.now();
    const errors: string[] = [];
    const events: Omit<WatchEvent, "fingerprint">[] = [];
    for (const path of JSON.parse(r.paths) as string[]) {
      const event = await this.check(r.url, path, started);
      if (event) events.push(event);
    }
    if (r.vercel) {
      try {
        events.push(...(await this.vercel(r)));
      } catch (e) {
        errors.push(String((e as Error).message ?? e));
      }
    }
    this.record(project, events);
    await this.process(project);
    this.host.db
      .prepare("UPDATE watches SET lastTickAt=?,lastError=?,cursor=? WHERE project=?")
      .run(started, errors.length ? errors.join(" · ").slice(0, 500) : null, r.vercel && !errors.length ? new Date(started).toISOString() : r.cursor, project);
    this.host.notify();
    return { events: events.length, errors };
  }

  /** GET one production path; an event when it is down, 5xx or slow. */
  private async check(url: string, path: string, at: number): Promise<Omit<WatchEvent, "fingerprint"> | undefined> {
    const target = `${url}${path}`;
    const start = Date.now();
    try {
      const res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel();
      const ms = Date.now() - start;
      if (res.status >= 500) return { id: `uptime:${path}:${at}`, source: "uptime", at, level: "error", message: `GET ${path} answered ${res.status}`, path, status: res.status };
      if (ms > SLOW_MS) return { id: `uptime:${path}:${at}`, source: "uptime", at, level: "warning", message: `GET ${path} took ${ms} ms`, path };
      return undefined;
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? "timed out" : String((e as Error).cause ?? (e as Error).message ?? e).slice(0, 120);
      return { id: `uptime:${path}:${at}`, source: "uptime", at, level: "error", message: `GET ${path} failed: ${why}`, path };
    }
  }

  /** Production runtime errors and 5xx requests since the last tick, from the Vercel CLI with the device's token. */
  private async vercel(r: WatchRow) {
    const token = process.env.VERCEL_TOKEN?.trim();
    if (!token) throw Error("VERCEL_TOKEN is not set on this device, so Vercel logs are not read");
    const cwd = this.host.sessionCwd(r.sessionId);
    if (!cwd) throw Error("The watch session is gone");
    const dir = r.path === "." ? cwd : `${cwd}/${r.path}`;
    const bin = process.env.ANTH_VERCEL_BIN?.trim() || "vercel";
    const scope = process.env.VERCEL_SCOPE?.trim() ? ` --scope ${q(process.env.VERCEL_SCOPE.trim())}` : "";
    const since = r.cursor ?? new Date(Date.now() - 5 * 60_000).toISOString();
    const out: Omit<WatchEvent, "fingerprint">[] = [];
    for (const [kind, query] of [
      ["runtime", "level:error OR level:fatal"],
      ["requests", "httpStatus >= 500"],
    ]) {
      const command = `${bin} logs ${kind} --environment production --query ${q(query)} --since ${q(since)} --limit 500 --json --token "$VERCEL_TOKEN"${scope}`;
      const result = await runEffect(command, dir, { VERCEL_TOKEN: token }, 120);
      if (result.code !== 0) throw Error(`vercel logs ${kind}: ${result.out.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
      for (const line of result.out.split("\n")) {
        const e = vercelEvent(line.trim());
        if (e) out.push(e);
      }
    }
    return out;
  }

  /** Judge unjudged events, apply the rule, and follow incidents that are shipping. */
  async process(project: string) {
    const pending = this.host.db
      .prepare("SELECT * FROM watch_events WHERE project=? AND verdict IS NULL ORDER BY at LIMIT 100")
      .all(project) as Record<string, unknown>[];
    for (const row of pending) {
      const e = toEvent(row);
      const { verdict, impact } = await this.judge(e);
      this.host.db.prepare("UPDATE watch_events SET verdict=?,impact=? WHERE project=? AND id=?").run(verdict, impact, project, e.id);
    }
    await this.apply(project);
    await this.follow(project);
  }

  /** Jev's verdict and impact for one event, or the offline rules. */
  private async judge(e: WatchEvent): Promise<{ verdict: WatchVerdict; impact: number }> {
    if (this.host.offline) return judgeOffline(e);
    try {
      const state = { source: e.source, level: e.level, path: e.path, status: e.status, message: e.message.slice(0, 1500) };
      const a = await askJev(state, QUESTIONS);
      const choice = a.verdict as Extract<JevAnswer, { type: "choice" }>;
      const impact = (a.impact as Extract<JevAnswer, { type: "noul" }>).noul;
      const verdict = (["normal", "suspicious", "incident"] as const).find((v) => v === choice.choice) ?? "suspicious";
      return { verdict, impact };
    } catch {
      // Jev unreachable: rules still catch outages and 5xx, so a Jev outage never hides a real incident.
      return judgeOffline(e);
    }
  }

  /** Open an incident for each fingerprint that crossed the threshold, or attach new events to its open incident. */
  private async apply(project: string) {
    const since = Date.now() - WINDOW_MS;
    // Only events no incident has claimed, and only ones newer than the last resolved incident with that fingerprint:
    // errors from before a fix went live (or reported late) must not reopen a bug that is already fixed.
    const fresh = `project=? AND fingerprint=? AND verdict='incident' AND incident IS NULL AND at>=? AND at > COALESCE((SELECT MAX(updatedAt) FROM incidents i WHERE i.project=watch_events.project AND i.fingerprint=watch_events.fingerprint AND i.status='resolved'), 0)`;
    const groups = this.host.db
      .prepare(
        `SELECT fingerprint, MIN(source) AS source, COUNT(*) AS n FROM watch_events WHERE project=? AND verdict='incident' AND incident IS NULL AND at>=?
         AND at > COALESCE((SELECT MAX(updatedAt) FROM incidents i WHERE i.project=watch_events.project AND i.fingerprint=watch_events.fingerprint AND i.status='resolved'), 0)
         GROUP BY fingerprint`,
      )
      .all(project, since) as { fingerprint: string; source: string; n: number }[];
    for (const g of groups) {
      const open = this.host.db
        .prepare("SELECT * FROM incidents WHERE project=? AND fingerprint=? AND status!='resolved' ORDER BY id DESC LIMIT 1")
        .get(project, g.fingerprint) as Incident | undefined;
      if (open) {
        const attached = this.host.db
          .prepare("UPDATE watch_events SET incident=? WHERE project=? AND fingerprint=? AND verdict='incident' AND incident IS NULL")
          .run(open.id, project, g.fingerprint).changes;
        if (attached) this.host.db.prepare("UPDATE incidents SET events=events+?,updatedAt=? WHERE id=?").run(attached, Date.now(), open.id);
        continue;
      }
      if (g.n < (g.source === "uptime" ? UPTIME_THRESHOLD : THRESHOLD)) continue;
      const r = this.row(project);
      if (!r) return;
      const samples = (
        this.host.db.prepare(`SELECT * FROM watch_events WHERE ${fresh} ORDER BY at`).all(project, g.fingerprint, since) as Record<string, unknown>[]
      ).map(toEvent);
      const now = Date.now();
      const id = Number(
        this.host.db
          .prepare("INSERT INTO incidents(project,fingerprint,title,status,openedAt,updatedAt,sessionId,events) VALUES(?,?,?,?,?,?,?,?)")
          .run(project, g.fingerprint, samples[0].message.split("\n")[0].slice(0, 120), "fixing", now, now, r.sessionId, samples.length)
          .lastInsertRowid,
      );
      this.host.db.prepare(`UPDATE watch_events SET incident=? WHERE ${fresh}`).run(id, project, g.fingerprint, since);
      this.host.notify();
      try {
        await this.host.openIncident(this.incident(id)!, samples);
      } catch (e) {
        this.updateIncident(id, { status: "needs-you", note: `Could not start the incident agent: ${String((e as Error).message ?? e).slice(0, 300)}` });
      }
    }
  }

  /** Resolve incidents whose ship run completed; flag the ones whose ship was declined or failed. */
  private async follow(project: string) {
    for (const incident of this.incidents(project).filter((i) => i.status === "shipping")) {
      const status = await this.host.shipStatus(incident);
      const next: IncidentStatus | undefined =
        status === "completed" ? "resolved" : status && ["failed", "declined", "aborted"].includes(status) ? "needs-you" : undefined;
      if (next) this.updateIncident(incident.id, { status: next, note: `Ship run ${status}` });
    }
  }
}
