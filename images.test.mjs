import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageTools } from "./images.mjs";

const origin = "https://www.genspark.ai";
const account = (email = "one@example.test", amount = 100) => ({ token: "fake-key", projectID: "fake-project", email, catalog: { genspark: { credit_balance: amount } } });
const tools = { tools: [{ name: "image_generation", parameters: { properties: {
  model: { enum: ["nano-banana-2-flash-lite"] }, aspect_ratio: { enum: ["1:1"] }, image_size: { enum: ["1k"] },
} } }] };
const generated = { status: "ok", data: { generated_images: [{ status: "SUCCESS", image_urls: [origin + "/api/files/s/fake?cache_control=1"], width: 1024, height: 1024, estimated_credits: 19 }] } };
const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
const ctx = () => ({ abort: AbortSignal.timeout(10000) });
const json = data => Response.json({ status: "ok", data });

test("generates once, saves response before resolving, downloads without credentials and reports credits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "genspark-images-test-"));
  let calls = 0, reads = 0, receipt;
  const hooks = createImageTools(async () => account(undefined, reads++ === 0 ? 100 : 81.3));
  const context = { ...ctx(), metadata: ({ metadata }) => { receipt = metadata.receipt; } };
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    if (String(url).endsWith("/tools")) return Response.json(tools);
    if (String(url).endsWith("/image_generation")) {
      assert.equal(init.headers["x-api-key"], "fake-key");
      assert.equal(init.headers["x-project-id"], "fake-project");
      // Exercise NDJSON frames split across chunks, including a final line without newline.
      const text = JSON.stringify({ heartbeat: 1 }) + "\n" + JSON.stringify(generated);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text.slice(0, 35))); c.enqueue(new TextEncoder().encode(text.slice(35))); c.close(); } }));
    }
    if (String(url).endsWith("/file/download")) {
      const saved = JSON.parse(await readFile(receipt, "utf8"));
      assert.deepEqual(saved.frames.at(-1), generated);
      assert.equal(saved.status, "generated");
      return json({ download_url: origin + "/api/files/s/fake?token=signed" });
    }
    assert.equal(String(url), origin + "/api/files/s/fake?token=signed");
    assert.equal(Object.keys(init.headers).length, 1);
    assert.match(init.headers["user-agent"], /Mozilla/);
    assert.equal(init.redirect, "error");
    return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  });
  try {
    const result = await hooks.image_generate.execute({ prompt: "orange cat", output_dir: dir }, context);
    assert.equal(result.status, "downloaded");
    assert.deepEqual(result.credits, { before: 100, after: 81.3, difference: 18.7, unit: "credits" });
    assert.deepEqual(await readFile(result.images[0].path), jpeg);
    assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("signed"), false);
    assert.equal((await readFile(receipt, "utf8")).includes("fake-key"), false);
    assert.equal(calls, 4);
    await hooks.image_download.execute({ receipt }, ctx());
    assert.equal(calls, 4, "successful recovery never redownloads or regenerates");
  } finally { fetch.mock.restore(); }
});

test("403 keeps a reusable receipt; retry only downloads, account switches are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "genspark-images-recovery-"));
  let generations = 0, blocked = true, email;
  const hooks = createImageTools(async () => account(email));
  const fetch = mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/tools")) return Response.json(tools);
    if (String(url).endsWith("/image_generation")) { generations++; return Response.json(generated); }
    if (String(url).endsWith("/file/download")) return json({ download_url: origin + "/api/files/s/fake?token=signed" });
    return blocked ? new Response(null, { status: 403 }) : new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  });
  try {
    const result = await hooks.image_generate.execute({ prompt: "cat", output_dir: dir }, ctx());
    assert.equal(result.status, "generated");
    assert.match(result.error, /image_download/);
    const saved = JSON.parse(await readFile(result.receipt, "utf8"));
    assert.equal(saved.download_urls[0], origin + "/api/files/s/fake?token=signed");
    email = "other@example.test";
    await assert.rejects(hooks.image_download.execute({ receipt: result.receipt }, ctx()), /其他.*账号/);
    email = undefined; blocked = false;
    const retry = await hooks.image_download.execute({ receipt: result.receipt }, ctx());
    assert.equal(retry.status, "downloaded");
    assert.equal(retry.error, undefined);
    assert.equal(generations, 1);
  } finally { fetch.mock.restore(); }
});

test("invalid inputs and missing project are rejected before generation", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => Response.json(tools));
  try {
    const hooks = createImageTools(async () => account());
    await assert.rejects(hooks.image_generate.execute({ prompt: " " }, ctx()), /prompt/);
    await assert.rejects(hooks.image_generate.execute({ prompt: "cat", output_dir: "relative" }, ctx()), /绝对路径/);
    const missing = createImageTools(async () => ({ ...account(), projectID: undefined }));
    await assert.rejects(missing.image_generate.execute({ prompt: "cat" }, ctx()), /项目 ID/);
    await assert.rejects(hooks.image_generate.execute({ prompt: "cat", model: "made-up" }, ctx()), /不支持 model/);
    assert.equal(fetch.mock.callCount(), 1);
  } finally { fetch.mock.restore(); }
});

test("model discovery is live and does not generate images", async () => {
  const fetch = mock.method(globalThis, "fetch", async url => {
    assert.equal(url, origin + "/api/tool_cli/tools");
    return Response.json(tools);
  });
  try {
    const result = await createImageTools(async () => account()).image_models.execute({}, ctx());
    assert.equal(result.balance, 100);
    assert.deepEqual(result.parameters, tools.tools[0].parameters);
  } finally { fetch.mock.restore(); }
});

test("foreign download URLs and HTML responses cannot save an image", async () => {
  for (const mode of ["foreign", "html"]) {
    const dir = await mkdtemp(join(tmpdir(), "genspark-images-unsafe-"));
    let downloadCalls = 0;
    const fetch = mock.method(globalThis, "fetch", async url => {
      if (String(url).endsWith("/tools")) return Response.json(tools);
      if (String(url).endsWith("/image_generation")) return Response.json(generated);
      if (String(url).endsWith("/file/download")) return json({ download_url: mode === "foreign" ? "http://127.0.0.1/private" : origin + "/api/files/s/fake?token=signed" });
      downloadCalls++;
      return new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } });
    });
    try {
      const result = await createImageTools(async () => account()).image_generate.execute({ prompt: "cat", output_dir: dir }, ctx());
      assert.equal(result.status, "generated");
      assert.equal(result.images.length, 0);
      assert.ok(result.error);
      assert.equal(downloadCalls, mode === "foreign" ? 0 : 1);
    } finally { fetch.mock.restore(); }
  }
});
