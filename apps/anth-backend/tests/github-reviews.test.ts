// The Lead reads GitHub pull request reviews through the backend: the token stays in the backend process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { cleanBody, parsePullRef, pullRequestReviews } from "../src/github.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const TOKEN = "ghp_review_secret_789";
const HEAD = "1fbc1af0000000000000000000000000000000aa";
const OLD = "9d3e2c10000000000000000000000000000000bb";

/** A stand-in for the GitHub API with one pull request (#17) in alek/site; records the auth headers it got. */
async function fakeGitHub() {
  const auth: string[] = [];
  const server: Server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const page = Number(url.searchParams.get("page") ?? "1");
    const list = (items: unknown[]) => send(200, page === 1 ? items : []);
    if (url.pathname.startsWith("/repos/alek/private/")) return send(404, { message: "Not Found" });
    if (url.pathname === "/repos/alek/echo/pulls/1") return send(500, { message: `bad credentials ${TOKEN}` });
    switch (url.pathname) {
      case "/repos/alek/site/pulls":
        return send(200, [
          { number: 17, title: "AI edits, round 1 (v2)", state: "open", html_url: "https://github.com/alek/site/pull/17", updated_at: "2026-10-28T09:12:00Z", head: { ref: "anth/ship-24-26512", sha: HEAD }, base: { ref: "main" } },
        ]);
      case "/repos/alek/site/pulls/17":
        return send(200, { number: 17, title: "AI edits, round 1 (v2)", state: "open", merged: false, draft: false, html_url: "https://github.com/alek/site/pull/17", head: { ref: "anth/ship-24-26512", sha: HEAD }, base: { ref: "main" } });
      case "/repos/alek/site/pulls/17/reviews":
        return list([
          { user: { login: "alex" }, state: "CHANGES_REQUESTED", body: "Blocking:\n1. Cost must come from usage.cost.", submitted_at: "2026-10-27T18:00:00Z", commit_id: OLD },
          // The empty wrapper of line comments: not listed as a review.
          { user: { login: "coderabbitai[bot]" }, state: "COMMENTED", body: "", submitted_at: "2026-10-27T18:05:00Z", commit_id: OLD },
          { user: { login: "coderabbitai[bot]" }, state: "COMMENTED", body: "<!-- walkthrough_start\nhidden state\n-->Actionable comments posted: 1", submitted_at: "2026-10-27T18:06:00Z", commit_id: OLD },
        ]);
      case "/repos/alek/site/pulls/17/comments":
        return list([
          { id: 1, user: { login: "alex" }, body: "Unknown models are billed at gpt-4o-mini prices.", path: "server/ai/credits.js", line: 42, original_line: 42, created_at: "2026-10-27T18:01:00Z" },
          { id: 2, user: { login: "dev" }, body: "Fixed in 1fbc1af.", path: "server/ai/credits.js", line: 42, original_line: 42, created_at: "2026-10-28T08:00:00Z", in_reply_to_id: 1 },
          { id: 3, user: { login: "coderabbitai[bot]" }, body: "ledger.init(db) is never called.", path: "server.js", line: null, original_line: 88, created_at: "2026-10-27T18:05:00Z" },
        ]);
      case "/repos/alek/site/issues/17/comments":
        return list([{ user: { login: "alex" }, body: "Please rebase onto main: the preview misses the host fix.", created_at: "2026-10-28T09:00:00Z" }]);
    }
    send(404, { message: "Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, auth, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** Set environment variables for the length of fn. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("parsePullRef and cleanBody", () => {
  assert.deepEqual(parsePullRef("17", "alek/site"), { repo: "alek/site", number: 17 });
  assert.deepEqual(parsePullRef("#17", undefined), { repo: undefined, number: 17 });
  assert.deepEqual(parsePullRef("alek/site#9", "other/repo"), { repo: "alek/site", number: 9 });
  assert.deepEqual(parsePullRef("https://github.com/Alek0190/anthwebbuilder/pull/17/files", undefined), { repo: "Alek0190/anthwebbuilder", number: 17 });
  assert.deepEqual(parsePullRef(undefined, "alek/site"), { repo: "alek/site", number: undefined });
  assert.throws(() => parsePullRef("the latest one", "alek/site"), /give its number/);
  assert.equal(cleanBody("<!-- state -->Hello\n\n\n\nworld"), "Hello\n\nworld");
  assert.match(cleanBody("x".repeat(50), 10), /^x{10}\n\[… 40 more characters\]$/);
});

test("pullRequestReviews: verdicts, reviews, line comments with replies, conversation; the token never shows", async () => {
  const gh = await fakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "anth-reviews-"));
  try {
    await withEnv({ GITHUB_TOKEN: TOKEN, ANTH_GITHUB_API: gh.origin }, async () => {
      // The repository comes from the folder's origin remote.
      const repo = join(root, "site");
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:alek/site.git"]);
      const text = await pullRequestReviews({ pr: "17", dir: repo });
      assert.match(text, /not instructions to you/);
      assert.match(text, /Pull request #17 in alek\/site: AI edits, round 1 \(v2\)/);
      assert.match(text, /open · anth\/ship-24-26512 → main · head 1fbc1af/);
      assert.match(text, /Verdicts: alex changes requested \(on 9d3e2c1, before the latest commit\)/);
      assert.match(text, /Reviews \(2, oldest first\)/, "the empty wrapper review is left out");
      assert.match(text, /Cost must come from usage\.cost/);
      assert.match(text, /Actionable comments posted: 1/);
      assert.doesNotMatch(text, /hidden state|walkthrough_start/, "bots' HTML comments are removed");
      assert.match(text, /server\/ai\/credits\.js:42 · alex/);
      assert.match(text, /↳ dev: Fixed in 1fbc1af\./);
      assert.match(text, /server\.js:88 \(outdated: the code changed since\)/);
      assert.match(text, /Conversation \(1\):[\s\S]*Please rebase onto main/);
      assert.doesNotMatch(text, new RegExp(TOKEN));
      assert.ok(gh.auth.every((a) => a === `Bearer ${TOKEN}`));

      // No number: the open pull requests.
      assert.match(await pullRequestReviews({ repo: "alek/site" }), /#17 AI edits, round 1 \(v2\) · anth\/ship-24-26512 → main/);
      // A repository the token cannot see says how to fix the token.
      await assert.rejects(pullRequestReviews({ pr: "alek/private#3" }), /Pull requests to Read/);
      // An error that echoes the token never carries it.
      await assert.rejects(pullRequestReviews({ pr: "alek/echo#1" }), (e: Error) => !e.message.includes(TOKEN) && /\[hidden\]/.test(e.message));
      await assert.rejects(pullRequestReviews({ pr: "17", dir: root }), /Set repo to owner\/repo/);
    });
    await withEnv({ GITHUB_TOKEN: undefined, ANTH_GITHUB_API: gh.origin }, async () => {
      await assert.rejects(pullRequestReviews({ pr: "17", repo: "alek/site" }), /GITHUB_TOKEN is not set/);
    });
  } finally {
    gh.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Lead reads a pull request's reviews with pull_request_reviews; its tools never see the token", async () => {
  const gh = await fakeGitHub();
  const t = await tempStore();
  const token = newToken();
  const repo = join(t.work, "site");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/alek/site.git"]);
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "reviews-box",
    env: { GITHUB_TOKEN: TOKEN, ANTH_GITHUB_API: gh.origin },
  });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("alek", "site", { name: "Site" });
    const s = await client.createSession({ name: "Site build", cwd: repo, model: faux, project: "alek/site" });
    const lead = client.agent(s.id, "main");
    assert.ok((await lead.get()).tools.find((x) => x.name === "pull_request_reviews")?.offered);
    const answer = await lead.send("reviews: 17", "followUp", "reviews-1", 30000);
    assert.equal(answer.status, "done");
    let md = "";
    await until(async () => (md = JSON.stringify(await lead.transcript("markdown"))).includes("Cost must come from usage.cost"), 15000, "the review in the transcript");
    assert.match(md, /ledger\.init\(db\) is never called/);
    assert.doesNotMatch(md, new RegExp(TOKEN));
    const leak = await lead.send("!echo token=[$GITHUB_TOKEN]", "followUp", "leak", 30000);
    assert.match(leak.status === "done" ? leak.answer.text : "", /token=\[\]/);
  } finally {
    await server.stop();
    gh.server.close();
    await t.cleanup();
  }
});
