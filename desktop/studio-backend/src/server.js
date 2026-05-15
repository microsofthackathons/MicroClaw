/**
 * Studio Node Backend — V1
 *
 * Minimal stateful HTTP server that tracks agent state for the pixel studio
 * visualisation in MicroClaw. Listens on 127.0.0.1 only.
 */

const http = require("http");

const { DATA_DIR, HOST, PORT, ensureDirectories } = require("./config");
const { createRequestHandler } = require("./routes");
const { cleanStaleGuests, loadAgents, loadState, saveAgents, saveState } = require("./store");

ensureDirectories();
loadState();
loadAgents();

const server = http.createServer(createRequestHandler());
const guestCleanupTimer = setInterval(cleanStaleGuests, 60_000);

server.listen(PORT, HOST, () => {
  console.log(`[studio-backend] Running on http://${HOST}:${PORT}`);
  console.log(`[studio-backend] Data dir: ${DATA_DIR}`);
});

function shutdown(signal) {
  console.log(`[studio-backend] ${signal} received, shutting down...`);
  clearInterval(guestCleanupTimer);
  saveState();
  saveAgents();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
