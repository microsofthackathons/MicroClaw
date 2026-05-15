const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT, 10) || 19000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(__dirname, "..", "data");

const STATE_FILE = path.join(DATA_DIR, "state.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents-state.json");

const VALID_STATES = new Set(["idle", "writing", "researching", "executing", "syncing", "error"]);

const GUEST_TTL_MS = 5 * 60 * 1000;
const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

module.exports = {
  AGENTS_FILE,
  DATA_DIR,
  GUEST_TTL_MS,
  HOST,
  PORT,
  REQUEST_BODY_LIMIT_BYTES,
  STATE_FILE,
  VALID_STATES,
  ensureDirectories,
};
