// Telegram alerts against a stand-in Bot API: what is sent, who may press the buttons, decisions made elsewhere,
// failures and incidents (old ones skipped on first start), and calls. Then the real backend: a button press approves
// a durable job run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Incident } from "../../anth-sdk/src/api.js";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { Alerts, alertsConfig, type AlertsHost } from "../src/telegram.js";
import type { SessionRow } from "../src/store.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const CHAT = 4242;
type Call = { method: string; body: Record<string, unknown> };

/** A stand-in for api.telegram.org: records every call and hands out queued updates to getUpdates. */
async function fakeTelegram(token: string) {
  const calls: Call[] = [];
  const queue: unknown[] = [];
  let nextId = 1;
  let messageId = 100;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const [, bot, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "") ?? [];
    res.setHeader("content-type", "application/json");
    if (bot !== token) return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    if (method === "getUpdates") {
      for (let i = 0; i < 20 && !queue.length; i++) await new Promise((r) => setTimeout(r, 50));
      const updates = queue.splice(0).map((u) => ({ update_id: nextId++, ...(u as object) }));
      return res.end(JSON.stringify({ ok: true, result: updates }));
    }
    calls.push({ method, body });
    res.end(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: ++messageId } : true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    api,
    calls,
    /** Messages sent so far. */
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body as { text: string; chat_id: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }),
    /** Press a button as a Telegram user in a chat. */
    press: (data: string, from = CHAT, chat = CHAT) =>
      queue.push({ callback_query: { id: `cq${nextId}`, from: { id: from }, data, message: { chat: { id: chat }, message_id: 1 } } }),
    say: (text: string, chat = CHAT) => queue.push({ message: { chat: { id: chat }, text } }),
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.body.text)),
    close: () => server.close(),
  };
}

/** A job run record with an approval waiting, or in another state. */
function run(id: number, fields: Partial<JobRun> = {}): JobRun {
  return {
    id,
    job: "ship",
    title: "Ship to production",
    run: id,
    input: {},
    startedBy: "you",
    background: false,
    status: "waiting",
    phase: "approve",
    approval: "pending",
    resumed: 0,
    startedAt: 0,
    updatedAt: 0,
    phases: [
      { id: "preview", label: "Preview", summary: "https://preview.site.test", status: "done", steps: [] },
      { id: "approve", label: "Approve production", summary: "Wait", status: "running", steps: [] },
    ] as JobRun["phases"],
    ...fields,
  };
}

const session = { id: "s1", name: "Site", project: "acme/site" } as SessionRow;

test("alerts: approvals with buttons, only your chat decides, decisions elsewhere, failures, incidents, calls", async () => {
  const tg = await fakeTelegram("T0K");
  const dataDir = mkdtempSync(join(tmpdir(), "anth-tg-"));
  const runs = new Map<number, JobRun>([[1, run(1, { status: "failed", approval: undefined, error: "old failure" })]]);
  const incidents: Incident[] = [{ id: 1, project: "acme/site", title: "old incident", status: "fixing" } as Incident];
  const approvals: [number, boolean][] = [];
  const rings: string[] = [];
  let fire = () => {};
  const host: AlertsHost = {
    name: "box",
    alertRuns: async () => [...runs.values()].map((r) => ({ session, conversationId: 7, agent: "Lead", run: r })),
    approveRun: async (_s, _c, taskId, approved) => {
      const r = runs.get(taskId)!;
      if (r.approval !== "pending") throw Error("No pending approval for that run");
      r.approval = approved ? "approved" : "declined";
      approvals.push([taskId, approved]);
    },
    incidents: () => incidents,
    subscribe: (fn) => ((fire = fn), () => {}),
  };
  const config = alertsConfig({ TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_CHAT_ID: String(CHAT), ANTH_TELEGRAM_API: tg.api, ANTH_RING_AFTER_MIN: "off" }, dataDir)!;
  config.ring = async (text) => void rings.push(text);
  const alerts = new Alerts(host, config, () => {});
  try {
    alerts.start(60_000);
    // First start: old failures and incidents are not news; nothing is sent until something needs you.
    await alerts.scan();
    assert.equal(tg.sent().length, 0);

    // A run waits for approval: one message with Approve / Reject, even after more scans.
    runs.set(2, run(2));
    fire();
    await until(async () => tg.sent().length === 1, 5000, "approval message");
    await alerts.scan();
    assert.equal(tg.sent().length, 1);
    const msg = tg.sent()[0];
    assert.equal(msg.chat_id, String(CHAT));
    assert.match(msg.text, /Ship to production.*acme\/site/);
    assert.match(msg.text, /Preview: https:\/\/preview\.site\.test/);
    const [approve, reject] = msg.reply_markup!.inline_keyboard[0];
    assert.deepEqual([approve.text, reject.text], ["✅ Approve", "❌ Reject"]);

    // Someone else, or another chat, cannot decide.
    tg.press(approve.callback_data, 999, CHAT);
    tg.press(approve.callback_data, CHAT, 999);
    await until(async () => tg.answers().length === 2, 5000, "refusals");
    assert.deepEqual(tg.answers(), ["Not allowed", "Not allowed"]);
    assert.equal(approvals.length, 0);

    // You approve: the run is approved once, the buttons go away, a second press is refused.
    tg.press(approve.callback_data);
    await until(async () => approvals.length === 1, 5000, "approved");
    assert.deepEqual(approvals[0], [2, true]);
    await until(async () => tg.sent().some((m) => /Approved in Telegram/.test(m.text)), 5000, "outcome");
    assert.ok(tg.calls.some((c) => c.method === "editMessageReplyMarkup"));
    tg.press(reject.callback_data);
    await until(async () => tg.answers().includes("Already decided"), 5000, "already decided");
    assert.equal(approvals.length, 1);

    // Decided in the hub: the Telegram message says so.
    runs.set(3, run(3));
    await alerts.scan();
    runs.get(3)!.approval = "declined";
    await alerts.scan();
    assert.ok(tg.sent().some((m) => /Rejected in the hub/.test(m.text)));

    // A new failure and a new incident are sent; the incident rings at once.
    runs.set(4, run(4, { status: "failed", approval: undefined, error: "Build failed: npm test" }));
    incidents.push({ id: 2, project: "acme/site", title: "Site is down: 503 on /", status: "fixing" } as Incident);
    await alerts.scan();
    assert.ok(tg.sent().some((m) => /failed<\/b>.*\n.*npm test/.test(m.text)));
    assert.ok(tg.sent().some((m) => /Incident #2/.test(m.text) && /503/.test(m.text)));
    assert.ok(!tg.sent().some((m) => /old (failure|incident)/.test(m.text)));
    await until(async () => rings.length === 1, 5000, "incident call");
    assert.match(rings[0], /Incident on acme\/site: Site is down/);
    assert.ok(tg.sent().some((m) => /📞 Calling you/.test(m.text)));

    // An incident the agent could not fix needs you: message and call.
    incidents[1] = { ...incidents[1], status: "needs-you", note: "Could not reproduce the 503" };
    await alerts.scan();
    await until(async () => rings.length === 2, 5000, "needs-you call");
    assert.ok(tg.sent().some((m) => /needs you/.test(m.text) && /reproduce/.test(m.text)));

    // /status lists what waits; other chats get nothing.
    runs.set(5, run(5));
    await alerts.scan();
    const before = tg.sent().length;
    tg.say("/status", 999);
    tg.say("/status");
    await until(async () => tg.sent().length === before + 1, 5000, "status reply");
    assert.match(tg.sent().at(-1)!.text, /Ship to production · acme\/site waits for approval[\s\S]*Incident #2/);
  } finally {
    await alerts.stop();
    tg.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("alerts: TELEGRAM_DEVICE keeps the bot on one device", () => {
  const env = { TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_DEVICE: "hetzner" };
  assert.equal(alertsConfig(env, "/tmp", "local"), undefined);
  assert.ok(alertsConfig(env, "/tmp", "hetzner"));
  assert.ok(alertsConfig({ TELEGRAM_BOT_TOKEN: "T0K" }, "/tmp", "local"));
});

test("alerts: setup mode tells you your chat id; an approval that waits too long rings once", async () => {
  const tg = await fakeTelegram("T0K");
  const dataDir = mkdtempSync(join(tmpdir(), "anth-tg-"));
  const host: AlertsHost = {
    name: "box",
    alertRuns: async () => [{ session, conversationId: 7, agent: "Lead", run: run(1) }],
    approveRun: async () => {},
    incidents: () => [],
    subscribe: () => () => {},
  };
  const setup = new Alerts(host, alertsConfig({ TELEGRAM_BOT_TOKEN: "T0K", ANTH_TELEGRAM_API: tg.api }, dataDir)!, () => {});
  try {
    setup.start(60_000);
    tg.say("/start", 555);
    await until(async () => tg.sent().length === 1, 5000, "chat id reply");
    assert.match(tg.sent()[0].text, /TELEGRAM_CHAT_ID=555/);
  } finally {
    await setup.stop();
  }

  // ANTH_RING_COMMAND places the call (here it writes a file); 0 minutes rings on the first scan, and only once.
  const ringLog = join(dataDir, "ring.log");
  const config = alertsConfig(
    { TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_CHAT_ID: String(CHAT), ANTH_TELEGRAM_API: tg.api, ANTH_RING_AFTER_MIN: "0", ANTH_RING_COMMAND: `echo "$ANTH_RING_TEXT" >> ${ringLog}` },
    dataDir,
  )!;
  const alerts = new Alerts(host, config, () => {});
  try {
    await alerts.scan();
    await alerts.scan();
    await until(async () => existsSync(ringLog), 5000, "ring command");
    await alerts.stop();
    assert.deepEqual(readFileSync(ringLog, "utf8").trim().split("\n"), ["Ship to production on acme/site is waiting for your approval"]);
  } finally {
    tg.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("alerts in the backend: a Telegram button approves a durable job run", async () => {
  const tg = await fakeTelegram("T0K");
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "tg-box",
    env: { TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_CHAT_ID: String(CHAT), ANTH_TELEGRAM_API: tg.api, ANTH_RING_AFTER_MIN: "off" },
  });
  try {
    const client = new AnthClient(server.base, token);
    const s = await client.createSession({ name: "Release", cwd: t.work, model: faux });
    const lead = client.agent(s.id, "main");
    const leak = await lead.send("!echo bot=[$TELEGRAM_BOT_TOKEN]", "followUp", "leak", 30000);
    assert.match(leak.status === "done" ? leak.answer.text : "", /bot=\[\]/);

    const { taskId } = await lead.demo<{ taskId: number }>("jobs", { job: "release-check", input: { commits: 1 } });
    await until(async () => tg.sent().some((m) => /Release check/.test(m.text) && !!m.reply_markup), 60000, "approval in Telegram");
    const approve = tg.sent().find((m) => m.reply_markup)!.reply_markup!.inline_keyboard[0][0];
    tg.press(approve.callback_data);
    const status = async () => (await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(taskId)];
    await until(async () => (await status())?.status === "completed", 60000, "run completed");
    assert.equal((await status())?.approval, "approved");
    assert.deepEqual(tg.answers(), ["Approved"]);
  } finally {
    await server.stop();
    tg.close();
    await t.cleanup();
  }
});

test("alerts: a failed ship the Lead is fixing says so; going live is announced; stuck on one problem is a real failure", async () => {
  const tg = await fakeTelegram("T0K");
  const dataDir = mkdtempSync(join(tmpdir(), "anth-tg-"));
  const runs = new Map<number, JobRun>();
  const host: AlertsHost = {
    name: "box",
    alertRuns: async () => [...runs.values()].map((r) => ({ session, conversationId: 7, agent: "Main", run: r })),
    approveRun: async () => {},
    incidents: () => [],
    subscribe: () => () => {},
    isLead: async () => true,
  };
  const alerts = new Alerts(host, alertsConfig({ TELEGRAM_BOT_TOKEN: "T0K", TELEGRAM_CHAT_ID: String(CHAT), ANTH_TELEGRAM_API: tg.api }, dataDir)!, () => {});
  /** A finished ship run; failures name the place the reviewer blocked on. */
  const ended = (id: number, status: JobRun["status"], place = `src/f${id}.ts:${id}`) =>
    run(id, {
      status,
      approval: undefined,
      startedAt: id,
      error: status === "failed" ? `The reviewer requested changes: ${place} breaks saving` : undefined,
      result: status === "completed" ? "https://site.test answers 200" : undefined,
    });
  try {
    await alerts.scan();
    // Different problems each round: progress, the Lead is on it.
    for (const id of [1, 2, 3]) runs.set(id, ended(id, "failed"));
    await alerts.scan();
    assert.match(tg.sent().at(-1)!.text, /🔧 <b>Ship to production stopped<\/b>[\s\S]*The Lead is fixing it \(round 3\)/);
    assert.equal(tg.sent().filter((m) => m.text.includes("🔴")).length, 0);
    runs.set(4, ended(4, "completed"));
    await alerts.scan();
    assert.match(tg.sent().at(-1)!.text, /✅ <b>Ship to production done<\/b>[\s\S]*answers 200/);
    // The same problem three rounds in a row: stuck, a real failure.
    for (const id of [5, 6, 7]) runs.set(id, ended(id, "failed", "src/editor.tsx:553"));
    await alerts.scan();
    assert.match(tg.sent().at(-1)!.text, /🔴 <b>Ship to production failed<\/b> · acme\/site · stuck on the same problem/);
  } finally {
    await alerts.stop();
    tg.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
