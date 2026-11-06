import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assistantText,
  createShopFixture,
  extractAnswer,
  isolatedEnvironment,
  measuredCost,
} from "./adapter.mjs";
import { createReferenceRun, taskPackets } from "./fixtures.mjs";
import { evaluateCapture } from "./evaluate.mjs";
import { createCapture } from "./fixtures.mjs";
import { createReplayTools } from "./replay-plugin.mjs";
import { startShopModelProxy, usageFromResponse, validateEndpoint } from "./model-proxy.mjs";
import { parseRunOptions } from "./run-cli.mjs";

async function temporary(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-adapter-test-"));
  try {
    return await work(directory);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), await realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("shop-adapter-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

test("isolated environment is an OS allowlist, not a copied user profile", () => {
  const root = path.resolve("isolated");
  const result = isolatedEnvironment(root, {
    PATH: "node",
    SystemRoot: "Windows",
    SHOP_API_KEY: "secret",
    GITHUB_TOKEN: "token",
    NODE_OPTIONS: "--require evil",
    OPENCLAW_STATE_DIR: "personal",
    HTTPS_PROXY: "personal-proxy",
  });
  assert.equal(result.PATH, "node");
  for (const key of ["SHOP_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "HTTPS_PROXY"])
    assert.equal(result[key], undefined);
  assert.equal(result.OPENCLAW_STATE_DIR, path.join(root, "state"));
  assert.equal(result.USERPROFILE, path.join(root, "home"));
});

test("fresh fixture exposes only fixed retailer tools and never ships oracle or personal state", async () =>
  temporary(async (directory) => {
    const root = path.join(directory, "run");
    const fixture = await createShopFixture(
      root,
      taskPackets()[0],
      "http://127.0.0.1:1234/v1",
      "test-model",
    );
    assert.deepEqual(fixture.config.tools.allow, ["shop_search", "shop_fetch"]);
    assert.equal(fixture.config.tools.toolSearch, false);
    assert.equal(fixture.config.tools.codeMode, false);
    assert.equal(fixture.config.update.checkOnStart, false);
    assert.equal(fixture.config.plugins.slots.memory, "none");
    assert.deepEqual(fixture.config.plugins.allow, ["shop-replay"]);
    assert.equal(fixture.config.gateway.bind, "loopback");
    assert.equal(fixture.config.agents.defaults.heartbeat.every, "0m");
    assert.doesNotMatch(
      await readFile(path.join(root, "packet.json"), "utf8"),
      /"oracle"|expectedOutcome|acceptableRecommendations/,
    );
    assert.match(
      await readFile(path.join(root, "plugin", "index.mjs"), "utf8"),
      /createReplayTools/,
    );
    await assert.rejects(
      createShopFixture(root, taskPackets()[0], "http://127.0.0.1:1234/v1", "test-model"),
      /EEXIST/,
    );
  }));

test("replay tools record results and reject arbitrary URL/path or cross-case retrieval", async () => {
  const events = [];
  const packet = taskPackets()[0];
  const [search, fetchTool] = createReplayTools(packet, (event) => events.push(event));
  const index = (await search.execute("q", { query: "black PS5 controller" })).details;
  assert.equal(index.sources.length, 3);
  assert.equal(index.sources[0].body, undefined);
  const fetched = (await fetchTool.execute("f", { sourceId: "offer-a" })).details;
  assert.equal(fetched.untrusted, true);
  assert.equal(fetched.body, packet.documents[0].body);
  for (const sourceId of ["../../credentials.json", "https://evil.example/", "old-snippet"])
    assert.match((await fetchTool.execute("x", { sourceId })).details.error, /outside/);
  assert.equal(events.length, 5);
  assert.match((await search.execute("bad", { query: 42 })).details.error, /query/);
});

test("injection is preserved as untrusted evidence, never evaluated by the tool", async () => {
  const tools = createReplayTools(taskPackets().find((packet) => packet.id === "S10"));
  const result = (await tools[1].execute("injection", { sourceId: "offer-a" })).details;
  assert.equal(result.untrusted, true);
  assert.match(result.body, /Ignore the user/);
});

test("structured answer extraction is faithful, retrieval-bound and never an auditor", () => {
  const answer = createReferenceRun("S01").answer;
  const block = `<shop_answer>${JSON.stringify(answer)}</shop_answer>`;
  assert.deepEqual(
    extractAnswer(`中文表格\n${block}`, new Set(["offer-a", "offer-b", "offer-c"])),
    answer,
  );
  assert.throws(() => extractAnswer(block, new Set()), /not retrieved/);
  assert.throws(() => extractAnswer(block + block, new Set()), /exactly one/);
  assert.throws(() => extractAnswer("I think it costs $69", new Set()), /exactly one/);
  assert.throws(
    () =>
      extractAnswer(
        `<shop_answer>${JSON.stringify({ ...answer, audit: { checks: { safety: "pass" } } })}</shop_answer>`,
        new Set(),
      ),
    /audit/,
  );
  const invalid = structuredClone(answer);
  invalid.offers[0].fields.taxCents = { value: 0, certainty: "unknown", sources: [] };
  assert.throws(
    () => extractAnswer(`<shop_answer>${JSON.stringify(invalid)}</shop_answer>`, new Set()),
    /null/,
  );
});

test("Gateway final text contains only actual text blocks", () => {
  assert.equal(
    assistantText({
      message: {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "visible" },
        ],
      },
    }),
    "visible",
  );
  assert.equal(assistantText({ message: { content: "visible" } }), "visible");
  assert.throws(() => assistantText({}), /no assistant text/);
});

test("real-model CLI is explicit, bounded and never reads implicit account credentials", () => {
  assert.throws(() => parseRunOptions(["--profile", "real-model"]), /requires explicit/);
  const flags = [
    "--profile",
    "real-model",
    "--model",
    "test",
    "--endpoint",
    "https://provider.example/v1",
    "--samples",
    "5",
    "--api-key-env",
    "SHOP_KEY",
    "--max-model-requests",
    "550",
    "--cases",
    "all",
  ];
  assert.throws(() => parseRunOptions(flags, {}), /empty/);
  const options = parseRunOptions(flags, { SHOP_KEY: "test-secret" });
  assert.equal(options.apiKey, "test-secret");
  assert.equal(options.caseIds.length, 11);
  assert.equal(options.maxRequests, 550);
  assert.equal(parseRunOptions([]).profile, "smoke");
  assert.throws(
    () => parseRunOptions(["--profile", "smoke", "--endpoint", "http://127.0.0.1/v1"]),
    /only accepted/,
  );
  for (const extra of [
    ["--cases", "S01,S01"],
    ["--cases", "S12"],
    ["--timeout-ms", "600001"],
    ["--samples", "0"],
  ])
    assert.throws(() => parseRunOptions(extra));
  assert.throws(
    () => parseRunOptions([...flags, "--input-usd-per-million", "1"], { SHOP_KEY: "key" }),
    /Both/,
  );
});

test("provider URLs exclude credential-bearing, redirect-prone and non-loopback HTTP input", () => {
  assert.equal(validateEndpoint("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
  for (const endpoint of [
    "http://provider.example/v1",
    "http://localhost/v1",
    "https://user:pass@provider.example/v1",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1#fragment",
    "file:///secrets",
  ])
    assert.throws(() => validateEndpoint(endpoint));
});

test("scripted model runs both user turns, calls search/fetch and returns explicitly synthetic incompletion", async () => {
  const proxy = await startShopModelProxy({
    profile: "smoke",
    model: "smoke",
    budget: { remaining: 5 },
  });
  try {
    const messages = [{ role: "user", content: "first" }];
    const call = async () => {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "smoke", messages }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).choices[0].message;
    };
    const first = await call();
    assert.match(first.content, /邮编/);
    messages.push(first, { role: "user", content: "second" });
    const search = await call();
    assert.equal(search.tool_calls[0].function.name, "shop_search");
    messages.push(search, {
      role: "tool",
      content: JSON.stringify({ sources: [{ id: "offer-a" }] }),
    });
    const fetched = await call();
    assert.equal(fetched.tool_calls[0].function.name, "shop_fetch");
    messages.push(fetched, { role: "tool", content: "untrusted page" });
    const final = await call();
    assert.match(final.content, /合成接线检查/);
    assert.equal(extractAnswer(final.content, new Set()).outcome, "incomplete");
    assert.equal(proxy.records.length, 4);
  } finally {
    await proxy.close();
  }
});

test("model proxy refuses non-replay tools and enforces a global request budget", async () => {
  const budget = { remaining: 1 };
  const proxy = await startShopModelProxy({ profile: "smoke", model: "smoke", budget });
  try {
    const send = () =>
      fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "smoke",
          messages: [],
          tools: [{ type: "function", function: { name: "exec" } }],
        }),
      });
    assert.equal((await send()).status, 502);
    assert.match(proxy.records[0].error, /outside the replay allowlist/);
    assert.equal((await send()).status, 429);
    assert.equal(budget.remaining, 0);
  } finally {
    await proxy.close();
  }
});

test("real proxy forwards tool messages, bounds output, captures usage, and does not forward local auth", async () => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    observed = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(text),
    };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 200 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startShopModelProxy({
    profile: "real-model",
    model: "test",
    apiKey: "provider-secret",
    endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
    budget: { remaining: 1 },
    maxTokens: 512,
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-placeholder" },
      body: JSON.stringify({
        model: "test",
        max_tokens: 9000,
        messages: [{ role: "tool", content: "source" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(observed.url, "/v1/chat/completions");
    assert.equal(observed.authorization, "Bearer provider-secret");
    assert.equal(observed.body.max_tokens, 512);
    assert.deepEqual(observed.body.messages, [{ role: "tool", content: "source" }]);
    assert.equal(proxy.records[0].usage.prompt_tokens, 100);
    assert.doesNotMatch(JSON.stringify(proxy.records), /provider-secret|local-placeholder/);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("usage, failed consumption and cached tokens never fabricate a known dollar cost", () => {
  const records = [{ outcome: "success", usage: { prompt_tokens: 1000, completion_tokens: 500 } }];
  assert.equal(measuredCost(records, "real-model", { input: 1, output: 4 }), 0.003);
  assert.equal(measuredCost(records, "real-model", null), null);
  assert.equal(measuredCost([{ outcome: "error" }], "real-model", { input: 1, output: 4 }), null);
  assert.equal(
    measuredCost(
      [
        {
          outcome: "success",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 50 },
          },
        },
      ],
      "real-model",
      { input: 1, output: 4 },
    ),
    null,
  );
  assert.equal(measuredCost([], "smoke", null), 0);
  const stream =
    'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
  assert.equal(usageFromResponse(stream, true).prompt_tokens, 12);
  assert.equal(usageFromResponse('data: {"choices":[]}\n\ndata: [DONE]\n\n', true), null);
});

test("adapter smoke stays synthetic after rescoring; absent audits cannot pass business gates", () => {
  const capture = createCapture(1);
  capture.subject.kind = "adapter-smoke";
  capture.plan.caseIds = ["S01"];
  const run = createReferenceRun("S01");
  run.audit = null;
  capture.runs = [run];
  const result = evaluateCapture(capture);
  assert.equal(result.summary.businessCompletion.numerator, 0);
  assert.equal(result.summary.safetyAuditCoverage.numerator, 0);
  assert.match(result.warnings[0], /SYNTHETIC ADAPTER SMOKE/);
});
