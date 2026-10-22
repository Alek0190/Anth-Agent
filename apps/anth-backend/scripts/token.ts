// Create (or with --rotate, replace) ANTH_TOKEN in $ANTH_HOME/backend.env and print it.
// `just net up <device>` does this remotely; this script is for manual setups.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = process.env.ANTH_ENV_FILE ?? join(process.env.ANTH_HOME ?? join(homedir(), ".anth"), "backend.env");
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
const current = text.match(/^ANTH_TOKEN=(.+)$/m)?.[1];
if (current && !process.argv.includes("--rotate")) {
  console.log(current);
} else {
  const token = `anth_${randomBytes(32).toString("base64url")}`;
  const rest = text.replace(/^ANTH_TOKEN=.*\n?/m, "");
  writeFileSync(file, `ANTH_TOKEN=${token}\n${rest}`, { mode: 0o600 });
  console.log(token);
}
