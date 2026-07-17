import { createServer } from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { createWss, handleUpgrade } from "./ws-handler.js";
import { startScribeLoops } from "./scribe.js";
import { startMetricsLoop } from "./metrics.js";
import { startThemeLoop } from "./themes.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
const wss = createWss();

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(wss, req, socket as import("node:stream").Duplex, head);
});

server.listen(port, () => {
  logger.info({ port }, "Scribe Pilot server listening");
  startScribeLoops();
  startMetricsLoop();
  startThemeLoop();
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
