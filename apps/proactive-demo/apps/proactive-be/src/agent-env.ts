// Copy of apps/anth-backend/src/agent-env.ts (the demo is its own package).
// The shell environment agents run in. pi-durable's NodeExecutionEnv passes the backend's whole process environment to
// every command by default, which would hand agents the device token, the OpenRouter key and any deploy tokens. This
// wrapper turns that off: agent commands see only the variables named here, plus what a call passes explicitly.
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Variables an agent's shell may inherit from the backend. Nothing secret belongs here. */
export const AGENT_ENV_KEYS = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ"];

/** The allowlisted part of the backend's environment. */
export function agentShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(AGENT_ENV_KEYS.flatMap((k) => (source[k] ? [[k, source[k]!]] : [])));
}

/** A NodeExecutionEnv whose commands never inherit the backend's environment. */
export class AgentExecutionEnv extends NodeExecutionEnv {
  private readonly base: Record<string, string>;
  constructor(options: { cwd: string; shellEnv?: Record<string, string> }) {
    const base = options.shellEnv ?? agentShellEnv();
    super({ cwd: options.cwd, shellEnv: base });
    this.base = base;
  }
  /** Run a command with only the allowlisted environment plus what the caller passes. */
  override exec(
    command: string | readonly string[],
    options: Parameters<NodeExecutionEnv["exec"]>[1],
    context: Context,
  ): ReturnType<NodeExecutionEnv["exec"]> {
    return super.exec(command, { ...options, inheritEnv: false, env: { ...this.base, ...options?.env } }, context);
  }
}
