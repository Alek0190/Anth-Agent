// Autopilot: how a ship or rollback ended goes back to the Lead by itself, once, with the round it is in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { Autopilot, notice, repeatsOf, sameBlocker, type AutopilotHost } from "../src/autopilot.js";
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
    // Each failure names a different place, as when every round fixes one problem and the next review finds another.
    ...(status === "failed" ? { error: `The reviewer requested changes: src/f${id}.ts:${id} breaks saving` } : {}),
    ...(status === "completed" ? { result: "https://site.test answers 200" } : {}),
    ...fields,
  };
}

test("notice: what the Lead is told for each ending", () => {
  assert.match(notice(run(1, "failed", 1), 1)!, /stopped in "Review":\nThe reviewer requested changes[\s\S]*round 1 \(rounds that each fix something new go on[\s\S]*team log[\s\S]*Blocking[\s\S]*Do not ask the owner first/);
  assert.match(notice(run(1, "failed", 1), 2, 2)!, /same blocker as the last round[\s\S]*failing test first/);
  assert.match(notice(run(1, "failed", 1), 3, 3)!, /same blocker has now stopped 3 rounds in a row[\s\S]*Do not start it again/);
  assert.match(notice(run(1, "failed", 1), 8)!, /round 8 of at most 8: do not start it again/);
  assert.match(notice(run(1, "completed", 1), 1)!, /finished: https:\/\/site\.test answers 200[\s\S]*Report to the owner/);
  assert.match(notice(run(1, "declined", 1), 1)!, /owner declined[\s\S]*Do not start it again/);
  assert.equal(notice(run(1, "aborted", 1), 1), undefined);
});

test("stuck detection: the same blocker round after round, versus progress", () => {
  assert.ok(sameBlocker("src/a.ts:3 drops pages; src/b.ts:9", "Still: src/a.ts:3 drops pages"));
  assert.ok(!sameBlocker("src/a.ts:3 drops pages", "src/c.ts:40 wrong layout"));
  assert.ok(sameBlocker("Build failed: npm test", "build failed:  npm test"));
  const same = (id: number) => run(id, "failed", id, { error: "Blocking: src/editor.tsx:553 publish ignores failed save" });
  const runs = [run(1, "completed", 1), same(2), same(3), same(4)];
  assert.equal(repeatsOf(runs, runs[1]), 1);
  assert.equal(repeatsOf(runs, runs[3]), 3, "three rounds in a row on the same blocker");
  assert.equal(repeatsOf([same(2), run(3, "failed", 3), same(4)], same(4)), 1, "a different blocker in between resets it");
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
    assert.match(told[0].text, /round 2 \(/, "run 1 failed too: this is the second round");
    assert.equal(told[0].requestId, "autopilot:2:failed");

    // Rounds 3 and 4 each stop on something new: progress, so the Lead keeps going.
    for (const n of [3, 4]) {
      runs.set(n, { conversationId: 7, run: run(n, "failed", n) });
      await pilot.scan();
    }
    assert.match(told[1].text, /round 3 \(rounds that each fix/);
    assert.match(told[2].text, /round 4 [\s\S]*Do not ask the owner first/);
    told.splice(1);

    // Went live: the Lead reports; the rounds start over after it.
    runs.set(10, { conversationId: 7, run: run(10, "completed", 10) });
    runs.set(11, { conversationId: 7, run: run(11, "failed", 11) });
    await pilot.scan();
    assert.match(told[1].text, /finished/);
    assert.match(told[2].text, /round 1 \(/);

    // Not the Lead (a member's conversation), a run the Lead waited on, and other jobs: nothing.
    runs.set(12, { conversationId: 9, run: run(12, "failed", 12) });
    runs.set(13, { conversationId: 7, run: run(13, "failed", 13, { toolCallId: "call-1", background: false }) });
    runs.set(14, { conversationId: 7, run: run(14, "failed", 14, { job: "workspace-snapshot" }) });
    await pilot.scan();
    assert.equal(told.length, 3);
  } finally {
    await pilot.stop();
  }
  // A restart does not tell anything twice.
  const again = new Autopilot(host, dataDir, () => {});
  try {
    await again.scan();
    assert.equal(told.length, 3);
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
  // An uncommitted change, so the ship has something to commit and review.
  writeFileSync(join(repo, "about.html"), "about");
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
    assert.match(await transcript(), /round 1 \(/);

    // The ship's review went into the team log, and the next ship's review is given those findings to check first.
    type Note = { author: string; text: string };
    const notes = async () =>
      (await (await fetch(`${server.base}/v1/sessions/${s.id}/team/notes?limit=200`, { headers: { authorization: `Bearer ${token}` } })).json()) as Note[];
    assert.ok((await notes()).some((n) => n.author === "Ship review 1: reviewer"));
    assert.ok((await notes()).some((n) => n.author === "Ship review 1: security"));
    writeFileSync(join(repo, "index.html"), "hi again");
    const second = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site" } });
    await until(async () => ((await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(second.taskId)] as JobRun)?.status === "failed", 60000, "second ship to fail");
    const review2 = (await notes()).find((n) => n.author === "Ship review 2: reviewer");
    assert.match(review2?.text ?? "", /Earlier reviews of this work found[\s\S]*Ship review 1: reviewer/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
