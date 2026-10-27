# 柴郡 QQ 群机器人 / Cheshire QQ Group Bot

> QQ 群聊机器人：@ 对话（文字/图片/视频）、**B站链接自动总结**、联网搜索、上下文记忆。
> **仓库不含任何密钥**，也不含 SnowLuma 本体（需单独安装）。

## 🇬🇧 English Quick Look

A QQ group chat bot playing Cheshire (Azur Lane): **@-mention** her for text / image / video chat, drop a **bilibili link** and she "watches" the video itself (playurl direct-stream → multimodal model) and summarizes it, asks her to **draw** something and the image lands right in the group (gpt-image-2), or generate **videos** from text and images (Grok Imagine, ≤15 s). She now **speaks** — replies shorter than a configurable threshold go out as voice first. The TTS endpoint is pluggable: point `ttsUrl` at any OpenAI-compatible chat/completions (voice designed in natural language) or at ByteDance's official seed-tts protocol — the client auto-detects which from the URL. Per-message tone directives plus the triggering message fed back as context keep the mood matching; a separate, independently-configured sing endpoint lets her **sing** on request. Extras: web search (Exa MCP), context memory with auto-compression, admin commands, and a **local web config panel** with provider presets (OpenCode / DeepSeek / Kimi / BigModel / SiliconFlow / OpenRouter / Ollama) and an automatic 4-point probe (basic generation / thinking modes / tool calling / vision).

- **Stack**: Bun + OneBot v11 (SnowLuma bridge) + any OpenAI-compatible LLM (default: MiMo)
- **This repo contains no keys** — real keys live in gitignored runtime files (`secrets.json` for the LLM key + OneBot tokens, `mediaapi.json` / `llmstate.json` written by the panel); `config.mjs` ships placeholders only
- Outbound requests on user-supplied URLs pass an SSRF gate (http/https only, loopback/private hosts rejected by literal check and DNS resolution); every external fetch has a hard timeout
- Docs are in Chinese (docs/01–03 + 更新公告 with an English summary at top); code comments are Chinese too, but the code itself is straightforward to read
- Every knob is listed in the **自定义 (Customization)** section below: which config key, which file (`config.mjs` / `mediaapi.json` / `switches.json` / `secrets.json`), and what needs a restart to take effect

> 中文文档从下一节开始 / Chinese docs start below ↓

## 功能一览

- 🗨️ **@ 对话**：文字 / 图片 / 视频识别。视频走 **URL 直传**——把 QQ 原始下载链接直接
  发给多模态模型（零下载、零转码，绕开 base64 50MB 限制，上限 300MB）
- 📺 **B站链接自动总结**：群里甩 `b23.tv` / BV 链接**免 @ 触发**，机器人自动取
  playurl 音画合一 mp4 直链（实测不校验 Referer）喂给模型「亲眼看片」——
  零下载零转存、免登录 720P、带提问模式、拒答检测 + 自动重试；
  总结自动存档并进上下文，之后可继续追问。命令行入口 `bilibili-summarize.mjs` 共用同一引擎
- 🔎 **联网搜索**：Exa MCP Server（`web_search` / `fetch_webpage`），无需 API key
- 🎙 **语音回复**：普通回复 ≤`ttsAutoVoiceChars`（默认 50）字**先发语音**、文字版跟上；
  **TTS 端点可插拔**——`ttsUrl` 指到 OpenAI 兼容 chat/completions（自然语言捏声线）或
  豆包官方 seed-tts 协议（客户端按 URL 自动识别切协议）；声线=自然语言描述可随时改，
  每条动态语气申报、触发那句原话一并喂进语境——腔调跟着内容走；
  @ 说「语音：/说一段/用日语说」也开口；TTS 挂了自动回退纯文字
- 🎵 **唱歌**：@ 说「唱歌/唱首/来一首 xxx」——LLM 现写歌词后走**唱歌专用通道**：
  `ttsSingUrl/ttsSingModel/ttsSingKey` 独立配置，prompt 驱动的音频生成模型或
  `(唱歌)` 标签预置音色都能接（按端点自动判形状）；说话和唱歌可各用各的服务商
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

> 上面每一项功能怎么配置、怎么自定义、改哪个文件哪个键、要不要重启——
> 全部列在下面的**「自定义」**一节（配置键 + 位置 + 生效方式的完整对照表）。

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

## 自定义（想改什么 → 改哪个键 → 在哪 → 怎么生效）

**配置文件分三层**，优先级从高到低（高层的键盖住低层）：

| 层 | 文件（都在 `qq-group-bot/`） | 谁写 | 生效 |
|---|---|---|---|
| 运行时状态 | `llmstate.json` | 面板 / 切换模型.cmd | 改完重启 bot |
| 媒体与语音 | `mediaapi.json` | 面板媒体卡 / 手改 | 改完重启 bot |
| 出厂默认 | `config.mjs`（含占位符，不含真 Key） | 手改 | 改完重启 bot |

另外：`secrets.json` = LLM Key + OneBot 双令牌（手改，重启生效）；`prompt.json` = 人设/提示词覆盖（面板写，重启生效）；`switches.json` = 功能开关（**每条消息现读，即刻生效**，不用重启）。
**回滚万能法：删掉对应 json 文件再重启 bot，就回到 `config.mjs` 默认值。**

### 换 LLM（对话模型）

- 推荐双击 **`切换面板.cmd`**（本地网页：填端点/Key → 拉模型列表 → **四件套自动探测**基础/思考档/工具/视觉 → 一键切换+重启，还能把配置**另存档案**随时启用）
- 命令行党用 **`切换模型.cmd`**（掩码输 Key、`--probe` 探测、`--list` 拉列表、`--restart` 才重启）
- 也可以手改 `config.mjs` 的 `llmUrl/llmKey/model/llmHeaders/thinking` 默认值
- 换服务商不需要改代码：任何 OpenAI 兼容端点都行；预设映射（DeepSeek/Kimi/智谱/SiliconFlow/OpenRouter/Ollama 等）在 `qq-group-bot/providers.mjs` 的 `PRESETS`，想加一家就在那里添一行正则

### 语音（TTS）——说话

| 配置键 | 位置 | 说明 |
|---|---|---|
| `ttsUrl` / `ttsKey` | `mediaapi.json`（面板「语音 API」卡） | **端点可插拔**：指到 OpenAI 兼容 chat/completions 即走「自然语言捏声线」协议；URL 里含 `openspeech.bytedance.com` 则自动切豆包官方 seed-tts 协议（头/请求体/流式解析全自动换挡），不用改代码 |
| `ttsModel` | 同上 | OpenAI 兼容端点填模型 ID；豆包协议填资源 ID（如 `seed-tts-2.0`） |
| `ttsVoice` | 同上 | 豆包协议专用：音色库的音色 ID（控制台「音色库」页搜音色名可拿） |
| `ttsVoiceDesign` | 同上 | **声线 = 一段自然语言描述**（音色/语速/语气/口癖都写在里面），改这一句就换嗓子 |
| `ttsAutoVoiceChars` | 同上 | 自动语音化阈值：普通回复 ≤ 此字数先发语音+文字版跟上，超长纯文字分段（0 = 关闭自动语音化） |
| `tts` 开关 | `switches.json`（面板「功能开关」） | 语音业务总闸，关了 @ 也只回文字 |

- 动态语气不用配置：LLM 每条回话末尾自动申报「语气指令：…」，触发那句原话也会喂进语境
- 想调语气规则的措辞/白名单话种：`qq-group-bot/bot.mjs` 的语音路由段（搜 `parseVoiceIntent`）

### 唱歌——独立通道

| 配置键 | 位置 | 说明 |
|---|---|---|
| `ttsSingUrl` / `ttsSingKey` | `mediaapi.json` | **和说话完全独立**的一对端点/Key——说话和唱歌可以各用各的服务商 |
| `ttsSingModel` | 同上 | 唱歌模型：prompt 驱动的音频生成模型（如豆包 Seed Audio 系）或带 `(唱歌)` 标签的 TTS 预置音色模型均可，客户端按端点自动判请求形状 |
| `ttsSingVoice` | 同上 | 预置音色方案专用：预置音色名（如茉莉/冰糖） |

- 演唱引导词（声线+风格的组合措辞）：`qq-group-bot/tts.mjs` 的 `generateSong`，改那一句模板即可
- 歌词规格（句数/字数）：`qq-group-bot/bot.mjs` 唱歌路由段（搜 `唱歌路由`）里那段歌词写手 system

### 生图 / 生视频

| 配置键 | 位置 | 说明 |
|---|---|---|
| `imggenUrl` / `imggenKey` / `imggenModel` | `mediaapi.json`（面板「生图 API」卡） | OpenAI 兼容 `/v1/images/generations`；面板卡上有实测按钮 |
| `imggenSize` / `imggenQuality` / `imggenAspectRatio` / `imggenResolution` | 同上 | **参数两套体系**：OpenAI gpt-image 系认 `imggenSize`+`imggenQuality`；Grok 系认 `imggenAspectRatio`+`imggenResolution`（且不传 quality=auto=最低档，切 Grok 前记得调） |
| `vidgenUrl` / `vidgenKey` / `vidgenModel` / `vidgenMaxSeconds` | `mediaapi.json`（面板「生视频 API」卡） | 异步任务制；`vidgenMaxSeconds` 是成片时长硬上限（超了不发） |
| `vidgenEnabled` | `switches.json` | 生视频业务总闸，关了 @ 也直接回歇业 |

### 人设 / 文案 / 其他

| 想改什么 | 配置键 | 位置 | 生效 |
|---|---|---|---|
| 人设/铁律/能力边界 | `systemPrompt` | `config.mjs` 或 `prompt.json`（面板写） | 重启 |
| #吃什么 推荐语风格 | `eatPrompt` | 同上 | 重启 |
| 信标词（喊 A 回 B） | `beaconTrigger` / `beaconReply` | `config.mjs` | 重启 |
| 消息分段长度/条数/冷却 | `chunkChars` / `maxReplyChunks` / `cooldownMs` | `config.mjs` | 重启 |
| 单媒体大小上限/关联窗口 | `maxMediaBytes` / `mediaMemoryWindow` / `mediaHistoryMaxBytes` | `config.mjs` | 重启 |
| 搜索条数/抓取字数/每日上限 | `searchResults` / `searchTextChars` / `fetchTextChars` / `searchDailyLimit` | `config.mjs` | 重启 |
| 饭食清单 | — | `qq-group-bot/foods.mjs`（368 道，自己加菜） | 重启 |
| 上下文压缩触发点 | `contextTokenLimit` / `compressRatio` / `keepRecent` | `config.mjs` | 重启 |

验证改完是否正常：`cd qq-group-bot && bun run selfcheck.mjs`（12 项）；
更深的排错见 [docs/03-坑与排错.md](docs/03-坑与排错.md)。

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
