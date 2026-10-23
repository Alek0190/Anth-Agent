// runEffect names a missing or wrong working folder instead of Node's "spawn bash ENOENT".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEffect } from "../src/jobs.js";

test("runEffect: a missing folder and a file are reported plainly; a folder runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "anth-effect-"));
  try {
    writeFileSync(join(root, "file.txt"), "x");
    await assert.rejects(() => runEffect("true", join(root, "nope"), {}, 10), /The folder .*nope does not exist/);
    await assert.rejects(() => runEffect("true", join(root, "file.txt"), {}, 10), /file\.txt is a file, not a folder/);
    assert.deepEqual(await runEffect("echo ok", root, {}, 10), { code: 0, out: "ok\n" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
