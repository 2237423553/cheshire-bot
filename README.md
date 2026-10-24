# 柴郡 QQ 群机器人 / Cheshire QQ Group Bot

> QQ 群聊机器人：@ 对话（文字/图片/视频）、**B站链接自动总结**、联网搜索、上下文记忆。
> **仓库不含任何密钥**，也不含 SnowLuma 本体（需单独安装）。

## 🇬🇧 English Quick Look

A QQ group chat bot playing Cheshire (Azur Lane): **@-mention** her for text / image / video chat, drop a **bilibili link** and she "watches" the video itself (playurl direct-stream → multimodal model) and summarizes it, asks her to **draw** something and the image lands right in the group (gpt-image-2), or generate **videos** from text and images (Grok Imagine, ≤15 s). She now **speaks** — replies ≤300 chars go out as voice first (MiMo TTS with natural-language voice design + per-message tone), and can even **sing** on request. Extras: web search (Exa MCP), context memory with auto-compression, admin commands, and a **local web config panel** with provider presets (OpenCode / DeepSeek / Kimi / BigModel / SiliconFlow / OpenRouter / Ollama) and an automatic 4-point probe (basic generation / thinking modes / tool calling / vision).

- **Stack**: Bun + OneBot v11 (SnowLuma bridge) + any OpenAI-compatible LLM (default: MiMo)
- **This repo contains no keys** — real keys live in gitignored runtime files (`secrets.json` for the LLM key + OneBot tokens, `mediaapi.json` / `llmstate.json` written by the panel); `config.mjs` ships placeholders only
- Outbound requests on user-supplied URLs pass an SSRF gate (http/https only, loopback/private hosts rejected by literal check and DNS resolution); every external fetch has a hard timeout
- Docs are in Chinese (docs/01–03 + 更新公告 with an English summary at top); code comments are Chinese too, but the code itself is straightforward to read

> 中文文档从下一节开始 / Chinese docs start below ↓

## 功能一览

- 🗨️ **@ 对话**：文字 / 图片 / 视频识别。视频走 **URL 直传**——把 QQ 原始下载链接直接
  发给多模态模型（零下载、零转码，绕开 base64 50MB 限制，上限 300MB）
- 📺 **B站链接自动总结**：群里甩 `b23.tv` / BV 链接**免 @ 触发**，机器人自动取
  playurl 音画合一 mp4 直链（实测不校验 Referer）喂给模型「亲眼看片」——
  零下载零转存、免登录 720P、带提问模式、拒答检测 + 自动重试；
  总结自动存档并进上下文，之后可继续追问。命令行入口 `bilibili-summarize.mjs` 共用同一引擎
- 🔎 **联网搜索**：Exa MCP Server（`web_search` / `fetch_webpage`），无需 API key
- 🎙 **语音回复**：普通回复 ≤300 字**先发语音**、文字版跟上（MiMo 官方 TTS，自然语言捏声线 +
  每条动态语气申报，腔调跟着内容走）；@ 说「语音：/说一段/用日语说」也开口；TTS 挂了自动回退纯文字
- 🎵 **唱歌**：@ 说「唱歌/唱首/来一首 xxx」——LLM 现写歌词 + `(唱歌)` 标签合成（预置音色专属，
  说话用捏的声线、唱歌借预置嗓子，官方互斥设计）
- 🖼 **文生图**：@ 说「画一张××」触发**意图强制路由**（脚本接管：prompt 翻译 → 生图 → 发群，
  模型没有装成功的机会）；10 分钟内说「改一下/性别错了」走**改稿路由**带上次 prompt 重画；
  审核拦截/限流都如实转告
- 🎬 **文生视频 / 图生视频**：@ 说「生成××视频」触发同样强制路由（异步任务：提交→轮询→下载→发群）；
  引用图片要求生成视频自动走**图生视频**；成片上限 15 秒（`vidgenMaxSeconds` 硬检查）；
  下载失败自动重试；`vidgenEnabled` 总闸可停业
- 📡 **寻呼信标**：喊「柴郡柴郡」秒回，零 token 定位机器人在不在
- 🔁 **+1 复读**：有人复读跟着复读一次（四道防死循环闸）
- 🧠 **上下文记忆**：自动压缩（120k×0.9 触发）、图片关联窗口（按互动计数）、
  多人插话不串线的回复署名
- 🛠 **管理指令**：`#上下文` / `#压缩` / `#清空` / `#模型` / `#吃什么` / `#战绩`
- ✅ **12 项自检**：进程 / 端口 / QQ 身份 / LLM / 搜索 / 抽签全打勾

## 架构

    QQ (NTQQ 9.9.x)  ←  SnowLuma hook 注入
      └ SnowLuma      WebUI :5099 ｜ OneBot HTTP :3000 ｜ OneBot WS :3001
          └ qq-group-bot（本仓库）
              ├ bot.mjs        主程序：消息流 / 工具循环 / 指令 / 媒体 / 上下文
              ├ bilibili.mjs   B站看片引擎（直链直传 + 拒答重试）
              ├ exa.mjs        Exa MCP 客户端（搜索/抓取）
              ├ api-panel.mjs / panel-page.mjs   本地 API 配置面板（Web）
              ├ probe-suite.mjs                  四件套探测（基础/思考档/工具/视觉）
              ├ llm-state.mjs / botctl.mjs       llmstate+档案唯一写入口 / 机器人进程控制
              ├ wt.mjs         战争雷霆战绩查询（Thunderskill）
              ├ imggen.mjs     文生图客户端
              ├ vidgen.mjs     文生/图生视频客户端（异步任务：提交→轮询→下载）
              └ foods.mjs      368 道饭食真随机抽签（模型只写推荐语）
          LLM：任意 OpenAI 兼容端点（默认 OpenCode Go / mimo-v2.6-flash，思考档 auto）

## 快速开始

1. **安装 SnowLuma**（第三方 QQ↔OneBot 桥，不在本仓库）到仓库根目录 `SnowLuma\`
   ⚠️ 非官方协议工具，接入 QQ 有封号风险；非商业许可，商用需其书面授权
2. **填配置**——真 Key 一律住 gitignored 运行时文件，`config.mjs` 只留占位符（密钥下沉，2026-10-24 起）：
   - `qq-group-bot/secrets.json` → `llmKey`（LLM API Key；默认端点需 `x-opencode-session` 会话头，bot 自动带）
     + `obHttpToken` / `obWsToken`（与 SnowLuma 的 `config/onebot_<你的QQ号>.json` 一致）
   - 生图/生视频/语音的端点/Key → 面板「生图 API / 生视频 API / 语音 API」卡（写 `mediaapi.json`），或手改该文件
   - LLM 端点/模型 → 面板或 `切换模型.cmd`（写 `llmstate.json`）
3. **装依赖**：`cd qq-group-bot && bun install`
4. **前置**：本机装 NTQQ（9.9.x；经典版不支持）并登录机器人的 QQ 号
5. **双击 `一键启动.cmd`**：自动停旧实例 → 起 SnowLuma + 机器人 → 弹管理后台 → 12 项自检

日常：重启就再点一次（幂等）；换模型双击 **「切换面板.cmd」**（本地网页：表单填 API → 拉模型列表 → 四件套探测 → 一键切换，适合不想碰命令行）、
或 `切换模型.cmd`（命令行：先验证再写盘）；
日志在 `qq-group-bot/bot.log`（正常）和 `bot.err`（报错走 stderr）。

## 自定义

- **更换 LLM API**：双击「切换面板.cmd」（推荐，本地网页：表单 + 模型下拉 + **四件套自动探测**
  基础/思考档/工具/视觉 + 配置档案管理），或「切换模型.cmd」命令行（掩码输 Key、`--probe`
  四件套、`--list`），或直接改 `config.mjs` 默认值。
  回滚 = 删掉 `llmstate.json`。换服务商要探的四件事已自动化（面板/`--probe`）
- **更改人设 / 提示词**：全部集中在 `config.mjs`——`systemPrompt`（人设 + 铁律 + 能力边界）、
  `eatPrompt`（#吃什么 文案语气）、`beaconTrigger/beaconReply`（信标词）。
  改完重启生效，验证三步见 [docs/01 · 8.2](docs/01-部署与配置.md)
- **功能开关**：面板「功能开关」子窗（即刻生效）或手改 `qq-group-bot/switches.json`；生图/生视频/语音的端点/Key/声线在面板「生图 API / 生视频 API / 语音 API」卡里改（写 `mediaapi.json`，重启生效）；LLM Key + OneBot 令牌在 `qq-group-bot/secrets.json`（手改，重启生效）

## 文档（细节都在这里）

| 文档 | 内容 |
|---|---|
| [docs/更新公告.md](docs/更新公告.md) | **按日期的改动公告**（最新版本来这里看） |
| [docs/01-部署与配置.md](docs/01-部署与配置.md) | 架构总览、一键启动、换模型工具、自检 12 项、全部配置参数表 |
| [docs/02-功能与机制.md](docs/02-功能与机制.md) | 触发规则、媒体处理（URL 直传/关联窗口）、上下文与压缩、B站总结引擎、搜索 |
| [docs/03-坑与排错.md](docs/03-坑与排错.md) | **35 个真实踩坑** + 故障速查表 + 常用命令（排错先看这个） |

> 文档沿用开发时的称呼：三位使用者在文档里叫「指挥官」，「上篇/中篇/下篇」即 docs/01~03。

## 已知边界

- 机器人**能发**语音（TTS 合成）但**听不懂**收到的语音消息，会如实说听不了
- 视频 URL 直传上限 300MB（≈720P 20 分钟）；base64 兜底受 50MB 字符串限制
- B站免登录 720P 封顶；会员/付费视频拿不到直链会明着报错
- **视频请求的 prompt_tokens 是粗估值**，不能判断服务端是否真拉到了视频；
  偶发拉取失败时 API 不报错、模型会「装看不见」——引擎已内置拒答检测 + 重取直链重试
- 上下文全在内存，重启即清零（有意设计）

## 许可

机器人代码随你处置（自用/魔改随意）；SnowLuma 为第三方组件，其 EULA 另见其发布页
（非商业许可，商业使用或自动化部署需事先书面授权）。
