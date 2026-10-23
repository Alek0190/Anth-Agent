// End-to-end check of the web client: a hub plus two faux-provider anth-backends, driven by a
// headless browser. Covers the network tree (devices from anth-network.yaml), sessions via the directory browser,
// streaming turns, every agent feature in the parity list, offline/recovery and narrow screens.
//   npm run build && node tests/network-ui.mjs        (HEADED=1 to watch)
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const app = resolve(import.meta.dirname, "..");
const backendDir = resolve(app, "../anth-backend");
const tmp = mkdtempSync(join(tmpdir(), "anth-net-ui-"));
const work = join(tmp, "work");
mkdirSync(join(work, "project-alpha"), { recursive: true });
// project-alpha is a git repository, so an incident there gets its own worktree.
for (const args of [
  ["init", "-q", "-b", "main"],
  [
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@t.t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ],
])
  execFileSync("git", args, { cwd: join(work, "project-alpha") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => randomBytes(24).toString("hex");
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
const children = new Set();
function run(args, env, cwd) {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.log = () => log;
  return child;
}
async function waitHttp(url) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw Error(`${url} never came up`);
}
async function backend(name, port, tok) {
  const home = join(tmp, name);
  mkdirSync(home, { recursive: true });
  const child = run(
    [resolve(backendDir, "src/main.ts"), "--port", String(port), "--host", "127.0.0.1"],
    {
      ANTH_HOME: home,
      ANTH_ENV_FILE: join(home, "none.env"),
      ANTH_TOKEN: tok,
      ANTH_PROVIDER: "faux",
      ANTH_START_DIRS: work,
      ANTH_DEVICE_NAME: name,
    },
    backendDir,
  );
  await waitHttp(`http://127.0.0.1:${port}/healthz`);
  return child;
}
const stop = (child) =>
  new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once("exit", done);
    child.kill("SIGKILL");
  });

const tokenA = token(),
  tokenB = token();
const [portA, portB, hubPort] = [await freePort(), await freePort(), await freePort()];
await backend("box-a", portA, tokenA);
let b = await backend("box-b", portB, tokenB);
writeFileSync(
  join(tmp, "anth-network.yaml"),
  `devices:\n  box-a:\n    kind: url\n    url: http://127.0.0.1:${portA}\n    token_env: TOKEN_A\n` +
    `  box-b:\n    kind: url\n    url: http://127.0.0.1:${portB}\n    token_env: TOKEN_B\n`,
);
mkdirSync(join(tmp, "hub"));
const hub = run(
  [resolve(app, "apps/anth-hub-server/src/main.ts"), "--port", String(hubPort)],
  // box-b starts with a wrong token: device setup happens in the terminal, not in the UI.
  {
    ANTH_HOME: join(tmp, "hub"),
    ANTH_NETWORK_FILE: join(tmp, "anth-network.yaml"),
    TOKEN_A: tokenA,
    TOKEN_B: "w".repeat(40),
  },
  app,
);
const base = `http://localhost:${hubPort}`;
await waitHttp(`${base}/api/network`);

const browser = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
let page = await context.newPage();
watch(page);
const pass = (msg) => console.log(`PASS ${msg}`);
const row = (key) => page.locator(`.tree-row[data-key="${key}"]`);
const composer = () => page.getByLabel("Message your agent");
async function send(text, mode = "followUp") {
  await page.getByLabel("When busy").selectOption(mode);
  await composer().fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
const chat = () => page.getByTestId("chat");
/** `just net register <id> --token <t>` against the test hub's registry. */
async function register(id, tok) {
  const child = run(
    [resolve(app, "../anth-sdk/scripts/net.ts"), "register", id, "--token", tok],
    { ANTH_HOME: join(tmp, "hub"), ANTH_NETWORK_FILE: join(tmp, "anth-network.yaml") },
    resolve(app, "../anth-sdk"),
  );
  const code = await new Promise((done) => child.on("exit", done));
  if (code !== 0) throw Error(`net register ${id} failed:\n${child.log()}`);
}
async function check(id) {
  await row(id).hover();
  await row(id)
    .getByRole("button", { name: `Check ${id}` })
    .click();
}
const tab = (name) => page.getByRole("tab", { name, exact: true }).click();

try {
  await page.goto(base);
  await expect(row("box-a").locator(".dot.on")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".network-summary")).toContainText("1 of 2 online");
  pass("config device from anth-network.yaml is online in the tree");

  // No device configuration in the UI: box-b is declared in the YAML with a wrong token.
  await expect(page.getByRole("button", { name: "Add device" })).toHaveCount(0);
  await expect(row("box-b").locator(".dot.err")).toBeVisible({ timeout: 15000 });
  await expect(row("box-b")).toContainText("token rejected");
  await register("box-b", tokenB);
  await check("box-b");
  await expect(row("box-b").locator(".dot.on")).toBeVisible({ timeout: 15000 });
  pass("YAML device with a bad token: unauthorized, fixed with net register + check");

  // New session on box-b through the directory browser.
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Device", { exact: true }).selectOption("box-b");
  await page.getByLabel("Session name").fill("UI on B");
  await page.getByRole("option", { name: "project-alpha" }).click();
  await expect(page.getByLabel("Working directory", { exact: true })).toHaveValue(/project-alpha$/);
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.locator(".device-chip")).toHaveText("box-b");
  await expect(page.getByText("A conversation with continuity.")).toBeVisible();
  await expect(page.locator(".tree-row.session").filter({ hasText: "UI on B" })).toBeVisible();
  pass("session created on box-b via the dir browser and selected");

  await send("hello there");
  await expect(chat().locator(".markdown").filter({ hasText: "Echo: hello there" })).toBeVisible();
  await send("!echo TOOL_OK");
  await expect(chat().locator(".tool-call").filter({ hasText: "bash" }).last()).toContainText(
    "Done",
    { timeout: 15000 },
  );
  await expect(chat().getByText("Tool finished: TOOL_OK")).toBeVisible();
  pass("streamed turns: text reply and a bash tool round");

  // Busy: queue + withdraw, reject-if-busy, steer, Escape interrupt.
  await send("!sleep 6");
  const interrupt = page.getByRole("button", { name: "Interrupt", exact: true });
  await expect(interrupt).toBeEnabled({ timeout: 10000 });
  await send("queued one");
  await expect(page.locator(".queue")).toContainText("Queued: queued one");
  await page
    .locator(".queue")
    .getByRole("button", { name: /Withdraw submission/ })
    .click();
  await expect(page.locator(".queue")).toHaveCount(0);
  await send("do not admit", "reject");
  await expect(page.locator(".error-banner")).toContainText(/busy/i);
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await send("steer this", "steer");
  await expect(chat().locator(".markdown").filter({ hasText: "Echo: steer this" })).toBeVisible({
    timeout: 20000,
  });
  await expect(chat().getByText("queued one")).toHaveCount(0);
  pass("follow-up withdraw, reject-if-busy, steer after the tool round");
  await send("!sleep 30");
  await expect(interrupt).toBeEnabled({ timeout: 10000 });
  // One Escape only arms the interrupt: the work keeps running.
  await page.locator("body").press("Escape");
  await expect(page.getByText("Press Esc again to interrupt")).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(500);
  await expect(interrupt).toBeEnabled();
  await page.locator("body").press("Escape");
  await expect(interrupt).toBeDisabled({ timeout: 15000 });
  pass("a single Escape warns; a second Escape interrupts foreground work");

  // Fork at the first assistant entry with a name.
  const firstAgent = chat().locator(".entry.pi-assistant").first();
  await firstAgent.getByRole("button", { name: /Fork at entry/ }).click();
  await page.getByLabel("Fork name").fill("Alt path");
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Conversation lineage" }).locator('[aria-current="page"]'),
  ).toContainText("Alt path");
  await expect(page.locator(".tree-row.agent.sel")).toContainText("Alt path");
  await expect(chat().locator(".markdown").filter({ hasText: "Echo: hello there" })).toBeVisible();
  await expect(chat().getByText("Tool finished: TOOL_OK")).toHaveCount(0);
  pass("fork at an entry: lineage breadcrumb, tree row, truncated history");
  await page.getByRole("button", { name: "Browse conversations" }).click();
  await page.locator(".conversation-choice").filter({ hasText: "Main" }).first().click();
  await expect(
    page.getByRole("navigation", { name: "Conversation lineage" }).locator('[aria-current="page"]'),
  ).toContainText("Main");
  pass("roots & forks picker switches agents");

  // Rename session (inspector) and agent (header).
  await page.getByRole("button", { name: "Rename session", exact: true }).click();
  await page.getByLabel("Session name").fill("Renamed B");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".tree-row.session").filter({ hasText: "Renamed B" })).toBeVisible();
  await page.getByRole("button", { name: "Rename agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Lead");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".tree-row.agent.sel")).toContainText("Lead");
  pass("rename session and agent");

  // Model picker, thinking level, instructions; they persist on the device.
  await page.locator(".model-button").click();
  await page.getByLabel("Search models").fill("echo");
  await page.locator(".model-list button").filter({ hasText: "Faux Echo" }).click();
  await expect(page.locator(".model-modal")).toHaveCount(0);
  await page.getByLabel("Thinking level").selectOption("minimal");
  await expect(page.locator(".toast")).toContainText("Thinking minimal");
  await tab("Tools");
  await expect(
    page
      .locator(".tool-row")
      .filter({ has: page.locator("summary strong", { hasText: /^bash$/ }) }),
  ).toBeVisible();
  await page.locator(".tool-row summary").filter({ hasText: "start_session" }).click();
  await expect(page.getByLabel("start_session TypeScript definition")).toContainText(
    "function start_session(args: {",
  );
  await expect(page.getByLabel("start_session TypeScript definition")).toContainText(
    "model?: string;",
  );
  pass("model and thinking level saved; tool signatures render");

  // Read only: the tools that write fade out as disabled and leave the agent's requests.
  const toolRow = (name) =>
    page
      .locator(".tool-row")
      .filter({ has: page.locator("summary strong", { hasText: new RegExp(`^${name}$`) }) });
  await page.getByRole("switch", { name: "Read only" }).click();
  await expect(page.getByRole("switch", { name: "Read only" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(toolRow("bash")).toHaveClass(/disabled/);
  await expect(toolRow("bash")).toContainText("disabled");
  await expect(toolRow("read")).not.toHaveClass(/disabled/);
  await send("!pwd");
  await expect(chat()).toContainText("Tool bash is not available", { timeout: 15000 });
  await page.getByRole("switch", { name: "Read only" }).click();
  await expect(page.getByRole("switch", { name: "Read only" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(toolRow("bash")).not.toHaveClass(/disabled/);
  pass("read only disables the tools that write, then restores them");

  // Extensions: custom harness capabilities turn on and off per agent and apply from the next request.
  await tab("Extend");
  await expect(page.locator(".ext-card")).toHaveCount(2);
  const jevSwitch = page.getByRole("switch", { name: "Jev damage control" });
  await expect(jevSwitch).toHaveAttribute("aria-checked", "false");
  await jevSwitch.click();
  await expect(jevSwitch).toHaveAttribute("aria-checked", "true");
  await send("!rm -rf nothing-here");
  await expect(chat()).toContainText("jev-damage-control blocked this command", { timeout: 15000 });
  await jevSwitch.click();
  await expect(jevSwitch).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "System prompts" }).click();
  await jevSwitch.click();
  await expect(page.getByRole("switch", { name: "System prompts" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(jevSwitch).toHaveAttribute("aria-checked", "true");
  await jevSwitch.click();
  await page.getByRole("checkbox", { name: "one_sentence.md" }).check();
  await page.reload();
  await tab("Extend");
  await expect(page.getByRole("switch", { name: "System prompts" })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: 10000 },
  );
  await expect(page.getByRole("checkbox", { name: "one_sentence.md" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "smart_ass_opus_fix.md" })).toBeChecked();
  await page.getByRole("switch", { name: "System prompts" }).click();
  await expect(page.getByRole("switch", { name: "System prompts" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  pass(
    "extensions: jev-damage-control blocks rm -rf while on; both stack; the prompt checklist persists",
  );

  // App State: live controls and the JSON editor with its revision guard.
  await tab("State");
  await page.getByRole("button", { name: "Increment /counter", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Value of /counter", exact: true }),
  ).toHaveValue("1");
  const json = page.getByLabel("App State JSON");
  const current = JSON.parse(await json.inputValue());
  await json.fill(JSON.stringify({ ...current, goal: "From the JSON editor" }, null, 2));
  await page.getByRole("button", { name: "Save JSON" }).click();
  await expect(page.locator(".toast")).toContainText("Shared App State saved.");
  await expect(page.getByLabel("Value of /goal")).toHaveValue("From the JSON editor");
  await json.fill(JSON.stringify({ ...current, goal: "stale edit" }, null, 2));
  await fetch(`${base}/api/devices/box-b/v1/sessions/Renamed B/agents/main/demo/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "increment", path: "/counter", value: 1 }),
  });
  await expect(page.getByText("State changed elsewhere")).toBeVisible();
  await page.getByRole("button", { name: "Load latest" }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Value of /counter", exact: true }),
  ).toHaveValue("2");
  pass("App State controls, JSON save and the stale-revision guard");

  // Durable jobs: the list in Tasks, run cards in the chat with named phases and their steps, stop, an approval that
  // survives a reload, a run the agent starts with its tool, the task tree, stop all and runtime details.
  await tab("Tasks");
  await expect(page.locator(".job-def")).toHaveCount(5);
  const shipDef = page.locator(".job-def").filter({ hasText: "Ship" }).first();
  await expect(shipDef).toContainText("Approve production");
  await expect(shipDef).toContainText("Promote");
  await page.getByRole("button", { name: "Run Workspace snapshot" }).click();
  const snapshot = chat().locator(".job-run").filter({ hasText: "Workspace snapshot" }).first();
  await expect(snapshot).toContainText("Completed", { timeout: 20000 });
  await expect(snapshot.locator(".job-stepper .ph-done")).toHaveCount(4);
  await expect(
    snapshot.locator(".job-steps code").filter({ hasText: "git status --short" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Run Change watch" }).click();
  const watching = chat().locator(".job-run").filter({ hasText: "Change watch" }).first();
  await expect(watching.locator(".job-stepper .ph-running")).toContainText("Watch", {
    timeout: 15000,
  });
  await expect(page.locator(".task-row").filter({ hasText: "Change watch #1" })).toBeVisible();
  await watching.getByRole("button", { name: "Stop" }).click();
  await expect(watching).toContainText("Stopped", { timeout: 15000 });
  await page.getByRole("button", { name: "Run Release check" }).click();
  const release = chat().locator(".job-run").filter({ hasText: "Release check" }).first();
  await expect(release.getByRole("button", { name: /Approve/ })).toBeVisible({ timeout: 30000 });
  await expect(release.locator(".job-steps .k-tool code").filter({ hasText: "bash" })).toHaveCount(
    1,
  );
  await page.reload();
  await release.getByRole("button", { name: /Approve/ }).click();
  await expect(release).toContainText("Completed", { timeout: 20000 });
  await send("job: workspace-snapshot");
  const byAgent = chat().locator(".job-run").filter({ hasText: "started by the agent" }).first();
  await expect(byAgent).toContainText("Completed", { timeout: 30000 });
  await expect(byAgent).toContainText("run #2");
  await tab("Tasks");
  await page.getByRole("button", { name: "Run Change watch" }).click();
  await expect(page.locator(".task-row").filter({ hasText: "Change watch #2" })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Stop all" }).click();
  await expect(page.locator(".task-row")).toHaveCount(0, { timeout: 15000 });
  await page.locator("summary").filter({ hasText: "Runtime details" }).click();
  await expect(page.locator("summary").filter({ hasText: "Recovery inspection" })).toBeVisible();
  await expect(
    page
      .locator(".tasks-panel details.raw details.raw summary")
      .filter({ hasText: /#\d+/ })
      .first(),
  ).toBeVisible({ timeout: 10000 });
  pass(
    "durable jobs: run cards with phases and steps, stop, approval across reload, agent run, task tree, stop all",
  );

  // Context bar: the auto-compaction marker moves with the keyboard and the session keeps it.
  await tab("Session");
  const autoMarker = page.getByRole("slider", { name: "Automatic compaction starts at" });
  await expect(autoMarker).toHaveAttribute("aria-valuenow", "78848");
  await autoMarker.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(autoMarker).toContainText("Auto-compact at 77.8k");
  await page.reload();
  await expect(
    page.getByRole("slider", { name: "Automatic compaction starts at" }),
  ).toHaveAttribute("aria-valuenow", "77824", { timeout: 10000 });
  await page.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "Context compaction" });
  await expect(details.getByRole("checkbox", { name: "Automatic compaction" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  pass("context bar: compaction markers save per session; Details opens the compaction settings");

  // Slash commands in the composer: the menu, /tasks, /compact, /reset with a handoff note.
  await composer().fill("/");
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }).getByRole("option"),
  ).toHaveCount(9);
  // A click proves the menu is on screen: a clipped option cannot receive the pointer.
  await composer().fill("/ta");
  await page.getByRole("option", { name: /\/tasks/ }).click();
  await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(composer()).toHaveValue("");
  await composer().fill("/compact");
  await composer().press("Enter");
  await expect(page.locator(".toast")).toContainText("Compaction requested");
  await composer().fill("/reset Carry on from the handoff.");
  await composer().press("Enter");
  await expect(
    chat()
      .getByText(/New context started|Carry on from the handoff/)
      .first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(chat().locator(".markdown").filter({ hasText: "Echo: hello there" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "History" })).toHaveCount(0);
  pass("slash commands: menu, /tasks, /compact, /reset with a handoff note");

  // Session tab usage; implementation details (storage paths) have no tab.
  await tab("Session");
  await expect(page.locator(".usage-breakdown")).toBeVisible();
  await expect(page.getByLabel("Thinking level")).toHaveValue("minimal");
  await expect(page.getByRole("tab", { name: "Storage" })).toHaveCount(0);
  pass("usage table, no storage tab");

  // New agent in the same session.
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByText("A conversation with continuity.")).toBeVisible();
  pass("new agent in the session");

  // Reload: selection and fold state come back from the hub's ui_state.
  const selectedKey = await page.locator(".tree-row.agent.sel").getAttribute("data-key");
  await page.reload();
  await expect(page.locator(".tree-row.agent.sel")).toHaveAttribute("data-key", selectedKey, {
    timeout: 10000,
  });
  pass("selection restored from ui_state after reload");

  // Two tabs on one agent: both stream.
  const second = await context.newPage();
  watch(second);
  await second.goto(base);
  await expect(second.locator(".tree-row.agent.sel")).toHaveAttribute("data-key", selectedKey);
  await send("from tab one");
  await expect(
    second.getByTestId("chat").locator(".markdown").filter({ hasText: "Echo: from tab one" }),
  ).toBeVisible();
  await second.close();
  pass("two tabs on the same agent both stream");

  // Keyboard: move through the tree and select with Enter.
  await page.locator(".tree-list").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  pass("tree keyboard navigation");

  // Offline: kill box-b → dimmed cached tree + offline panel; restart → recovers on its own.
  const agentKey = selectedKey;
  await page.locator(`.tree-row[data-key="${agentKey}"]`).click();
  await stop(b);
  await expect(row("box-b").locator(".dot.off")).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".offline-panel")).toContainText("box-b is offline");
  await expect(page.locator(`.tree-row[data-key="${agentKey}"]`)).toHaveClass(/stale/);
  b = await backend("box-b", portB, tokenB);
  await expect(row("box-b").locator(".dot.on")).toBeVisible({ timeout: 40000 });
  await expect(page.locator(".offline-panel")).toHaveCount(0);
  await expect(chat().locator(".markdown").filter({ hasText: "Echo: from tab one" })).toBeVisible({
    timeout: 15000,
  });
  pass("offline panel, cached tree, automatic recovery");

  // Token rejected → the offline panel shows the terminal fix; Check now recovers.
  await register("box-b", "z".repeat(40));
  await check("box-b");
  await expect(page.locator(".offline-panel")).toContainText("rejected its token", {
    timeout: 15000,
  });
  await expect(page.locator(".offline-command")).toContainText("just net register box-b");
  await register("box-b", tokenB);
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".offline-panel")).toHaveCount(0, { timeout: 15000 });
  pass("unauthorized device: offline panel shows just net register, Check now recovers");

  // Collapse both side panels to their rails, then expand from the rails.
  await page.getByRole("button", { name: "Collapse network" }).click();
  await page.getByRole("button", { name: "Collapse inspector" }).click();
  await expect(page.locator(".network-sidebar.collapsed .rail-device")).toHaveCount(2);
  await page.getByRole("button", { name: "Open Tasks" }).click();
  await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Expand network" }).click();
  await expect(page.locator(".tree-list")).toBeVisible();
  // Hotkeys toggle both panels: Ctrl on macOS, Alt+Shift elsewhere.
  const mod = process.platform === "darwin" ? "Control" : "Alt+Shift";
  await page.keyboard.press(`${mod}+KeyN`);
  await expect(page.locator(".network-sidebar.collapsed")).toHaveCount(1);
  await page.keyboard.press(`${mod}+KeyN`);
  await expect(page.locator(".tree-list")).toBeVisible();
  await page.keyboard.press(`${mod}+KeyT`);
  await expect(page.getByRole("button", { name: "Expand inspector" })).toBeVisible();
  await page.keyboard.press(`${mod}+KeyT`);
  await expect(page.getByRole("button", { name: "Collapse inspector" })).toBeVisible();
  pass("network and inspector collapse to rails, expand again, and toggle by hotkey");

  // Breadcrumb: device › workspace › agent levels.
  const crumbs = page.getByRole("navigation", { name: "Conversation lineage" });
  await expect(crumbs.locator(".crumb-kind")).toHaveText(["device", "workspace", "agent"]);
  await expect(crumbs.locator(".device-icon")).toHaveCount(1);
  pass("breadcrumb labels device, workspace and agent");

  // Narrow screen: no horizontal overflow; the tree is a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Toggle network" }).click();
  await expect(page.locator(".network-sidebar.open")).toBeVisible();
  await page.screenshot({ path: "/tmp/anth-net-mobile.png" });
  pass("narrow viewport: drawer tree, no horizontal overflow");

  // Archive the session from the tree.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const session = page.locator(".tree-row.session").filter({ hasText: "Renamed B" });
  await session.hover();
  await session.getByRole("button", { name: /Archive session/ }).click();
  await page.getByRole("button", { name: "Archive session", exact: true }).click();
  await expect(page.locator(".tree-row.session").filter({ hasText: "Renamed B" })).toHaveCount(0, {
    timeout: 10000,
  });
  pass("archive session");

  // Clients → projects → environments: a new client and project, its first session, a move to prod, and a second
  // device joining the same project in staging.
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Client", { exact: true }).selectOption("__new");
  await page.getByLabel("Client name").fill("Dental Co");
  await page.getByLabel("Project name").fill("Booking site");
  await page.getByLabel("Register on device").selectOption("box-b");
  await expect(page.locator(".session-modal")).toContainText("dental-co/booking-site");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  // The new-session dialog opens with the project and dev already chosen.
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("dental-co/booking-site");
  await expect(page.getByLabel("Environment", { exact: true })).toHaveValue("dev");
  await expect(page.getByLabel("Device", { exact: true })).toHaveValue("box-b");
  await page.getByLabel("Session name").fill("Booking build");
  await page.getByRole("option", { name: "project-alpha" }).click();
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(row("c/dental-co")).toContainText("Dental Co");
  await expect(row("c/dental-co/p/booking-site")).toContainText("Booking site");
  await expect(row("c/dental-co/p/booking-site/e/dev")).toBeVisible();
  const booking = page.locator(".tree-row.session").filter({ hasText: "Booking build" });
  await expect(booking).toContainText("box-b");
  await expect(page.locator(".device-chip")).toHaveText("box-b");
  pass("new client and project, first session lands in dev with its device badge");

  await booking.hover();
  await booking.getByRole("button", { name: /Move session .* to a project/ }).click();
  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await page.getByRole("button", { name: "Move session", exact: true }).click();
  await expect(row("c/dental-co/p/booking-site/e/prod")).toBeVisible({ timeout: 10000 });
  await expect(row("c/dental-co/p/booking-site/e/dev")).toHaveCount(0);
  await expect(
    page.locator(".tree-row.session").filter({ hasText: "Booking build" }),
  ).toBeVisible();
  pass("move a session to prod");

  const project = row("c/dental-co/p/booking-site");
  await project.hover();
  await project.getByRole("button", { name: "New session in Booking site" }).click();
  await page.getByLabel("Device", { exact: true }).selectOption("box-a");
  await page.getByLabel("Environment", { exact: true }).selectOption("staging");
  await page.getByLabel("Session name").fill("Booking staging");
  await page.getByRole("option", { name: "project-alpha" }).click();
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  const staging = row("c/dental-co/p/booking-site/e/staging");
  await expect(staging).toBeVisible({ timeout: 10000 });
  await expect(
    page.locator(".tree-row.session").filter({ hasText: "Booking staging" }),
  ).toContainText("box-a");
  await expect(row("c/dental-co")).toContainText("1 project");
  await expect(project).toContainText("2 sessions");
  // Project sessions leave the device sections.
  await expect(
    page.locator(".tree-row.session").filter({ hasText: "Booking staging" }),
  ).toHaveCount(1);
  await page.screenshot({ path: "/tmp/anth-net-projects.png" });
  pass("a second device joins the same project in staging");

  // The agent team: on for project sessions; the Lead delegates and the member shows in the tree under it.
  await tab("Team");
  await expect(page.getByRole("switch", { name: "Lead a team" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(".team-role")).toHaveCount(8);
  await page.getByLabel("Tester model").selectOption("echo");
  await expect(page.getByLabel("Tester model")).toHaveValue("echo");
  await send("delegate: backend | !echo from-the-team");
  await expect(
    chat().locator(".markdown").filter({ hasText: "Backend developer reports" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.locator(".tree-row.agent").filter({ hasText: "Backend developer" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/anth-net-team.png" });
  // Selecting the member warns that messages there never reach the Lead, and one click goes back to the owner.
  await expect(page.locator(".member-banner")).toHaveCount(0);
  await page.locator(".tree-row.agent").filter({ hasText: "Backend developer" }).click();
  await expect(page.locator(".member-banner")).toContainText("Backend developer");
  await expect(page.locator(".member-banner")).toContainText("can't delegate or ship");
  await page.getByRole("button", { name: "Message its owner" }).click();
  await expect(page.locator(".member-banner")).toHaveCount(0);
  await expect(
    chat().locator(".markdown").filter({ hasText: "Backend developer reports" }),
  ).toBeVisible({ timeout: 10000 });
  await page.getByRole("switch", { name: "Lead a team" }).click();
  await expect(page.getByRole("switch", { name: "Lead a team" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  pass("agent team: Team tab, model per role, a delegation shows the member in the tree, the member banner leads back");

  // Watch and fix: watch the project from the Watch tab, then three webhook events with one cause open an incident.
  await tab("Watch");
  await page.getByLabel("Production URL").fill(base);
  await page.getByLabel("Read Vercel logs").uncheck();
  await page.getByRole("button", { name: "Start watching", exact: true }).click();
  await expect(page.locator(".watch-form")).toContainText("Watching", { timeout: 10000 });
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(
    page.locator(".toast, [role=status]").filter({ hasText: "Checked" }).first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(row("c/dental-co/p/booking-site").locator(".watching")).toBeVisible();
  const webhook = (await page.locator(".webhook").textContent())?.trim();
  for (let i = 0; i < 3; i++) {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `evt-${i}`,
        message: "Checkout crashed: total is undefined",
        level: "error",
        path: "/checkout",
      }),
    });
    if (res.status !== 202) throw Error(`webhook answered ${res.status}`);
  }
  await expect(row("c/dental-co/p/booking-site").locator(".incident-badge")).toContainText(
    "1 incident",
    { timeout: 20000 },
  );
  await page.getByRole("button", { name: "Check now" }).click();
  const card = page.locator(".incident").first();
  await expect(card).toContainText("Checkout crashed", { timeout: 15000 });
  await expect(page.locator(".watch-events li.incident")).toHaveCount(3);
  await page.screenshot({ path: "/tmp/anth-net-watch.png" });
  await card.getByRole("button", { name: "Open incident agent" }).click();
  await expect(page.locator(".tree-row.agent.sel")).toContainText("Incident #1");
  pass(
    "watch and fix: Watch tab setup, webhook events open an incident, its agent is one click away",
  );

  expect(errors).toEqual([]);
  pass("no browser runtime errors");
  console.log("ALL NETWORK UI CHECKS PASSED");
} catch (e) {
  await page.screenshot({ path: "/tmp/anth-net-failure.png" }).catch(() => {});
  console.error("hub log:\n" + hub.log().slice(-3000));
  throw e;
} finally {
  await browser.close();
  for (const child of children) await stop(child);
  rmSync(tmp, { recursive: true, force: true });
}
