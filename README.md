# 柴郡 QQ 群机器人 / Cheshire QQ Group Bot

> 一只住在 QQ 群里的柴郡猫。@她就能聊天，扔个 B 站链接她就自己看完然后讲给你听，
> 还会画画、配音、唱歌。所有 AI 服务都从本机配置面板随手更换。
> 仓库不含任何密钥，也不含 SnowLuma 本体（需单独安装）。

---

# 🇬🇧 English

A Cheshire cat living in your QQ group. @-mention her to chat — she remembers the group's ongoing conversation. Paste a Bilibili link and she watches the video herself, then tells you what it's about (@ not required). She can draw, speak with a real synthesized voice, and sing. Everything runs on your own machine, and every AI service she talks to is a plug you swap on a local settings page.

## What she can do

- 💬 **Chat** — @ her with text, a picture, or a short video; she answers in character, keeps the thread, and even accepts hand-typed `@柴郡 …` without the real AT segment
- 💌 **Private chat** — DM her directly and she answers with the full skill set; only whitelisted QQ accounts get replies (everyone else is silently ignored)
- 📺 **Watch a Bilibili video for you** — paste a `b23.tv` link anywhere and she pulls the video's stream, actually watches it, and replies with a full Chinese summary (times, key points); you can ask about that video afterwards and she remembers it. There's also a command-line tool (`bilibili-summarize.mjs`) that uses the exact same engine
- 🔎 **Search the web** when a question isn't something she'd know
- 🎙 **Speak** — short replies come out as synthesized voice with the text copy right after; the voice itself is described in one natural-language sentence ("girl's voice, a bit haughty, purrs when pleased") and you can rewrite it anytime. Say `语音：…` or `念出来…` and she reads something out loud specifically — no length cap on that
- 🎵 **Sing** — ask with `唱歌 xxx`, she writes the lyrics and performs them; singing uses its own separate service, so talking and singing can sound differently
- 🐾 **Random Cheshire meme** — `随机柴郡图` pulls a random meme from a GitHub-hosted collection, no repeats in a run
- 💍 **Daily wife** — `今日老婆` draws a ship-girl (picture + CN/JP/EN name + two voice lines) and costs 2 magic cubes; `签到` checks in for +10; `本命老婆 <name>` pins a favorite (50% chance to draw her for free). Data lives in `js/register_table/` (`fig_data.json` pool, `register_dict.json` user table)
- 🖼 **Draw** — `画一张××`; within 10 minutes, `改一下` or `性别错了` gets a revision of the same picture. Moderation blocks or quota exhaustion are reported honestly instead of silently failing
- 🎬 **Make short videos** (15 s cap) — text-to-video, or image-to-video by quoting a picture
- 📡 **Beacon** — shout the trigger phrase and get an instant scripted reply: zero tokens, proof she's alive
- 🔁 **+1 echo** — joins a (+1) repeat chain once, with four guards against loops
- 🧠 **Memory** — the conversation is summarized automatically when it grows too long, so she never "forgets" the group
- 🛠 **Admin commands** — `#上下文` `#压缩` `#清空` `#模型` `#吃什么` `#战绩`
- ✅ **Self-check** — an 8-point report tells you at a glance whether the bot, config, LLM, search and lottery are healthy

## Stack & safety

- **Stack**: Bun + OneBot v11 (SnowLuma bridge) + any OpenAI-compatible LLM endpoint
- **This repo contains no keys** — real keys live in gitignored runtime files (`secrets.json` for the LLM key + OneBot tokens; `mediaapi.json` / `llmstate.json` / `prompt.json` written by the panel); `config.mjs` ships placeholders only
- Outbound requests on user-supplied URLs pass an **SSRF gate** (http/https only, loopback/private hosts rejected by literal check *and* DNS resolution, anti-rebinding); every external fetch has a hard timeout
- Honest-error policy: audit blocks, rate limits, quota exhaustion and "couldn't reach the API" are reported as-is, never retried into silence
- Docs are in Chinese (docs/01–03 + 更新公告 with an English summary at top); code comments are Chinese too, but the code itself is straightforward to read

## Quick start

1. **Install SnowLuma** (third-party QQ↔OneBot bridge, **not in this repo**) into the repo root `SnowLuma\`
   ⚠️ unofficial protocol tool — using it carries a QQ account ban risk; non-commercial license, written authorization required for commercial use
2. **Fill in config** — real keys always live in gitignored runtime files; `config.mjs` ships placeholders only:
   - `qq-group-bot/secrets.json` → `llmKey` (LLM API key; the default endpoint also needs an `x-opencode-session` header, added automatically) + `obHttpToken` / `obWsToken` (must match SnowLuma's `config/onebot_<your QQ>.json`)
   - image / video / TTS endpoints & keys → the panel's "生图 API / 生视频 API / 语音 API" cards (writes `mediaapi.json`), or hand-edit that file
   - LLM endpoint / model → panel or `切换模型.cmd` (writes `llmstate.json`)
3. **Install deps**: `cd qq-group-bot && bun install`
4. **Prerequisite**: NTQQ (9.9.x; the classic edition won't work) installed and the bot's QQ account logged in
5. **Double-click `一键启动.cmd`**: stops stale instances → starts SnowLuma + the bot → opens the admin WebUI → runs the 8-point self-check

Daily ops: re-run the same launcher to restart (idempotent); switch models via **`切换面板.cmd`** (local web page: form → model list → 4-point probe → one-click switch, for mouse people) or `切换模型.cmd` (CLI: verify first, then write). Logs: `qq-group-bot/bot.log` (stdout) and `bot.err` (stderr).

## Customization: what → which key → where → effect

**Config lives in three layers**, highest priority first (a key in a higher layer overrides lower ones):

| Layer | File (all in `qq-group-bot/`) | Written by | Effect |
|---|---|---|---|
| Runtime state | `llmstate.json` | panel / switch-model CLI | restart the bot |
| Media & voice | `mediaapi.json` | panel media cards / hand-edit | restart the bot |
| Factory defaults | `config.mjs` (placeholders, no real keys) | hand-edit | restart the bot |

Also: `secrets.json` = LLM key + both OneBot tokens (hand-edit, restart); `prompt.json` = persona/prompt overrides (panel-written, restart); `switches.json` = feature switches (**re-read on every message, instant, no restart**).
**Universal rollback: delete the json file, restart, and you're back to the `config.mjs` defaults.**

### Swapping the LLM (chat model)

- Recommended: double-click **`切换面板.cmd`** (local web page: endpoint/key form → pull model list → **automatic 4-point probe** basic/thinking/tool-calling/vision → one-click switch + restart; save configurations as **profiles** and re-enable anytime)
- CLI: **`切换模型.cmd`** (masked key input, `--probe`, `--list`, `--restart` to actually restart)
- Or hand-edit the `llmUrl / llmKey / model / llmHeaders / thinking` defaults in `config.mjs`
- No code changes needed for a new provider — any OpenAI-compatible endpoint works; the preset URL mappings (DeepSeek / Kimi / BigModel / SiliconFlow / OpenRouter / Ollama…) live in `PRESETS` in `qq-group-bot/providers.mjs`, add a regex line to support another

### Voice (TTS) — talking

| Key | Where | Meaning |
|---|---|---|
| `ttsUrl` / `ttsKey` | `mediaapi.json` (panel "语音 API" card) | **Pluggable endpoint**: point it at an OpenAI-compatible chat/completions for natural-language voice design; if the URL contains `openspeech.bytedance.com` the client auto-switches to ByteDance's official seed-tts protocol (headers, body wrapper, streamed parsing — all automatic) |
| `ttsModel` | same | Model ID on OpenAI-compatible endpoints; resource ID (e.g. `seed-tts-2.0`) on the Doubao protocol |
| `ttsVoice` | same | Doubao protocol only: a timbre ID from the voice library (search the voice name in the console's voice-library page) |
| `ttsVoiceDesign` | same | **The voice = one natural-language description** (timbre, speed, mood, verbal tics) — rewrite that one sentence to change it |
| `ttsAutoVoiceChars` | same | Auto-voicing threshold: replies ≤ this many chars go voice-first + text copy, longer ones stay as chunked text (0 = disable auto-voicing) |
| `tts` switch | `switches.json` (panel "功能开关") | Voice master switch; off = text-only even when @-mentioned |

- Dynamic tone needs no config: the LLM appends a per-reply "tone directive" automatically, and the triggering message is quoted into context
- To tweak the tone-line wording / allowed language varieties: the voice-route section of `qq-group-bot/bot.mjs` (search `parseVoiceIntent`)

### Singing — a separate channel

| Key | Where | Meaning |
|---|---|---|
| `ttsSingUrl` / `ttsSingKey` | `mediaapi.json` | **Fully independent** from speech — talking and singing may use different providers |
| `ttsSingModel` | same | The singing model: a prompt-driven audio-generation model, or a TTS model whose preset voices accept the `(唱歌)` tag — the client detects the request shape from the endpoint |
| `ttsSingVoice` | same | Preset-voice route only: a preset timbre name |

- The singing prompt template (voice + style phrasing): `generateSong` in `qq-group-bot/tts.mjs` — edit that one sentence
- Lyric spec (lines / length): the lyric-writer system prompt in `qq-group-bot/bot.mjs`'s singing route (search `唱歌路由`)

### Image / video generation

| Key | Where | Meaning |
|---|---|---|
| `imggenUrl` / `imggenKey` / `imggenModel` | `mediaapi.json` (panel "生图 API" card) | OpenAI-compatible `/v1/images/generations`; the panel card has a live test button |
| `imggenSize` / `imggenQuality` / `imggenAspectRatio` / `imggenResolution` | same | **Two parameter systems**: OpenAI gpt-image-family reads `imggenSize` + `imggenQuality`; xAI Grok family reads `imggenAspectRatio` + `imggenResolution` (and omitting quality = auto = lowest tier, so raise it before switching to Grok) |
| `vidgenUrl` / `vidgenKey` / `vidgenModel` / `vidgenMaxSeconds` | `mediaapi.json` (panel "生视频 API" card) | Async-task based; `vidgenMaxSeconds` is a hard cap (longer clips are discarded, not sent) |
| `vidgenEnabled` | `switches.json` | Video master switch; off = @ requests get a polite "closed" reply |

### Persona / copy / misc

| What | Key | Where | Effect |
|---|---|---|---|
| Persona / rules / capability bounds | `systemPrompt` | `config.mjs` or `prompt.json` (panel) | restart |
| `#吃什么` recommendation style | `eatPrompt` | same | restart |
| Beacon phrase (shout A, reply B) | `beaconTrigger` / `beaconReply` | `config.mjs` | restart |
| Message chunking / cooldown | `chunkChars` / `maxReplyChunks` / `cooldownMs` | `config.mjs` | restart |
| Media size caps / association window | `maxMediaBytes` / `mediaMemoryWindow` / `mediaHistoryMaxBytes` | `config.mjs` | restart |
| Search counts / fetch chars / daily cap | `searchResults` / `searchTextChars` / `fetchTextChars` / `searchDailyLimit` | `config.mjs` | restart |
| Food list | — | `qq-group-bot/foods.mjs` (368 dishes, add your own) | restart |
| Context compression triggers | `contextTokenLimit` / `compressRatio` / `keepRecent` | `config.mjs` | restart |

Verify after changing anything: `cd qq-group-bot && bun run selfcheck.mjs` (8 checks);
deeper troubleshooting in [docs/03-坑与排错.md](docs/03-坑与排错.md) (Chinese).

## Architecture

    QQ (NTQQ 9.9.x)  ←  SnowLuma hook injection
      └ SnowLuma      WebUI :5099 ｜ OneBot HTTP :3000 ｜ OneBot WS :3001
          └ qq-group-bot (this repo)
              ├ bot.mjs        main: message flow / tool loop / commands / media / context
              ├ bilibili.mjs   bilibili watcher (direct-stream + refuse-detection retry)
              ├ exa.mjs        Exa MCP client (search / fetch)
              ├ api-panel.mjs / panel-page.mjs   local API config panel (web)
              ├ probe-suite.mjs                  4-point probe (basic/thinking/tools/vision)
              ├ llm-state.mjs / botctl.mjs       sole state writer / bot process control
              ├ wt.mjs         War Thunder stats (Thunderskill)
              ├ imggen.mjs     image generation client
              ├ vidgen.mjs     video generation client (submit → poll → download)
              ├ tts.mjs        speech synthesis (dual protocol) + singing client
              └ foods.mjs      368 dishes, truly random draw (the model only writes blurbs)
          LLM: any OpenAI-compatible endpoint — pick in the local panel, swap without code changes

## Docs & known limits

| Doc | Content |
|---|---|
| [docs/更新公告.md](docs/更新公告.md) | **changelog by date** (English summary at top — start here) |
| [docs/01-部署与配置.md](docs/01-部署与配置.md) | architecture, launcher, model-switch tooling, 8-point self-check, full config table (Chinese) |
| [docs/02-功能与机制.md](docs/02-功能与机制.md) | trigger rules, media handling, context & compression, bilibili engine, search (Chinese) |
| [docs/03-坑与排错.md](docs/03-坑与排错.md) | **real-world pitfalls** + quick troubleshooting table + common commands (Chinese) |

Known limits:

- She can **send** voice (TTS) but cannot **understand** incoming voice messages — and says so honestly
- Video URL-direct caps at 300 MB (≈720P / 20 min); base64 fallback limited to 50 MB strings
- Bilibili login-free tops out at 720P; paid/members-only videos error out loudly when no stream is available
- For video requests `prompt_tokens` is a rough estimate and can't prove the server actually fetched the video; occasional silent fetch failures with the model "pretending not to see" — the engine has refuse-detection + re-fetch retries built in
- Context lives in memory only and resets on restart (by design)

## License

The bot code is yours to use and modify freely; SnowLuma is a third-party component under its own EULA
(see its release page — non-commercial license, written authorization required for commercial use or automated deployment).

---

# 🇨🇳 中文文档

## 她能干什么

- 💬 **聊天**：@ 她就能聊——文字、图片、短视频都行；带上下文记忆，多人插话也不串线；
  手打「@柴郡 …」也能喊到她
- 💌 **私聊**：加她好友直接发消息也能聊（全套功能都在），但只对白名单 QQ 反应，
  其他人的私聊一概不回、不留痕
- 📺 **帮你看 B 站视频**：群里甩个 `b23.tv` 链接（**不用 @**），她自己取视频、自己看完，
  用中文给你讲清楚讲明白；看完还能接着追问内容。命令行工具 `bilibili-summarize.mjs`
  用的是同一套引擎
- 🔎 **联网搜索**：群里聊到的她不知道的事，会自己上网查了再说
- 🎙 **开口说话**：短回复先发**语音**再附文字版；声线就是一段自然语言
  （「少女音，傲娇一点，开心了会呼噜」这么写的），想换嗓子改那一句就行。
  说「语音：…」「念出来 xx」她会专门念给你听，长稿也不设字数上限
- 🎵 **唱歌**：说「唱歌 xxx」，她现写歌词现唱；唱歌走独立通道，可以和说话用不同的服务商
- 🐾 **随机柴郡图**：说「随机柴郡图」从表情包库里真随机抽一张，连抽不重样
- 💍 **今日老婆**：@ 她说「今日老婆」抽一位舰娘（发图 + 中日英名 + 两条台词，扣 2 魔方）；
  「签到」每天领 10 魔方；「本命老婆 <名字>」指定本命（五成概率直接出本命、不扣魔方）。
  数据在 `js/register_table/`（`fig_data.json` 老婆池 + `register_dict.json` 用户表）
- 🖼 **画画**：说「画一张××」就画；10 分钟内说「改一下」「性别错了」她会带着原 prompt 重画。
  审核拦截、限流这些都会如实说，不装死也不静默
- 🎬 **生成短视频**：15 秒内的小片段，文字生成、引用一张图也会图生视频
- 📡 **寻呼信标**：喊「柴郡柴郡」秒回——零开销确认她还活着
- 🔁 **+1 复读**：有人 +1 她跟着复读一次（带死循环防护）
- 🛠 **管理指令**：`#上下文` `#压缩` `#清空` `#模型` `#吃什么` `#战绩`
- ✅ **自检**：一条命令 8 项体检，bot、配置、模型、搜索、抽签健不健康一眼可查

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
              ├ wife.mjs       今日老婆/签到/本命（数据在 register_table/）
              └ foods.mjs      368 道饭食真随机抽签（模型只写推荐语）
          LLM：任意 OpenAI 兼容端点——本地面板里挑着换，不用改代码

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
5. **双击 `一键启动.cmd`**：自动停旧实例 → 起 SnowLuma + 机器人 → 弹管理后台 → 8 项自检

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

验证改完是否正常：`cd qq-group-bot && bun run selfcheck.mjs`（8 项）；
更深的排错见 [docs/03-坑与排错.md](docs/03-坑与排错.md)。

## 文档（细节都在这里）

| 文档 | 内容 |
|---|---|
| [docs/更新公告.md](docs/更新公告.md) | **按日期的改动公告**（最新版本来这里看） |
| [docs/01-部署与配置.md](docs/01-部署与配置.md) | 架构总览、一键启动、换模型工具、自检 8 项、全部配置参数表 |
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
