// Images attached to a message: checked, saved in the project folder for the team, shown to a model that can see
// them, and kept out of git and out of the entries clients download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AnthClient } from "../../anth-sdk/src/client.js";
import {
  attachmentMessage,
  looksLike,
  MAX_ATTACHMENTS,
  parseAttachments,
  safeName,
  withoutImageData,
} from "../src/attachments.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

// A real 1×1 PNG, an SVG, and a "PNG" of 400 KB (more than the 256 KB every other route accepts).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>').toString("base64");
const BIG_PNG = Buffer.concat([Buffer.from(PNG, "base64").subarray(0, 8), Buffer.alloc(400 * 1024, 7)]).toString("base64");
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");

test("attachments: names, types and limits are checked before anything is saved", () => {
  assert.equal(safeName("../../etc/My Logo (final).PNG", "image/png"), "My-Logo-final.png");
  assert.equal(safeName("C:\\Users\\alex\\icon.jpeg", "image/jpeg"), "icon.jpg");
  assert.equal(safeName("....", "image/svg+xml"), "image.svg");
  assert.ok(looksLike("image/png", Buffer.from(PNG, "base64")));
  assert.ok(looksLike("image/svg+xml", Buffer.from(SVG, "base64")));
  assert.ok(!looksLike("image/png", Buffer.from(SVG, "base64")), "an SVG renamed to .png is refused");

  const one = parseAttachments([{ name: "logo.png", mimeType: "image/png", data: PNG }]);
  assert.equal(one[0].name, "logo.png");
  assert.deepEqual(one[0].view, { mimeType: "image/png", data: PNG }, "a small original is shown as it is");
  assert.equal(parseAttachments([{ name: "a.svg", mimeType: "image/svg+xml", data: SVG }])[0].view, undefined, "an SVG is saved, not shown");
  assert.deepEqual(parseAttachments(undefined), []);

  const refused: [unknown, RegExp][] = [
    ["logo.png", /must be a list/],
    [Array(MAX_ATTACHMENTS + 1).fill({ name: "a.png", mimeType: "image/png", data: PNG }), /at most 4/],
    [[{ name: "a.pdf", mimeType: "application/pdf", data: PNG }], /only PNG, JPEG, WebP, GIF and SVG/],
    [[{ name: "a.png", mimeType: "image/png", data: SVG }], /is not a PNG image/],
    [[{ name: "a.png", mimeType: "image/png", data: "not base64!" }], /base64/],
    [[{ name: "", mimeType: "image/png", data: PNG }], /needs a file name/],
    [[{ name: "a.png", mimeType: "image/png", data: PNG, preview: { mimeType: "image/svg+xml", data: SVG } }], /preview must be/],
    [[{ name: "a.png", mimeType: "image/png", data: PNG, preview: { mimeType: "image/jpeg", data: PNG } }], /preview is not a JPEG/],
  ];
  for (const [value, message] of refused) assert.throws(() => parseAttachments(value), message);
  // A preview from the hub is what the model sees.
  const withPreview = parseAttachments([{ name: "photo.png", mimeType: "image/png", data: PNG, preview: { mimeType: "image/jpeg", data: JPEG_HEAD } }]);
  assert.deepEqual(withPreview[0].view, { mimeType: "image/jpeg", data: JPEG_HEAD });
});

test("attachments: the message names the files, and shows the images only to a model that can see them", () => {
  const saved = [
    { path: ".anth/uploads/2026-10-25/logo.png", absolute: "/x", mimeType: "image/png", size: 2048, view: { mimeType: "image/png", data: PNG } },
    { path: ".anth/uploads/2026-10-25/icon.svg", absolute: "/y", mimeType: "image/svg+xml", size: 900 },
  ];
  const seeing = attachmentMessage("Use this logo", saved, true);
  assert.ok(Array.isArray(seeing));
  const [intro, image] = seeing as [{ type: "text"; text: string }, { type: "image"; data: string; mimeType: string }];
  assert.match(intro.text, /^Use this logo\n\nThe owner attached 2 files/);
  assert.match(intro.text, /- \.anth\/uploads\/2026-10-25\/logo\.png \(PNG image, 2 KB\)/);
  assert.match(intro.text, /- \.anth\/uploads\/2026-10-25\/icon\.svg \(SVG image, 1 KB\)/);
  assert.match(intro.text, /git-ignored: to use one in the product, copy it into the project/);
  assert.match(intro.text, /open the others with your tools/);
  assert.deepEqual(image, { type: "image", data: PNG, mimeType: "image/png" });
  assert.equal(seeing.length, 2, "the SVG is not sent as a picture");

  const blind = attachmentMessage("", saved, false);
  assert.equal(typeof blind, "string");
  assert.match(blind as string, /^The owner attached 2 files/);
  assert.match(blind as string, /Your model cannot see images/);

  const stripped = withoutImageData({ entries: [{ model: [{ role: "user", content: seeing }] }] });
  assert.deepEqual((stripped.entries[0].model[0].content as unknown[])[1], { type: "image", mimeType: "image/png", data: "", omitted: true });
});

test("attachments over the API: saved for the team, git-ignored, reused on retry, shown to the model, stripped for clients", async () => {
  const t = await tempStore();
  const token = newToken();
  const project = join(t.work, "project");
  execFileSync("git", ["init", "-q"], { cwd: project });
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "uploads-box" });
  try {
    const client = new AnthClient(server.base, token);
    const s = await client.createSession({ name: "Brand", cwd: project, model: faux });
    const lead = client.agent(s.id, "main");
    const logo = { name: "anthwebbuilder logo.png", mimeType: "image/png", data: BIG_PNG };
    const icon = { name: "icon.svg", mimeType: "image/svg+xml", data: SVG };

    const sent = await lead.send("Here are the logo and icon", "followUp", "up-1", 60000, [logo, icon]);
    assert.equal(sent.status, "done");
    const day = new Date().toISOString().slice(0, 10);
    const folder = join(project, ".anth", "uploads", day);
    assert.deepEqual(readdirSync(folder).sort(), ["anthwebbuilder-logo.png", "icon.svg"]);
    assert.ok(readFileSync(join(folder, "anthwebbuilder-logo.png")).equals(Buffer.from(BIG_PNG, "base64")));
    // Never committed by accident: the repo's local exclude keeps .anth/ out of git add -A.
    assert.match(readFileSync(join(project, ".git", "info", "exclude"), "utf8"), /^\/\.anth\/$/m);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }), "");

    // The agent got the paths, and (its model sees images) the PNG itself; clients get the entry without the data.
    const md = (await lead.transcript("markdown")).text ?? "";
    assert.match(md, /Here are the logo and icon/);
    assert.match(md, new RegExp(`\\.anth/uploads/${day}/anthwebbuilder-logo\\.png \\(PNG image, 400 KB\\)`));
    const entries = await lead.entries();
    type Stored = { model?: { role: string; content: unknown }[] };
    const user = (entries.items as unknown as Stored[]).find(
      (e) => e.model?.[0]?.role === "user" && JSON.stringify(e).includes("anthwebbuilder-logo.png"),
    );
    const blocks = user!.model![0].content as unknown[];
    assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "", omitted: true });
    assert.ok(JSON.stringify(entries).length < 100_000, "no image data downloaded");

    // A retried send (same requestId) and the same file again reuse the saved file; a different file gets -2.
    await lead.send("Here are the logo and icon", "followUp", "up-1", 60000, [logo, icon]);
    await lead.send("Same logo", "followUp", "up-2", 60000, [logo]);
    assert.equal(readdirSync(folder).length, 2);
    await lead.send("New version", "followUp", "up-3", 60000, [{ ...logo, data: PNG }]);
    assert.deepEqual(readdirSync(folder).sort(), ["anthwebbuilder-logo-2.png", "anthwebbuilder-logo.png", "icon.svg"]);

    // Refusals the owner can act on; nothing is saved.
    const post = (body: unknown) =>
      fetch(`${server.base}/v1/sessions/${s.id}/agents/main/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const fake = await post({ content: "x", requestId: "bad-1", attachments: [{ name: "a.png", mimeType: "image/png", data: SVG }] });
    assert.equal(fake.status, 400);
    assert.match(JSON.stringify(await fake.json()), /is not a PNG image/);
    const empty = await post({ content: "  ", requestId: "bad-2" });
    assert.equal(empty.status, 400);
    const huge = await post({ content: "x", requestId: "bad-3", attachments: [{ name: "a.png", mimeType: "image/png", data: "A".repeat(34 * 1024 * 1024) }] });
    assert.equal(huge.status, 400);
    assert.match(JSON.stringify(await huge.json()), /Message too large/);
    assert.ok(!existsSync(join(folder, "a.png")));
    // Other routes keep their small body limit.
    const other = await fetch(`${server.base}/v1/sessions/${s.id}/agents/main`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(300 * 1024) }),
    });
    assert.equal(other.status, 400);
    assert.match(JSON.stringify(await other.json()), /Body too large/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
