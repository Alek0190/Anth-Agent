// Provider limits: every model call carries an output cap, and an account problem (no credits) stops the Lead from
// retrying and reaches the owner instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { accountProblem } from "../src/team.js";
import { maxOutputTokens, teamTaskLimit } from "../src/store.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("accountProblem and maxOutputTokens", () => {
  assert.equal(accountProblem('402: {"message":"This request requires more credits, or fewer max_tokens."}'), "out of credits");
  assert.equal(accountProblem("401 Unauthorized: invalid API key"), "the API key was refused");
  assert.equal(accountProblem("Command exited with code 1"), undefined);
  assert.equal(maxOutputTokens({}), 32000);
  assert.equal(maxOutputTokens({ ANTH_MAX_OUTPUT_TOKENS: "16000" }), 16000);
  assert.equal(maxOutputTokens({ ANTH_MAX_OUTPUT_TOKENS: "12" }), 32000);
  assert.equal(teamTaskLimit({}), 40);
  assert.equal(teamTaskLimit({ ANTH_TEAM_MAX_TASKS: "12" }), 12);
  for (const bad of ["0", "-3", "2.5", "lots", "5000"]) assert.equal(teamTaskLimit({ ANTH_TEAM_MAX_TASKS: bad }), 40, bad);
});

test("a Lead stops at its task limit and reports; the owner's next message lets it carry on", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "loop-box", env: { ANTH_TEAM_MAX_TASKS: "2" } });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "shop", { name: "Shop" });
    const s = await client.createSession({ name: "Build", cwd: t.work, model: faux, project: "acme/shop" });
    const lead = client.agent(s.id, "main");
    const testers = async () => (await client.session(s.id).agents()).filter((a) => a.name === "Tester").length;

    // Three tasks side by side in one turn with a limit of two: two run, the third is refused with the stop rule.
    const out = await lead.send("delegate: tester | !echo one ;; tester | !echo two ;; tester | !echo three", "followUp", "loop-1", 120000);
    assert.equal(out.status, "done");
    const transcript = JSON.stringify(await lead.transcript("markdown"));
    const refusals = (text: string) => text.match(/Not delegated: the team reached its limit of 2 tasks/g)?.length ?? 0;
    assert.ok(refusals(transcript) >= 1, "the third task is refused");
    assert.match(transcript, /Do not delegate again\. Stop now and report to the owner/);
    await until(async () => (await testers()) === 2, 15000, "two testers ran");
    // The owner hears about it (the phone alert path).
    assert.match(server.output(), /problem: The team stopped after 2 tasks since your last message/);

    // A client retry of the same message (same requestId) gets the same submission back: it is not a new owner
    // message, so it must not start the count again.
    const ownerInputs = () => {
      const dataDir = server.output().match(/data: (\S+)/)?.[1];
      assert.ok(dataDir, "the server prints its data folder");
      const db = new DatabaseSync(join(dataDir, "catalog.sqlite"), { readOnly: true });
      try {
        return db.prepare("SELECT submissionId, at FROM owner_inputs WHERE sessionId=? ORDER BY at").all(s.id) as { submissionId: number; at: number }[];
      } finally {
        db.close();
      }
    };
    const before = ownerInputs();
    assert.equal(before.length, 1);
    const retry = await lead.send("delegate: tester | !echo one ;; tester | !echo two ;; tester | !echo three", "followUp", "loop-1", 30000);
    assert.equal(retry.status, "done");
    assert.deepEqual(ownerInputs(), before, "a retried request does not reset the count");

    // The owner replies: the count starts again and the next task runs.
    const next = await lead.send("delegate: tester | !echo four", "followUp", "loop-2", 120000);
    assert.equal(next.status, "done");
    await until(async () => (await testers()) === 3, 15000, "the third tester ran after the owner replied");
    const after = JSON.stringify(await lead.transcript("markdown"));
    assert.equal(refusals(after), refusals(transcript), "no new refusal");
    assert.equal(ownerInputs().length, 2, "the new message is a new start");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("model calls carry the output cap; a member out of credits is reported, not retried", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "limits-box", env: { ANTH_MAX_OUTPUT_TOKENS: "20000" } });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "shop", { name: "Shop" });
    const s = await client.createSession({ name: "Build", cwd: t.work, model: faux, project: "acme/shop" });
    const lead = client.agent(s.id, "main");
    const cap = await lead.send("maxtokens?", "followUp", "cap-1", 30000);
    assert.match(cap.status === "done" ? cap.answer.text : "", /maxTokens=20000/);

    const out = await lead.send("delegate: reviewer | nocredits", "followUp", "nc-1", 120000);
    assert.equal(out.status, "done");
    const transcript = JSON.stringify(await lead.transcript("markdown"));
    assert.match(transcript, /could not run: the model provider refused the request \(out of credits\)/);
    assert.match(transcript, /Do not retry/);
    assert.match(server.output(), /problem: The model provider refused a request for the Reviewer: out of credits/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
