const crypto = require("crypto");
const fs = require("fs");

const { AGENTS_FILE, GUEST_TTL_MS, STATE_FILE, VALID_STATES } = require("./config");

let mainState = {
  state: "idle",
  detail: "",
  progress: 0,
  name: "Star",
  updatedAt: Date.now(),
};

const guestAgents = new Map();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (raw && typeof raw.state === "string") {
        mainState = { ...mainState, ...raw, updatedAt: Date.now() };
      }
    }
  } catch {
    // Start fresh when persisted state is unreadable.
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(mainState, null, 2), "utf-8");
  } catch (err) {
    console.error("[studio] Failed to save state:", err.message);
  }
}

function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
      if (Array.isArray(raw)) {
        for (const agent of raw) {
          if (agent && agent.id) {
            guestAgents.set(agent.id, agent);
          }
        }
      }
    }
  } catch {
    // Start fresh when persisted agents are unreadable.
  }
}

function saveAgents() {
  try {
    fs.writeFileSync(
      AGENTS_FILE,
      JSON.stringify(Array.from(guestAgents.values()), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("[studio] Failed to save agents:", err.message);
  }
}

function cleanStaleGuests(now = Date.now()) {
  for (const [id, agent] of guestAgents) {
    if (now - agent.lastPush > GUEST_TTL_MS) {
      console.log(`[studio] Guest ${agent.name} (${id}) timed out`);
      guestAgents.delete(id);
    }
  }
}

function getMainState() {
  return mainState;
}

function listGuestAgents() {
  cleanStaleGuests();
  return Array.from(guestAgents.values());
}

function updateMainState(payload = {}) {
  const newState = String(payload.state || "idle").toLowerCase();
  if (!VALID_STATES.has(newState)) {
    throw new Error(`Invalid state: ${newState}`);
  }

  mainState = {
    ...mainState,
    state: newState,
    detail: String(payload.detail || "").slice(0, 200),
    progress: Math.max(0, Math.min(100, Number(payload.progress) || 0)),
    updatedAt: Date.now(),
  };

  saveState();
  return mainState;
}

function joinAgent(payload = {}) {
  const name = String(payload.name || "Guest").slice(0, 50);
  const id = payload.id || crypto.randomUUID();
  const agent = {
    id,
    name,
    state: "idle",
    detail: "",
    joinedAt: Date.now(),
    lastPush: Date.now(),
  };

  guestAgents.set(id, agent);
  saveAgents();
  return agent;
}

function pushAgentState(payload = {}) {
  const id = payload.id || payload.agentId;
  if (!id || !guestAgents.has(id)) {
    throw new Error("Agent not found");
  }

  const agent = guestAgents.get(id);
  const newState = String(payload.state || agent.state).toLowerCase();
  if (VALID_STATES.has(newState)) {
    agent.state = newState;
  }
  if (payload.detail !== undefined) {
    agent.detail = String(payload.detail).slice(0, 200);
  }
  agent.lastPush = Date.now();

  saveAgents();
  return agent;
}

function leaveAgent(payload = {}) {
  const id = payload.id || payload.agentId;
  if (id) {
    guestAgents.delete(id);
    saveAgents();
  }
  return { ok: true };
}

module.exports = {
  cleanStaleGuests,
  getMainState,
  joinAgent,
  leaveAgent,
  listGuestAgents,
  loadAgents,
  loadState,
  pushAgentState,
  saveAgents,
  saveState,
  updateMainState,
};
