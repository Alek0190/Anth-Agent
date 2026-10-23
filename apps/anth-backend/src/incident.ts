// The incident agent: one per incident, a team Lead working in its own git worktree on branch incident/inc-<n>.
//
// It investigates the events, has the team write a fix and a regression test, then calls submit_fix. submit_fix proves
// the fix in code, not by the agent's word: the changed tests must FAIL on the base branch and PASS on the incident
// branch. Only then does it start the ship job, which builds, reviews, deploys a preview, opens a pull request and waits
// for the owner's approval before production.
import { cp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { Incident, WatchEvent } from "../../anth-sdk/src/api.js";
import { runEffect, type Values } from "./jobs.js";

/** Records which ship run a submit_fix call started, so a replay after a crash never starts a second one. */
const Receipt = defineDoc<{ applied: boolean; taskId: number }>({
  kind: "incident.submit-fix",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, taskId: 0 }),
});

/** Quote a value for bash. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/** Run a git or test command in a folder; never with secrets. */
const run = (command: string, dir: string, timeoutSec = 600) => runEffect(command, dir, {}, timeoutSec);

/** The repository's default branch: origin/HEAD, else main or master. */
export async function defaultBranch(repo: string) {
  const head = (await run("git symbolic-ref --quiet --short refs/remotes/origin/HEAD", repo)).out.trim();
  if (head.startsWith("origin/")) return head.slice(7);
  for (const name of ["main", "master"]) if ((await run(`git rev-parse --verify --quiet ${name}`, repo)).code === 0) return name;
  return "main";
}

/** Create (or find) the incident's worktree next to the repository: <parent>/.anth-incidents/<repo>-inc-<id>. */
export async function prepareWorktree(repo: string, id: number) {
  const base = await defaultBranch(repo);
  const branch = `incident/inc-${id}`;
  const worktree = join(dirname(repo), ".anth-incidents", `${basename(repo)}-inc-${id}`);
  const exists = await stat(join(worktree, ".git")).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(dirname(worktree), { recursive: true });
    // Refresh the base when the remote is reachable; a stale or missing remote must not stop the incident.
    await run(`git fetch --quiet origin ${q(base)}`, repo, 120);
    const branchExists = (await run(`git rev-parse --verify --quiet ${q(branch)}`, repo)).code === 0;
    const r = await run(
      branchExists ? `git worktree add ${q(worktree)} ${q(branch)}` : `git worktree add -b ${q(branch)} ${q(worktree)} ${q(base)}`,
      repo,
    );
    if (r.code !== 0) throw Error(`git worktree add failed: ${r.out.trim().slice(-300)}`);
  }
  return { worktree, branch, base };
}

/** The first message to the incident agent: what happened, where to work, and how to finish. */
export function incidentBrief(incident: Incident, samples: WatchEvent[], url: string) {
  const lines = samples
    .slice(-10)
    .map((e) => `- ${new Date(e.at).toISOString()} [${e.source}${e.status ? ` ${e.status}` : ""}${e.path ? ` ${e.path}` : ""}] ${e.message.slice(0, 400)}`);
  return [
    `Incident #${incident.id} in ${incident.project}: ${incident.title}`,
    "",
    `Production (${url}) is failing. ${incident.events} events share this fingerprint: ${incident.fingerprint}`,
    "",
    "Recent events:",
    ...lines,
    "",
    `You work in the worktree ${incident.worktree} on branch ${incident.branch}, made from ${incident.base}. It is your working directory.`,
    "1. Find the cause: read the code the events point at, and reproduce the failure locally (install dependencies here first).",
    "2. Delegate the fix to the right member, and have the tester add a regression test that fails without the fix.",
    "3. Run the test yourself in the worktree and make sure it passes.",
    "4. Call submit_fix with the exact command that runs that test. It proves the test fails on the base branch and passes here, then starts the ship job, which waits for the owner's approval before production.",
    "If you cannot find or fix the cause, say so plainly and stop: never ship a guess.",
  ].join("\n");
}

export interface IncidentHost {
  /** The incident whose agent is this conversation. */
  incidentFor(conversationId: number): Incident | undefined;
  update(id: number, fields: Partial<Pick<Incident, "status" | "shipTaskId" | "note">>): void;
  /** The session's working directory, which ship paths are relative to. */
  sessionCwd(): string;
  /** Start the ship job inside this commit; returns its task id. */
  startShip(tx: Tx, conversationId: number, input: Record<string, string>, toolCallId: string): Promise<TaskId>;
}

/** Copy the changed test files into a detached worktree of the base branch and run the test there. */
async function runOnBase(repo: string, worktree: string, base: string, tests: string[], command: string) {
  const proof = `${worktree}-proof`;
  await run(`git worktree remove --force ${q(proof)}`, repo);
  await rm(proof, { recursive: true, force: true });
  const added = await run(`git worktree add --detach ${q(proof)} ${q(base)}`, repo);
  if (added.code !== 0) throw Error(`Could not check out ${base} to prove the fix: ${added.out.trim().slice(-200)}`);
  try {
    for (const file of tests) {
      await mkdir(dirname(join(proof, file)), { recursive: true });
      await cp(join(worktree, file), join(proof, file));
    }
    // Reuse the worktree's installed dependencies so the base run fails for the bug, not for a missing package.
    const modules = join(worktree, "node_modules");
    if (await stat(modules).then(() => true, () => false)) await symlink(modules, join(proof, "node_modules"), "dir");
    return await run(command, proof);
  } finally {
    await run(`git worktree remove --force ${q(proof)}`, repo);
    await rm(proof, { recursive: true, force: true });
  }
}

/** The incident extension: its playbook and submit_fix. Selected only on incident agents. */
export function createIncidentExtension(host: IncidentHost) {
  const submitFix = defineTool({
    name: "submit_fix",
    description:
      "Prove the fix and ship it. Runs test_command with only the changed tests on the base branch (it must fail) and on this incident branch (it must pass). " +
      "Then starts the ship job, which deploys a preview, opens a pull request and waits for the owner's approval before production.",
    parameters: Type.Object({
      test_command: Type.String({ description: "The command that runs the regression test, from the worktree root, e.g. npm test -- checkout" }),
      summary: Type.String({ description: "One or two sentences: the cause and the fix." }),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const incident = host.incidentFor(api.conversationId as number);
      if (!incident?.worktree || !incident.base) throw Error("submit_fix only works in an incident agent's conversation");
      const done = await api.snapshot(Receipt, api.taskId, ctx);
      if (done?.applied) return { content: [{ type: "text", text: `Already shipping as durable task #${done.taskId}.` }] };
      const wt = incident.worktree;
      const repo = (await run("git rev-parse --path-format=absolute --git-common-dir", wt)).out.trim().replace(/\/\.git$/, "");
      const changed = new Set(
        [
          ...(await run(`git diff --name-only ${q(incident.base)}`, wt)).out.split("\n"),
          ...(await run("git ls-files --others --exclude-standard", wt)).out.split("\n"),
        ]
          .map((f) => f.trim())
          .filter(Boolean),
      );
      const tests = [...changed].filter((f) => TEST_FILE.test(f));
      const code = [...changed].filter((f) => !TEST_FILE.test(f));
      if (!tests.length) throw Error("No test file changed. Add a regression test (a *.test.* or *.spec.* file, or one under test/) that fails without the fix.");
      if (!code.length) throw Error("Only tests changed. The fix itself is missing.");
      api.output(`Changed: ${code.length} code file(s), ${tests.length} test file(s)\nRunning the test on ${incident.base}…\n`);
      const before = await runOnBase(repo, wt, incident.base, tests, args.test_command);
      if (before.code === 0)
        throw Error(`The test passes on ${incident.base} too, so it does not prove the fix. Make it fail without the fix.\n${before.out.trim().slice(-600)}`);
      api.output(`Fails on ${incident.base} as it should. Running it on ${incident.branch}…\n`);
      const after = await run(args.test_command, wt);
      if (after.code !== 0) throw Error(`The test fails on ${incident.branch}: the fix is not done.\n${after.out.trim().slice(-600)}`);
      api.output("Passes with the fix. Starting the ship job…\n");
      const input: Values = {
        // Absolute: the ship job runs in this conversation, whose working directory is already the worktree.
        path: wt,
        base: incident.base,
        title: `Fix incident #${incident.id}: ${incident.title}`.slice(0, 120),
      };
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return receipt.taskId;
        const id = (await host.startShip(tx, api.conversationId as number, input as Record<string, string>, api.callId)) as number;
        receipt.applied = true;
        receipt.taskId = id;
        return id;
      }, ctx);
      host.update(incident.id, { status: "shipping", shipTaskId: taskId, note: args.summary.slice(0, 500) });
      return {
        content: [
          {
            type: "text",
            text:
              `Proven: the regression test fails on ${incident.base} and passes on ${incident.branch}. ` +
              `Started the ship job as durable task #${taskId}; it waits for the owner's approval before production. Do not start another.`,
          },
        ],
        details: { taskId },
      };
    },
  });

  return defineExtension({
    name: "incident",
    tools: [submitFix],
    sections: [
      section(
        "incident",
        () =>
          "You are an incident agent. Production is failing for real visitors. Work fast but never guess: find the cause, " +
          "fix it with the team, prove it with a regression test, then call submit_fix. Work only inside your worktree. " +
          "Never push, merge or deploy yourself; submit_fix starts the ship job, and the owner approves production.",
        { tag: false },
      ),
    ],
  });
}
