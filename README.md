# Magpie · Genspark App 登录复用

<img src="./icon.svg" width="32" height="32" alt="Genspark App 登录复用插件图标">

适用于 macOS 的 Genspark Super App。只读 App 为 GenCode 生成的凭据，每次请求重新读取文件，跟随 App 的凭据更新；不解密 `session.enc`，不复制保存真实密钥。

## 供应商

一个插件导出两个供应商，需要分别连接，但共用本机 Genspark App 的账号和积分：

| 供应商 ID | 显示名称 | 协议 | 插件导出 |
| --- | --- | --- | --- |
| `genspark-llm-proxy` | Genspark GenCode | Chat Completions | `GensparkApp` |
| `genspark-gemini-proxy` | Genspark GenCode Gemini | Gemini | `GensparkGeminiApp` |

两个供应商共用 Genspark Super App 内 GenCode 的绿色终端图标，图形与颜色取自 App 内置的 `SpaceGlyph` 组件（2026-10-25）。图标内嵌在包元数据中，显示时无需额外访问图片服务器。

## 使用

先安装 Magpie 和 Genspark Super App，在 Genspark App 登录并打开 GenCode。然后运行（`magpie` 不在 PATH 时使用 `/Applications/magpie.app/Contents/MacOS/magpie`）：

```sh
magpie plugin add github:orangercat/magpie-genspark
magpie plugin login genspark-llm-proxy
magpie plugin login genspark-gemini-proxy
magpie plugin
magpie quota genspark-llm-proxy
magpie quota genspark-gemini-proxy
```

或在 Magpie 的插件页添加 `github:orangercat/magpie-genspark`，并分别点击两个供应商的“复用 Genspark App 当前登录”。登录方式不要求输入密钥；Magpie 只保存绑定标记和账号邮箱。每台机器使用其本机 Genspark App 的登录态，无需复制凭据。

更新已安装插件：

```sh
magpie plugin update
```

也可克隆本仓库，在仓库根目录运行 `magpie plugin add .`，作为本地文件夹插件加载。

登录、模型发现和余额查询都会请求 `/api/tool_cli/opencode-config`。模型的上下文、输入输出类型、推理档位及默认选项来自目录；已禁用或标记为 deprecated 的模型、已禁用的档位不会显示。

`magpie quota` 会分别显示两个 Genspark 供应商绑定账号的套餐和实时积分余额。两个供应商共用同一个 Genspark App 账号。

## 开发与验证

项目使用 Node.js ES 模块和内置 API，没有额外 npm 依赖；测试需要可用的 Node.js 和 npm。文件入口如下：

| 文件 | 用途 |
| --- | --- |
| `index.mjs` | 两个插件导出、凭据读取、账号绑定、模型目录映射和请求转发 |
| `test.mjs` | 使用临时凭据和模拟 fetch 的回归测试 |
| `package.json` | 包入口、发布文件范围和测试命令 |
| `icon.svg` | 共享图标的 SVG 源文件；`package.json` 的 `magpie.icon` 内嵌相同内容 |

在仓库根目录运行：

```sh
npm test
```

2026-10-24 本轮运行 `npm test`，8 项检查全部通过。覆盖免密登录、模型与档位过滤、两个供应商的余额查询和请求转发、凭据轮换、换号拦截、无效凭据及目录服务故障。测试不读取本机真实凭据，也不发送网络请求，不消耗 Genspark 积分。

需要真实联调时，可在连接成功后运行：

```sh
magpie provider test genspark-llm-proxy gpt-5.4-nano
```

该命令会产生真实模型调用和 Genspark 积分消耗，模型需存在于当前账号目录。本插件不在安装或登录时发送推理请求。

### 历史联调记录

以下为现有文档保留的 2026-10-24 联调记录，本轮文档更新未重复执行真实请求：隔离 Magpie 配置中两个供应商登录成功并发现 44 + 8 个实时模型；GPT-5.4 Nano 通过 Magpie `provider test`；Gemini 3.1 Flash Lite 通过插件请求钩子以 SSE 返回 `OK`；正式 Magpie 的两个供应商均通过 `quota` 余额查询验证。模型数量取决于账号的实时目录。当时 Magpie CLI 的 `provider test` 不支持 Gemini，因此未使用该命令验证 Gemini。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 无法读取凭据，或凭据无效 | 在 Genspark App 登录并打开 GenCode，再重新连接对应供应商；检查 App 是否仍使用下述凭据路径。 |
| 提示当前账号与绑定账号不同 | 确认 App 当前账号后，分别重新连接两个供应商。 |
| 模型目录请求返回 401 | 在 App 中重新登录，再重新连接插件。 |
| 模型目录请求返回 403，App 中正常 | 优先检查 Magpie 的代理设置和实际网络出口，按下方步骤排查；不要仅凭 403 判定凭据失效。 |
| 模型目录请求返回其他 HTTP 错误 | 检查网络和 Genspark 服务状态；插件将其作为服务错误，不据此判定登录过期。 |
| Magpie 的美元费用估算为零 | 目录价格以积分计价，插件未将其换算为美元；用 `magpie quota` 查询积分余额。 |

### 模型目录 HTTP 403：代理排查

2026-10-25 的一次跨机器安装排查中，用户确认凭据文件可读、字段有效，且重新登录后 App 内 GenCode 正常，但 Magpie 仍提示“模型目录请求失败（HTTP 403）”。最终用户确认原因为代理问题，处理代理后恢复。这是本次案例的结论，并不代表所有 403 都由代理引起。

排查顺序：

1. 确认插件已加载，并核对完整错误。凭据文件不存在、无读取权限或 JSON 格式错误，会报“无法读取 GenCode 登录凭据”；目录请求返回 403 属于后续网络请求阶段。
2. 确认本机凭据文件可读，`base_url` 为 `https://www.genspark.ai`，且 `api_key` 是非空字符串。这只证明文件格式符合要求，不证明服务端仍接受该凭据；不要分享或复制密钥。
3. 在 Genspark App 打开 GenCode，确认模型列表正常。若 App 也失败，先处理 App 登录或网络问题；若只有 Magpie 失败，重点检查 Magpie 的全局代理、对应供应商或账号的代理设置，以及代理客户端对域名的分流规则。App 正常不保证两个程序使用相同网络出口。
4. 将 Magpie 切换到已确认可用的代理或网络出口，再重新连接两个供应商。无需重装插件，也无需修改请求地址。

```sh
magpie plugin login genspark-llm-proxy
magpie plugin login genspark-gemini-proxy
```

目录请求地址为 `GET https://www.genspark.ai/api/tool_cli/opencode-config`，通过 `x-api-key` 请求头携带本机凭据。两个供应商及余额查询都使用该接口；这一步失败时尚未发送推理请求。

若调整代理后仍报 403，应继续核对响应内容、账号访问权限与 Genspark 服务状态，不能直接归因为代理。排查时只提供错误和必要的响应信息，不发送凭据文件或含密钥的请求头。

## 边界

- App 凭据位置：`~/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json`。这是当前 App 的内部文件结构，升级后可能变化。
- App 换号时插件会拒绝继续使用旧账号绑定，需要重新连接两个供应商。目录在内存最多缓存 60 秒；密钥变化立即重新校验账号。
- 凭据过期由 App 负责更新；插件不自行申请或刷新凭据。模型目录返回 401 时，插件会报告登录失效；推理请求的响应直接交给 Magpie 处理。
- 目录返回的价格单位是 Genspark 积分，不是美元。因此不把它写成美元单价，Magpie 中的美元费用估算为零，**不代表免费**。实际计费以 Genspark 为准。
- 请求只允许发往 `https://www.genspark.ai` 对应的模型代理路径，禁止跟随重定向，不记录密钥和对话内容。
- 当前只适配 macOS；Windows、Linux 尚未适配和验证。
- 插件不会修改任何 Agent 的模型选择，也不新增依赖。本项目为非官方插件。
