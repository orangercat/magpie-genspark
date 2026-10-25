import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const ORIGIN = "https://www.genspark.ai";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = description => ({ type: "string", minLength: 1, description });

async function save(path, value) {
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

function wrapper(value) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || !/^\/api\/files\/s\/[^/]+$/.test(url.pathname) || url.username || url.password) {
    throw new Error("拒绝下载 Genspark 文件入口以外的地址。");
  }
  return url.href;
}

async function api(session, path, body, signal, onFrame) {
  const response = await fetch(ORIGIN + "/api/tool_cli" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-api-key": session.token, ...(session.projectID ? { "x-project-id": session.projectID } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error", signal,
  });
  if (!response.ok) throw new Error(`Genspark ${path} 请求失败（HTTP ${response.status}）。`);
  if (body === undefined) return response.json();
  let pending = "", result;
  const consume = async line => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    await onFrame?.(frame);
    if (frame.status === "ok" || frame.status === "error") result = frame;
  };
  for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
    pending += text;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      await consume(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
  await consume(pending);
  if (result?.status !== "ok") throw new Error(`Genspark ${path} 未成功完成；请保留本机记录，不要自动重新生图。`);
  return result.data;
}

const balance = session => {
  const n = session.catalog.genspark?.credit_balance;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

function summary(receipt, path) {
  return {
    receipt: path, status: receipt.status, model: receipt.parameters.model,
    images: receipt.images ?? [], credits: receipt.credits,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export function createImageTools(getSession) {
  async function download(path, signal) {
    if (!isAbsolute(path)) throw new Error("receipt 必须是生成工具返回的绝对路径。");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const session = await getSession();
    if (receipt.email !== session.email) throw new Error("此图片记录属于其他 Genspark 账号，请切回生成时的账号。");
    const result = receipt.frames?.findLast(frame => frame.status === "ok")?.data;
    const images = result?.generated_images;
    if (!Array.isArray(images) || !images.length) throw new Error("记录中尚无已生成图片；不要自动重新生图，先核对 Genspark App 的任务状态和余额。");
    receipt.images ??= [];
    for (const [index, image] of images.entries()) {
      if (receipt.images.some(saved => saved.index === index)) continue;
      if (image.status !== "SUCCESS" || !image.image_urls?.length) throw new Error("Genspark 图片尚未生成成功。");
      const resolved = await api(session, "/file/download", { file_wrapper_url: wrapper(image.image_urls[0]) }, signal);
      const url = wrapper(resolved.download_url);
      receipt.download_urls ??= [];
      receipt.download_urls[index] = url;
      await save(path, receipt);
      // Genspark's file edge rejects Python/default clients with HTTP 403/1010.
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "error", signal });
      if (!response.ok) throw new Error(`Genspark 图片下载失败（HTTP ${response.status}）；使用 image_download 重试此记录，不要重复生图。`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : undefined;
      if (!extension || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("下载响应不是有效的 PNG、JPEG 或 WebP 图片。");
      const file = join(dirname(path), `image-${index + 1}.${extension}`);
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      receipt.images.push({ index, path: file, bytes: bytes.length, width: image.width, height: image.height, estimated_credits: image.estimated_credits });
      await save(path, receipt);
    }
    receipt.status = "downloaded";
    delete receipt.error;
    await save(path, receipt);
    return summary(receipt, path);
  }

  return {
    image_models: {
      description: "查询 Genspark 当前账号的生图模型、参数和积分余额，不生成图片。",
      args: schema({}),
      async execute(_args, ctx) {
        const session = await getSession();
        const tools = await api(session, "/tools", undefined, ctx.abort);
        const image = tools.tools?.find(tool => tool.name === "image_generation");
        if (!image) throw new Error("Genspark 当前未提供生图工具。");
        return { parameters: image.parameters, balance: balance(session), unit: "credits" };
      },
    },
    image_generate: {
      description: "使用本机 Genspark App 当前账号文生图（消耗积分），先保存返回记录，再下载图片并显示积分变化。超时或下载失败时保留 receipt，勿重复生成；用 image_download 补下载。",
      args: schema({
        prompt: string("图片描述；默认使用 Nano Banana 2 Flash Lite。"),
        model: string("image_models 返回的模型 ID。"),
        aspect_ratio: string("例如 1:1、16:9；默认 1:1。"),
        image_size: string("例如 1k、2k；默认 1k。"),
        output_dir: string("保存目录的绝对路径；默认 ~/Pictures/Genspark。记录含私有图片地址，请勿提交公开仓库。"),
      }, ["prompt"]),
      async execute(args, ctx) {
        if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt 不能为空。");
        const directory = args.output_dir ?? join(homedir(), "Pictures/Genspark");
        if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("output_dir 必须是绝对路径。");
        const session = await getSession();
        if (typeof session.projectID !== "string" || !session.projectID) throw new Error("Genspark App 尚无项目 ID，请在 App 中打开 GenCode。");
        const parameters = { model: args.model ?? "nano-banana-2-flash-lite", query: args.prompt, aspect_ratio: args.aspect_ratio ?? "1:1", image_size: args.image_size ?? "1k" };
        const tools = await api(session, "/tools", undefined, ctx.abort);
        const properties = tools.tools?.find(tool => tool.name === "image_generation")?.parameters?.properties;
        for (const key of ["model", "aspect_ratio", "image_size"]) {
          if (!properties?.[key]?.enum?.includes(parameters[key])) throw new Error(`Genspark 不支持 ${key} 的此取值；先查询 image_models。`);
        }
        const folder = join(directory, randomUUID());
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, "receipt.json");
        const receipt = { email: session.email, parameters, status: "submitted", frames: [], credits: { before: balance(session), after: null, difference: null, unit: "credits" } };
        await save(path, receipt);
        ctx.metadata?.({ title: "Genspark 生图", metadata: { receipt: path } });
        try {
          ctx.abort?.throwIfAborted();
          await api(session, "/image_generation", parameters, ctx.abort, async frame => {
            receipt.frames.push(frame);
            if (frame.status === "ok") receipt.status = "generated";
            await save(path, receipt);
          });
          try {
            receipt.credits.after = balance(await getSession());
            if (receipt.credits.before !== null && receipt.credits.after !== null) receipt.credits.difference = Number((receipt.credits.before - receipt.credits.after).toFixed(8));
          } catch { receipt.credits.note = "生成后余额暂时不可用，请用 magpie quota 查询。"; }
          await save(path, receipt);
          return await download(path, ctx.abort);
        } catch {
          const saved = JSON.parse(await readFile(path, "utf8"));
          saved.error = "请求未完整完成。若记录已有生成结果，用 image_download 补下载；否则先在 App 核对任务和余额，勿自动重新生成。";
          await save(path, saved);
          return summary(saved, path);
        }
      },
    },
    image_download: {
      description: "从 image_generate 返回的 receipt 本机记录补下载图片，不重新生图；账号必须与生成时一致。",
      args: schema({ receipt: string("image_generate 返回的 receipt 绝对路径。") }, ["receipt"]),
      execute: (args, ctx) => download(args.receipt, ctx.abort),
    },
  };
}
