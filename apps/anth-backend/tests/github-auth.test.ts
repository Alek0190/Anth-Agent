// Private repositories: the base branch is fetched with GITHUB_TOKEN, and git sends it to github.com only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseRef, githubAuth } from "../src/incident.js";

/** Run git and return its trimmed output. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("githubAuth: a basic auth header for x-access-token, sent by git to github.com only", () => {
  const before = process.env.GITHUB_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    assert.deepEqual(githubAuth(), {});
    process.env.GITHUB_TOKEN = "ghp_secret123";
    const header = githubAuth().ANTH_GIT_AUTH;
    assert.equal(header, `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghp_secret123").toString("base64")}`);
    // The same -c option baseRef uses: git applies it to https://github.com/... and to nothing else.
    const lookup = (url: string) =>
      spawnSync("git", ["-c", `http.https://github.com/.extraHeader=${header}`, "config", "--get-urlmatch", "http.extraHeader", url], { encoding: "utf8" }).stdout.trim();
    assert.equal(lookup("https://github.com/Alek0190/anthwebbuilder.git"), header);
    assert.equal(lookup("https://evil.example.com/github.com/x.git"), "");
    assert.equal(lookup("https://github.com.evil.example/x.git"), "");
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
  }
});

test("baseRef: fetches the latest base branch, also with a token set and a non-GitHub origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "anth-baseref-"));
  const before = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "ghp_secret123";
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const a = join(root, "a");
    execFileSync("git", ["clone", "-q", remote, a]);
    git(a, "config", "user.email", "a@example.com");
    git(a, "config", "user.name", "A");
    writeFileSync(join(a, "f"), "1");
    git(a, "add", "-A");
    git(a, "commit", "-qm", "one");
    git(a, "push", "-q", "origin", "main");
    const b = join(root, "b");
    execFileSync("git", ["clone", "-q", remote, b]);
    // A newer commit lands on the remote; b's local main is now behind.
    writeFileSync(join(a, "f"), "2");
    git(a, "commit", "-qam", "two");
    git(a, "push", "-q", "origin", "main");
    assert.equal(await baseRef(b, "main"), "origin/main");
    assert.equal(git(b, "rev-parse", "origin/main"), git(a, "rev-parse", "HEAD"));
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
    rmSync(root, { recursive: true, force: true });
  }
});
