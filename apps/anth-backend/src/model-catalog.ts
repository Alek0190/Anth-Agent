// Source: https://agenticengineer.com/model-stack, retrieved 2026-10-05.
// Active S+, S, A and B models, matched to https://openrouter.ai/api/v1/models.
// Gemini 4 Argon is rolling out and has no OpenRouter listing at this snapshot.
export const curatedModels = [
  {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-fable-5.1",
    name: "Claude Fable 5.1",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Opus 5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-fable-5",
    name: "Fable 5",
    tier: "S",
    icon: "anthropic.png",
  },
  {
    id: "meta/muse-spark-1.3",
    name: "Muse Spark 1.3",
    tier: "S",
    icon: "meta.png",
  },
  {
    id: "openai/gpt-6-sol",
    name: "GPT-6 Sol",
    tier: "S",
    icon: "openai.png",
  },
  {
    id: "x-ai/grok-4.7",
    name: "Grok 4.7",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "xiaomi/mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    tier: "S",
    icon: "xiaomi.png",
  },
  {
    id: "x-ai/grok-4.6",
    name: "Grok 4.6",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    tier: "S",
    icon: "deepseek.png",
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM-5.3",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    tier: "A",
    icon: "kimi.png",
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    tier: "A",
    icon: "kimi.png",
  },
  {
    id: "openai/gpt-6.1-terra-pro",
    name: "GPT-6.1 Terra Pro",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "openai/gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT 5.6 Terra",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "qwen/qwen3.8-2.4t-a95b",
    name: "Qwen3.8-2.4T-A95B",
    tier: "A",
    icon: "qwen.png",
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Sonnet 5",
    tier: "A",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    tier: "A",
    icon: "xiaomi.png",
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM-5.2",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "minimax/minimax-m3.1-flash",
    name: "MiniMax-M3.1-Flash",
    tier: "A",
    icon: "minimax.png",
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    tier: "B",
    icon: "zai.png",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    tier: "B",
    icon: "gemini.png",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax-M3",
    tier: "B",
    icon: "minimax.png",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    tier: "B",
    icon: "gemini.png",
  },
] as const;
export const defaultModelId = "anthropic/claude-sonnet-5.5";

/**
 * Curated models newer than the OpenRouter snapshot bundled with pi-ai. Each copies the API settings of a model the
 * snapshot lists (`like`) and sets what differs. DeepSeek V4.1 Flash 1017: pi-ai's OpenRouter snapshot (2026-10-21).
 * GPT-6.1 Terra and Terra Pro, Kimi K3.1 Pro, MiniMax M3.1 Flash: openrouter.ai model pages, 2026-10-27; their output
 * limits are not published yet, so they keep the `like` model's. Drop an entry once the bundled snapshot lists the
 * model itself.
 */
export const newerModels = [
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    like: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek: DeepSeek V4.1 Flash 1017",
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 393216,
  },
  {
    id: "openai/gpt-6.1-terra-pro",
    like: "openai/gpt-5.6-terra-pro",
    name: "OpenAI: GPT-6.1 Terra Pro",
    cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: "openai/gpt-6.1-terra",
    like: "openai/gpt-5.6-terra",
    name: "OpenAI: GPT-6.1 Terra",
    cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  {
    id: "moonshotai/kimi-k3.1-pro",
    like: "moonshotai/kimi-k3",
    name: "MoonshotAI: Kimi K3.1 Pro",
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: "minimax/minimax-m3.1-flash",
    like: "minimax/minimax-m3",
    name: "MiniMax: MiniMax M3.1 Flash",
    cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 512000,
  },
] as const;

type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/**
 * The OpenRouter catalog with the newer curated models added, each copied from its `like` model with its own name,
 * prices and limits. A model the catalog already lists is left as the catalog has it.
 */
export function withNewerModels<T extends CatalogModel>(catalog: readonly T[]): T[] {
  const out = [...catalog];
  for (const extra of newerModels) {
    const base = out.find((m) => m.id === extra.like);
    if (base && !out.some((m) => m.id === extra.id))
      out.push({ ...base, id: extra.id, name: extra.name, cost: { ...extra.cost }, contextWindow: extra.contextWindow, maxTokens: extra.maxTokens });
  }
  return out;
}

/** Curated model ids the catalog cannot serve (the backend refuses to start with any). */
export const missingCurated = (catalog: readonly { id: string }[]) =>
  curatedModels.filter((c) => !catalog.some((m) => m.id === c.id)).map((c) => c.id);
