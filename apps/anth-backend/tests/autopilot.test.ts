// Autopilot: how a ship or rollback ended goes back to the Lead by itself, once, with the round it is in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { Autopilot, notice, type AutopilotHost } from "../src/autopilot.js";
import type { SessionRow } from "../src/store.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const session = { id: "s1", name: "Site", project: "acme/site" } as SessionRow;

/** A finished ship run record. */
function run(id: number, status: JobRun["status"], startedAt: number, fields: Partial<JobRun> = {}): JobRun {
  return {
    id,
    job: "ship",
    title: "Ship to production",
    run: id,
    input: { path: "site" },
    startedBy: "you",
    background: true,
    status,
    phase: status === "failed" ? "review" : undefined,
    phases: [{ id: "review", label: "Review", status: status === "failed" ? "failed" : "done", steps: [] }],
    resumed: 0,
    startedAt,
    updatedAt: startedAt,
    ...(status === "failed" ? { error: "The reviewer requested changes: stale save path" } : {}),
    ...(status === "completed" ? { result: "https://site.test answers 200" } : {}),
    ...fields,
  };
}

test("notice: what the Lead is told for each ending", () => {
  assert.match(notice(run(1, "failed", 1), 1)!, /stopped in "Review":\nThe reviewer requested changes[\s\S]*round 1 of 3[\s\S]*Do not ask the owner first/);
  assert.match(notice(run(1, "failed", 1), 3)!, /round 3 of 3: do not start it again/);
  assert.match(notice(run(1, "completed", 1), 1)!, /finished: https:\/\/site\.test answers 200[\s\S]*Report to the owner/);
  assert.match(notice(run(1, "declined", 1), 1)!, /owner declined[\s\S]*Do not start it again/);
  assert.equal(notice(run(1, "aborted", 1), 1), undefined);
});

test("autopilot: old endings skipped, each new one told once with its round, non-Leads and waited runs left alone", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "anth-autopilot-"));
  const runs = new Map<number, { conversationId: number; run: JobRun }>([[1, { conversationId: 7, run: run(1, "failed", 1) }]]);
  const told: { conversationId: number; text: string; requestId: string }[] = [];
  const host: AutopilotHost = {
    alertRuns: async () => [...runs.values()].map((r) => ({ session, agent: "Main", ...r })),
    isLead: async (_s, c) => c === 7,
    submit: async (_s, conversationId, text, requestId) => void told.push({ conversationId, text, requestId }),
    subscribe: () => () => {},
  };
  const pilot = new Autopilot(host, dataDir, () => {});
  try {
    await pilot.scan();
    assert.equal(told.length, 0, "an ending from before the start is not news");

    runs.set(2, { conversationId: 7, run: run(2, "failed", 2) });
    await pilot.scan();
    await pilot.scan();
    assert.equal(told.length, 1);
    assert.match(told[0].text, /round 2 of 3/, "run 1 failed too: this is the second round");
    assert.equal(told[0].requestId, "autopilot:2:failed");

    runs.set(3, { conversationId: 7, run: run(3, "failed", 3) });
    await pilot.scan();
    assert.match(told[1].text, /round 3 of 3: do not start it again/);

    // Went live: the Lead reports; the rounds start over after it.
    runs.set(4, { conversationId: 7, run: run(4, "completed", 4) });
    runs.set(5, { conversationId: 7, run: run(5, "failed", 5) });
    await pilot.scan();
    assert.match(told[2].text, /finished/);
    assert.match(told[3].text, /round 1 of 3/);

    // Not the Lead (a member's conversation), a run the Lead waited on, and other jobs: nothing.
    runs.set(6, { conversationId: 9, run: run(6, "failed", 6) });
    runs.set(7, { conversationId: 7, run: run(7, "failed", 7, { toolCallId: "call-1", background: false }) });
    runs.set(8, { conversationId: 7, run: run(8, "failed", 8, { job: "workspace-snapshot" }) });
    await pilot.scan();
    assert.equal(told.length, 4);
  } finally {
    await pilot.stop();
  }
  // A restart does not tell anything twice.
  const again = new Autopilot(host, dataDir, () => {});
  try {
    await again.scan();
    assert.equal(told.length, 4);
  } finally {
    await again.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("autopilot in the backend: a ship that fails reaches the Lead of a team session by itself", async () => {
  const t = await tempStore();
  const token = newToken();
  const repo = join(t.work, "site");
  execFileSync("git", ["init", "-q", "-b", "main", "site"], { cwd: t.work });
  writeFileSync(join(repo, "index.html"), "hi");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=A", "-c", "user.email=a@b.c", "commit", "-qm", "v1"], { cwd: repo });
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "autopilot-box" });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "site", { name: "Site" });
    const s = await client.createSession({ name: "Site", cwd: t.work, model: faux, project: "acme/site" });
    const lead = client.agent(s.id, "main");
    // Started by the owner from the Tasks tab; it fails at the preview (no Vercel token on this device).
    const { taskId } = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site" } });
    await until(async () => ((await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(taskId)] as JobRun)?.status === "failed", 60000, "ship to fail");
    const transcript = async () => JSON.stringify(await lead.transcript("markdown"));
    await until(async () => (await transcript()).includes("[Automatic notice]"), 30000, "the notice in the Lead's conversation");
    assert.match(await transcript(), /VERCEL_TOKEN is not set/);
    assert.match(await transcript(), /round 1 of 3/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
