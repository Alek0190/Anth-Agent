// deploy/anth-deploy.sh, run for real with stand-ins for docker, curl and caddy on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../../../deploy/anth-deploy.sh");

/** A server root with one app and fake docker/curl that record what they were asked to do. */
function server() {
  const root = mkdtempSync(join(tmpdir(), "anth-deploy-"));
  const bin = join(root, "bin");
  const srv = join(root, "srv");
  const app = join(srv, "site");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "images"), { recursive: true });
  mkdirSync(app, { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(
    join(app, "app.env"),
    'DOMAINS="site.test, www.site.test"\nPREVIEW_DOMAIN="preview.site.test"\nBASE_PORT=18000\nAPP_PORT=3000\nHEALTH_PATH="/health"\nDATA_DIR="/app/data"\n',
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
echo "docker $*" >> ${log}
case "$1" in
  build) tag="$4"; [ -f "$5/Dockerfile" ] || exit 1; touch "${root}/images/$tag" ;;
  image) [ -f "${root}/images/$3" ] ;;
  inspect) [ -f "${root}/preview-image" ] && cat "${root}/preview-image" ;;
  run) if [ "$2" = -d ] && [ "$4" = anth-site-preview ]; then echo "\${@: -1}" > "${root}/preview-image"; fi ;;
  rm) if [[ "$*" == *anth-site-preview* ]]; then rm -f "${root}/preview-image"; fi ;;
  logs) for i in 1 2 3; do echo "2026-10-27T14:00:0$i.000000000Z line $i of \${@: -1}"; done; echo "2026-10-27T14:00:04.000000000Z $(printf 'x%.0s' {1..5000})"; echo "stderr line" >&2 ;;
esac
`,
  );
  // curl fails for the port named in FAIL_PORT, so a test can make one slot unhealthy.
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho "curl $*" >> ${log}\n[ -n "$FAIL_PORT" ] && [[ "$*" == *":$FAIL_PORT/"* ]] && exit 22\nexit 0\n`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  /** Run anth-deploy with these args (or a forced-command string), feeding `input` on stdin. */
  const run = (args: string[], opts: { input?: Buffer; forced?: string; failPort?: number; reload?: string; env?: Record<string, string> } = {}) => {
    const r = spawnSync("bash", [SCRIPT, ...args], {
      input: opts.input ?? Buffer.alloc(0),
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        ANTH_DEPLOY_ROOT: srv,
        ANTH_CADDY_RELOAD: opts.reload ?? `echo caddy-reload`,
        ANTH_HEALTH_TRIES: "2",
        ...(opts.forced !== undefined ? { SSH_ORIGINAL_COMMAND: opts.forced } : {}),
        ...(opts.failPort ? { FAIL_PORT: String(opts.failPort) } : {}),
        ...opts.env,
      },
    });
    return { code: r.status, out: r.stdout.toString().trim(), err: r.stderr.toString() };
  };
  /** A tar of a tiny project with a Dockerfile (or without). */
  const tarball = (withDockerfile = true) => {
    const src = mkdtempSync(join(root, "src-"));
    writeFileSync(join(src, "index.js"), "console.log('hi')\n");
    if (withDockerfile) writeFileSync(join(src, "Dockerfile"), "FROM node:24-alpine\n");
    return spawnSync("tar", ["-c", "-C", src, "."]).stdout;
  };
  /** Everything the fake docker and curl were asked to do. */
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  /** A file in the app folder, trimmed. */
  const file = (name: string) => readFileSync(join(app, name), "utf8").trim();
  return { root, app, run, tarball, calls, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("anth-deploy: preview, zero-downtime promote between slots, rollback, refusals", () => {
  const s = server();
  try {
    // Preview: builds the image and runs it on the preview slot (base + 2).
    const preview = s.run(["preview", "site", "abc1234"], { input: s.tarball() });
    assert.equal(preview.code, 0, preview.err);
    assert.equal(preview.out, "https://preview.site.test");
    assert.match(s.calls(), /docker build -q -t anth-site:abc1234/);
    assert.match(s.calls(), /docker run -d --name anth-site-preview .*-p 127\.0\.0\.1:18002:3000 .*-v .*preview-data:\/app\/data anth-site:abc1234/);
    assert.ok(existsSync(join(s.app, "releases", "abc1234", "Dockerfile")));

    // First promote: slot 0, Caddy points production at 18000 and preview at 18002.
    const first = s.run(["promote", "site", "abc1234"]);
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out, "https://site.test");
    assert.equal(s.file("current"), "0 abc1234");
    assert.match(s.file("Caddyfile"), /site\.test, www\.site\.test \{[\s\S]*reverse_proxy 127\.0\.0\.1:18000/);
    assert.match(s.file("Caddyfile"), /preview\.site\.test \{[\s\S]*reverse_proxy 127\.0\.0\.1:18002/);
    assert.match(s.calls(), /-v .*\/srv\/site\/data:\/app\/data anth-site:abc1234/);
    assert.match(first.err, /caddy-reload/);

    // Second release goes to slot 1 while slot 0 still serves; then slot 0 stops.
    assert.equal(s.run(["preview", "site", "def5678"], { input: s.tarball() }).code, 0);
    assert.equal(s.run(["promote", "site", "def5678"]).code, 0);
    assert.equal(s.file("current"), "1 def5678");
    assert.equal(s.file("previous"), "0 abc1234");
    assert.match(s.file("Caddyfile"), /reverse_proxy 127\.0\.0\.1:18001/);
    assert.match(s.calls(), /docker stop anth-site-0/);

    // Promoting what is already live changes nothing.
    const again = s.run(["promote", "site", "def5678"]);
    assert.equal(again.code, 0);
    assert.match(again.err, /already production/);

    // Rollback brings the previous image back on the other slot.
    const back = s.run(["rollback", "site"]);
    assert.equal(back.code, 0, back.err);
    assert.equal(s.file("current"), "0 abc1234");
    assert.equal(s.file("previous"), "1 def5678");
    assert.match(s.file("Caddyfile"), /reverse_proxy 127\.0\.0\.1:18000/);

    // A release that fails its health check never reaches production.
    assert.equal(s.run(["preview", "site", "bad0000"], { input: s.tarball() }).code, 0);
    const unhealthy = s.run(["promote", "site", "bad0000"], { failPort: 18001 });
    assert.notEqual(unhealthy.code, 0);
    assert.match(unhealthy.err, /did not answer on \/health; production is unchanged/);
    assert.equal(s.file("current"), "0 abc1234");

    // Caddy rejects the new config: the old Caddyfile comes back, production and its state are unchanged.
    const live = s.file("Caddyfile");
    assert.equal(s.run(["preview", "site", "cad0000"], { input: s.tarball() }).code, 0);
    const rejected = s.run(["promote", "site", "cad0000"], { reload: "false" });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.err, /caddy reload failed; production is unchanged/);
    assert.equal(s.file("Caddyfile"), live);
    assert.equal(s.file("current"), "0 abc1234");
    assert.equal(existsSync(join(s.app, "Caddyfile.bak")), false);

    // Refusals: no image, no Dockerfile, bad names, unknown commands.
    assert.match(s.run(["promote", "site", "fff9999"]).err, /no image for fff9999/);
    assert.match(s.run(["preview", "site", "abc9999"], { input: s.tarball(false) }).err, /no Dockerfile/);
    assert.match(s.run(["preview", "Site!", "abc1234"]).err, /invalid app name/);
    assert.match(s.run(["preview", "site", "not-a-sha"]).err, /invalid commit/);
    assert.match(s.run(["shell", "site"]).err, /usage/);
    assert.match(s.run(["status", "nope"]).err, /not set up on this server/);
  } finally {
    s.cleanup();
  }
});

test("anth-deploy logs: production's lines since a time, bounded, read only, never waiting for a deploy", () => {
  const s = server();
  try {
    assert.match(s.run(["logs", "site", "1700000000"]).err, /no production deployment yet/);
    assert.equal(s.run(["preview", "site", "abc1234"], { input: s.tarball() }).code, 0);
    assert.equal(s.run(["promote", "site", "abc1234"]).code, 0);
    // A deploy holds the lock for minutes; reading logs must not wait for it.
    const held = spawnSync("bash", ["-c", `exec 9>"${join(s.app, ".lock")}"; flock 9; ANTH_DEPLOY_ROOT=${join(s.root, "srv")} PATH=${join(s.root, "bin")}:$PATH timeout 10 bash ${SCRIPT} logs site 1700000000`]);
    assert.equal(held.status, 0, held.stderr.toString());
    const out = held.stdout.toString().trim().split("\n");
    assert.deepEqual(out.slice(0, 3), [
      "2026-10-27T14:00:01.000000000Z line 1 of anth-site-0",
      "2026-10-27T14:00:02.000000000Z line 2 of anth-site-0",
      "2026-10-27T14:00:03.000000000Z line 3 of anth-site-0",
    ]);
    assert.equal(out[3].length, 4000, "each line is cut to 4000 characters");
    assert.ok(out.includes("stderr line"), "the app's stderr is read too");
    assert.match(s.calls(), /docker logs --timestamps --since 1700000000 anth-site-0/);
    // The newest ANTH_LOG_LINES at most.
    assert.equal(s.run(["logs", "site", "1700000000"], { env: { ANTH_LOG_LINES: "2" } }).out.split("\n").length, 2);
    // Over the forced command, and nothing but a number as the time.
    assert.equal(s.run([], { forced: "logs site 1700000000" }).code, 0);
    const marker = join(s.root, "pwned");
    for (const bad of ["logs site 1h", `logs site 1700000000; touch ${marker}`, "logs site", `logs site $(touch ${marker})`])
      assert.notEqual(s.run([], { forced: bad }).code, 0, bad);
    assert.equal(existsSync(marker), false);
  } finally {
    s.cleanup();
  }
});

test("anth-deploy as a forced command: reads SSH_ORIGINAL_COMMAND and never runs anything else", () => {
  const s = server();
  try {
    assert.equal(s.run(["preview", "site", "abc1234"], { input: s.tarball() }).code, 0);
    assert.equal(s.run([], { forced: "promote site abc1234" }).code, 0);
    const status = s.run([], { forced: "anth-deploy status site" });
    assert.equal(status.code, 0);
    assert.match(status.out, /current: abc1234 \(slot 0\)/);
    // Shell syntax is just text: "site;" is not a valid app name, and nothing after it runs.
    const marker = join(s.root, "pwned");
    const attack = s.run([], { forced: `status site; touch ${marker}` });
    assert.notEqual(attack.code, 0);
    assert.equal(existsSync(marker), false);
    const sub = s.run([], { forced: `status $(touch ${marker})` });
    assert.notEqual(sub.code, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    s.cleanup();
  }
});

test("anth-deploy: /anth-health stays open; just server lock puts production and preview behind a password", () => {
  const s = server();
  try {
    assert.equal(s.run(["preview", "site", "abc1234"], { input: s.tarball() }).code, 0);
    assert.equal(s.run(["promote", "site", "abc1234"]).code, 0);
    const open = s.file("Caddyfile");
    assert.match(open, /handle \/anth-health \{\n\t\trewrite \* \/health\n\t\treverse_proxy 127\.0\.0\.1:18000/);
    assert.doesNotMatch(open, /basicauth/);

    // The lock script with a stand-in caddy: only a hash is stored, and the live Caddyfile is rewritten.
    const bin = join(s.root, "bin");
    writeFileSync(join(bin, "caddy"), `#!/usr/bin/env bash\n[ "$1" = hash-password ] && echo '$2a$14$fakeHASHfor'"$(printf %s "$3" | wc -c)"\n`);
    chmodSync(join(bin, "caddy"), 0o755);
    const deployBin = join(s.root, "anth-deploy");
    writeFileSync(deployBin, `#!/usr/bin/env bash\nexec bash ${SCRIPT} "$@"\n`);
    chmodSync(deployBin, 0o755);
    const LOCK = resolve(import.meta.dirname, "../../../deploy/server-lock.sh");
    /** Run server-lock.sh as `just server lock|unlock` does: an optional PW= line, then the script, on stdin. */
    const lock = (pw?: string) =>
      spawnSync("bash", ["-s", "--", "site", "alex"], {
        input: Buffer.concat([Buffer.from(pw === undefined ? "" : `PW=${pw}\n`), readFileSync(LOCK)]),
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: s.root, ANTH_DEPLOY_ROOT: join(s.root, "srv"), ANTH_DEPLOY_BIN: deployBin, ANTH_CADDY_RELOAD: "echo caddy-reload", ANTH_HEALTH_TRIES: "2" },
      });
    const locked = lock("correct-horse-battery");
    assert.equal(locked.status, 0, locked.stderr.toString());
    assert.match(s.file("app.env"), /^BASIC_AUTH_USER=alex$/m);
    assert.doesNotMatch(s.file("app.env"), /correct-horse/);
    const caddy = s.file("Caddyfile");
    // Both sites: the health path open, everything else behind the password.
    assert.equal(caddy.match(/basicauth \{\n\t\t\talex \$2a\$14\$fakeHASHfor21\n\t\t\}/g)?.length, 2);
    assert.match(caddy, /handle \/anth-health \{[^}]*\}\n\thandle \{\n\t\tbasicauth/);
    // Later deploys keep the password; unlock removes it.
    assert.equal(s.run(["preview", "site", "def5678"], { input: s.tarball() }).code, 0);
    assert.equal(s.run(["promote", "site", "def5678"]).code, 0);
    assert.match(s.file("Caddyfile"), /reverse_proxy 127\.0\.0\.1:18001/);
    assert.match(s.file("Caddyfile"), /basicauth/);
    assert.equal(lock().status, 0);
    assert.doesNotMatch(s.file("Caddyfile"), /basicauth/);
    assert.doesNotMatch(s.file("app.env"), /BASIC_AUTH/);
    assert.match(s.run(["refresh", "nope"]).err, /not set up/);
  } finally {
    s.cleanup();
  }
});

test("anth-deploy: a protected preview starts on a fresh copy of production's data; an open one never does", async () => {
  const s = server();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    // Production data: a JSON file, a folder, a SQLite database in WAL mode with writes not yet checkpointed, and a
    // file that only looks like a database (its snapshot fails, so its plain copy must stay whole).
    const data = join(s.app, "data");
    mkdirSync(join(data, "backups"), { recursive: true });
    writeFileSync(join(data, "sites.json"), '[{"slug":"bistro"}]');
    writeFileSync(join(data, "backups", "old.json"), "{}");
    writeFileSync(join(data, "broken.db"), "SQLite format 3\0not really a database");
    const db = new DatabaseSync(join(data, "app.db"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE users(email TEXT); INSERT INTO users VALUES('a@example.com'),('b@example.com');");
    // The preview's leftovers from last time must go.
    const previewData = join(s.app, "preview-data");
    mkdirSync(previewData, { recursive: true });
    writeFileSync(join(previewData, "stale.json"), "old preview");
    const local = { ANTH_DATA_COPY: "local" };
    const env = () => readFileSync(join(s.app, "app.env"), "utf8");

    // No password: real users' data stays out of the preview.
    const open = s.run(["preview", "site", "abc1234"], { input: s.tarball(), env: local });
    assert.equal(open.code, 0, open.err);
    assert.match(open.err, /has no password, so it does not get a copy of production's data/);
    assert.ok(existsSync(join(previewData, "stale.json")));
    assert.ok(!existsSync(join(previewData, "sites.json")));
    assert.match(s.calls(), /docker run -d --name anth-site-preview .*-e ANTH_PREVIEW=1/);

    // Preview locked (production public): the copy is made, SQLite as a consistent snapshot, stale files gone.
    writeFileSync(join(s.app, "app.env"), env() + "BASIC_AUTH_USER=alex\nBASIC_AUTH_HASH='$2a$14$x'\nBASIC_AUTH_SCOPE=preview\n");
    const locked = s.run(["preview", "site", "def5678"], { input: s.tarball(), env: local });
    assert.equal(locked.code, 0, locked.err);
    assert.match(locked.err, /copying production's data into the preview/);
    assert.match(locked.err, /consistent snapshot of app\.db/);
    assert.equal(readFileSync(join(previewData, "sites.json"), "utf8"), '[{"slug":"bistro"}]');
    assert.ok(existsSync(join(previewData, "backups", "old.json")));
    assert.ok(!existsSync(join(previewData, "stale.json")));
    assert.ok(!existsSync(join(previewData, "app.db-wal")), "the snapshot replaces the copy's WAL");
    const copy = new DatabaseSync(join(previewData, "app.db"), { readOnly: true });
    assert.equal((copy.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 2);
    copy.close();
    // A snapshot that fails keeps the plain copy, whole.
    assert.match(locked.err, /no consistent snapshot of broken\.db .*keeps the plain copy/);
    assert.equal(readFileSync(join(previewData, "broken.db"), "latin1"), "SQLite format 3\0not really a database");
    assert.ok(!existsSync(join(previewData, "broken.db.anth-snapshot")));
    db.close();
    // Production's own data is untouched; no staging folders are left behind.
    assert.equal(readFileSync(join(data, "sites.json"), "utf8"), '[{"slug":"bistro"}]');
    assert.ok(!existsSync(join(s.app, "preview-data.next")));
    assert.deepEqual(readdirSync(s.app).filter((f) => f.startsWith(".discard-")), []);

    // A copy that fails leaves the preview with the data it had.
    writeFileSync(join(previewData, "mine.json"), "preview only");
    const failing = join(s.root, "failing-bin");
    mkdirSync(failing);
    writeFileSync(join(failing, "cp"), "#!/bin/sh\necho 'cp: disk full' >&2\nexit 1\n");
    chmodSync(join(failing, "cp"), 0o755);
    const failed = s.run(["preview", "site", "abc9876"], { input: s.tarball(), env: { ...local, PATH: `${join(s.root, "bin")}:${failing}:${process.env.PATH}` } });
    assert.equal(failed.code, 0, failed.err);
    assert.match(failed.err, /copying production's data failed; the preview keeps the data it had/);
    assert.ok(existsSync(join(previewData, "mine.json")));
    assert.ok(existsSync(join(previewData, "sites.json")));
    assert.ok(!existsSync(join(s.app, "preview-data.next")));

    // On the server the copy runs in a container as root, with production's data read-only and no network.
    const docker = s.run(["preview", "site", "abc5555"], { input: s.tarball() });
    assert.equal(docker.code, 0, docker.err);
    assert.match(s.calls(), /docker run --rm --user 0:0 --network none --entrypoint sh [\s\S]*? -v \S+\/data:\/from:ro -v \S+\/preview-data\.next:\/to anth-site:abc5555 /);

    // Scope preview: production is public, the preview asks for the password.
    assert.equal(s.run(["promote", "site", "def5678"]).code, 0);
    const [prod, preview] = s.file("Caddyfile").split("preview.site.test {");
    assert.doesNotMatch(prod, /basicauth/);
    assert.match(preview, /basicauth \{\n\t\t\talex/);

    // PREVIEW_DATA=empty: the preview keeps its own data even when locked.
    writeFileSync(join(previewData, "mine.json"), "preview only");
    writeFileSync(join(s.app, "app.env"), env() + "PREVIEW_DATA=empty\n");
    const kept = s.run(["preview", "site", "abc9876"], { input: s.tarball(), env: local });
    assert.equal(kept.code, 0, kept.err);
    assert.match(kept.err, /keeps its own data \(PREVIEW_DATA=empty\)/);
    assert.ok(existsSync(join(previewData, "mine.json")));

    // Unlock: the copy leaves the preview before the password does, and the preview starts again on empty data.
    writeFileSync(join(s.app, "app.env"), env().replace(/^BASIC_AUTH_.*\n/gm, ""));
    const before = s.calls().length;
    const unlocked = s.run(["refresh", "site"], { env: local });
    assert.equal(unlocked.code, 0, unlocked.err);
    assert.match(unlocked.err, /removing its copy of production's data/);
    assert.deepEqual(readdirSync(previewData), []);
    assert.ok(!existsSync(join(s.app, "preview-data.production")));
    assert.doesNotMatch(s.file("Caddyfile"), /basicauth/);
    const after = s.calls().slice(before);
    assert.match(after, /docker rm -f anth-site-preview[\s\S]*docker run -d --name anth-site-preview .*-e ANTH_PREVIEW=1 .*anth-site:abc9876/);
    // The copy is gone before Caddy drops the password.
    assert.ok(unlocked.err.indexOf("removing its copy") < unlocked.err.indexOf("caddy-reload"));
    assert.ok(unlocked.err.includes("caddy-reload"));

    // And a copy left on an open preview by older versions is never served: the next ship removes it first.
    writeFileSync(join(previewData, "users.json"), "real users");
    writeFileSync(join(s.app, "preview-data.production"), "");
    const reopened = s.run(["preview", "site", "abc4444"], { input: s.tarball(), env: local });
    assert.equal(reopened.code, 0, reopened.err);
    assert.ok(!existsSync(join(previewData, "users.json")));
  } finally {
    s.cleanup();
  }
});
