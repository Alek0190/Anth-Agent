// deploy/anth-deploy.sh, run for real with stand-ins for docker, curl and caddy on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
esac
`,
  );
  // curl fails for the port named in FAIL_PORT, so a test can make one slot unhealthy.
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho "curl $*" >> ${log}\n[ -n "$FAIL_PORT" ] && [[ "$*" == *":$FAIL_PORT/"* ]] && exit 22\nexit 0\n`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  /** Run anth-deploy with these args (or a forced-command string), feeding `input` on stdin. */
  const run = (args: string[], opts: { input?: Buffer; forced?: string; failPort?: number; reload?: string } = {}) => {
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
