// Telegram alerts: one bot that tells you what needs you and takes your decision.
//
// What it sends to TELEGRAM_CHAT_ID:
//   - a job run waiting for approval (ship, rollback): what it is, preview and PR links, Approve / Reject buttons
//   - a job run that failed
//   - a new incident from Watch
// When a run is decided (in Telegram or in the hub) its message is edited and the buttons go away.
//
// Calls: a new incident rings at once; an approval rings once when it has waited ANTH_RING_AFTER_MIN minutes
// (default 10, "off" never). The ring comes from a second Telegram account (telegram-call.ts) or ANTH_RING_COMMAND.
//
// Only TELEGRAM_CHAT_ID can press buttons or use commands. The bot long-polls, so no public URL is needed. Run it on
// one device only (the always-on box): two backends polling one bot token make Telegram refuse the second.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Incident } from "../../anth-sdk/src/api.js";
import type { JobRun } from "../../anth-sdk/src/jobs.js";
import type { SessionRow } from "./store.js";
import { MAX_ROUNDS, STUCK_REPEATS, repeatsOf, roundOf } from "./autopilot.js";

/** What the alerts need from the store; a narrow view so tests and the store stay decoupled. */
export interface AlertsHost {
  /** Device name, shown in /start. */
  name: string;
  alertRuns(): Promise<{ session: SessionRow; conversationId: number; agent: string; run: JobRun }[]>;
  approveRun(sessionId: string, conversationId: number, taskId: number, approved: boolean): Promise<unknown>;
  incidents(): Incident[];
  /** Call fn whenever anything changes. */
  subscribe(fn: () => void): () => void;
  /** True when the conversation is a team Lead, which fixes failed ship and rollback runs itself (the autopilot). */
  isLead?(sessionId: string, conversationId: number): Promise<boolean>;
}

export interface AlertsConfig {
  token: string;
  /** Empty: setup mode, the bot answers /start with the chat id to put in .env. */
  chatId: string;
  /** Bot API base URL (tests point it at a stand-in). */
  api: string;
  /** How long an approval waits before a call; null never calls for approvals. */
  ringAfterMs: number | null;
  /** Place a call that reads or shows this text; undefined when no caller is set up. */
  ring?: (text: string) => Promise<void>;
  dataDir: string;
}

/**
 * Read the alert settings from the environment; undefined when TELEGRAM_BOT_TOKEN is not set, or when TELEGRAM_DEVICE
 * names another device (one .env feeds every device, and only one may poll the bot).
 */
export function alertsConfig(env: NodeJS.ProcessEnv, dataDir: string, device?: string): AlertsConfig | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return undefined;
  const only = env.TELEGRAM_DEVICE?.trim();
  if (only && device !== undefined && only !== device) return undefined;
  const after = (env.ANTH_RING_AFTER_MIN ?? "10").trim();
  const minutes = Number(after);
  return {
    token,
    chatId: (env.TELEGRAM_CHAT_ID ?? "").trim(),
    api: (env.ANTH_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, ""),
    ringAfterMs: after === "off" || !Number.isFinite(minutes) ? null : Math.max(0, minutes) * 60_000,
    ring: ringerFromEnv(env),
    dataDir,
  };
}

/** The call to place: ANTH_RING_COMMAND (any script, e.g. a phone call service), else the Telegram caller account. */
function ringerFromEnv(env: NodeJS.ProcessEnv): AlertsConfig["ring"] {
  const command = env.ANTH_RING_COMMAND?.trim();
  if (command)
    return (text) =>
      new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", command], { env: { ...process.env, ANTH_RING_TEXT: text }, stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(Error(`ANTH_RING_COMMAND exited with ${code}`))));
      });
  const { TELEGRAM_API_ID: id, TELEGRAM_API_HASH: hash, TELEGRAM_CALLER_SESSION: session, TELEGRAM_CALL_TO: to } = env;
  if (!id || !hash || !session || !to) return undefined;
  return async (text) => {
    const { ring } = await import("./telegram-call.js");
    await ring({ apiId: Number(id), apiHash: hash, session, to, text });
  };
}

type AlertRow = {
  id: number;
  key: string;
  kind: "approval" | "failed" | "incident";
  messageId: number | null;
  state: "open" | "closed";
  createdAt: number;
  rungAt: number | null;
  sessionId: string | null;
  conversationId: number | null;
  taskId: number | null;
};

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number } };
};

/** Escape text for Telegram's HTML parse mode. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Shorten a line for a chat message. */
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a run is about, for message text: the project, or the session name. */
const where = (session: SessionRow) => session.project ?? session.name;

/** The message for a run waiting for approval: title, where, and what the earlier phases produced. */
export function approvalText(session: SessionRow, agent: string, run: JobRun) {
  const lines = [`🟡 <b>${esc(run.title)}</b> · ${esc(where(session))} · run ${run.run}`, "Waiting for your approval."];
  for (const phase of run.phases)
    if (phase.status === "done" && phase.summary) lines.push(`• ${esc(phase.label)}: ${esc(clip(phase.summary))}`);
  lines.push(`<i>${esc(session.name)} · ${esc(agent)}</i>`);
  return lines.join("\n");
}

const DECIDED: Record<string, string> = {
  approved: "✅ Approved",
  declined: "❌ Rejected",
  cancelled: "⏹ Cancelled (the run stopped)",
};

export class Alerts {
  private db: DatabaseSync;
  private abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private scanning?: Promise<void>;
  private dirty = false;
  private ringing = Promise.resolve();

  constructor(
    private readonly host: AlertsHost,
    private readonly config: AlertsConfig,
    private readonly log: (line: string) => void = (line) => console.log(`telegram: ${line}`),
  ) {
    this.db = new DatabaseSync(join(config.dataDir, "telegram.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        messageId INTEGER, state TEXT NOT NULL, createdAt INTEGER NOT NULL, rungAt INTEGER,
        sessionId TEXT, conversationId INTEGER, taskId INTEGER);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  /** Start polling Telegram and watching the store. */
  start(intervalMs = 30_000) {
    this.unsubscribe = this.host.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(0), intervalMs);
    void this.poll();
    this.schedule(0);
    this.log(this.config.chatId ? `alerts on for chat ${this.config.chatId}` : "no TELEGRAM_CHAT_ID yet: send /start to the bot");
  }

  /** Stop polling and timers, and close the database. */
  async stop() {
    this.abort.abort();
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.unsubscribe?.();
    await this.scanning?.catch(() => {});
    await this.ringing;
    this.db.close();
  }

  /** Scan soon; many changes in a burst become one scan. */
  private schedule(delay = 400) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), delay);
  }

  /** Run one scan at a time; a change during a scan runs one more after it. */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.dirty = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.dirty = false;
        try {
          if (this.config.chatId && !this.abort.signal.aborted) await this.scanOnce();
        } catch (e) {
          this.log(`scan failed: ${(e as Error).message}`);
        }
      } while (this.dirty && !this.abort.signal.aborted);
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  private meta(key: string) {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  private alert(key: string) {
    return this.db.prepare("SELECT * FROM alerts WHERE key=?").get(key) as AlertRow | undefined;
  }
  /** Record an alert; with quiet it is only marked as seen (the first scan after setup skips old failures). */
  private insert(key: string, kind: AlertRow["kind"], fields: Partial<AlertRow>, state: AlertRow["state"] = "open") {
    this.db
      .prepare("INSERT OR IGNORE INTO alerts(key,kind,messageId,state,createdAt,sessionId,conversationId,taskId) VALUES(?,?,?,?,?,?,?,?)")
      .run(key, kind, fields.messageId ?? null, state, Date.now(), fields.sessionId ?? null, fields.conversationId ?? null, fields.taskId ?? null);
    return this.alert(key)!;
  }

  /** Compare what needs you now with what was already sent, and send, edit or call. */
  private async scanOnce() {
    const firstScan = this.meta("baseline") === undefined;
    const firstCompletedScan = this.meta("completedBaseline") === undefined;
    const runs = await this.host.alertRuns();
    const byRun = new Map(runs.map((r) => [`${r.session.id}:${r.conversationId}:${r.run.id}`, r]));

    for (const { session, conversationId, agent, run } of runs) {
      const at = `${session.id}:${conversationId}:${run.id}`;
      if (run.approval === "pending") {
        const key = `approval:${at}:${run.phase ?? ""}`;
        if (this.alert(key)) continue;
        // Insert first: the button's callback data names this row, and a crash after sending must not send twice.
        const row = this.insert(key, "approval", { sessionId: session.id, conversationId, taskId: run.id });
        try {
          const msg = await this.send(approvalText(session, agent, run), [
            [
              { text: "✅ Approve", callback_data: `ap:${row.id}:1` },
              { text: "❌ Reject", callback_data: `ap:${row.id}:0` },
            ],
          ]);
          this.db.prepare("UPDATE alerts SET messageId=? WHERE id=?").run(msg.message_id, row.id);
        } catch (e) {
          // Not delivered: forget it so the next scan tries again.
          this.db.prepare("DELETE FROM alerts WHERE id=?").run(row.id);
          throw e;
        }
      } else if (run.status === "failed") {
        const key = `failed:${at}`;
        if (this.alert(key)) continue;
        if (firstScan) {
          this.insert(key, "failed", {}, "closed");
          continue;
        }
        this.insert(key, "failed", {}, "closed");
        // A team Lead fixes failed ship and rollback runs itself: say it is on it, and only call it a failure when the
        // last round is used up.
        const lead = ["ship", "rollback"].includes(run.job) && (await this.host.isLead?.(session.id, conversationId));
        const mine = runs.filter((r) => r.session.id === session.id && r.conversationId === conversationId).map((r) => r.run);
        const round = lead ? roundOf(mine, run) : 0;
        const stuck = lead && repeatsOf(mine, run) >= STUCK_REPEATS;
        if (lead && !stuck && round < MAX_ROUNDS)
          await this.send(
            `🔧 <b>${esc(run.title)} stopped</b> · ${esc(where(session))}\nThe Lead is fixing it (round ${round}). You'll hear when it's ready for approval, or if it needs you.\n<i>${esc(clip(run.error ?? "", 300))}</i>`,
          );
        else
          await this.send(
            `🔴 <b>${esc(run.title)} failed</b> · ${esc(where(session))}${stuck ? " · stuck on the same problem; the Lead will report what blocks it" : lead ? ` · the Lead used all ${MAX_ROUNDS} rounds and will report what blocks it` : ""}\n${esc(clip(run.error ?? "No error message", 600))}`,
          );
      } else if (run.status === "completed" && ["ship", "rollback"].includes(run.job)) {
        const key = `completed:${at}`;
        if (this.alert(key)) continue;
        this.insert(key, "failed", {}, "closed");
        // "Done" messages came later than the first baseline: on an upgraded install, runs that went live before them
        // are old news too, so their own baseline is set after the first scan that knows about them.
        if (!firstScan && !firstCompletedScan) await this.send(`✅ <b>${esc(run.title)} done</b> · ${esc(where(session))}\n${esc(clip(run.result ?? "", 400))}`);
      }
    }

    // Approvals decided elsewhere (the hub, or the run stopped): edit the message so the buttons go away.
    for (const row of this.db.prepare("SELECT * FROM alerts WHERE kind='approval' AND state='open'").all() as AlertRow[]) {
      const live = byRun.get(`${row.sessionId}:${row.conversationId}:${row.taskId}`);
      if (live?.run.approval === "pending" && row.key.endsWith(`:${live.run.phase ?? ""}`)) continue;
      const decided = live?.run.approval && live.run.approval !== "pending" ? DECIDED[live.run.approval] : undefined;
      await this.close(row, decided ? `${decided} in the hub` : "⏹ No longer waiting");
    }

    for (const incident of this.host.incidents()) {
      if (incident.status === "needs-you") {
        const key = `incident:${incident.id}:needs-you`;
        if (!this.alert(key)) {
          const row = this.insert(key, "incident", {}, "closed");
          if (!firstScan) {
            await this.send(`🙋 <b>Incident #${incident.id} needs you</b> · ${esc(incident.project)}\n${esc(clip(incident.note ?? incident.title, 600))}`);
            this.ring(row, `Incident on ${incident.project} needs you`);
          }
        }
      }
      if (incident.status === "resolved") continue;
      const key = `incident:${incident.id}`;
      if (this.alert(key)) continue;
      if (firstScan) {
        this.insert(key, "incident", {}, "closed");
        continue;
      }
      const row = this.insert(key, "incident", {}, "closed");
      await this.send(
        `🚨 <b>Incident #${incident.id}</b> · ${esc(incident.project)}\n${esc(clip(incident.title, 400))}\nThe incident agent is on it. A proven fix comes back here for your approval.`,
      );
      this.ring(row, `Incident on ${incident.project}: ${incident.title}`);
    }

    // Approvals that waited too long get one call.
    if (this.config.ringAfterMs !== null) {
      const due = Date.now() - this.config.ringAfterMs;
      for (const row of this.db
        .prepare("SELECT * FROM alerts WHERE kind='approval' AND state='open' AND rungAt IS NULL AND createdAt<=?")
        .all(due) as AlertRow[]) {
        const live = byRun.get(`${row.sessionId}:${row.conversationId}:${row.taskId}`);
        if (live) this.ring(row, `${live.run.title} on ${where(live.session)} is waiting for your approval`);
      }
    }

    if (firstScan) this.setMeta("baseline", String(Date.now()));
    if (firstCompletedScan) this.setMeta("completedBaseline", String(Date.now()));
  }

  /** Tell the owner about a problem only they can fix, at most once per key every six hours. */
  async problem(key: string, text: string) {
    if (!this.config.chatId) return;
    const last = Number(this.meta(`problem:${key}`) ?? 0);
    if (Date.now() - last < 6 * 3600_000) return;
    this.setMeta(`problem:${key}`, String(Date.now()));
    await this.send(`⚠️ <b>Needs you</b>\n${esc(clip(text, 700))}`).catch((e) => this.log(`problem alert failed: ${(e as Error).message}`));
  }

  /** Call once for this alert, one call at a time; say in the chat that a call is coming or why it could not. */
  private ring(row: AlertRow, text: string) {
    this.db.prepare("UPDATE alerts SET rungAt=? WHERE id=?").run(Date.now(), row.id);
    const ring = this.config.ring;
    if (!ring) return;
    this.ringing = this.ringing.then(async () => {
      try {
        await this.send(`📞 Calling you: ${esc(text)}`);
        await ring(text);
      } catch (e) {
        this.log(`call failed: ${(e as Error).message}`);
        await this.send(`📞 The call failed: ${esc(clip((e as Error).message))}`).catch(() => {});
      }
    });
  }

  /** Mark an approval alert decided and replace its buttons with the outcome. */
  private async close(row: AlertRow, outcome: string) {
    this.db.prepare("UPDATE alerts SET state='closed' WHERE id=?").run(row.id);
    if (row.messageId === null) return;
    await this.call("editMessageReplyMarkup", { chat_id: this.config.chatId, message_id: row.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await this.send(outcome, undefined, row.messageId).catch(() => {});
  }

  // ------------------------------------------------------------ Telegram Bot API

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.config.api}/bot${this.config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!json.ok) throw Object.assign(Error(`${method}: ${json.description ?? "failed"}`), { code: json.error_code ?? res.status });
    return json.result;
  }

  /** Send an HTML message to the alerts chat, optionally with buttons or as a reply. */
  private send(text: string, buttons?: { text: string; callback_data: string }[][], replyTo?: number) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.config.chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  /** Long-poll for button presses and commands until stopped. */
  private async poll() {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        const offset = Number(this.meta("offset") ?? 0);
        const updates = await this.call<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, signal);
        for (const u of updates) {
          this.setMeta("offset", String(u.update_id + 1));
          await this.handle(u).catch((e) => this.log(`update failed: ${(e as Error).message}`));
        }
      } catch (e) {
        if (signal.aborted) return;
        const code = (e as { code?: number }).code;
        this.log(code === 409 ? "another backend is polling this bot token; run alerts on one device only" : `poll failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(u: Update) {
    const allowed = (chat: number) => this.config.chatId !== "" && String(chat) === this.config.chatId;
    if (u.message) {
      const chat = u.message.chat.id;
      const text = (u.message.text ?? "").trim();
      if (!this.config.chatId && text.startsWith("/start")) {
        await this.call("sendMessage", { chat_id: chat, text: `Your chat id is ${chat}. Put TELEGRAM_CHAT_ID=${chat} in .env and restart the backend.` });
        return;
      }
      if (!allowed(chat)) return;
      if (text.startsWith("/status")) await this.send(await this.status());
      else if (text.startsWith("/start")) await this.send(`Anth-Agent alerts are on for <b>${esc(this.host.name)}</b>. /status shows what is waiting.`);
      return;
    }
    const q = u.callback_query;
    if (!q) return;
    const answer = (text: string) => this.call("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
    if (!q.message || !allowed(q.message.chat.id) || !allowed(q.from.id)) return answer("Not allowed");
    const m = /^ap:(\d+):([01])$/.exec(q.data ?? "");
    const row = m && (this.db.prepare("SELECT * FROM alerts WHERE id=?").get(Number(m[1])) as AlertRow | undefined);
    if (!m || !row || row.kind !== "approval") return answer("Unknown button");
    if (row.state !== "open") return answer("Already decided");
    const approved = m[2] === "1";
    try {
      await this.host.approveRun(row.sessionId!, row.conversationId!, row.taskId!, approved);
    } catch (e) {
      await answer(clip((e as Error).message, 180));
      await this.close(row, "⏹ No longer waiting");
      return;
    }
    await answer(approved ? "Approved" : "Rejected");
    await this.close(row, approved ? `${DECIDED.approved} in Telegram` : `${DECIDED.declined} in Telegram`);
  }

  /** What is waiting right now, for /status. */
  private async status() {
    const lines: string[] = [];
    for (const { session, run } of await this.host.alertRuns())
      if (run.approval === "pending") lines.push(`🟡 ${esc(run.title)} · ${esc(where(session))} waits for approval`);
      else if (run.status === "running" || run.status === "waiting") lines.push(`⏳ ${esc(run.title)} · ${esc(where(session))} is ${run.status}`);
    for (const i of this.host.incidents()) if (i.status !== "resolved") lines.push(`🚨 Incident #${i.id} · ${esc(i.project)}: ${esc(clip(i.title, 120))}`);
    return lines.length ? lines.join("\n") : "Nothing is waiting for you.";
  }
}
