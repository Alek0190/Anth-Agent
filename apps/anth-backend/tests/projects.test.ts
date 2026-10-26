import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { AnthClient } from "../../anth-sdk/src/client.js";
import { AnthError } from "../../anth-sdk/src/errors.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

/** Matches an AnthError with this error code, for assert.rejects. */
const code = (c: string) => (e: AnthError) => e.code === c;

test("clients, projects and environments: upsert, placement, moves, tree, restart", async () => {
  const t = await tempStore();
  const token = newToken();
  const home = join(t.root, "home");
  const server = await bootServer({ home, startDirs: t.work, token, name: "proj-box" });
  try {
    const client = new AnthClient(server.base, token);
    assert.deepEqual(await client.clients(), []);
    assert.deepEqual(await client.projects(), []);

    // Clients: upsert by id, rename on repeat, ids are validated.
    const dental = await client.putClient("dental-co", { name: "Dental Co" });
    assert.equal(dental.name, "Dental Co");
    assert.equal((await client.putClient("dental-co", { name: "Dental Co." })).createdAt, dental.createdAt);
    assert.equal((await client.clients())[0].name, "Dental Co.");
    await assert.rejects(() => client.putClient("Bad Id", { name: "x" }), code("invalid"));

    // Projects: create under an existing client, or create the client on the way.
    const site = await client.putProject("dental-co", "booking-site", { name: "Booking site" });
    assert.deepEqual([site.client, site.slug, site.name], ["dental-co", "booking-site", "Booking site"]);
    assert.equal((await client.putProject("dental-co", "booking-site", { name: "Booking site" })).createdAt, site.createdAt);
    await client.putProject("cafe-luna", "menu-app", { name: "Menu app", clientName: "Cafe Luna" });
    assert.deepEqual((await client.clients()).map((c) => c.name), ["Cafe Luna", "Dental Co."]);
    assert.equal((await client.projects()).length, 2);
    await assert.rejects(() => client.putProject("dental-co", "-bad-", { name: "x" }), code("invalid"));
    await assert.rejects(() => client.project("dental-co", "nope"), code("not_found"));

    // Sessions: placement is validated; env defaults to dev; no project means no env.
    const base = { cwd: t.work, model: faux };
    await assert.rejects(() => client.createSession({ ...base, name: "x", project: "dental-co/nope" }), code("not_found"));
    await assert.rejects(() => client.createSession({ ...base, name: "x", project: "no-slash" }), code("invalid"));
    await assert.rejects(
      () => client.createSession({ ...base, name: "x", project: "dental-co/booking-site", env: "qa" as never }),
      code("invalid"),
    );
    await assert.rejects(() => client.createSession({ ...base, name: "x", env: "prod" }), code("invalid"));
    const dev = await client.createSession({ ...base, name: "Build", project: "dental-co/booking-site" });
    assert.deepEqual([dev.project, dev.env], ["dental-co/booking-site", "dev"]);
    const prod = await client.createSession({ ...base, name: "On call", project: "dental-co/booking-site", env: "prod" });
    assert.equal(prod.env, "prod");
    const loose = await client.createSession({ ...base, name: "Scratch" });
    assert.equal(loose.project, undefined);
    assert.equal(loose.env, undefined);
    assert.deepEqual((await client.project("dental-co", "booking-site")).sessions.sort(), [dev.id, prod.id].sort());

    // PATCH: move into a project (keeps env default dev), change env, rename alone keeps placement, move out.
    let moved = await client.session(loose.id).update({ project: "cafe-luna/menu-app" });
    assert.deepEqual([moved.project, moved.env], ["cafe-luna/menu-app", "dev"]);
    moved = await client.session(loose.id).update({ env: "staging" });
    assert.equal(moved.env, "staging");
    moved = await client.session(loose.id).rename("Menu work");
    assert.deepEqual([moved.name, moved.project, moved.env], ["Menu work", "cafe-luna/menu-app", "staging"]);
    await assert.rejects(() => client.session(loose.id).update({}), code("invalid"));
    await assert.rejects(() => client.session(loose.id).update({ project: null, env: "dev" }), code("invalid"));
    moved = await client.session(loose.id).update({ project: null });
    assert.equal(moved.project, undefined);
    await assert.rejects(() => client.session(loose.id).update({ env: "prod" }), code("invalid"));

    // The device tree carries clients, projects and each session's placement.
    const tree = await client.tree();
    assert.deepEqual(tree.clients?.map((c) => c.slug), ["cafe-luna", "dental-co"]);
    assert.deepEqual(tree.projects?.map((p) => `${p.client}/${p.slug}`).sort(), ["cafe-luna/menu-app", "dental-co/booking-site"]);
    assert.equal(tree.sessions.find((s) => s.id === prod.id)?.env, "prod");

    // Everything survives a restart.
    await server.stop();
    await server.start();
    const after = await client.tree();
    assert.equal(after.projects?.length, 2);
    assert.deepEqual(
      [after.sessions.find((s) => s.id === dev.id)?.project, after.sessions.find((s) => s.id === prod.id)?.env],
      ["dental-co/booking-site", "prod"],
    );

    // Removing a project archives its sessions, drops it and its emptied client; the others stay.
    const removed = await client.removeProject("dental-co", "booking-site");
    assert.deepEqual(removed.archivedSessions.sort(), [dev.id, prod.id].sort());
    const left = await client.tree();
    assert.deepEqual(left.projects?.map((p) => `${p.client}/${p.slug}`), ["cafe-luna/menu-app"]);
    assert.deepEqual(left.clients?.map((c) => c.slug), ["cafe-luna"]);
    assert.deepEqual(left.sessions.map((s) => s.id), [loose.id]);
    await assert.rejects(() => client.project("dental-co", "booking-site"), code("not_found"));
    assert.deepEqual(await client.removeProject("dental-co", "booking-site"), { removed: "dental-co/booking-site", archivedSessions: [] }, "again is a no-op");
    // A missing project leaves its client alone, even a client with no projects.
    await client.putClient("solo", { name: "Solo" });
    assert.deepEqual((await client.removeProject("solo", "nope")).archivedSessions, []);
    assert.ok((await client.clients()).some((c) => c.slug === "solo"), "the empty client stays");

  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a catalog from before projects gains the new columns and keeps its sessions", async () => {
  const t = await tempStore();
  const token = newToken();
  const home = join(t.root, "home");
  let server = await bootServer({ home, startDirs: t.work, token, name: "old-box" });
  const client = new AnthClient(server.base, token);
  try {
    const old = await client.createSession({ name: "Legacy", cwd: t.work, model: faux });
    await server.stop();
    // Rebuild the sessions table the way upstream durable-pi created it: seven columns, no project or env.
    const db = new DatabaseSync(join(home, "backend", "catalog.sqlite"));
    db.exec(`CREATE TABLE legacy AS SELECT id,name,cwd,dbPath,createdAt,model,provider FROM sessions;
      DROP TABLE sessions; ALTER TABLE legacy RENAME TO sessions;`);
    assert.equal((db.prepare("PRAGMA table_info(sessions)").all() as unknown[]).length, 7);
    db.close();
    server = await bootServer({ home, startDirs: t.work, token, name: "old-box", port: Number(new URL(server.base).port) });
    const sessions = await client.sessions();
    assert.deepEqual(sessions.map((s) => s.name), ["Legacy"]);
    assert.equal(sessions[0].id, old.id);
    assert.equal(sessions[0].project, undefined);
    await client.putProject("acme", "site", { name: "Site" });
    assert.equal((await client.session(old.id).update({ project: "acme/site", env: "prod" })).env, "prod");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a project removed while a session for it is being created: the session is refused, nothing is left behind", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    store.upsertProject("race-co", "site", { name: "Site" });
    // Remove the project at the worst moment: after the placement check, while the new session's agent opens.
    const open = store.openAgent.bind(store);
    /** Open the agent as usual, then remove its project before create goes on. */
    store.openAgent = async (...args: Parameters<typeof open>) => {
      const h = await open(...args);
      await store.removeProject("race-co", "site");
      return h;
    };
    await assert.rejects(
      () => store.create({ name: "Racing", cwd: t.work, model: faux, project: "race-co/site" }),
      (e: AnthError) => e.code === "not_found",
    );
    assert.deepEqual(store.list(), [], "no session points at the removed project");
    assert.equal(store.opened.size, 0, "the agent opened for it is closed");
    assert.deepEqual(readdirSync(join(t.options.dataDir, "sessions")), [], "its new folder is gone");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
