// The team log: members pass on what they did. A note and a report from one member reach the next member's task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { formatNotes } from "../src/team.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("formatNotes: time, author, addressee", () => {
  const at = Date.UTC(2026, 9, 23, 21, 5);
  assert.equal(
    formatNotes([
      { at, author: "Backend developer", to: "all", text: "API moved to /v2" },
      { at, author: "Lead", to: "frontend", text: "Use the new pages API" },
    ]),
    "- 2026-10-23 21:05 Backend developer: API moved to /v2\n- 2026-10-23 21:05 Lead → Frontend developer: Use the new pages API",
  );
});

test("team log: a member's note and report reach the next member, and the log is readable over the API", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "notes-box" });
  try {
    const client = new AnthClient(server.base, token);
    await client.putProject("acme", "shop", { name: "Shop" });
    const s = await client.createSession({ name: "Build", cwd: t.work, model: faux, project: "acme/shop" });
    const lead = client.agent(s.id, "main");
    const first = await lead.send("delegate: backend | note: Pages API moved to /api/v2/pages", "followUp", "n-1", 60000);
    assert.equal(first.status, "done");
    // The frontend developer's task carries the log, and its echo of the task shows the note arrived.
    const second = await lead.send("delegate: frontend | build the pages panel", "followUp", "n-2", 60000);
    assert.match(second.status === "done" ? JSON.stringify(await lead.transcript("markdown")) : "", /Frontend developer reports[\s\S]*Pages API moved to \/api\/v2\/pages/);
    const notes = (await (
      await fetch(`${server.base}/v1/sessions/${s.id}/team/notes`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { author: string; to: string; text: string }[];
    await until(async () => notes.length >= 3, 1000, "three notes");
    assert.deepEqual(
      notes.map((n) => n.author),
      ["Backend developer", "Backend developer", "Frontend developer"],
      "the backend's note, its report, then the frontend's report",
    );
    assert.equal(notes[0].text, "Pages API moved to /api/v2/pages");
    assert.equal(notes[0].to, "all");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
