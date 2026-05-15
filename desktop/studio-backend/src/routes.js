const { HOST, PORT } = require("./config");
const { readJsonBody, sendCorsPreflight, sendJson } = require("./http-utils");
const {
  getMainState,
  joinAgent,
  leaveAgent,
  listGuestAgents,
  pushAgentState,
  updateMainState,
} = require("./store");

function createRequestHandler() {
  return async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    } catch {
      sendJson(res, 400, { error: "Invalid request URL" });
      return;
    }
    const pathname = url.pathname;
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      sendCorsPreflight(res);
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { status: "ok", uptime: process.uptime() });
      return;
    }

    if (method === "GET" && pathname === "/status") {
      sendJson(res, 200, getMainState());
      return;
    }

    if (method === "POST" && pathname === "/set_state") {
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...updateMainState(body) });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (method === "GET" && pathname === "/agents") {
      sendJson(res, 200, listGuestAgents());
      return;
    }

    if (method === "POST" && pathname === "/join-agent") {
      try {
        const agent = joinAgent(await readJsonBody(req));
        sendJson(res, 200, { ok: true, agentId: agent.id, ...agent });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/agent-push") {
      try {
        sendJson(res, 200, { ok: true, ...pushAgentState(await readJsonBody(req)) });
      } catch (err) {
        const status = err.message === "Agent not found" ? 404 : 400;
        sendJson(res, status, { error: err.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/leave-agent") {
      try {
        sendJson(res, 200, leaveAgent(await readJsonBody(req)));
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  };
}

module.exports = {
  createRequestHandler,
};
