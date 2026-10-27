// The ship job: take what the team built from a branch to production, with one approval.
//
//   prepare → build → review → preview → check → pull request → APPROVE → promote → verify
//
// Everything before the approval runs on its own. The preview deploy is the exact build that production gets: promote
// moves that verified deployment to production without rebuilding. Deploy and GitHub steps run in the backend process
// with tokens from the device's environment (VERCEL_TOKEN, GITHUB_TOKEN), so agents never see them. Each outside effect
// is safe to repeat after a crash: the pull request is looked up before it is created, pushing the same branch again
// changes nothing, and promoting the same deployment twice leaves production as it was.
//
// Rollback is its own job: target → approve → roll back → verify. On an app server the target release is fixed before
// the approval, so a replay after a crash promotes that same release again (a no-op) instead of flipping back.
import type { JobDef } from "../../anth-sdk/src/jobs.js";
import type { Handler, Outcome, Phase } from "./jobs.js";

const RESULT = "/jobs/ship";

export const SHIP_DEFS: JobDef[] = [
  {
    id: "ship",
    title: "Ship",
    summary:
      "Commit the work to a branch, build and test it, let the reviewer and security check it, deploy a Vercel preview, check it and open a pull request. Then wait for your approval and promote that exact preview to production.",
    phases: [
      { id: "prepare", label: "Prepare", summary: "Commit the work to a ship branch" },
      { id: "build", label: "Build and test", summary: "Install, lint, build and test" },
      { id: "review", label: "Review", summary: "The reviewer and security check the diff" },
      { id: "preview", label: "Preview", summary: "Deploy a Vercel preview" },
      { id: "check", label: "Check preview", summary: "The preview answers over HTTP" },
      { id: "pr", label: "Pull request", summary: "Push the branch and open a pull request" },
      { id: "approve", label: "Approve production", summary: "Wait for your approval", kind: "approval" },
      { id: "promote", label: "Promote", summary: "Promote the checked preview to production" },
      { id: "verify", label: "Verify production", summary: "Production answers over HTTP" },
    ],
    inputs: [
      { name: "path", type: "string", default: ".", description: "Project folder, relative to the session's working directory" },
      { name: "base", type: "string", default: "auto", description: "Branch to compare and open the pull request against (auto: the current branch, or main)" },
      { name: "title", type: "string", default: "auto", description: "Commit and pull request title (auto: Anth-Agent ship #n)" },
      { name: "production_url", type: "string", default: "auto", description: "Production URL to verify (auto: productionUrl in anth.json)" },
      { name: "health_path", type: "string", default: "auto", description: "Path to check on the preview and production (auto: healthPath in anth.json, or /)" },
      { name: "github_repo", type: "string", default: "auto", description: "owner/repo for the pull request (auto: from the origin remote)" },
    ],
    approval: true,
    resultPath: RESULT,
    seconds: 120,
  },
  {
    id: "rollback",
    title: "Roll back production",
    summary: "After your approval, put the previous production deployment back on Vercel and check production answers.",
    phases: [
      { id: "target", label: "Find the release", summary: "The release production goes back to" },
      { id: "approve", label: "Approve rollback", summary: "Wait for your approval", kind: "approval" },
      { id: "rollback", label: "Roll back", summary: "Restore the previous production deployment" },
      { id: "verify", label: "Verify production", summary: "Production answers over HTTP" },
    ],
    inputs: [
      { name: "path", type: "string", default: ".", description: "Project folder, relative to the session's working directory" },
      { name: "production_url", type: "string", default: "auto", description: "Production URL to verify (auto: productionUrl in anth.json)" },
      { name: "health_path", type: "string", default: "auto", description: "Path to check (auto: healthPath in anth.json, or /)" },
    ],
    approval: true,
    resultPath: "/jobs/rollback",
    seconds: 30,
  },
];

// ------------------------------------------------------------------ helpers

/** Quote a value for bash. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** Prefix a command with `cd <dir>` unless it runs in the working directory. */
const inDir = (dir: string, command: string) => (dir === "." ? command : `cd ${q(dir)} && ${command}`);
/** True when an input was left on `auto` (or empty). */
const auto = (v: unknown) => v === undefined || v === "auto" || v === "";

/** The reviewer's verdict: the last line that starts with "VERDICT:". */
/** The blocking findings of a review report, for an error message (the whole report is in the team log). */
export function blocking(report: string) {
  // The heading must be a line of its own starting with "Blocking" ("Non-blocking:" is not it), optionally bold or a
  // markdown heading; the list ends at the next heading line or the verdict.
  const m = /^[ \t]*(?:#+[ \t]*)?\**[ \t]*blocking\b[^\n]*\n([\s\S]*?)(?=^[ \t]*(?:#+[ \t]*)?\**[ \t]*(?:follow-?ups?|non-blocking|verdict)\b|(?![\s\S]))/im.exec(report);
  return (m ? m[1] : report.split("\n").slice(-6).join("\n")).trim().slice(0, 1500);
}

export function parseVerdict(report: string): "safe" | "owner" | "changes" | undefined {
  const lines = report.split("\n").filter((l) => /^\s*\**\s*VERDICT\s*:/i.test(l));
  const line = lines.at(-1)?.toLowerCase();
  if (!line) return undefined;
  if (line.includes("changes requested")) return "changes";
  if (line.includes("owner")) return "owner";
  if (line.includes("safe to merge")) return "safe";
  return undefined;
}

/** Add the fix to a Vercel deploy failure we recognise; otherwise point at the deployment's own log. */
export function explainVercel(message: string) {
  if (/contributing access|hobby plan does not support collaboration|git author/i.test(message))
    return `${message} Vercel blocked the build because the commit author is not your Vercel account. On the Hobby plan, set git config --global user.email to your Vercel account's email, then ship again.`;
  return `${message} Open the deployment's Inspect link in the step output for Vercel's full build log.`;
}

/** Add the fix to a git push failure we recognise. */
export function explainPush(message: string, repo: string) {
  if (/write access to repository not granted|403/i.test(message))
    return `${message} GITHUB_TOKEN can reach ${repo} but cannot write to it. Edit the fine-grained token: select ${repo} under Repository access and set Contents and Pull requests to Read and write, then ship again (no restart needed).`;
  if (/repository not found|404/i.test(message))
    return `${message} GITHUB_TOKEN cannot see ${repo}. Add the repository to the token's Repository access.`;
  return message;
}

/** The remote's default branch (origin/HEAD), else main or master, whichever exists. */
async function defaultBranch(p: Phase, dir: string) {
  const head = (await p.shell(inDir(dir, "git symbolic-ref --quiet --short refs/remotes/origin/HEAD"))).out.trim();
  if (head.startsWith("origin/")) return head.slice(7);
  for (const name of ["main", "master"])
    if ((await p.shell(inDir(dir, `git rev-parse --verify --quiet ${name}`))).code === 0) return name;
  return "main";
}

/** owner/repo from a GitHub remote URL (https or ssh), or undefined for anything else. */
export function githubRepo(remote: string) {
  const m = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The first http(s) URL on the last line that has one: how the Vercel CLI prints a deployment. */
export function lastUrl(out: string) {
  for (const line of out.trim().split("\n").reverse()) {
    const m = line.match(/https?:\/\/[^\s"'<>]+/);
    if (m) return m[0].replace(/[.,)]+$/, "");
  }
  return undefined;
}

/** A trimmed environment variable from the backend process, or undefined. */
const env = (name: string) => process.env[name]?.trim() || undefined;
/** The Vercel CLI command (ANTH_VERCEL_BIN overrides it, e.g. for tests). */
const vercel = () => env("ANTH_VERCEL_BIN") ?? "vercel";
/** ` --scope <team>` when VERCEL_SCOPE is set. */
const scope = () => (env("VERCEL_SCOPE") ? ` --scope ${q(env("VERCEL_SCOPE")!)}` : "");

/** The Vercel token for a deploy step, or an error that says how to set it. */
function vercelSecrets(device: string) {
  const token = env("VERCEL_TOKEN");
  if (!token)
    throw Error(
      `VERCEL_TOKEN is not set on ${device}. Add it to .env and to env_keys in anth-network.yaml, then run just net up ${device}.`,
    );
  return { VERCEL_TOKEN: token };
}

/** Where a project deploys: Vercel (the default) or an app server reached over SSH (anth.json "deploy"). */
export type DeployTarget = { kind: "vercel" } | { kind: "server"; host: string; user: string; app: string };

/** Read and validate anth.json's "deploy" block: {"target": "server", "host": "1.2.3.4", "app": "my-app"}. */
export function parseTarget(raw: unknown): DeployTarget {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (d.target === undefined || d.target === "vercel") return { kind: "vercel" };
  if (d.target !== "server") throw Error(`anth.json deploy.target must be "vercel" or "server", not ${JSON.stringify(d.target)}`);
  const host = typeof d.host === "string" ? d.host.trim() : "";
  const app = typeof d.app === "string" ? d.app.trim() : "";
  const user = typeof d.user === "string" && d.user.trim() ? d.user.trim() : "anth";
  if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(host)) throw Error("anth.json deploy.host must be the server's address, e.g. 203.0.113.7");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(app)) throw Error("anth.json deploy.app must be the app name used in just server setup");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw Error("anth.json deploy.user must be a Unix user name");
  return { kind: "server", host, user, app };
}

/** The project's deploy target from its anth.json. */
async function deployTarget(p: Phase, dir: string) {
  const r = await p.shell(inDir(dir, "cat anth.json 2>/dev/null || true"));
  let parsed: { deploy?: unknown } = {};
  try {
    parsed = JSON.parse(r.out || "{}");
  } catch {
    throw Error("anth.json is not valid JSON");
  }
  return parseTarget(parsed.deploy);
}

/**
 * The deploy key for app servers, from ANTH_DEPLOY_SSH_KEY (the private key, base64 or as is). It never touches disk
 * outside the one command that uses it: a 0600 temp file, removed when the command ends.
 */
export function serverSecrets() {
  const raw = env("ANTH_DEPLOY_SSH_KEY");
  if (!raw)
    throw Error(
      "ANTH_DEPLOY_SSH_KEY is not set on this device. Run just server keygen, add ANTH_DEPLOY_SSH_KEY to env_keys in anth-network.yaml, then just net up <device>.",
    );
  const key = raw.includes("PRIVATE KEY") ? raw : Buffer.from(raw, "base64").toString("utf8");
  if (!key.includes("PRIVATE KEY")) throw Error("ANTH_DEPLOY_SSH_KEY is not a private key (base64 of the key file)");
  const home = env("ANTH_HOME") ?? `${env("HOME") ?? "~"}/.anth`;
  return { ANTH_DEPLOY_SSH_KEY: key.endsWith("\n") ? key : `${key}\n`, ANTH_KNOWN_HOSTS: `${home}/known_hosts` };
}

/** A shell command that runs `anth-deploy <args>` on the server with the deploy key. */
export function sshCommand(t: Extract<DeployTarget, { kind: "server" }>, args: string) {
  const ssh = env("ANTH_SSH_BIN") ?? "ssh";
  // A subshell, so a pipe into it (git archive | …) feeds ssh, and the key file goes when it ends.
  return (
    `( k=$(mktemp) && trap 'rm -f "$k"' EXIT && printf '%s' "$ANTH_DEPLOY_SSH_KEY" > "$k" && chmod 600 "$k" && ` +
    `mkdir -p "$(dirname "$ANTH_KNOWN_HOSTS")" && ` +
    `${ssh} -i "$k" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$ANTH_KNOWN_HOSTS" ` +
    `${q(`${t.user}@${t.host}`)} ${args} )`
  );
}

/** The project's anth.json: productionUrl and healthPath, when the team or you wrote one. */
async function projectConfig(p: Phase, dir: string) {
  const r = await p.shell(inDir(dir, "cat anth.json 2>/dev/null || true"));
  try {
    const parsed = JSON.parse(r.out || "{}") as { productionUrl?: unknown; healthPath?: unknown };
    return {
      productionUrl: typeof parsed.productionUrl === "string" ? parsed.productionUrl : undefined,
      healthPath: typeof parsed.healthPath === "string" ? parsed.healthPath : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The path to check: the input, else /anth-health on an app server (anth-deploy keeps it open when the site has a
 * password, and serves the app's health path there), else anth.json's healthPath, else /.
 */
async function healthPath(p: Phase, dir: string) {
  if (!auto(p.input.health_path)) return String(p.input.health_path);
  if ((await deployTarget(p, dir)).kind === "server") return "/anth-health";
  return (await projectConfig(p, dir)).healthPath ?? "/";
}

/** The production URL: the input, else anth.json's productionUrl. */
async function productionUrl(p: Phase, dir: string) {
  if (!auto(p.input.production_url)) return String(p.input.production_url);
  return (await projectConfig(p, dir)).productionUrl;
}

/** GET a URL until it answers below 400, for up to `tries` attempts; records one step. */
async function httpCheck(p: Phase, url: string, tries = 10) {
  const bypass = env("VERCEL_AUTOMATION_BYPASS_SECRET");
  return p.step("command", `GET ${url}`, async () => {
    let last = "";
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
          headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
        });
        await res.body?.cancel();
        if (res.status < 400) return { value: res.status, detail: `${res.status} ${res.statusText} after ${i + 1} attempt${i ? "s" : ""}` };
        last = `${res.status} ${res.statusText}`;
        if (res.status === 401 && !bypass)
          last += ". The preview may have Vercel Deployment Protection: set VERCEL_AUTOMATION_BYPASS_SECRET on the device";
      } catch (e) {
        last = String((e as Error).message ?? e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw Error(`${url} did not answer: ${last}`);
  });
}

/** Join a base URL and a path with exactly one slash. */
const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

/** Call the GitHub REST API with the device's token. */
async function github(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = env("GITHUB_TOKEN");
  if (!token) throw Error("GITHUB_TOKEN is not set on this device. Add it to .env and env_keys in anth-network.yaml.");
  const res = await fetch(`${env("ANTH_GITHUB_API") ?? "https://api.github.com"}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${String(data.message ?? "")}`);
  return data;
}

// ------------------------------------------------------------------ the ship job

const ship: Record<string, Handler> = {
  /** Check the folder is a clean git repo and make the release branch. */
  prepare: async (p) => {
    const dir = String(p.input.path);
    await p.exec(inDir(dir, "git rev-parse --is-inside-work-tree"), "git rev-parse --is-inside-work-tree");
    const current = (await p.exec(inDir(dir, "git rev-parse --abbrev-ref HEAD"), "git rev-parse --abbrev-ref HEAD")).trim();
    const base = auto(p.input.base) ? (current.startsWith("anth/ship-") ? await defaultBranch(p, dir) : current) : String(p.input.base);
    const branch = `anth/ship-${p.run.n}-${p.run.id}`;
    const title = auto(p.input.title) ? `Anth-Agent ship #${p.run.n}` : String(p.input.title);
    if (current !== branch) await p.exec(inDir(dir, `git checkout -B ${q(branch)}`), `git checkout -B ${branch}`);
    await p.exec(inDir(dir, "git add -A"), "git add -A");
    const staged = await p.shell(inDir(dir, "git diff --cached --quiet"));
    if (staged.code !== 0) {
      // Commit as the configured git author. Never invent one: Vercel's Hobby plan only builds commits whose author
      // email belongs to the Vercel account, so a made-up author gets every deploy blocked.
      const email = (await p.shell(inDir(dir, "git config user.email"))).out.trim();
      if (!email)
        throw Error(
          'No git author is set on this device. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com" ' +
            "with the email of your Vercel account (Vercel Hobby only builds commits by the account owner), then ship again.",
        );
      await p.exec(inDir(dir, `git commit -q -m ${q(title)}`), `git commit -m "${title}"`);
    } else await p.note("Nothing new to commit");
    const exists = await p.shell(inDir(dir, `git rev-parse --verify --quiet ${q(base)}`));
    if (exists.code !== 0) throw Error(`Base branch ${base} does not exist. Set the base input.`);
    const ahead = Number((await p.exec(inDir(dir, `git rev-list --count ${q(base)}..HEAD`), `git rev-list --count ${base}..HEAD`)).trim());
    const head = (await p.shell(inDir(dir, "git rev-parse --short HEAD"))).out.trim();
    return {
      done: ahead ? `${branch}: ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${base}` : `No new commits; shipping ${base} as it is`,
      data: { base, branch, title, ahead, head },
    };
  },

  /** Install and run the project's build and tests. */
  build: async (p) => {
    const dir = String(p.input.path);
    const raw = (await p.shell(inDir(dir, "cat package.json 2>/dev/null || true"))).out;
    if (!raw.trim()) {
      await p.note("No package.json: nothing to install, build or test");
      return { done: "Nothing to build" };
    }
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      throw Error("package.json is not valid JSON");
    }
    const files = (await p.shell(inDir(dir, "ls -1A"))).out.split("\n");
    const pm = files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : files.includes("bun.lockb") || files.includes("bun.lock") ? "bun" : "npm";
    if (!files.includes("node_modules")) {
      const install = pm === "npm" ? (files.includes("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund") : `${pm} install`;
      await p.exec(inDir(dir, install), install, 900);
    }
    const ran: string[] = [];
    for (const name of ["lint", "typecheck", "build", "test"]) {
      if (!scripts[name]) continue;
      await p.exec(inDir(dir, `${pm} run ${name}`), `${pm} run ${name}`, 900);
      ran.push(name);
    }
    return { done: ran.length ? `${ran.join(", ")} passed` : "No lint, typecheck, build or test scripts" };
  },

  /** Ask the reviewer and security members; "changes requested" stops the ship. */
  review: async (p) => {
    if (!Number(p.data.ahead)) {
      await p.note("No new commits to review");
      return { done: "Nothing to review" };
    }
    const dir = String(p.input.path);
    const base = String(p.data.base);
    const where = dir === "." ? "" : ` in the folder ${dir}`;
    const stat = await p.exec(inDir(dir, `git diff --stat ${q(base)}...HEAD | tail -1`), `git diff --stat ${base}...HEAD`);
    const ask = (what: string) =>
      `${what} the change on branch ${p.data.branch} against ${base}${where}. Run \`git diff ${base}...HEAD\` and read the files it touches. ` +
      `It is about to be deployed as a preview and, after the owner approves, to production. ` +
      `First read AGENTS.md${where} if it exists: risks it lists as accepted and decisions it records are known, so ` +
      `mention them at most in one line and never request changes for them. Judge this change, not the whole app.`;
    // Earlier ship reviews of this work: the reviewer checks those findings first instead of starting over, so each
    // round converges on the same list rather than surfacing new nits.
    const earlier = p
      .notes(200)
      .filter((n) => n.author.startsWith("Ship review"))
      .slice(-2)
      .map((n) => `${n.author}:\n${n.text}`)
      .join("\n\n");
    const withEarlier = (text: string) =>
      earlier
        ? `${text}\n\nEarlier reviews of this work found the items below. Check each one first and say whether it is fixed. ` +
          `Then add only new blocking problems; do not raise new non-blocking points as blockers.\n\n${earlier.slice(-6000)}`
        : text;
    // Each report goes to the team log as soon as it exists, so the developers who fix it and the next review see the
    // same list, even when the security review after it fails.
    const review = await p.member("reviewer", withEarlier(ask("Review")));
    p.log(`Ship review ${p.run.n}: reviewer`, review);
    const security = await p.member("security", withEarlier(ask("Check the security of")));
    p.log(`Ship review ${p.run.n}: security`, security);
    const verdict = parseVerdict(review);
    if (verdict === "changes") throw Error(`The reviewer requested changes (full report in the team log). ${blocking(review)}`);
    return {
      done: `${stat.trim() || "Reviewed"}. Reviewer: ${verdict === "safe" ? "safe to merge" : verdict === "owner" ? "needs your approval" : "no verdict"}`,
      data: { review, security, verdict: verdict ?? "none" },
    };
  },

  /** Deploy a preview: Vercel, or the committed tree to the app server's preview slot. */
  preview: async (p): Promise<Outcome> => {
    const dir = String(p.input.path);
    const target = await deployTarget(p, dir);
    if (target.kind === "server") {
      // The committed tree goes to the server as a tar; it builds the Dockerfile and runs it on the preview slot.
      const sha = (await p.exec(inDir(dir, "git rev-parse --short=12 HEAD"), "git rev-parse --short=12 HEAD")).trim();
      const out = await p.effect(`git archive --format=tar HEAD | ${sshCommand(target, `preview ${target.app} ${sha}`)}`, {
        label: `deploy preview of ${sha} to ${target.host}`,
        dir,
        secrets: serverSecrets(),
        timeoutSec: 1800,
      });
      const url = lastUrl(out);
      if (!url) throw Error(`The server printed no preview URL: ${out.trim().split("\n").slice(-3).join(" ")}`);
      return { done: url, data: { previewUrl: url, previewSha: sha } };
    }
    const out = await p
      .effect(`${vercel()} deploy --yes --token "$VERCEL_TOKEN"${scope()}`, {
        label: "vercel deploy (preview)",
        dir,
        secrets: vercelSecrets("this device"),
        timeoutSec: 1200,
      })
      .catch((e: Error) => {
        throw Error(explainVercel(e.message));
      });
    const url = lastUrl(out);
    if (!url) throw Error(`vercel deploy printed no URL: ${out.trim().split("\n").slice(-3).join(" ")}`);
    return { done: url, data: { previewUrl: url } };
  },

  /** Check that the preview answers over HTTP. */
  check: async (p) => {
    const dir = String(p.input.path);
    const path = await healthPath(p, dir);
    const status = await httpCheck(p, joinUrl(String(p.data.previewUrl), path));
    return { done: `Preview answers ${status} on ${path}`, data: { healthPath: path } };
  },

  /** Push the branch and open (or reuse) the pull request. */
  pr: async (p) => {
    if (!Number(p.data.ahead)) {
      await p.note("No new commits: no pull request");
      return { done: "No pull request needed" };
    }
    const dir = String(p.input.path);
    const branch = String(p.data.branch);
    const remote = (await p.shell(inDir(dir, "git remote get-url origin 2>/dev/null || true"))).out.trim();
    if (!remote) throw Error("The project has no origin remote to push to");
    const repo = auto(p.input.github_repo) ? githubRepo(remote) : String(p.input.github_repo);
    if (!repo) throw Error(`Cannot tell the GitHub repository from origin ${remote}. Set the github_repo input to owner/repo.`);
    const token = env("GITHUB_TOKEN");
    if (!token) throw Error("GITHUB_TOKEN is not set on this device. Add it to .env and env_keys in anth-network.yaml.");
    const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    await p
      .effect(`git -c http.extraHeader="$ANTH_GIT_AUTH" push -u origin ${q(branch)}`, {
        label: `git push -u origin ${branch}`,
        dir,
        secrets: { ANTH_GIT_AUTH: auth },
        timeoutSec: 300,
      })
      .catch((e: Error) => {
        throw Error(explainPush(e.message, repo));
      });
    const [owner] = repo.split("/");
    const pr = await p.step("command", `pull request ${branch} → ${p.data.base}`, async () => {
      const open = (await github(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)) as unknown as {
        number: number;
        html_url: string;
      }[];
      if (Array.isArray(open) && open[0]) return { value: open[0], detail: `Already open: ${open[0].html_url}` };
      const body = [
        `Shipped by Anth-Agent (run #${p.run.n}).`,
        "",
        `**Preview:** ${p.data.previewUrl}`,
        "",
        "### Reviewer",
        String(p.data.review ?? "No review: no new commits."),
        "",
        "### Security",
        String(p.data.security ?? "No security check: no new commits."),
        "",
        "Production waits for the owner's approval in Anth-Agent. Merging this pull request does not deploy.",
      ].join("\n");
      const created = (await github(`/repos/${repo}/pulls`, {
        method: "POST",
        body: { title: String(p.data.title), head: branch, base: String(p.data.base), body },
      })) as unknown as { number: number; html_url: string };
      return { value: created, detail: created.html_url };
    });
    return { done: pr.html_url, data: { prUrl: pr.html_url, prNumber: pr.number, repo } };
  },

  /** Approval phases are handled by the job engine, never called. */
  approve: async () => {
    throw Error("approval phases run in the engine");
  },

  /** Put the approved preview into production (Vercel promote, or anth-deploy promote by commit). */
  promote: async (p) => {
    const dir = String(p.input.path);
    const target = await deployTarget(p, dir);
    if (target.kind === "server") {
      const sha = String(p.data.previewSha ?? "");
      if (!sha) throw Error("No previewed build to promote");
      // anth-deploy runs the same image on the idle production slot, health checks it, then switches Caddy to it.
      await p.effect(sshCommand(target, `promote ${target.app} ${sha}`), {
        label: `promote ${sha} to production on ${target.host}`,
        dir,
        secrets: serverSecrets(),
        timeoutSec: 900,
      });
      return { done: `${sha} is production on ${target.host}` };
    }
    await p.effect(`${vercel()} promote ${q(String(p.data.previewUrl))} --yes --token "$VERCEL_TOKEN"${scope()}`, {
      label: `vercel promote ${p.data.previewUrl}`,
      dir,
      secrets: vercelSecrets("this device"),
      timeoutSec: 600,
    });
    return { done: `${p.data.previewUrl} is production` };
  },

  /** Check that production answers over HTTP and record the result. */
  verify: async (p) => {
    const dir = String(p.input.path);
    const url = await productionUrl(p, dir);
    let status: number | undefined;
    if (url) status = await httpCheck(p, joinUrl(url, String(p.data.healthPath ?? "/")), 20);
    else await p.note("No production URL: set productionUrl in anth.json or the production_url input to check it");
    await p.saveState(RESULT, {
      run: p.run.n,
      at: new Date(p.now()).toISOString(),
      branch: String(p.data.branch ?? ""),
      commit: String(p.data.head ?? ""),
      preview: String(p.data.previewUrl ?? ""),
      pullRequest: String(p.data.prUrl ?? ""),
      production: url ?? "",
      verified: status !== undefined,
    });
    return { done: url ? `${url} answers ${status}` : "Promoted; production URL not set, so not checked" };
  },
};

/** Parse `anth-deploy status` output into the current and previous production commits ("" when there is none). */
export function parseStatus(out: string): { current: string; previous: string } {
  const pick = (key: string) => {
    const sha = out.match(new RegExp(`^${key}: ([0-9a-f]{7,40})\\b`, "m"))?.[1];
    return sha ?? "";
  };
  return { current: pick("current"), previous: pick("previous") };
}

const rollback: Record<string, Handler> = {
  /** Before approval, fix the release production goes back to (app server: the previous commit). */
  target: async (p) => {
    const target = await deployTarget(p, String(p.input.path));
    if (target.kind !== "server") return { done: "Vercel's previous production deployment" };
    const out = await p.effect(sshCommand(target, `status ${target.app}`), {
      label: `read production on ${target.host}`,
      dir: String(p.input.path),
      secrets: serverSecrets(),
      timeoutSec: 60,
    });
    const { current, previous } = parseStatus(out);
    if (!previous) throw Error(`no previous production deployment of ${target.app} to roll back to`);
    return { done: `${current || "nothing"} → ${previous}`, data: { rollbackSha: previous } };
  },
  /** Approval phases are handled by the job engine, never called. */
  approve: async () => {
    throw Error("approval phases run in the engine");
  },
  /** Put the release chosen before approval back into production. */
  rollback: async (p) => {
    const target = await deployTarget(p, String(p.input.path));
    if (target.kind === "server") {
      // Promote the release chosen before approval. Promoting what is already live is a no-op, so a replay is safe.
      const sha = String(p.data.rollbackSha ?? "");
      if (!sha) throw Error("No rollback release was chosen");
      await p.effect(sshCommand(target, `promote ${target.app} ${sha}`), {
        label: `roll back production to ${sha} on ${target.host}`,
        dir: String(p.input.path),
        secrets: serverSecrets(),
        timeoutSec: 900,
      });
      return { done: `${sha} is production again` };
    }
    await p.effect(`${vercel()} rollback --yes --token "$VERCEL_TOKEN"${scope()}`, {
      label: "vercel rollback",
      dir: String(p.input.path),
      secrets: vercelSecrets("this device"),
      timeoutSec: 600,
    });
    return { done: "The previous production deployment is back" };
  },
  /** Check that production answers over HTTP after the rollback. */
  verify: async (p) => {
    const dir = String(p.input.path);
    const url = await productionUrl(p, dir);
    if (!url) {
      await p.note("No production URL: set productionUrl in anth.json or the production_url input to check it");
      return { done: "Rolled back; production URL not set, so not checked" };
    }
    const status = await httpCheck(p, joinUrl(url, await healthPath(p, dir)), 20);
    return { done: `${url} answers ${status}` };
  },
};

export const SHIP_HANDLERS: Record<string, Record<string, Handler>> = { ship, rollback };
