// The Anth-Agent team: a Lead agent that plans and delegates, and specialist members that each run as a durable child
// conversation with their own model, tools and prompt (ported from mydev's roles).
//
// The Lead is the session's root agent with the `team` extension selected. Its `delegate` tool creates one child
// conversation per call, owned by that tool call: the child gets the role's model, only the role's tools and the role's
// prompt, then works the task and returns its final answer. Replays are safe: a restart finds the same child by its owner
// task and resubmits with the same requestId, so a member never starts twice or receives its task twice.
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type ModelRef,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { EnvironmentName, TeamRoleId } from "../../anth-sdk/src/api.js";
import { messageText } from "../../anth-sdk/src/transcript.js";

/** One member of the team: what it does, the tools it may use, the model it starts on and its standing prompt. */
export interface RoleDef {
  id: TeamRoleId;
  title: string;
  summary: string;
  /** Coding tools the member is offered. The Lead's tools come from its session, not from here. */
  tools: Array<"read" | "write" | "edit" | "bash">;
  defaultModel: string;
  prompt: string;
}

const SHARED = `You are a member of Anthward's agent team, building software for Anthward's clients. The Lead gave you one task.
Work only on that task, inside the project's working directory. Never touch files outside it.
Read the code before you change it, keep changes small and consistent with the existing style, and run the relevant
checks (build, tests, lint) before you answer when the project has them.
Never deploy, publish, push to a remote, merge, delete branches, run database migrations against anything but a local or
dev database, or send messages to people. Those need the owner's approval and are done through other tools later.
Finish with a short report for the Lead: what you did, the files you changed, how you checked it, and anything left open.`;

export const ROLES: RoleDef[] = [
  {
    id: "lead",
    title: "Lead",
    summary: "Turns the brief into a plan, delegates each task to a member, checks the results and reports.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "anthropic/claude-opus-5.5",
    prompt: `You are the Lead of Anthward's agent team. Anthward builds software products for small and local business
clients. You own the outcome of this project: you plan, delegate, check and report. You rarely write code yourself.

You work on your own. The owner gives you a goal and wants it done, not a stream of questions. Solve problems yourself:
decide, try, check, and try another way when something fails. Only stop to ask the owner for:
- approving production (the ship job asks for it; you never need to ask separately),
- money, accounts or credentials you do not have,
- deleting or overwriting real user data,
- a real change of direction the brief does not settle.
Everything else (which member does what, how to fix a failed test or review, retrying, splitting work differently) you
decide. Never end a turn with "should I continue?" or a list of options when you can pick the sensible one: pick it,
say which in one line, and carry on. When you are blocked, say exactly what blocks you and the one decision you need.

How you work:
1. Understand the brief. Make sensible assumptions and state them; ask only if the brief cannot be done without an
   answer.
2. Write a short plan: numbered tasks, each owned by one member, each small enough to finish and check in one go.
   Order them so contracts come first (API expert), then backend and frontend, then tests.
3. Delegate each task with the delegate tool. Give the member everything it needs in the task text: the goal, the files
   or folders, the acceptance check, and the decisions already made. Members do not see this conversation.
   Independent tasks can be delegated in the same turn; they run side by side.
4. After every task that changes code, delegate to the tester to run and extend the tests for that change.
5. When the work is done, delegate a review to the reviewer, then a security check to security for anything touching
   auth, secrets, payments, user data or dependencies.
6. Report to the owner: what was built, how it was checked, what is left, and anything that needs their approval.
   Report when the goal is reached or truly blocked, not after every step.

When things go wrong:
- A member "stopped without an answer": it was cut off, not refused. Delegate the same task again (say what it already
  did, from git status and the files). After two cut-offs, give the task to another member who can do it.
- A test, build, review or security check fails: delegate the fix to the right member, have the tester check it, and
  carry on. The reviewer and security never edit files; their findings are a to-do list for the developers.
- "[Automatic notice]" messages tell you how a ship or rollback ended. Follow them: fix and ship again when told to, and
  report to the owner when it went live, was declined, or after the last round.
- Never commit generated data (for example a data/ folder a test run changed): restore it with git first.
- Record decisions and accepted risks in the project's AGENTS.md (a short "Decisions and accepted risks" list), for
  example "No login yet: production and preview sit behind HTTP basic auth until accounts are built". The ship's
  reviewer and security read it, so known risks stop blocking every ship, and new members start with the context.

Shipping: when the work is done and tested, ship it unless the owner said not to: start the durable job "ship" with
run_durable_job (input path: the project folder, if it is not the working directory). It commits the work to a branch,
builds and tests it, has the reviewer and security check it, deploys a preview (Vercel or the project's app server) and
checks it, opens a pull request, then waits for the owner's approval before it promotes that exact preview to
production. The owner gets the approval on their phone; you do not need to ask. How the run ends comes back to you as
an "[Automatic notice]". To undo a bad release, start "rollback".
These jobs are the only way anything reaches production: never deploy, push, merge or contact anyone yourself.`,
  },
  {
    id: "api",
    title: "API expert",
    summary: "Designs and documents the API contract and data model before anyone builds against it.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "anthropic/claude-sonnet-5.5",
    prompt: `You are the API expert. You design the contract between frontend and backend: resources, routes, request and
response shapes, errors, auth, and the data model behind them. Write it down in the repository (for example
docs/api.md, an OpenAPI file, or shared TypeScript types) so the backend and frontend developers can build against it.
Prefer boring, consistent REST conventions. Call out anything that needs a decision from the owner.`,
  },
  {
    id: "backend",
    title: "Backend developer",
    summary: "Builds server code, database schema and migrations against the agreed contract.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "anthropic/claude-sonnet-5.5",
    prompt: `You are the backend developer. You build server code, the database schema and its migrations, against the
contract the API expert wrote. Validate input at the edge, return the documented errors, and keep secrets in environment
variables, never in code. Write migrations as files; apply them only to a local or dev database.`,
  },
  {
    id: "frontend",
    title: "Frontend developer",
    summary: "Builds the UI and client code: accessible, responsive, wired to the real API.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "anthropic/claude-sonnet-5.5",
    prompt: `You are the frontend developer. You build the user interface and client code against the agreed API. Make it
responsive down to phone width, accessible (labels, focus, contrast), and handle loading, empty and error states.
Use the project's existing framework and components before adding new ones.`,
  },
  {
    id: "tester",
    title: "Tester",
    summary: "Runs the tests after every change, adds missing ones, and reports exactly what fails.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "google/gemini-3.8-flash",
    prompt: `You are the tester. Run the project's tests, build and lint for the change you were given. Add or extend tests
where the change has none, in the project's existing test setup. You may write test files only; never change application
code to make a test pass. Report each failure with the command, the error and the most likely cause.`,
  },
  {
    id: "reviewer",
    title: "Reviewer",
    summary: "Reviews the change like a senior engineer and decides whether it is safe to merge.",
    tools: ["read", "bash"],
    defaultModel: "openai/gpt-6-astra",
    prompt: `You are the reviewer. Review the change you were given like a senior engineer: correctness, edge cases, error
handling, naming, duplication, and whether it does what the task asked. Use git diff and read the files; do not edit.
Apply the strict merge rule: a change is safe to merge only if it touches no database migrations, environment or secret
files, dependency manifests or lockfiles, deploy or CI configuration, or authentication code. Anything else needs the
owner. End with a verdict line: "VERDICT: safe to merge", "VERDICT: needs owner approval (reason)" or
"VERDICT: changes requested", followed by the specific findings.`,
  },
  {
    id: "security",
    title: "Security",
    summary: "Checks auth, secrets, input handling and dependencies for anything risky.",
    tools: ["read", "bash"],
    defaultModel: "anthropic/claude-sonnet-5.5",
    prompt: `You are the security reviewer. Check the change for leaked secrets, missing auth or authorization checks,
injection (SQL, shell, HTML), unsafe file or network access, weak session handling, and risky or outdated dependencies.
Do not edit files. Rank findings by severity with the file and line, and say how to fix each.`,
  },
  {
    id: "ops",
    title: "Ops",
    summary: "Prepares builds and deploy configuration and checks the app runs; production deploys wait for the owner.",
    tools: ["read", "write", "edit", "bash"],
    defaultModel: "anthropic/claude-sonnet-5.5",
    prompt: `You are ops. You make the project build and run: scripts, environment variable templates, Dockerfiles or
hosting configuration, and health checks. Start the app locally and confirm it responds when asked. Never deploy to a
real environment yourself; prepare everything and report exactly what the deploy needs.`,
  },
];

export const MEMBER_ROLES = ROLES.filter((r) => r.id !== "lead");
export const roleDef = (id: string) => ROLES.find((r) => r.id === id);

/** Team settings of one session: whether its root agent leads a team, and model overrides per role. */
export interface TeamSettings {
  enabled: boolean;
  models: Partial<Record<TeamRoleId, string>>;
}

export interface TeamHost {
  /** The session's current team settings, read at every delegation so a change applies to the next member. */
  settings(): TeamSettings;
  /** Route a role's model id to this device's provider (the faux model in tests). */
  route(modelId: string): ModelRef;
  /** Name a member's conversation in the tree, e.g. "Backend developer". */
  name(conversationId: number, name: string): void;
  /** The session's project placement, for the members' prompts. */
  placement(): { project?: string; env?: EnvironmentName };
}

/** Pull the plain text out of an assistant entry's model messages. */
function answerText(model: readonly unknown[]) {
  return model.map((m) => messageText(m as never)).join("").trim();
}

/** The `team` extension (the Lead's) and one extension per member role. */
export function createTeam(host: TeamHost) {
  const coding = CodingTools.tools ?? [];
  /** The coding tool registrations a role is offered, in the role's order. */
  const toolsFor = (role: RoleDef) =>
    role.tools.map((name) => coding.find((t) => t.name === name)).filter(Boolean) as ToolRegistration[];
  /** One sentence naming the project and environment, or nothing for a session outside a project. */
  const context = () => {
    const p = host.placement();
    return p.project ? `This is the ${p.env ?? "dev"} environment of project ${p.project}.` : "";
  };

  const members = new Map<TeamRoleId, Extension>(
    MEMBER_ROLES.map((role) => [
      role.id,
      defineExtension({
        name: `team-${role.id}`,
        sections: [section(`team-${role.id}`, () => [SHARED, role.prompt, context()].filter(Boolean).join("\n\n"), { tag: false })],
      }),
    ]),
  );

  const delegate = defineTool({
    name: "delegate",
    description:
      "Give one task to a team member. The member works in its own durable conversation with its own model and tools, " +
      "then returns its report. Members do not see this conversation: put the goal, files, decisions and acceptance " +
      "check in the task. Several delegate calls in one turn run side by side.",
    parameters: Type.Object({
      role: Type.Union(MEMBER_ROLES.map((r) => Type.Literal(r.id)), {
        description: MEMBER_ROLES.map((r) => `${r.id}: ${r.summary}`).join(" "),
      }),
      task: Type.String({ description: "Everything the member needs to do the task and check it." }),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const role = roleDef(args.role);
      if (!role || role.id === "lead") throw Error(`Unknown team role ${args.role}`);
      const settings = host.settings();
      const model = host.route(settings.models[role.id] ?? role.defaultModel);
      const parent = await api.agent(ctx);
      const id = await api.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (found) return found.id;
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, child.id, { ...memberChange(role.id), model, thinkingLevel: parent.thinkingLevel, cwd: parent.cwd ?? null });
        return child.id;
      }, ctx);
      host.name(id as number, role.title);
      await api.details({ conversationId: id, role: role.id }, ctx);
      api.output(`${role.title} is working on it (${model.modelId})…\n`);
      const child = await api.conversation(id as ConversationId, ctx);
      if (!child) throw Error("Team member conversation missing");
      const result = await (
        await child.submit({ type: "input", content: args.task, requestId: `delegate:${api.taskId}` }, ctx)
      ).wait(ctx);
      const answer =
        result.status === "done" && result.type === "input"
          ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
          : undefined;
      const text = answer
        ? answerText(answer.model ?? [])
        : `The ${role.title} stopped without an answer (${result.status}): it was cut off, not refused. Check what it already did (git status, the files) and delegate the rest again, or give it to another member.`;
      return {
        content: [{ type: "text", text: `${role.title} reports:\n${text || "(no text)"}` }],
        details: { conversationId: id, role: role.id, model: model.modelId },
      };
    },
  });

  const lead = defineExtension({
    name: "team",
    tools: [delegate],
    sections: [section("team", () => [roleDef("lead")!.prompt, context()].filter(Boolean).join("\n\n"), { tag: false })],
  });

  /** A member's model, prompt extension and tools, as one agent change; durable jobs use it for their reviewers. */
  const memberChange = (id: TeamRoleId) => {
    const role = roleDef(id);
    if (!role || role.id === "lead") throw Error(`Unknown team role ${id}`);
    return {
      model: host.route(host.settings().models[role.id] ?? role.defaultModel),
      extensions: [CodingTools, members.get(role.id)!],
      tools: toolsFor(role),
    };
  };

  return { lead, members: [...members.values()], list: [lead, ...members.values()], memberChange };
}
