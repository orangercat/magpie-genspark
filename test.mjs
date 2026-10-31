import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internal } from "./index.mjs";

const root = await mkdtemp(join(tmpdir(), "magpie-genspark-test-"));
test.after(() => rm(root, { recursive: true, force: true }));
const origin = "https://www.genspark.ai";
const catalog = email => ({
  genspark: { email, plan: "plus", credit_balance: 10691.1 },
  provider: Object.fromEntries(_internal.definitions.map(def => [def.id, { models: {
    coder: { name: "Coder", limit: { context: 1000000, output: 128000 },
      reasoning: true, modalities: { input: ["text", "image"] }, cost: { input: 1100 },
      options: { thinkingConfig: { thinkingLevel: "low" } },
      variants: { low: { reasoningEffort: "low" }, medium: { disabled: true } } },
    hidden: { disabled: true }, retired: { status: "deprecated" },
  } }])),
});

async function fixture(name, def = _internal.definitions[0]) {
  const path = join(root, name + ".json");
  const update = async (key, base = origin) => writeFile(path, JSON.stringify({ api_key: key, base_url: base }));
  await update("fake-app-token");
  return { hooks: _internal.createProvider(def, path), update };
}

test("keyless sign-in stores only a marker and binds the account", async () => {
  const { hooks } = await fixture("login");
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, origin + "/api/tool_cli/opencode-config");
    assert.equal(init.headers["x-api-key"], "fake-app-token");
    assert.equal(init.redirect, "error");
    return Response.json(catalog("one@example.test"));
  });
  try {
    const result = await hooks.auth.methods[0].authorize();
    assert.deepEqual(result, { type: "success", key: "genspark-app-session", metadata: { email: "one@example.test" } });
    assert.equal(JSON.stringify(result).includes("fake-app-token"), false);
    const auth = { type: "api", key: result.key, metadata: result.metadata };
    const models = await hooks.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(models), ["coder"]);
    assert.deepEqual(Object.keys(models.coder.variants), ["low"]);
    assert.equal(models.coder.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(models.coder.capabilities.input.image, true);
    assert.equal(models.coder.limit.context, 1000000);
    assert.equal(models.coder.cost.input, 0);
  } finally { fetch.mock.restore(); }
});

test("keyless sign-in supports persistent opencode-server-config format", async () => {
  const path = join(root, "opencode-server-config.json");
  await writeFile(path, JSON.stringify({
    cogenId: "proj-123",
    config: {
      provider: {
        "genspark-llm-proxy": {
          options: { apiKey: "fake-opencode-token", baseURL: origin + "/api/llm_proxy/v1" }
        }
      }
    }
  }));
  const hooks = _internal.createProvider(_internal.definitions[0], path);
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.headers["x-api-key"], "fake-opencode-token");
    return Response.json(catalog("one@example.test"));
  });
  try {
    const result = await hooks.auth.methods[0].authorize();
    assert.deepEqual(result, { type: "success", key: "genspark-app-session", metadata: { email: "one@example.test" } });
  } finally { fetch.mock.restore(); }
});

for (const def of _internal.definitions) {
  test(`${def.id}: quota reports the live Genspark credit balance`, async () => {
    const { hooks } = await fixture(`${def.id}-usage`, def);
    let reads = 0;
    const fetch = mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(url, origin + "/api/tool_cli/opencode-config");
      assert.equal(init.headers["x-api-key"], "fake-app-token");
      reads++;
      return Response.json(reads === 1 ? catalog("one@example.test") : {
        ...catalog("one@example.test"),
        genspark: { email: "one@example.test", plan: "plus", credit_balance: 4242.25 },
      });
    });
    try {
      const auth = { key: "genspark-app-session", metadata: { email: "one@example.test" } };
      await hooks.provider.models({ models: {} }, { auth });
      assert.deepEqual(await hooks.auth.usage(async () => auth), {
        plan: "plus",
        user: "one@example.test",
        balance: "4,242.25 credits",
        windows: [],
      });
      assert.equal(reads, 2);
    } finally { fetch.mock.restore(); }
  });

  test(`${def.id}: forwards the body, stream, cancellation and current credentials`, async () => {
    const { hooks, update } = await fixture(def.id, def);
    let currentToken = "fake-app-token";
    const response = new Response("data: streaming\n\n", { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const body = JSON.stringify({ model: "coder", stream: true });
    let calls = 0;
    const fetch = mock.method(globalThis, "fetch", async (url, init) => {
      calls++;
      if (String(url).endsWith("/opencode-config")) return Response.json(catalog("one@example.test"));
      assert.equal(new URL(url).searchParams.has("key"), false);
      assert.equal(init.headers.get(def.header), def.header === "authorization" ? `Bearer ${currentToken}` : currentToken);
      assert.equal(init.body, body);
      assert.equal(init.signal, controller.signal);
      assert.equal(init.redirect, "error");
      return response;
    });
    try {
      const auth = { key: "genspark-app-session", metadata: { email: "one@example.test" } };
      const loader = await hooks.auth.loader(async () => auth);
      const send = () => loader.fetch(origin + def.path + "/chat/completions?key=old", {
        method: "POST", body, signal: controller.signal,
        headers: { authorization: "old", "x-api-key": "old", "x-goog-api-key": "old" },
      });
      assert.equal(await send(), response);
      currentToken = "fake-rotated-token";
      await update(currentToken);
      assert.equal(await send(), response);
      assert.equal(calls, 4);
      await assert.rejects(loader.fetch("https://example.test/chat/completions"), /拒绝/);
      await assert.rejects(loader.fetch(origin + "/other"), /拒绝/);
      assert.equal(calls, 4);
    } finally { fetch.mock.restore(); }
  });
}

test("account switch and revoked credentials fail without forwarding an inference", async () => {
  const { hooks, update } = await fixture("switch");
  const fetch = mock.method(globalThis, "fetch", async () => Response.json(catalog("other@example.test")));
  try {
    const auth = { key: "genspark-app-session", metadata: { email: "one@example.test" } };
    const loader = await hooks.auth.loader(async () => auth);
    await assert.rejects(loader.fetch(origin + "/api/llm_proxy/v1/chat/completions"), { signIn: "expired" });
    assert.equal(fetch.mock.callCount(), 1);
    await update("fake-revoked-token");
    fetch.mock.mockImplementation(async () => new Response(null, { status: 401 }));
    await assert.rejects(hooks.provider.models({ models: {} }, { auth }), { signIn: "expired" });
  } finally { fetch.mock.restore(); }
});

test("invalid profile, unsupported origin and logged-out state never send credentials", async () => {
  const { hooks, update } = await fixture("invalid");
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  try {
    assert.deepEqual(await hooks.auth.loader(async () => undefined), {});
    const provider = { models: {} };
    assert.equal(await hooks.provider.models(provider), provider.models);
    await update("fake-app-token", "https://example.test");
    await assert.rejects(hooks.auth.methods[0].authorize(), { signIn: "expired" });
    await update("");
    await assert.rejects(hooks.auth.methods[0].authorize(), { signIn: "expired" });
    assert.equal(fetch.mock.callCount(), 0);
  } finally { fetch.mock.restore(); }
});

test("catalog outage remains a service error instead of being reported as expired login", async () => {
  const { hooks } = await fixture("outage");
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  try {
    await assert.rejects(hooks.auth.methods[0].authorize(), error => /503/.test(error.message) && !error.signIn);
  } finally { fetch.mock.restore(); }
});
