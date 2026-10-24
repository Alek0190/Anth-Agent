import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { blocking, explainPush, explainVercel, githubRepo, lastUrl, parseVerdict } from "../src/ship.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("ship helpers: verdicts, GitHub remotes, deployment URLs", () => {
  assert.equal(parseVerdict("Looks fine.\nVERDICT: safe to merge"), "safe");
  assert.equal(parseVerdict("**VERDICT: needs owner approval (touches auth)**"), "owner");
  // The error message carries the Blocking list, not the follow-ups.
  const report = "Blocking:\n1. src/a.ts:3 save drops pages\nFollow-ups:\n- rename x\nVERDICT: changes requested";
  assert.equal(blocking(report), "1. src/a.ts:3 save drops pages");
  assert.equal(parseVerdict("VERDICT: safe to merge\n...\nVERDICT: changes requested\n- missing test"), "changes");
  assert.equal(parseVerdict("Echo: no verdict here, but the word VERDICT: appears mid-line"), undefined);
  assert.equal(githubRepo("https://github.com/Alek0190/Anth-Agent.git"), "Alek0190/Anth-Agent");
  assert.equal(githubRepo("git@github.com:Alek0190/site.git"), "Alek0190/site");
  assert.equal(githubRepo("/tmp/remote.git"), undefined);
  assert.equal(lastUrl("Inspect: https://vercel.com/a/b\nhttps://site-abc.vercel.app\n"), "https://site-abc.vercel.app");
  assert.equal(lastUrl("nothing"), undefined);
  assert.match(explainPush("Exit 128: remote: Write access to repository not granted.", "alek/site"), /Contents and Pull requests to Read and write/);
  assert.match(explainPush("Exit 128: remote: Repository not found.", "alek/site"), /cannot see alek\/site/);
  assert.match(explainVercel("Error: the commit author did not have contributing access"), /user.email to your Vercel account/);
  assert.match(explainVercel("Error: Command \"npm run build\" exited with 1"), /Inspect link/);
});

/** Read a request body as JSON. */
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Run git in a folder and return its trimmed output. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("ship: branch, build, review, preview, PR, durable approval across a crash, promote once, verify; tokens stay out of agents", async () => {
  const t = await tempStore();
  const token = newToken();

  // A stand-in for the deployed site and for the GitHub API, on one local server.
  const pulls: { head: string; base: string; body: string; title: string }[] = [];
  const auth: string[] = [];
  const site = createServer(async (req, res) => {
    if (req.url?.startsWith("/repos/alek/site/pulls")) {
      auth.push(String(req.headers.authorization));
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        const b = await body(req);
        pulls.push(b);
        return res.end(JSON.stringify({ number: pulls.length, html_url: `https://github.com/alek/site/pull/${pulls.length}` }));
      }
      const head = new URL(req.url, "http://x").searchParams.get("head")?.split(":")[1];
      const open = pulls.filter((p) => p.head === head).map((p, i) => ({ number: i + 1, html_url: `https://github.com/alek/site/pull/${i + 1}` }));
      return res.end(JSON.stringify(open));
    }
    res.end("ok");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const port = (site.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  // A fake Vercel CLI: logs each call (and whether it got the token), prints a preview URL on deploy.
  const log = join(t.root, "vercel.log");
  const bin = join(t.root, "vercel");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\necho "$1 $2 token=$([ "$VERCEL_TOKEN" = vt-secret-123 ] && echo yes || echo no)" >> ${log}\n` +
      `case "$1" in deploy) echo "Inspect: https://vercel.com/anthward/site"; echo "${origin}/preview-$(grep -c ^deploy ${log})";; ` +
      `promote) echo "Success: promoted $2";; rollback) echo "Success: rolled back";; esac\n`,
  );
  chmodSync(bin, 0o755);
  /** The fake Vercel CLI's calls so far. */
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  // The client's project: a git repo with a build and a test script, an origin remote, and uncommitted work.
  const repo = join(t.work, "site");
  const remote = join(t.root, "remote.git");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(t.work, "init", "-q", "-b", "main", "site");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "echo built", test: "echo tested" } }));
  writeFileSync(join(repo, "anth.json"), JSON.stringify({ productionUrl: `${origin}/prod`, healthPath: "/health" }));
  writeFileSync(join(repo, "index.html"), "<h1>v1</h1>");
  git(repo, "config", "user.name", "Alex");
  git(repo, "config", "user.email", "alex@example.com");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v1");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  writeFileSync(join(repo, "index.html"), "<h1>v2 by the team</h1>");

  const env = {
    ANTH_VERCEL_BIN: bin,
    ANTH_GITHUB_API: origin,
    VERCEL_TOKEN: "vt-secret-123",
    GITHUB_TOKEN: "gh-secret-456",
  };
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "ship-box", env });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("alek", "site", { name: "Site" });
    const s = await client.createSession({ name: "Site build", cwd: t.work, model: faux, project: "alek/site" });
    const lead = client.agent(s.id, "main");

    // Agents never see the deploy tokens.
    const leak = await lead.send("!echo token=[$VERCEL_TOKEN][$GITHUB_TOKEN]", "followUp", "leak", 30000);
    assert.match(leak.status === "done" ? leak.answer.text : "", /token=\[\]\[\]/);

    /** The session's job run records. */
    const runs = async () => (await lead.doc<JobRunsDoc>("demo.job-runs")).value;
    /** One run's record. */
    const runOf = async (id: number) => (await runs()).items[String(id)] as JobRun;
    const { taskId } = await lead.demo<{ taskId: number }>("jobs", {
      job: "ship",
      input: { path: "site", github_repo: "alek/site", title: "Booking page v2" },
    });
    await until(async () => {
      const r = await runOf(taskId);
      if (r.status === "failed") throw Error(`ship failed: ${r.error}`);
      return r.status === "waiting";
    }, 90000, "ship to wait for approval");

    let run = await runOf(taskId);
    const branch = `anth/ship-1-${taskId}`;
    assert.deepEqual(run.phases.map((p) => p.status), ["done", "done", "done", "done", "done", "done", "waiting", "pending", "pending"]);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(git(repo, "log", "-1", "--format=%s"), "Booking page v2");
    assert.equal(git(repo, "log", "-1", "--format=%an"), "Alex", "commits as the repository's author when it has one");
    assert.match(execFileSync("git", ["--git-dir", remote, "branch"], { encoding: "utf8" }), new RegExp(branch));
    assert.deepEqual(calls(), ["deploy --yes token=yes"]);
    assert.equal(pulls.length, 1);
    assert.deepEqual([pulls[0].head, pulls[0].base, pulls[0].title], [branch, "main", "Booking page v2"]);
    assert.match(pulls[0].body, new RegExp(`${origin}/preview-1`));
    assert.ok(auth.every((a) => a === "Bearer gh-secret-456"));
    assert.match(run.phases[1].summary ?? "", /build, test passed/);
    const members = (await client.session(s.id).agents()).map((a) => a.name);
    assert.ok(members.includes("Reviewer") && members.includes("Security"), `members: ${members.join(", ")}`);
    // No step shows a token, even the git push that carried one.
    assert.doesNotMatch(JSON.stringify(run), /vt-secret-123|gh-secret-456/);

    // Kill the device while the approval waits. After the restart the same run still waits; nothing redeploys.
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await runOf(taskId)).status === "waiting", 20000, "run to be waiting after restart");
    assert.deepEqual(calls(), ["deploy --yes token=yes"]);
    assert.equal(pulls.length, 1);

    await lead.demo(`jobs/${taskId}/approval`, { approved: true });
    await until(async () => {
      const r = await runOf(taskId);
      if (r.status === "failed") throw Error(`ship failed: ${r.error}`);
      return r.status === "completed";
    }, 60000, "ship to complete");
    run = await runOf(taskId);
    assert.deepEqual(calls(), ["deploy --yes token=yes", `promote ${origin}/preview-1 token=yes`]);
    assert.match(run.result ?? "", new RegExp(`${origin}/prod answers 200`));
    const state = (await client.deviceDoc<Record<string, Record<string, unknown>>>("app.shared-state")).value;
    assert.equal(state.jobs?.ship && (state.jobs.ship as Record<string, unknown>).verified, true);

    // A second ship that you decline never reaches production.
    writeFileSync(join(repo, "index.html"), "<h1>v3</h1>");
    const second = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site", github_repo: "alek/site" } });
    await until(async () => (await runOf(second.taskId)).status === "waiting", 90000, "second ship to wait");
    assert.equal((await runOf(second.taskId)).phases[0].summary?.includes("ahead of main"), true, "base auto is main from a ship branch");
    await lead.demo(`jobs/${second.taskId}/approval`, { approved: false });
    await until(async () => (await runOf(second.taskId)).status === "declined", 20000, "second ship declined");
    assert.equal(calls().filter((c) => c.startsWith("promote")).length, 1);

    // Rollback is one approval.
    const rb = await lead.demo<{ taskId: number }>("jobs", { job: "rollback", input: { path: "site" } });
    await until(async () => (await runOf(rb.taskId)).status === "waiting", 20000, "rollback to wait");
    assert.equal(calls().filter((c) => c.startsWith("rollback")).length, 0);
    await lead.demo(`jobs/${rb.taskId}/approval`, { approved: true });
    await until(async () => (await runOf(rb.taskId)).status === "completed", 30000, "rollback to complete");
    assert.equal(calls().filter((c) => c.startsWith("rollback")).length, 1);
  } finally {
    await server.stop();
    site.close();
    await t.cleanup();
  }
});

test("ship without a Vercel token stops before deploying and says how to fix it", async () => {
  const t = await tempStore();
  const token = newToken();
  const repo = join(t.work, "site");
  git(t.work, "init", "-q", "-b", "main", "site");
  writeFileSync(join(repo, "index.html"), "hi");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=A", "-c", "user.email=a@b.c", "commit", "-qm", "v1");
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "no-token-box" });
  try {
    const client = new AnthClient(server.base, token);
    const s = await client.createSession({ name: "S", cwd: t.work, model: faux });
    const lead = client.agent(s.id, "main");
    const { taskId } = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site" } });
    await until(
      async () => ((await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(taskId)] as JobRun).status === "failed",
      60000,
      "ship to fail",
    );
    const run = (await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(taskId)] as JobRun;
    assert.equal(run.phase, "preview");
    assert.match(run.error ?? "", /VERCEL_TOKEN is not set/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
