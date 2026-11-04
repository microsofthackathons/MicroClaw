import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export const FIXED_TEXT = "MICROCLAW_PERF_OK";
export const FIXED_PROMPT = "Reply with exactly MICROCLAW_PERF_OK. Do not use tools.";

export async function startModelService({
  profile = "fixed-response",
  model = "perf-fixed",
  endpoint,
  apiKey,
  maxRequests = 100,
  budget = { remaining: maxRequests },
} = {}) {
  const requests = [];
  const pending = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (budget.remaining <= 0) {
      response
        .writeHead(429, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Performance model request budget exceeded" }));
      return;
    }
    budget.remaining -= 1;
    const record = {
      index: requests.length + 1,
      startedAt: new Date().toISOString(),
      outcome: "pending",
    };
    requests.push(record);
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    pending.add(controller);
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error("Model request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== model) throw new Error("Unexpected model in performance fixture");
      if (profile === "real-model") {
        const upstream = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
        });
        if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
        response.end();
        record.outcome = upstream.ok ? "success" : "upstream-error";
      } else if (body.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const write = (delta, finishReason = null) =>
          response.write(
            `data: ${JSON.stringify({
              id: `perf-${record.index}`,
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`,
          );
        write({ role: "assistant" });
        for (const text of ["MICROCLAW_", "PERF_OK"]) {
          await delay(20, undefined, { signal: controller.signal });
          write({ content: text });
        }
        write({}, "stop");
        response.end("data: [DONE]\n\n");
        record.outcome = "success";
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: `perf-${record.index}`,
            object: "chat.completion",
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: FIXED_TEXT },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
        record.outcome = "success";
      }
    } catch {
      record.outcome = controller.signal.aborted ? "timeout" : "error";
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Performance model fixture request failed" }));
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      record.elapsedMs = performance.now() - started;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
