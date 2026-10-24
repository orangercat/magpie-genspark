import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://www.genspark.ai";
const PROFILE = join(homedir(), "Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json");
const DEFINITIONS = [
  { id: "genspark-llm-proxy", name: "Genspark GenCode", npm: "@ai-sdk/openai-compatible", path: "/api/llm_proxy/v1", header: "authorization" },
  { id: "genspark-gemini-proxy", name: "Genspark GenCode Gemini", npm: "@ai-sdk/google", path: "/api/llm_proxy/gemini/v1beta", header: "x-goog-api-key" },
];

function expired(message) {
  return Object.assign(new Error(message), { signIn: "expired" });
}

function creditBalance(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)} credits`;
}

async function readProfile(path) {
  let profile;
  try {
    profile = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw expired("无法读取 GenCode 登录凭据。请在 Genspark App 中登录并打开 GenCode，再重新连接此插件。");
  }
  if (profile.base_url !== ORIGIN || typeof profile.api_key !== "string" || !profile.api_key.trim()) {
    throw expired("GenCode 凭据无效或服务地址不受支持。请在 Genspark App 中重新登录。");
  }
  return profile.api_key;
}

function modelList(def, catalog) {
  const source = catalog.provider?.[def.id];
  if (!source || !source.models || typeof source.models !== "object") {
    throw new Error("Genspark 未返回此代理的模型目录。");
  }
  return Object.fromEntries(Object.entries(source.models)
    .filter(([, m]) => !m.disabled && m.status !== "deprecated")
    .map(([id, m]) => [id, {
      id, providerID: def.id, name: m.name ?? id,
      api: { id: m.id ?? id, url: ORIGIN + def.path, npm: def.npm },
      limit: m.limit,
      // Genspark reports credits here; Magpie's cost field means dollars.
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: {
        temperature: m.temperature ?? true, reasoning: m.reasoning ?? false,
        toolcall: m.tool_call ?? true, attachment: m.attachment ?? false,
        input: Object.fromEntries((m.modalities?.input ?? ["text"]).map(k => [k, true])),
        output: Object.fromEntries((m.modalities?.output ?? ["text"]).map(k => [k, true])),
      },
      options: m.options ?? {}, headers: {},
      variants: Object.fromEntries(Object.entries(m.variants ?? {}).filter(([, v]) => !v.disabled)),
    }]));
}

function createProvider(def, profilePath = PROFILE) {
  let cached;
  async function session(auth, refresh = false) {
    const token = await readProfile(profilePath);
    if (refresh || !cached || cached.token !== token || Date.now() - cached.at > 60_000) {
      const response = await fetch(ORIGIN + "/api/tool_cli/opencode-config", {
        headers: { "x-api-key": token, accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) throw expired("Genspark 登录已失效。请在 App 中重新登录，再重新连接此插件。");
      if (!response.ok) throw new Error(`Genspark 模型目录请求失败（HTTP ${response.status}）。`);
      const catalog = await response.json();
      const email = catalog.genspark?.email;
      if (typeof email !== "string" || !email) throw new Error("Genspark 未返回账号身份，无法绑定当前登录。");
      cached = { token, catalog, email, at: Date.now() };
    }
    if (auth && (auth.key !== "genspark-app-session" || auth.metadata?.email !== cached.email)) {
      throw expired("Genspark App 当前账号与插件绑定账号不同。请重新连接此插件。");
    }
    return cached;
  }

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[def.id] ??= { name: def.name, npm: def.npm, api: ORIGIN + def.path, models: {} };
    },
    auth: {
      provider: def.id,
      single: true,
      methods: [{
        type: "api", keyless: true, label: "复用 Genspark App 当前登录",
        async authorize() {
          const { email } = await session(undefined, true);
          return { type: "success", key: "genspark-app-session", metadata: { email } };
        },
      }],
      async loader(getAuth) {
        if (!(await getAuth())) return {};
        return {
          baseURL: ORIGIN + def.path,
          async fetch(input, init = {}) {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.origin !== ORIGIN || !url.pathname.startsWith(def.path + "/")) {
              throw new Error("拒绝向 Genspark 模型代理以外的地址发送凭据。");
            }
            const auth = await getAuth();
            if (!auth) throw expired("插件尚未连接 Genspark App。");
            const { token } = await session(auth);
            const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
            for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(name);
            url.searchParams.delete("key");
            headers.set(def.header, def.header === "authorization" ? `Bearer ${token}` : token);
            return fetch(url, { ...init, headers, redirect: "error" });
          },
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) throw expired("插件尚未连接 Genspark App。");
        const { catalog } = await session(auth, true);
        const account = catalog.genspark ?? {};
        return {
          plan: typeof account.plan === "string" ? account.plan : undefined,
          user: typeof account.email === "string" ? account.email : undefined,
          balance: creditBalance(account.credit_balance),
          windows: [],
        };
      },
    },
    provider: {
      id: def.id,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        return modelList(def, (await session(auth, true)).catalog);
      },
    },
  };
}

export const GensparkApp = async () => createProvider(DEFINITIONS[0]);
export const GensparkGeminiApp = async () => createProvider(DEFINITIONS[1]);
export const _internal = { createProvider, definitions: DEFINITIONS };
