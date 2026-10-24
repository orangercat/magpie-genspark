# Magpie · Genspark App 登录复用

适用于 macOS 的 Genspark Super App。只读 App 为 GenCode 生成的凭据，每次请求重新读取文件，跟随 App 的凭据更新；不解密 `session.enc`，不复制保存真实密钥。

## 使用

先安装 Magpie 和 Genspark Super App，在 Genspark App 登录并打开 GenCode。然后运行（`magpie` 不在 PATH 时使用 `/Applications/magpie.app/Contents/MacOS/magpie`）：

```sh
magpie plugin add github:orangercat/magpie-genspark
magpie plugin login genspark-llm-proxy
magpie plugin login genspark-gemini-proxy
magpie plugin
magpie quota genspark-llm-proxy
```

或在 Magpie 的插件页添加 `github:orangercat/magpie-genspark`，并分别点击两个供应商的“复用 Genspark App 当前登录”。登录方式不要求输入密钥；Magpie 只保存绑定标记和账号邮箱。每台机器使用其本机 Genspark App 的登录态，无需复制凭据。

更新已安装插件：

```sh
magpie plugin update
```

也可克隆本仓库后运行 `magpie plugin add ./magpie-genspark`，作为本地文件夹插件加载。

模型列表实时查询 `/api/tool_cli/opencode-config`。两个供应商分别使用 Chat Completions 和 Gemini 协议。模型的上下文、图片输入、推理档位及默认选项来自目录；禁用的档位不会显示。

`magpie quota` 会分别显示两个 Genspark 供应商绑定账号的套餐和实时积分余额。两个供应商共用同一个 Genspark App 账号。

## 验证

```sh
cd magpie-genspark
npm test
```

`magpie provider test genspark-llm-proxy gpt-5.4-nano` 会产生真实模型调用和 Genspark 积分消耗。本插件不在安装或登录时发送推理请求。

2026-10-24 已完成：8 项回归检查；隔离 Magpie 配置中两个供应商登录成功并发现 44 + 8 个实时模型；GPT-5.4 Nano 通过 Magpie `provider test`；Gemini 3.1 Flash Lite 通过插件请求钩子以 SSE 返回 `OK`；正式 Magpie 的两个供应商均通过 `quota` 余额查询验证。模型数量取决于账号的实时目录。Magpie CLI 的 `provider test` 暂不支持 Gemini，因此未使用该命令验证 Gemini。

## 边界

- App 凭据位置：`~/Library/Application Support/gensparkaio/spaces/gencode/gsk/profile/config.json`。这是当前 App 的内部文件结构，升级后可能变化。
- App 换号时插件会拒绝继续使用旧账号绑定，需要重新连接两个供应商。目录在内存最多缓存 60 秒；密钥变化立即重新校验账号。
- 凭据过期由 App 负责更新；插件不自行申请或刷新凭据。401 会使 Magpie 标记登录失效，回到 App 登录后重新连接。
- 目录返回的价格单位是 Genspark 积分，不是美元。因此不把它写成美元单价，Magpie 中的美元费用估算为零，**不代表免费**。实际计费以 Genspark 为准。
- 请求只允许发往 `https://www.genspark.ai` 对应的模型代理路径，禁止跟随重定向，不记录密钥和对话内容。
- 当前只适配 macOS；Windows、Linux 尚未适配和验证。
- 插件不会修改任何 Agent 的模型选择，也不新增依赖。本项目为非官方插件。
