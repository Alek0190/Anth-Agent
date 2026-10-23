import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { AnthError } from "../../anth-sdk/src/errors.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

/** Matches an AnthError with this error code, for assert.rejects. */
const code = (c: string) => (e: AnthError) => e.code === c;

test("agent team: on for project sessions, delegate runs members with their own tools, settings persist", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "team-box" });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("dental-co", "booking-site", { name: "Booking site", clientName: "Dental Co" });

    // A session in a project starts with a team; a loose session does not, until it is turned on.
    const built = await client.createSession({ name: "Build", cwd: t.work, model: faux, project: "dental-co/booking-site" });
    assert.equal(built.team, true);
    const loose = await client.createSession({ name: "Scratch", cwd: t.work, model: faux });
    assert.equal(loose.team, undefined);
    assert.equal((await client.session(loose.id).team()).enabled, false);
    assert.equal((await client.session(loose.id).setTeam({ enabled: true })).enabled, true);
    const optOut = await client.createSession({ name: "Solo", cwd: t.work, model: faux, project: "dental-co/booking-site", team: false });
    assert.equal(optOut.team, undefined);

    // Roles: eight, the Lead first; reviewer and security only read; models route to this device's provider.
    const team = await client.session(built.id).team();
    assert.deepEqual(team.roles.map((r) => r.id), ["lead", "api", "backend", "frontend", "tester", "reviewer", "security", "ops"]);
    assert.deepEqual(team.roles.filter((r) => !r.writes).map((r) => r.id), ["reviewer", "security"]);
    assert.ok(team.roles.every((r) => r.model === "echo"), "faux device runs every role on the faux model");
    assert.equal(team.roles.find((r) => r.id === "backend")?.defaultModel, "anthropic/claude-sonnet-5.5");

    // The Lead is offered delegate; read only takes it away like any tool that leads to writes.
    const lead = client.agent(built.id, "main");
    assert.ok((await lead.get()).tools.find((t) => t.name === "delegate")?.offered);
    await lead.configure({ readOnly: true });
    assert.equal((await lead.get()).tools.find((t) => t.name === "delegate")?.offered, false);
    await lead.configure({ readOnly: false });

    // One turn delegates to two members side by side. The backend writes a file; the reviewer only reads.
    const answer = await lead.send(
      "delegate: backend | !echo built-by-backend > team-output.txt ;; reviewer | !ls",
      "followUp",
      "team-1",
      60000,
    );
    assert.equal(answer.status, "done");
    assert.match(answer.status === "done" ? answer.answer.text : "", /Tool finished/);
    assert.equal(readFileSync(join(t.work, "team-output.txt"), "utf8").trim(), "built-by-backend");
    await until(async () => (await client.session(built.id).agents()).length === 3, 15000, "two members in the tree");
    const agents = await client.session(built.id).agents();
    const backend = agents.find((a) => a.name === "Backend developer");
    const reviewer = agents.find((a) => a.name === "Reviewer");
    assert.equal(backend?.kind, "subagent");
    assert.equal(backend?.ownerAgentId, 1);
    assert.ok(reviewer);
    /** The tool names an agent is offered, sorted. */
    const offered = async (id: number) =>
      (await client.agent(built.id, id).get()).tools.filter((t) => t.offered).map((t) => t.name).sort();
    assert.deepEqual(await offered(backend!.id), ["bash", "edit", "read", "team_note", "team_notes", "write"]);
    // Reviewers still cannot write files; notes go to the team log, not the project.
    assert.deepEqual(await offered(reviewer!.id), ["bash", "read", "team_note", "team_notes"]);
    // Members get their role prompt, not the Lead's tools.
    assert.equal((await client.agent(built.id, backend!.id).get()).tools.some((t) => t.name === "delegate"), false);

    // The same requestId never delegates twice.
    const again = await lead.send("delegate: backend | !echo again > again.txt", "followUp", "team-1");
    assert.equal(again.submissionId, answer.submissionId);
    assert.equal(existsSync(join(t.work, "again.txt")), false);

    // Model overrides: validated, saved, cleared with null; the Lead's model is the root agent's.
    await assert.rejects(() => client.session(built.id).setTeam({ models: { backend: "no-such-model" } }), code("invalid"));
    await assert.rejects(() => client.session(built.id).setTeam({ models: { painter: "echo" } as never }), code("invalid"));
    await assert.rejects(() => client.session(built.id).setTeam({}), code("invalid"));
    await client.session(built.id).setTeam({ models: { tester: "echo", lead: "echo" } });

    // Everything survives a restart: the team stays on and the members stay in the tree.
    await server.stop();
    await server.start();
    assert.equal((await client.session(built.id).get()).team, true);
    assert.equal((await client.session(built.id).agents()).length, 3);
    assert.equal((await client.session(loose.id).team()).enabled, true);
    await client.session(built.id).setTeam({ models: { tester: null }, enabled: false });
    assert.equal((await client.session(built.id).team()).enabled, false);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a delegation survives a crash: same member, same task, one answer", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "crash-box" });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "shop", { name: "Shop" });
    const s = await client.createSession({ name: "Build", cwd: t.work, model: faux, project: "acme/shop" });
    const lead = client.agent(s.id, "main");
    const queued = await lead.send("delegate: frontend | !sleep 4; echo done > slow.txt", "followUp", "crash-1");
    await until(async () => (await client.session(s.id).agents()).some((a) => a.name === "Frontend developer"), 15000, "member started");
    // Crash only once the member's bash is running, so there is a tool call to interrupt.
    await until(async () => {
      const member = (await client.session(s.id).agents()).find((a) => a.name === "Frontend developer");
      return !!member && /bash/.test(JSON.stringify(await client.agent(s.id, member.id).transcript("markdown")));
    }, 15000, "member bash running");
    await server.stop("SIGKILL");
    await server.start();
    const settled = await client.session(s.id).submission(queued.submissionId, 60000);
    assert.equal(settled.status, "done");
    const members = (await client.session(s.id).agents()).filter((a) => a.name === "Frontend developer");
    assert.equal(members.length, 1, "the restart reuses the member instead of starting another");
    // The member's bash was cut off by the crash, so it comes back interrupted rather than silently rerunning.
    const transcript = await client.agent(s.id, members[0].id).transcript("markdown");
    assert.match(JSON.stringify(transcript), /interrupt/i);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
