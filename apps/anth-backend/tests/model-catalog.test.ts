// The model catalog the backend builds at startup from pi-ai's bundled OpenRouter snapshot plus newerModels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { curatedModels, missingCurated, newerModels, withNewerModels } from "../src/model-catalog.js";

test("every curated model is served (the backend would refuse to start otherwise), newer ones with their own prices", () => {
  const snapshot = openrouterProvider().getModels();
  const catalog = withNewerModels(snapshot);
  assert.deepEqual(missingCurated(catalog), []);
  assert.equal(new Set(curatedModels.map((m) => m.id)).size, curatedModels.length, "no model is listed twice");
  for (const extra of newerModels) {
    const base = snapshot.find((m) => m.id === extra.like);
    assert.ok(base, `${extra.id} copies ${extra.like}, which the snapshot must list`);
    const m = catalog.find((c) => c.id === extra.id)!;
    assert.deepEqual([m.cost, m.contextWindow, m.maxTokens], [extra.cost, extra.contextWindow, extra.maxTokens]);
    // API settings come from the model it copies.
    assert.deepEqual([m.api, m.reasoning, m.input], [base.api, base.reasoning, base.input]);
  }
  // Added on 2026-10-27, all on tier A.
  const added = ["openai/gpt-6.1-terra-pro", "openai/gpt-6.1-terra", "moonshotai/kimi-k3.1-pro", "minimax/minimax-m3.1-flash"];
  assert.deepEqual(
    added.map((id) => curatedModels.find((c) => c.id === id)?.tier),
    ["A", "A", "A", "A"],
  );
  assert.equal(catalog.find((m) => m.id === "minimax/minimax-m3.1-flash")?.contextWindow, 1000000);
  // A model the snapshot already lists is never overwritten.
  assert.equal(withNewerModels(catalog).length, catalog.length);
});
