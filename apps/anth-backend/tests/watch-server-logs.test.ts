// Watch and fix for a project that ships to an app server: the watch reads the app's log lines with the deploy key. A
// fake ssh hands the command to the real deploy/anth-deploy.sh as a forced command (SSH_ORIGINAL_COMMAND), and a fake
// docker prints whatever the test wrote as the production container's log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const SCRIPT = resolve(import.meta.dirname, "../../../deploy/anth-deploy.sh");

/** Run git in a folder and return its trimmed output. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Docker-style log lines: a timestamp, then the app's own output. */
const lines = (at: number, ...text: string[]) => text.map((l, i) => `${new Date(at + i).toISOString()} ${l}`).join("\n") + "\n";

test("watch and fix on an app server: the app's error lines arrive over the deploy key, redacted, and open an incident", async () => {
  const t = await tempStore();
  const token = newToken();

  // The live site (healthy: the errors are only in the log).
  const site = createServer((_req, res) => res.end("site"));
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  // The app server: the app set up and in production on slot 0, a docker whose `logs` prints the test's log file.
  const fake = join(t.root, "server");
  const bin = join(fake, "bin");
  const srv = join(fake, "srv");
  const calls = join(fake, "calls.log");
  const containerLog = join(fake, "container.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(srv, "site"), { recursive: true });
  writeFileSync(join(srv, "site", "app.env"), 'DOMAINS="site.test"\nPREVIEW_DOMAIN="preview.site.test"\nBASE_PORT=18000\n');
  writeFileSync(join(srv, "site", "current"), "0 abc1234\n");
  writeFileSync(containerLog, "");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> ${calls}\n[ "$1" = logs ] && cat ${containerLog}\nexit 0\n`);
  const ssh = join(t.root, "ssh");
  const sshBody = (run: string) => `#!/usr/bin/env bash
key=""
while [ $# -gt 0 ]; do case "$1" in -i) key="$2"; shift 2 ;; -o) shift 2 ;; *) break ;; esac; done
target="$1"; shift
echo "ssh $target $* key-mode=$(stat -c %a "$key")" >> ${calls}
${run}
`;
  writeFileSync(ssh, sshBody(`SSH_ORIGINAL_COMMAND="$*" ANTH_DEPLOY_ROOT=${srv} PATH=${bin}:$PATH exec bash ${SCRIPT}`));
  for (const f of [join(bin, "docker"), ssh]) chmodSync(f, 0o755);

  // The project ships to that server (anth.json), and its repository has an origin for the incident's worktree.
  const repo = join(t.work, "site");
  const remote = join(t.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(t.work, "init", "-q", "-b", "main", "site");
  git(repo, "config", "user.name", "Alex");
  git(repo, "config", "user.email", "alex@example.com");
  writeFileSync(join(repo, "anth.json"), JSON.stringify({ productionUrl: origin, deploy: { target: "server", host: "app.example.com", app: "site" } }));
  writeFileSync(join(repo, "server.js"), "module.exports = (sub) => sub.data.items.length;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v1");
  git(repo, "remote", "add", "origin", "https://github.com/acme/site.git");
  git(repo, "config", `url.${remote}.pushInsteadOf`, "https://github.com/acme/site.git");
  git(repo, "push", "-q", "origin", "main");
  // A second project on Vercel, to show server logs are refused where there is no app server.
  const other = join(t.work, "vercel-site");
  mkdirSync(other);
  writeFileSync(join(other, "anth.json"), JSON.stringify({ productionUrl: origin }));

  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nfakekeymaterial\n-----END OPENSSH PRIVATE KEY-----\n";
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "watch-server-box",
    env: { ANTH_WATCH_INTERVAL_MS: "0", ANTH_SSH_BIN: ssh, ANTH_DEPLOY_SSH_KEY: Buffer.from(key).toString("base64") },
  });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "site", { name: "Site" });
    await client.putProject("acme", "other", { name: "Other" });
    const s = await client.createSession({ name: "Site", cwd: t.work, model: faux, project: "acme/site", env: "prod" });

    // A new watch of a project that ships to an app server reads its server logs, not Vercel's.
    const watch = await client.putWatch("acme", "site", { sessionId: s.id, path: "site", url: origin });
    assert.deepEqual([watch.serverLogs, watch.vercel], [true, false]);
    // Server logs need an app server in anth.json; a Vercel project keeps the old default.
    await assert.rejects(() => client.putWatch("acme", "other", { sessionId: s.id, path: "vercel-site", url: origin, serverLogs: true }), /Server logs need anth\.json/);
    const vercel = await client.putWatch("acme", "other", { sessionId: s.id, path: "vercel-site", url: origin, enabled: false });
    assert.deepEqual([vercel.serverLogs, vercel.vercel], [false, true]);

    // A quiet log: nothing to record, and the read went over the deploy key to anth-deploy logs.
    writeFileSync(containerLog, lines(Date.now(), "Server listening on port 3000"));
    assert.deepEqual(await client.watchTick("acme", "site"), { events: 0, errors: [] });
    const log = readFileSync(calls, "utf8");
    assert.match(log, /ssh anth@app\.example\.com logs site \d{10} key-mode=600/);
    assert.match(log, /docker logs --timestamps --since \d{10} anth-site-0/);

    // Three crashes with one cause (a stack trace each, a visitor's email in the line) open one incident.
    const now = Date.now();
    writeFileSync(
      containerLog,
      lines(now - 3000, "Server listening on port 3000") +
        [0, 1, 2]
          .map((i) =>
            lines(
              now - 2000 + i * 100,
              `TypeError: Cannot read properties of undefined (reading 'items') for visitor${i}@example.com`,
              "    at module.exports (/app/server.js:1:41)",
              "    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
            ),
          )
          .join(""),
    );
    const tick = await client.watchTick("acme", "site");
    assert.deepEqual(tick, { events: 3, errors: [] });
    const events = await client.watchEvents("acme", "site");
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.source === "server-log" && e.verdict === "incident" && e.incident === 1));
    assert.ok(events.every((e) => !e.message.includes("@example.com") && e.message.includes("<email>")), "no visitor email is kept");
    assert.ok(events.every((e) => e.message.includes("at module.exports (/app/server.js:1:41)")), "the stack trace stays with its error");
    const [incident] = await client.incidents("acme", "site");
    assert.equal(incident.status, "fixing");
    const agent = (await client.session(s.id).agents()).find((a) => a.name === "Incident #1");
    assert.equal(agent?.id, incident.conversationId);
    await until(
      async () => JSON.stringify(await client.agent(s.id, agent!.id).transcript("markdown")).includes("Cannot read properties of undefined"),
      15000,
      "the incident brief with the log line",
    );

    // The next tick reads the same lines again (the reads overlap) and records nothing twice.
    await client.watchTick("acme", "site");
    assert.equal((await client.watchEvents("acme", "site")).length, 3);
    assert.equal((await client.incidents("acme", "site")).length, 1);

    // An app server whose anth-deploy predates logs: the watch says how to update it, and keeps its place.
    writeFileSync(ssh, sshBody(`echo "anth-deploy: usage: preview <app> <sha> | promote <app> <sha> | rollback <app> | status <app> | refresh <app>" >&2; exit 1`));
    const old = await client.watchTick("acme", "site");
    assert.match(old.errors.join(" "), /no logs command yet: run just server update root@app\.example\.com/);
    assert.match((await client.watch("acme", "site")).lastError ?? "", /just server update/);
    // The key never shows in what the watch reports.
    assert.ok(!JSON.stringify(await client.watch("acme", "site")).includes("fakekeymaterial"));
  } finally {
    await server.stop();
    site.close();
    await t.cleanup();
  }
});
