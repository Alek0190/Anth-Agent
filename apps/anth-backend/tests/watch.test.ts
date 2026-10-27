import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { fingerprint, judgeOffline, MAX_SERVER_EVENTS, redact, serverLogEvents, serverLogsError, vercelEvent, webhookEvent } from "../src/watch.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("watch helpers: Vercel log lines, webhook bodies, fingerprints, offline rules", () => {
  const log = vercelEvent(
    JSON.stringify({ type: "log", data: { id: "a1", timestamp: 1700000000000, level: "error", message: "TypeError at line 42", requestPath: "/api/order/123" } }),
  );
  assert.equal(log?.source, "vercel-log");
  assert.equal(log?.id, "vercel:a1");
  const request = vercelEvent(JSON.stringify({ type: "request", data: { requestId: "r9", httpStatus: 502, requestMethod: "POST", requestPath: "/api/contact" } }));
  assert.equal(request?.status, 502);
  assert.equal(request?.message, "POST /api/contact → 502");
  assert.equal(vercelEvent(JSON.stringify({ type: "summary", recordsReturned: 0 })), undefined);
  assert.equal(vercelEvent("not json"), undefined);
  const sentry = webhookEvent({ data: { issue: { id: "77", title: "ZeroDivisionError", culprit: "/checkout" } } });
  assert.deepEqual([sentry.id, sentry.message, sentry.path, sentry.level], ["webhook:77", "ZeroDivisionError", "/checkout", "error"]);
  // Same cause, different ids and numbers: one fingerprint.
  const a = fingerprint({ source: "vercel-log", message: "TypeError at line 42 for order 123", path: "/api/order/123" });
  const b = fingerprint({ source: "vercel-log", message: "TypeError at line 42 for order 456", path: "/api/order/456" });
  assert.equal(a, b);
  assert.equal(judgeOffline({ id: "x", source: "uptime", at: 0, level: "error", message: "down", fingerprint: "f" }).verdict, "incident");
  assert.equal(judgeOffline({ id: "x", source: "uptime", at: 0, level: "warning", message: "slow", fingerprint: "f" }).verdict, "suspicious");
  assert.equal(judgeOffline({ id: "x", source: "vercel-log", at: 0, level: "info", message: "ok", fingerprint: "f" }).verdict, "normal");
});

test("server logs: error lines with their stack traces become events, routine lines do not, nothing private is kept", () => {
  const out = [
    "Warning: Permanently added '203.0.113.7' (ED25519) to the list of known hosts.", // ssh chatter: no timestamp
    "2026-10-27T14:00:00.100000000Z Server listening on port 3000",
    "2026-10-27T14:00:01.200000000Z [auth] login-failed reason=password email=3f2a9c1b7d4e ip=198.51.100.23",
    "2026-10-27T14:00:02.300000000Z TypeError: Cannot read properties of undefined (reading 'items')",
    "2026-10-27T14:00:02.300000000Z     at addSubmission (/app/server/sitesRoutes.js:44:18)",
    "2026-10-27T14:00:02.300000000Z     at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
    "2026-10-27T14:00:03.400000000Z POST /api/public/sites/cafe/submissions?token=abc123 500 12ms",
    '2026-10-27T14:00:04.500000000Z {"level":50,"msg":"payment webhook failed","err":{"message":"boom","stack":"Error: boom\\n    at pay (/app/pay.js:1:1)"},"req":{"url":"/api/pay?session=xyz"}}',
    '2026-10-27T14:00:05.600000000Z {"level":30,"msg":"request done","res":{"statusCode":200}}',
    "2026-10-27T14:00:06.700000000Z Error: connect ECONNREFUSED 10.0.0.5:5432 for user alex@example.com password=hunter2 Bearer eyJhbGciOiJIUzI1NiJ9abcdef1234567890xyz",
  ].join("\n");
  const events = serverLogEvents(out);
  assert.deepEqual(events.map((e) => e.level), ["warning", "error", "error", "error", "error"]);
  assert.ok(events.every((e) => e.source === "server-log" && e.id.startsWith("server:")));
  const [failed, crash, http, json, db] = events;
  // Routine lines (listening, an info JSON line) and ssh chatter are not events; the warning keeps its shape, not the IP.
  assert.match(failed.message, /login-failed reason=password email=3f2a9c1b7d4e ip=<ip>/);
  // The stack trace stays with its error, as one event.
  assert.match(crash.message, /^TypeError: Cannot read properties of undefined \(reading 'items'\)\n {4}at addSubmission \(\/app\/server\/sitesRoutes\.js:44:18\)\n/);
  assert.equal(crash.at, Date.parse("2026-10-27T14:00:02.300Z"));
  // A request line gives the path and status, without its query string.
  assert.deepEqual([http.path, http.status], ["/api/public/sites/cafe/submissions?<query>", 500]);
  assert.doesNotMatch(http.message, /abc123/);
  // pino JSON: the level number, the message, the error's stack and the request path.
  assert.match(json.message, /^payment webhook failed\nError: boom\n {4}at pay/);
  assert.equal(json.path, "/api/pay?<query>");
  // No email, IP, password or token survives.
  assert.equal(db.message, "Error: connect ECONNREFUSED <ip>:5432 for user <email> password=<redacted> Bearer <redacted>");
  // The same line read again (the ticks overlap) has the same id; one cause, one fingerprint.
  assert.deepEqual(serverLogEvents(out).map((e) => e.id), events.map((e) => e.id));
  const again = serverLogEvents("2026-10-27T15:00:00.000000000Z TypeError: Cannot read properties of undefined (reading 'items')")[0];
  assert.equal(fingerprint(again), fingerprint(crash));
  assert.equal(judgeOffline({ ...crash, fingerprint: "f" }).verdict, "incident");
  // A flood is capped.
  const flood = Array.from({ length: 500 }, (_, i) => `2026-10-27T14:00:00.${String(i).padStart(9, "0")}Z Error: x ${i}`).join("\n");
  assert.equal(serverLogEvents(flood).length, MAX_SERVER_EVENTS);
  // Times, versions and paths are not mistaken for secrets.
  assert.equal(redact("at 12:30:45 node v24.1.0 /app/node_modules/express/lib/router/index.js"), "at 12:30:45 node v24.1.0 /app/node_modules/express/lib/router/index.js");
  // Failures say what to do.
  assert.match(serverLogsError("anth-deploy: usage: preview <app> <sha> | promote <app> <sha> | rollback <app> | status <app> | refresh <app>", "203.0.113.7"), /just server update root@203\.0\.113\.7/);
  assert.match(serverLogsError("anth@203.0.113.7: Permission denied (publickey).", "203.0.113.7"), /refused the deploy key/);
});

/** Read a request body as JSON. */
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Run git in a folder and return its trimmed output. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("watch and fix: Vercel errors open one incident, its agent proves the fix, ship waits for approval, the incident resolves", async () => {
  const t = await tempStore();
  const token = newToken();

  // The live site, the GitHub API and the preview URLs, on one local server.
  let siteStatus = 200;
  const pulls: { head: string; base: string }[] = [];
  const site = createServer(async (req, res) => {
    if (req.url?.startsWith("/repos/acme/site/pulls")) {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        pulls.push(await body(req));
        return res.end(JSON.stringify({ number: pulls.length, html_url: `https://github.com/acme/site/pull/${pulls.length}` }));
      }
      return res.end("[]");
    }
    res.statusCode = req.url?.startsWith("/preview") ? 200 : siteStatus;
    res.end("site");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  // A fake Vercel CLI: deploy and promote for the ship job, and `logs runtime` printing whatever the test wrote.
  const logs = join(t.root, "vercel-runtime.jsonl");
  const bin = join(t.root, "vercel");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\ncase "$1" in\n` +
      `logs) if [ "$2" = runtime ] && [ -f ${logs} ]; then cat ${logs}; fi; echo '{"type":"summary","recordsReturned":0}';;\n` +
      `deploy) echo "${origin}/preview-1";;\npromote) echo promoted;;\nesac\n`,
  );
  chmodSync(bin, 0o755);

  // The client's repository: a checkout function with a bug, an existing passing test, an origin remote.
  const repo = join(t.work, "site");
  const remote = join(t.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(t.work, "init", "-q", "-b", "main", "site");
  git(repo, "config", "user.name", "Alex");
  git(repo, "config", "user.email", "alex@example.com");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node sum.test.js" } }));
  writeFileSync(join(repo, "app.js"), "module.exports = (cart) => cart.items.length;\n");
  writeFileSync(join(repo, "sum.test.js"), "require('assert').equal(1 + 1, 2);\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v1");
  // origin looks like GitHub (so the ship job finds acme/site) while pushes land in a local bare repository.
  git(repo, "remote", "add", "origin", "https://github.com/acme/site.git");
  git(repo, "config", `url.${remote}.pushInsteadOf`, "https://github.com/acme/site.git");
  git(repo, "push", "-q", "origin", "main");
  // The local main falls behind: a later commit is on the remote only (a pull request merged on GitHub, not pulled).
  writeFileSync(join(repo, "version.txt"), "2\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v2");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "reset", "-q", "--hard", "HEAD~1");

  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "watch-box",
    env: {
      ANTH_WATCH_INTERVAL_MS: "0",
      ANTH_VERCEL_BIN: bin,
      ANTH_GITHUB_API: origin,
      VERCEL_TOKEN: "vt-secret-123",
      GITHUB_TOKEN: "gh-secret-456",
    },
  });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "site", { name: "Site", clientName: "Acme" });
    const s = await client.createSession({ name: "Site", cwd: t.work, model: faux, project: "acme/site", env: "prod" });

    // Watch setup is validated; the project shows as watched in the tree.
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: "nope", url: origin }));
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: s.id, url: "not-a-url" }));
    // A typo in the repository folder is refused when saving, not found later as "spawn bash ENOENT".
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: s.id, path: ".site", url: origin }), /\.site does not exist/);
    // Only folders inside the session folder: no way out with .. or an absolute path, and a file is not a folder.
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: s.id, path: "..", url: origin }), /must be inside the session folder/);
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: s.id, path: "/tmp", url: origin }), /must be inside the session folder/);
    await assert.rejects(() => client.putWatch("acme", "site", { sessionId: s.id, path: "site/app.js", url: origin }), /is a file, not a folder/);
    const watch = await client.putWatch("acme", "site", { sessionId: s.id, path: "site", url: origin, paths: ["/"] });
    assert.equal(watch.vercel, true);
    assert.match(watch.webhookPath, /^\/hooks\/acme\/site\/[\w-]{20,}$/);
    assert.deepEqual((await client.tree()).projects?.[0].watch, { enabled: true, openIncidents: 0 });

    // A healthy tick: no events, no incidents.
    assert.deepEqual(await client.watchTick("acme", "site"), { events: 0, errors: [] });
    assert.equal((await client.incidents("acme", "site")).length, 0);

    // Three production errors with one cause open one incident and its agent.
    const now = Date.now();
    writeFileSync(
      logs,
      [1, 2, 3]
        .map((i) =>
          JSON.stringify({
            type: "log",
            data: { id: `err-${i}`, timestamp: now - i * 1000, level: "error", message: "TypeError: Cannot read properties of undefined (reading 'length') at app.js:1", requestPath: "/api/checkout" },
          }),
        )
        .join("\n") + "\n",
    );
    await client.watchTick("acme", "site");
    const events = await client.watchEvents("acme", "site");
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.verdict === "incident" && e.incident === 1));
    let [incident] = await client.incidents("acme", "site");
    assert.equal(incident.id, 1);
    assert.equal(incident.status, "fixing");
    assert.equal(incident.branch, "incident/inc-1");
    assert.equal(incident.base, "main");
    const worktree = join(t.work, ".anth-incidents", "site-inc-1");
    assert.equal(incident.worktree, worktree);
    assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "incident/inc-1");
    assert.equal(existsSync(join(worktree, "version.txt")), true, "the worktree starts from origin/main, not the stale local main");
    const agent = (await client.session(s.id).agents()).find((a) => a.name === "Incident #1");
    assert.equal(agent?.id, incident.conversationId);
    const tools = (await client.agent(s.id, agent!.id).get()).tools.filter((t) => t.offered).map((t) => t.name);
    assert.ok(tools.includes("submit_fix") && tools.includes("delegate"), tools.join(", "));
    await until(
      async () => JSON.stringify(await client.agent(s.id, agent!.id).transcript("markdown")).includes("Incident #1 in acme/site"),
      15000,
      "the incident brief",
    );
    assert.equal((await client.tree()).projects?.[0].watch?.openIncidents, 1);

    // The same events again change nothing; a webhook event attaches to nothing until it crosses the threshold.
    await client.watchTick("acme", "site");
    assert.equal((await client.watchEvents("acme", "site")).length, 3);
    assert.equal((await client.incidents("acme", "site")).length, 1);
    assert.equal((await fetch(`${server.base}/hooks/acme/site/wrong-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    const hooked = await fetch(`${server.base}${watch.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Contact form crashed", level: "error", path: "/contact" }),
    });
    assert.equal(hooked.status, 202);
    await until(async () => (await client.watchEvents("acme", "site")).some((e) => e.source === "webhook" && e.verdict), 10000, "webhook judged");

    // The site going down is its own incident after two failed checks.
    siteStatus = 503;
    await client.watchTick("acme", "site");
    assert.equal((await client.incidents("acme", "site")).length, 1);
    await client.watchTick("acme", "site");
    const down = (await client.incidents("acme", "site")).find((i) => i.fingerprint.startsWith("uptime"));
    assert.ok(down, "uptime incident");
    siteStatus = 200;

    // submit_fix refuses without a test, then proves a real fix: the new test fails on main and passes here.
    const lead = client.agent(s.id, agent!.id);
    const noTest = await lead.send("submitfix: node app.test.js", "followUp", "fix-0", 60000);
    assert.match(noTest.status === "done" ? noTest.answer.text : "", /No test file changed/);
    writeFileSync(join(worktree, "app.js"), "module.exports = (cart) => (cart && cart.items ? cart.items.length : 0);\n");
    // A test that passes without the fix proves nothing: refused.
    writeFileSync(join(worktree, "app.test.js"), "require('assert').equal(require('./app.js')({ items: [1] }), 1);\n");
    const weak = await lead.send("submitfix: node app.test.js", "followUp", "fix-weak", 60000);
    assert.match(weak.status === "done" ? weak.answer.text : "", /passes on main too/);
    writeFileSync(join(worktree, "app.test.js"), "require('assert').equal(require('./app.js')(undefined), 0);\n");
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    const fixed = await lead.send("submitfix: node app.test.js", "followUp", "fix-1", 60000);
    assert.match(fixed.status === "done" ? fixed.answer.text : "", /Proven/);
    assert.equal(existsSync(`${worktree}-proof`), false, "the proof worktree is removed");
    incident = (await client.incidents("acme", "site")).find((i) => i.id === 1)!;
    assert.equal(incident.status, "shipping");
    assert.ok(incident.shipTaskId);

    // The ship job runs from the incident branch against main and waits for the owner.
    const runOf = async () => (await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(incident.shipTaskId)] as JobRun;
    await until(async () => {
      const r = await runOf();
      if (r?.status === "failed") throw Error(`ship failed: ${r.error}`);
      return r?.status === "waiting";
    }, 90000, "ship to wait for approval");
    assert.equal(pulls[0].base, "main");
    assert.match(pulls[0].head, /^anth\/ship-/);
    await lead.demo(`jobs/${incident.shipTaskId}/approval`, { approved: true });
    await until(async () => (await runOf()).status === "completed", 60000, "ship to complete");

    // The next tick sees the completed ship and resolves the incident.
    await client.watchTick("acme", "site");
    assert.equal((await client.incidents("acme", "site")).find((i) => i.id === 1)?.status, "resolved");

    // The errors from before the fix are still inside the window: they must not reopen the bug as a new incident.
    const before = (await client.incidents("acme", "site")).length;
    await client.watchTick("acme", "site");
    await client.watchTick("acme", "site");
    assert.equal((await client.incidents("acme", "site")).length, before, "no duplicate incident after the fix");
    // A late-reported error from before the fix is ignored too; three fresh ones after it would open a new incident.
    writeFileSync(
      logs,
      JSON.stringify({ type: "log", data: { id: "late", timestamp: now, level: "error", message: "TypeError: Cannot read properties of undefined (reading 'length') at app.js:1", requestPath: "/api/checkout" } }) + "\n",
    );
    await client.watchTick("acme", "site");
    assert.equal((await client.incidents("acme", "site")).length, before);

    // Removing the project while the watch session sits outside it: the session stays, the watch stops and the
    // open incidents close (their agents are stopped).
    assert.ok((await client.incidents("acme", "site")).some((i) => i.status !== "resolved"), "an incident is still open");
    await client.session(s.id).update({ project: null });
    const removed = await client.removeProject("acme", "site");
    assert.deepEqual(removed.archivedSessions, []);
    assert.ok((await client.sessions()).some((x) => x.id === s.id), "the watch session stays");
    assert.ok((await client.incidents("acme", "site")).every((i) => i.status === "resolved"));
    await assert.rejects(() => client.watch("acme", "site"));
    for (const i of await client.incidents("acme", "site"))
      if (i.conversationId !== undefined)
        assert.equal((await client.session(s.id).get()).agents.find((a) => a.id === i.conversationId)?.busy ?? false, false);
  } finally {
    await server.stop();
    site.close();
    await t.cleanup();
  }
});
