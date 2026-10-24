// Autopilot: the Lead hears how its durable jobs ended, without the owner relaying it.
//
// A ship the reviewer or security stopped, a ship that went live, a rollback the owner declined: each ending is
// submitted to the Lead's conversation as a short notice, once. The Lead then fixes and ships again, or reports. Only
// Lead conversations (the root agent of a session that leads a team) get notices, and only for runs it did not already
// wait on (a run_durable_job call with wait: true returns the outcome itself).
//
// The first scan after start marks runs that had already ended as seen, so a restart never replays old news.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { JobRun } from "../../anth-sdk/src/jobs.js";
import type { SessionRow } from "./store.js";

/** Jobs whose endings the Lead acts on. */
const JOBS = new Set(["ship", "rollback"]);
/**
 * A hard budget of fix-and-ship rounds. Progress, not a count, is what normally decides: rounds that each fail on a
 * different finding are progress and go on; the Lead stops and reports only when the same blocker survives
 * STUCK_REPEATS rounds in a row, or this budget is spent.
 */
export const MAX_ROUNDS = 8;
/** The same blocker this many rounds in a row means the team is stuck, not making progress. */
export const STUCK_REPEATS = 3;

/** The file:line places a failure names, to tell the same blocker from a new one. */
function places(error: string) {
  return new Set([...error.matchAll(/[\w./-]+\.[a-z]{1,5}:\d+/gi)].map((m) => m[0].toLowerCase()));
}

/** True when two failures name the same blocker: most of the same file:line places, or the same opening words. */
export function sameBlocker(a: string, b: string) {
  const pa = places(a);
  const pb = places(b);
  if (pa.size && pb.size) {
    const shared = [...pa].filter((p) => pb.has(p)).length;
    return shared / Math.min(pa.size, pb.size) >= 0.5;
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  return norm(a) === norm(b);
}

/** How many failed runs in a row, ending with this one, stopped on the same blocker (1 = a new blocker). */
export function repeatsOf(conversationRuns: JobRun[], run: JobRun) {
  const failed = conversationRuns
    .filter((r) => r.job === run.job && r.startedAt <= run.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  let n = 1;
  for (let i = failed.length - 2; i >= 0 && failed[i].status === "failed"; i--) {
    if (!sameBlocker(failed[i].error ?? "", run.error ?? "")) break;
    n++;
  }
  return n;
}

export interface AutopilotHost {
  alertRuns(): Promise<{ session: SessionRow; conversationId: number; agent: string; run: JobRun }[]>;
  /** True when this conversation is the session's root agent and it leads a team. */
  isLead(sessionId: string, conversationId: number): Promise<boolean>;
  /** Submit text to a conversation as a follow-up, idempotent by requestId. */
  submit(sessionId: string, conversationId: number, text: string, requestId: string): Promise<void>;
  subscribe(fn: () => void): () => void;
}

/** Which fix-and-ship round a run is: its job's failed runs since the last completed one, up to and including it. */
export function roundOf(conversationRuns: JobRun[], run: JobRun) {
  const mine = conversationRuns.filter((r) => r.job === run.job && r.startedAt <= run.startedAt).sort((a, b) => a.startedAt - b.startedAt);
  const lastDone = mine.map((r) => r.status).lastIndexOf("completed", run.status === "completed" ? mine.length - 2 : mine.length - 1);
  return Math.max(1, mine.slice(lastDone + 1).filter((r) => r.status === "failed").length);
}

/** The notice for a run that ended, or undefined when the Lead has nothing to do about it. */
export function notice(run: JobRun, round: number, repeats = 1): string | undefined {
  const name = `${run.title} run ${run.run}`;
  if (run.status === "failed") {
    const where = run.phases.find((p) => p.status === "failed")?.label ?? run.phase ?? "a phase";
    const stuck = repeats >= STUCK_REPEATS;
    const again =
      repeats > 1 && !stuck
        ? `This is the same blocker as the last round, so the last fix did not work. Before you ship again, find the root cause: have a developer reproduce it in a failing test first, fix it until that test passes, and have your reviewer confirm it is gone. `
        : "";
    const next = stuck
      ? `The same blocker has now stopped ${repeats} rounds in a row. Do not start it again. Report to the owner what blocks it, what you tried each round, and the one decision you need.`
      : round < MAX_ROUNDS
        ? `${again}This was round ${round} (rounds that each fix something new go on; you stop only when you are stuck on the same problem). Fix the cause yourself with the team. When a review stopped it, the full report is in the team log (team_notes, "Ship review ${run.run}"): give every Blocking item to the developers, have the tester check, ask your reviewer to confirm they are fixed, then start "${run.job}" again with the same inputs. Follow-ups do not need fixing now. Do not ask the owner first.`
        : `This was round ${round} of at most ${MAX_ROUNDS}: do not start it again. Report to the owner what blocks it, what you tried each round, and the one decision you need.`;
    return `[Automatic notice] ${name} stopped in "${where}":\n${run.error ?? "no error message"}\n\n${next}`;
  }
  if (run.status === "completed")
    return `[Automatic notice] ${name} finished: ${run.result ?? "done"}.\nReport to the owner in a few lines: what changed, how it was checked, and where it is live.`;
  if (run.status === "declined")
    return `[Automatic notice] The owner declined ${name}. Do not start it again. Report what was waiting and ask what they want changed.`;
  return undefined;
}

export class Autopilot {
  private db: DatabaseSync;
  private unsubscribe?: () => void;
  private debounce?: NodeJS.Timeout;
  private scanning?: Promise<void>;
  private dirty = false;

  constructor(
    private readonly host: AutopilotHost,
    dataDir: string,
    private readonly log: (line: string) => void = (line) => console.log(`autopilot: ${line}`),
  ) {
    this.db = new DatabaseSync(join(dataDir, "autopilot.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reported(key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  /** Watch for runs ending. */
  start() {
    this.unsubscribe = this.host.subscribe(() => this.schedule());
    this.schedule(0);
  }

  /** Stop watching and close the database. */
  async stop() {
    clearTimeout(this.debounce);
    this.unsubscribe?.();
    await this.scanning?.catch(() => {});
    this.db.close();
  }

  private schedule(delay = 500) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), delay);
  }

  /** One scan at a time; a change during a scan runs one more after it. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.dirty = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.dirty = false;
        try {
          await this.scanOnce();
        } catch (e) {
          this.log(`scan failed: ${(e as Error).message}`);
        }
      } while (this.dirty);
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  private async scanOnce() {
    const firstScan = !this.db.prepare("SELECT 1 FROM meta WHERE key='baseline'").get();
    const runs = await this.host.alertRuns();
    for (const { session, conversationId, run } of runs) {
      if (!JOBS.has(run.job) || !["failed", "completed", "declined"].includes(run.status)) continue;
      // The Lead waited on this run in its own tool call, so it already has the outcome.
      if (run.toolCallId && !run.background) continue;
      const key = `${session.id}:${conversationId}:${run.id}:${run.status}`;
      if (this.db.prepare("SELECT 1 FROM reported WHERE key=?").get(key)) continue;
      const seen = () => this.db.prepare("INSERT OR IGNORE INTO reported(key,at) VALUES(?,?)").run(key, Date.now());
      if (firstScan || !(await this.host.isLead(session.id, conversationId))) {
        seen();
        continue;
      }
      const round = roundOf(
        runs.filter((r) => r.session.id === session.id && r.conversationId === conversationId).map((r) => r.run),
        run,
      );
      const mine = runs.filter((r) => r.session.id === session.id && r.conversationId === conversationId).map((r) => r.run);
      const text = notice(run, round, run.status === "failed" ? repeatsOf(mine, run) : 1);
      if (text) await this.host.submit(session.id, conversationId, text, `autopilot:${run.id}:${run.status}`);
      // Marked after the submit (which is idempotent by requestId), so a crash in between tells the Lead once, not never.
      seen();
      if (!text) continue;
      this.log(`told the Lead of session ${session.name}: ${run.title} run ${run.run} ${run.status}`);
    }
    if (firstScan) this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('baseline',?)").run(String(Date.now()));
  }
}
