// Provider limits: every model call carries an output cap, and an account problem (no credits) stops the Lead from
// retrying and reaches the owner instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { accountProblem } from "../src/team.js";
import { maxOutputTokens } from "../src/store.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

test("accountProblem and maxOutputTokens", () => {
  assert.equal(accountProblem('402: {"message":"This request requires more credits, or fewer max_tokens."}'), "out of credits");
  assert.equal(accountProblem("401 Unauthorized: invalid API key"), "the API key was refused");
  assert.equal(accountProblem("Command exited with code 1"), undefined);
  assert.equal(maxOutputTokens({}), 32000);
  assert.equal(maxOutputTokens({ ANTH_MAX_OUTPUT_TOKENS: "16000" }), 16000);
  assert.equal(maxOutputTokens({ ANTH_MAX_OUTPUT_TOKENS: "12" }), 32000);
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
