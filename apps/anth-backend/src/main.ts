// anth-backend: one device of the Durable Agent Network.
import express from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { Alerts, alertsConfig } from "./telegram.js";

const config = loadConfig();
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
});

// Telegram alerts and approvals, when TELEGRAM_BOT_TOKEN is set (see docs/TELEGRAM.md).
const alertSettings = alertsConfig(process.env, config.dataDir);
const alerts =
  alertSettings &&
  new Alerts(
    {
      name: config.name,
      alertRuns: () => store.alertRuns(),
      approveRun: (s, c, t, a) => store.approveRun(s, c, t, a),
      incidents: () => store.watcher.incidents(),
      subscribe: (fn) => store.subscribe(fn),
    },
    alertSettings,
  );
alerts?.start();

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
// Events from other services (Sentry alerts, your app): no bearer token, the per-project secret in the path is the key.
app.post("/hooks/:client/:project/:secret", express.json({ limit: "256kb" }), (req, res) =>
  res.status(202).json(store.watcher.hook(String(req.params.client), String(req.params.project), String(req.params.secret), req.body)),
);
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(store));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`anth-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await alerts?.stop();
  await store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
