// Device configuration: ~/.anth/backend.env (or $ANTH_ENV_FILE) plus CLI flags.
// Nothing here knows about specific machines; anth-network.yaml on the operator's laptop
// writes this env file through `just net up <device>`.
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  provider: "openrouter" | "faux";
  token: string;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.ANTH_HOME ?? join(homedir(), ".anth"));
  const envFile = expand(flag("--env-file", env.ANTH_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config: BackendConfig = {
    name: flag("--name", env.ANTH_DEVICE_NAME ?? hostname().replace(/\.local$/, "")),
    host: flag("--host", env.ANTH_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.ANTH_PORT ?? "4780")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.ANTH_DATA_DIR ?? join(home, "backend")))),
    startDirs: flag("--start-dirs", env.ANTH_START_DIRS ?? "~/anth-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    provider: (env.ANTH_PROVIDER ?? "openrouter") === "faux" ? "faux" : "openrouter",
    token: env.ANTH_TOKEN ?? "",
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.token.length < 32)
    throw Error(
      `ANTH_TOKEN is missing or shorter than 32 characters (looked in ${envFile}). Create one with: npm run token`,
    );
  return config;
}
