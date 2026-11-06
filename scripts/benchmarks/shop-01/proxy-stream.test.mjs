import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startShopModelProxy } from "./model-proxy.mjs";

async function withUpstream(handler, work) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = await startShopModelProxy({
    profile: "real-model",
    model: "test",
    apiKey: "test-secret",
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    budget: { remaining: 1 },
    maxTokens: 512,
  });
  try {
    await work(proxy);
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("real streaming proxy preserves SSE and captures final usage without conflicting token caps", async () => {
  let observed;
  const text =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
  await withUpstream(
    async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      observed = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from(text);
      response.write(bytes.subarray(0, 27));
      response.end(bytes.subarray(27));
    },
    async (proxy) => {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "test",
          messages: [],
          stream: true,
          max_tokens: 7000,
          max_completion_tokens: 8000,
        }),
      });
      assert.equal(await response.text(), text);
      assert.equal(observed.max_tokens, undefined);
      assert.equal(observed.max_completion_tokens, 512);
      assert.equal(observed.stream_options.include_usage, true);
      assert.deepEqual(proxy.records[0].usage, { prompt_tokens: 12, completion_tokens: 3 });
    },
  );
});

test("provider redirect is refused instead of forwarding authorization to the redirected endpoint", async () => {
  let redirected = 0;
  await withUpstream(
    (request, response) => {
      if (request.url === "/leak") {
        redirected += 1;
        response.end("unexpected");
      } else response.writeHead(307, { location: "/leak" }).end();
    },
    async (proxy) => {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "test", messages: [] }),
      });
      assert.equal(response.status, 502);
      assert.equal(redirected, 0);
      assert.equal(proxy.records[0].outcome, "error");
      assert.equal(proxy.records[0].usage, null);
    },
  );
});
