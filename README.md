# 柴郡 QQ 群机器人

> QQ 群聊机器人：@ 对话（文字/图片/视频）、**B站链接自动总结**、联网搜索、上下文记忆。
> **仓库不含任何密钥**，也不含 SnowLuma 本体（需单独安装）。

## 功能一览

- 🗨️ **@ 对话**：文字 / 图片 / 视频识别。视频走 **URL 直传**——把 QQ 原始下载链接直接
  发给多模态模型（零下载、零转码，绕开 base64 50MB 限制，上限 300MB）
- 📺 **B站链接自动总结**：群里甩 `b23.tv` / BV 链接**免 @ 触发**，机器人自动取
  playurl 音画合一 mp4 直链（实测不校验 Referer）喂给模型「亲眼看片」——
  零下载零转存、免登录 720P、带提问模式、拒答检测 + 自动重试；
  总结自动存档并进上下文，之后可继续追问。命令行入口 `bilibili-summarize.mjs` 共用同一引擎
- 🔎 **联网搜索**：Exa MCP Server（`web_search` / `fetch_webpage`），无需 API key
- 🖼 **文生图**：OpenAI 兼容生图端点（`generate_image` 工具）
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
              ├ wt.mjs         战争雷霆战绩查询（Thunderskill）
              ├ imggen.mjs     文生图客户端
              └ foods.mjs      368 道饭食真随机抽签（模型只写推荐语）
          LLM：任意 OpenAI 兼容端点（默认 OpenCode Go / mimo-v2.6-flash，思考档 auto）

## 快速开始

1. **安装 SnowLuma**（第三方 QQ↔OneBot 桥，不在本仓库）到仓库根目录 `SnowLuma\`
   ⚠️ 非官方协议工具，接入 QQ 有封号风险；非商业许可，商用需其书面授权
2. **填配置** `qq-group-bot/config.mjs`：
   - `llmKey` → 你的 LLM API Key（OpenAI 兼容端点；默认端点需 `x-opencode-session` 会话头）
   - `imggenKey` → 生图 Key（不用可留占位）
   - `obHttpToken` / `obWsToken` → 与 SnowLuma 的 `config/onebot_<你的QQ号>.json` 一致
3. **装依赖**：`cd qq-group-bot && bun install`
4. **前置**：本机装 NTQQ（9.9.x；经典版不支持）并登录机器人的 QQ 号
5. **双击 `一键启动.cmd`**：自动停旧实例 → 起 SnowLuma + 机器人 → 弹管理后台 → 12 项自检

日常：重启就再点一次（幂等）；换模型双击 `切换模型.cmd`（先验证再写盘）；
日志在 `qq-group-bot/bot.log`（正常）和 `bot.err`（报错走 stderr）。

## 自定义

- **更换 LLM API**：双击「切换模型.cmd」（交互式：地址 → Key → 拉列表 → 选 → 验证通过才切换），
  或命令行 `bun run switch-model.mjs <url> <key> [model]`，或直接改 `config.mjs` 默认值。
  回滚 = 删掉 `llmstate.json`。换服务商要探的四件事见 [docs/01 · 8.1](docs/01-部署与配置.md)
- **更改人设 / 提示词**：全部集中在 `config.mjs`——`systemPrompt`（人设 + 铁律 + 能力边界）、
  `eatPrompt`（#吃什么 文案语气）、`beaconTrigger/beaconReply`（信标词）。
  改完重启生效，验证三步见 [docs/01 · 8.2](docs/01-部署与配置.md)

## 文档（细节都在这里）

| 文档 | 内容 |
|---|---|
| [docs/01-部署与配置.md](docs/01-部署与配置.md) | 架构总览、一键启动、换模型工具、自检 12 项、全部配置参数表 |
| [docs/02-功能与机制.md](docs/02-功能与机制.md) | 触发规则、媒体处理（URL 直传/关联窗口）、上下文与压缩、B站总结引擎、搜索 |
| [docs/03-坑与排错.md](docs/03-坑与排错.md) | **32 个真实踩坑** + 故障速查表 + 常用命令（排错先看这个） |

> 文档沿用开发时的称呼：三位使用者在文档里叫「指挥官」，「上篇/中篇/下篇」即 docs/01~03。

## 已知边界

- QQ 语音消息（SILK v3）不支持，机器人会如实说听不了
- 视频 URL 直传上限 300MB（≈720P 20 分钟）；base64 兜底受 50MB 字符串限制
- B站免登录 720P 封顶；会员/付费视频拿不到直链会明着报错
- **视频请求的 prompt_tokens 是粗估值**，不能判断服务端是否真拉到了视频；
  偶发拉取失败时 API 不报错、模型会「装看不见」——引擎已内置拒答检测 + 重取直链重试
- 上下文全在内存，重启即清零（有意设计）

## 许可

机器人代码随你处置（自用/魔改随意）；SnowLuma 为第三方组件，其 EULA 另见其发布页
（非商业许可，商业使用或自动化部署需事先书面授权）。
