// Log in as the "Anth Alerts" account once and save the session to .env as TELEGRAM_CALLER_SESSION.
//   just telegram login          (needs TELEGRAM_API_ID and TELEGRAM_API_HASH in .env, from my.telegram.org)
//   just telegram call "text"    (rings TELEGRAM_CALL_TO once, to test)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { callerClient, ring } from "../src/telegram-call.js";

const [mode = "login", arg = ""] = process.argv.slice(2);
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first: my.telegram.org → API development tools (log in with the alerts account's number).");
  process.exit(1);
}

if (mode === "call") {
  const { TELEGRAM_CALLER_SESSION: session, TELEGRAM_CALL_TO: to } = process.env;
  if (!session || !to) {
    console.error("Set TELEGRAM_CALLER_SESSION (just telegram login) and TELEGRAM_CALL_TO (your @username or +phone) in .env.");
    process.exit(1);
  }
  console.log(`Calling ${to}…`);
  console.log(`Call ${await ring({ apiId, apiHash, session, to, text: arg || "Test call from Anth-Agent" })}.`);
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
const client = callerClient(apiId, apiHash, "");
await client.start({
  phoneNumber: () => rl.question("Phone number of the alerts account (+44…): "),
  phoneCode: () => rl.question("Code Telegram sent to that account: "),
  password: () => rl.question("Two-step password (empty if none): "),
  onError: (e) => console.error(e.message),
});
const session = client.session.save() as unknown as string;
appendFileSync(arg || ".env", `\nTELEGRAM_CALLER_SESSION=${session}\n`);
console.log(`Saved TELEGRAM_CALLER_SESSION to ${arg || ".env"}. Keep it secret: it is a login to that account.`);
rl.close();
await client.disconnect();
process.exit(0);
