import http from "node:http";
import { TOOL_NAMES } from "./replay-plugin.mjs";

const MAX_BYTES = 8 * 1024 * 1024;

export function validateEndpoint(value) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Endpoint must be HTTPS or literal loopback HTTP, without credentials/query/hash",
    );
  return url.href.replace(/\/$/, "");
}

export function scriptedReply(body) {
  const messages = body.messages;
  if (messages.filter((entry) => entry.role === "user").length < 2)
    return { content: "这是合成接线检查。请确认收货邮编、是否只要全新及是否接受第三方卖家？" };
  const lastUser = messages.findLastIndex((entry) => entry.role === "user");
  const outputs = messages.slice(lastUser + 1).filter((entry) => entry.role === "tool");
  if (outputs.length === 0)
    return {
      tool_calls: [
        {
          id: "smoke-search",
          type: "function",
          function: {
            name: "shop_search",
            arguments: JSON.stringify({ query: "black PS5 DualSense" }),
          },
        },
      ],
    };
  if (outputs.length === 1) {
    const result = JSON.parse(outputs[0].content);
    const text = Array.isArray(result) ? result.find((entry) => entry.type === "text")?.text : null;
    const search = text ? JSON.parse(text) : result;
    return {
      tool_calls: search.sources.map((source, index) => ({
        id: `smoke-fetch-${index}`,
        type: "function",
        function: {
          name: "shop_fetch",
          arguments: JSON.stringify({ sourceId: source.id }),
        },
      })),
    };
  }
  return {
    content:
      "合成接线检查已读取固定来源；不生成购物能力成绩。\n<shop_answer>" +
      JSON.stringify({
        outcome: "incomplete",
        offers: [],
        ranking: [],
        lowestOfferIds: [],
        recommendedOfferId: null,
      }) +
      "</shop_answer>",
  };
}

export function usageFromResponse(text, streaming) {
  const objects = streaming
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .flatMap((line) => {
          try {
            return [JSON.parse(line.slice(6))];
          } catch {
            return [];
          }
        })
    : [JSON.parse(text)];
  return objects.findLast((entry) => entry.usage)?.usage ?? null;
}

export async function startShopModelProxy({
  profile,
  model,
  endpoint,
  apiKey,
  budget,
  maxTokens = 4096,
}) {
  if (profile === "real-model") endpoint = validateEndpoint(endpoint);
  const records = [];
  const pending = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    if (budget.remaining <= 0) {
      response
        .writeHead(429, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "SHOP-01 global model-request budget exhausted" }));
      return;
    }
    budget.remaining -= 1;
    const record = { at: new Date().toISOString(), outcome: "pending", usage: null };
    records.push(record);
    const started = performance.now();
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error("Model request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      record.request = body;
      if (body.model !== model || !Array.isArray(body.messages))
        throw new Error("Unexpected model request");
      const unexpectedTools = body.tools?.filter(
        (tool) => !TOOL_NAMES.includes(tool.function?.name),
      );
      if (unexpectedTools?.length)
        throw new Error(
          `Runtime exposed a tool outside the replay allowlist: ${unexpectedTools.map((tool) => tool.function?.name).join(", ")}`,
        );
      if (body.max_completion_tokens !== undefined) {
        body.max_completion_tokens = Math.min(body.max_completion_tokens, maxTokens);
        delete body.max_tokens;
      } else body.max_tokens = Math.min(body.max_tokens ?? maxTokens, maxTokens);
      if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      record.request = body;
      if (profile === "real-model") {
        const upstream = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
        });
        const output = [];
        let outputBytes = 0;
        for await (const chunk of upstream.body ?? []) {
          outputBytes += chunk.length;
          if (outputBytes > MAX_BYTES) throw new Error("Model response too large");
          output.push(Buffer.from(chunk));
          response.write(chunk);
        }
        record.response = Buffer.concat(output).toString("utf8");
        record.usage = usageFromResponse(record.response, body.stream);
        record.outcome = upstream.ok ? "success" : "upstream-error";
        response.end();
      } else {
        const message = { role: "assistant", ...scriptedReply(body) };
        const finishReason = message.tool_calls ? "tool_calls" : "stop";
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const delta = {
            ...message,
            tool_calls: message.tool_calls?.map((call, index) => ({ index, ...call })),
          };
          const result = {
            id: `shop-${records.length}`,
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          record.response = `data: ${JSON.stringify(result)}\n\ndata: ${JSON.stringify({
            ...result,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage,
          })}\n\ndata: [DONE]\n\n`;
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          record.response = JSON.stringify({
            id: `shop-${records.length}`,
            object: "chat.completion",
            created: 0,
            model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          });
        }
        record.usage = usage;
        record.outcome = "success";
        response.end(record.response);
      }
    } catch (error) {
      record.outcome = controller.signal.aborted ? "timeout" : "error";
      record.error = error.message;
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "SHOP-01 proxy request failed" }));
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
    records,
    async close() {
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
