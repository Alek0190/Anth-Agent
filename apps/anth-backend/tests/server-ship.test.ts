// The ship and rollback jobs with an app-server target: a fake ssh hands the command to the real deploy/anth-deploy.sh
// as a forced command (SSH_ORIGINAL_COMMAND), with stand-ins for docker and curl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import type { JobRun, JobRunsDoc } from "../../anth-sdk/src/jobs.js";
import { parseStatus, parseTarget } from "../src/ship.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const SCRIPT = resolve(import.meta.dirname, "../../../deploy/anth-deploy.sh");

/** Read a request body as JSON. */
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Run git in a folder and return its trimmed output. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("anth.json deploy targets are validated", () => {
  assert.deepEqual(parseTarget(undefined), { kind: "vercel" });
  assert.deepEqual(parseTarget({ target: "server", host: "203.0.113.7", app: "site" }), { kind: "server", host: "203.0.113.7", user: "anth", app: "site" });
  assert.throws(() => parseTarget({ target: "ftp" }), /must be "vercel" or "server"/);
  assert.throws(() => parseTarget({ target: "server", host: "x; rm -rf /", app: "site" }), /deploy.host/);
  assert.throws(() => parseTarget({ target: "server", host: "h", app: "Site!" }), /deploy.app/);
  assert.deepEqual(parseStatus("current: abc1234 (slot 0)\nprevious: def5678\n"), { current: "abc1234", previous: "def5678" });
  assert.deepEqual(parseStatus("current:  (slot )\nprevious: none\n"), { current: "", previous: "" });
});

test("ship to an app server: preview over ssh, approval, zero-downtime promote, verify, rollback; the key never reaches agents", async () => {
  const t = await tempStore();
  const token = newToken();

  // The production site and the GitHub API on one local server.
  const pulls: { head: string }[] = [];
  const site = createServer(async (req, res) => {
    if (req.url?.startsWith("/repos/acme/site/pulls")) {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        pulls.push(await body(req));
        return res.end(JSON.stringify({ number: 1, html_url: "https://github.com/acme/site/pull/1" }));
      }
      return res.end("[]");
    }
    res.end("ok");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const host = `127.0.0.1:${(site.address() as { port: number }).port}`;

  // The "server": /srv/anth/site set up as server-setup.sh would, fake docker and curl, and an ssh that runs anth-deploy.
  const fake = join(t.root, "server");
  const bin = join(fake, "bin");
  const srv = join(fake, "srv");
  const log = join(fake, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(fake, "images"), { recursive: true });
  mkdirSync(join(srv, "site"), { recursive: true });
  writeFileSync(join(srv, "site", "app.env"), `DOMAINS="${host}/prod"\nPREVIEW_DOMAIN="${host}/preview"\nBASE_PORT=18000\nAPP_PORT=3000\nHEALTH_PATH="/"\n`);
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash\necho "docker $*" >> ${log}\ncase "$1" in build) touch "${fake}/images/$4" ;; image) [ -f "${fake}/images/$3" ] ;; esac\n`,
  );
  writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const ssh = join(t.root, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
key=""
while [ $# -gt 0 ]; do case "$1" in -i) key="$2"; shift 2 ;; -o) shift 2 ;; *) break ;; esac; done
target="$1"; shift
echo "ssh $target $* key-mode=$(stat -c %a "$key") key-ok=$(grep -q 'PRIVATE KEY' "$key" && echo yes)" >> ${log}
SSH_ORIGINAL_COMMAND="$*" ANTH_DEPLOY_ROOT=${srv} ANTH_CADDY_RELOAD=true ANTH_URL_SCHEME=http ANTH_HEALTH_TRIES=2 PATH=${bin}:$PATH exec bash ${SCRIPT}
`,
  );
  for (const f of [join(bin, "docker"), join(bin, "curl"), ssh]) chmodSync(f, 0o755);
  /** Everything the fake ssh and docker were asked to do. */
  const calls = () => readFileSync(log, "utf8");

  // The project: a Dockerfile, an anth.json pointing at the server, and a GitHub-style origin.
  const repo = join(t.work, "site");
  const remote = join(t.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(t.work, "init", "-q", "-b", "main", "site");
  git(repo, "config", "user.name", "Alex");
  git(repo, "config", "user.email", "alex@example.com");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "Dockerfile"), "FROM node:24-alpine\nCOPY . /app\nCMD node /app/server.js\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "echo tested" } }));
  writeFileSync(join(repo, "anth.json"), JSON.stringify({ productionUrl: `http://${host}/prod`, deploy: { target: "server", host: "app.example.com", app: "site" } }));
  writeFileSync(join(repo, "index.html"), "v1");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v1");
  git(repo, "remote", "add", "origin", "https://github.com/acme/site.git");
  git(repo, "config", `url.${remote}.pushInsteadOf`, "https://github.com/acme/site.git");
  git(repo, "push", "-q", "origin", "main");
  writeFileSync(join(repo, "index.html"), "v2");

  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nfakekeymaterial\n-----END OPENSSH PRIVATE KEY-----\n";
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "ship-server-box",
    env: {
      ANTH_SSH_BIN: ssh,
      ANTH_DEPLOY_SSH_KEY: Buffer.from(key).toString("base64"),
      ANTH_GITHUB_API: `http://${host}`,
      GITHUB_TOKEN: "gh-secret-456",
    },
  });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "site", { name: "Site" });
    const s = await client.createSession({ name: "Site", cwd: t.work, model: faux, project: "acme/site" });
    const lead = client.agent(s.id, "main");
    const leak = await lead.send("!echo key=[$ANTH_DEPLOY_SSH_KEY]", "followUp", "leak", 30000);
    assert.match(leak.status === "done" ? leak.answer.text : "", /key=\[\]/);

    /** The job run record for a task. */
    const runOf = async (id: number) => (await lead.doc<JobRunsDoc>("demo.job-runs")).value.items[String(id)] as JobRun;
    /** Wait until a run reaches a status; fail fast if it failed. */
    const waitFor = (id: number, status: string) =>
      until(async () => {
        const r = await runOf(id);
        if (r?.status === "failed") throw Error(`${r.job} failed: ${r.error}`);
        return r?.status === status;
      }, 90000, `run ${id} ${status}`);

    const { taskId } = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site" } });
    await waitFor(taskId, "waiting");
    const sha = git(repo, "rev-parse", "--short=12", "HEAD");
    assert.match(calls(), new RegExp(`ssh anth@app\\.example\\.com preview site ${sha} key-mode=600 key-ok=yes`));
    assert.match(calls(), new RegExp(`docker build -q -t anth-site:${sha}`));
    assert.doesNotMatch(calls(), /promote/);
    assert.equal((await runOf(taskId)).phases.find((p) => p.id === "preview")?.summary, `http://${host}/preview`);
    assert.equal(pulls.length, 1);
    assert.doesNotMatch(JSON.stringify(await runOf(taskId)), /fakekeymaterial/);

    await lead.demo(`jobs/${taskId}/approval`, { approved: true });
    await waitFor(taskId, "completed");
    assert.match(calls(), new RegExp(`ssh anth@app\\.example\\.com promote site ${sha}`));
    assert.equal(readFileSync(join(srv, "site", "current"), "utf8").trim(), `0 ${sha}`);
    assert.match(readFileSync(join(srv, "site", "Caddyfile"), "utf8"), /reverse_proxy 127\.0\.0\.1:18000/);
    assert.match((await runOf(taskId)).result ?? "", /\/prod answers 200/);
    // Checks on an app server go to /anth-health, which stays open when the site has a password.
    assert.equal((await runOf(taskId)).phases.find((p) => p.id === "check")?.summary, "Preview answers 200 on /anth-health");

    // With only one release there is nothing to roll back to: the job says so before asking for approval.
    const none = await lead.demo<{ taskId: number }>("jobs", { job: "rollback", input: { path: "site" } });
    await until(async () => (await runOf(none.taskId)).status === "failed", 30000, "rollback to fail");
    assert.match((await runOf(none.taskId)).error ?? "", /no previous production deployment/);

    // A second release, then a rollback: the target is fixed before approval and promoted by its commit.
    writeFileSync(join(repo, "index.html"), "v3");
    const second = await lead.demo<{ taskId: number }>("jobs", { job: "ship", input: { path: "site" } });
    await waitFor(second.taskId, "waiting");
    const sha2 = git(repo, "rev-parse", "--short=12", "HEAD");
    await lead.demo(`jobs/${second.taskId}/approval`, { approved: true });
    await waitFor(second.taskId, "completed");
    assert.equal(readFileSync(join(srv, "site", "current"), "utf8").trim(), `1 ${sha2}`);

    const rb = await lead.demo<{ taskId: number }>("jobs", { job: "rollback", input: { path: "site" } });
    await waitFor(rb.taskId, "waiting");
    assert.equal((await runOf(rb.taskId)).phases.find((p) => p.id === "target")?.summary, `${sha2} → ${sha}`);
    await lead.demo(`jobs/${rb.taskId}/approval`, { approved: true });
    await waitFor(rb.taskId, "completed");
    // Promoted twice by the same commit: once by the first ship, once by the rollback. No "rollback" command is sent.
    assert.equal(calls().split("\n").filter((l) => l.startsWith(`ssh anth@app.example.com promote site ${sha} `)).length, 2);
    assert.doesNotMatch(calls(), /ssh \S+ rollback /);
    assert.equal(readFileSync(join(srv, "site", "current"), "utf8").trim(), `0 ${sha}`);
  } finally {
    await server.stop();
    site.close();
    await t.cleanup();
  }
});
