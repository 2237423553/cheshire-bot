# 柴郡 QQ 群机器人

> QQ 群聊机器人「柴郡」：@ 对话（文字/图片/视频）、B站链接自动总结、联网搜索、上下文记忆。
> **此仓库不含任何密钥**，也不含 SnowLuma 本体。

## 功能一览

- 🗨️ **@ 对话**：文字 / 图片 / 视频识别（视频 URL 直传多模态模型，零下载零转码）
- 📺 **B站链接自动总结**：群里甩 `b23.tv` / BV 链接免 @ 触发，直链直传模型「亲眼看片」
  （playurl 直链不校验 Referer，免登录 720P；含拒答检测 + 自动重试）；也支持带问题看片
- 🔎 **联网搜索**：Exa MCP Server，无需 API key
- 📡 **寻呼信标**：喊「柴郡柴郡」秒回，用来定位机器人在不在
- 🔁 **+1 复读**：有人复读跟着复读一次（四道防死循环闸）
- 🧠 **上下文记忆**：自动压缩、图片关联窗口、多人不串线署名
- 🛠 **管理指令**：#上下文 / #压缩 / #清空 / #模型 / #吃什么 / #战绩（全零 token 或独立会话）
- 🖥 **命令行入口**：`bilibili-summarize.mjs` 与机器人共用同一套B站看片引擎

## 仓库结构

    一键启动.cmd            一键：停旧实例 → 起 SnowLuma + 机器人 → 自检 → 开管理页
    复检.cmd                只重跑 12 项自检
    切换模型.cmd            本地换 LLM 服务商/模型（先验证再写盘 llmstate.json）
    _start-all.ps1          一键启动的实际逻辑
    bilibili-summarize.mjs  B站视频总结命令行入口
    qq-group-bot/           机器人本体
    ├─ bot.mjs              主程序（消息流 / LLM / 媒体 / 上下文）
    ├─ bilibili.mjs         B站看片引擎（直链直传 + 拒答重试）
    ├─ config.mjs           配置（含密钥占位符，**部署时填这里**）
    ├─ selfcheck.mjs        12 项自检
    ├─ foods / exa / wt     吃什么抽签 / Exa 搜索 / 战争雷霆战绩
    └─ providers / switch-model / _urlprobe / _start.ps1

## 部署步骤

1. **SnowLuma（不在本仓库）**：按其官方说明安装到仓库根目录的 `SnowLuma\`
   （一键启动默认在 `../SnowLuma/node.exe` 找它的运行时）。
   ⚠️ SnowLuma 为非官方协议工具、非商业许可，用非官方协议接入 QQ 有封号风险，自担。
2. **填密钥**：改 `qq-group-bot/config.mjs`
   - `llmKey` → 你的 LLM API Key（OpenAI 兼容 `/chat/completions` 端点，默认 OpenCode Go）
   - `imggenKey` → 你的生图 API Key（不用生图可留占位）
   - `obHttpToken` / `obWsToken` → 与 SnowLuma 的 `config/onebot_你的QQ号.json` 保持一致
3. **装依赖**：`cd qq-group-bot && bun install`
4. **QQ 前置**：本机装 NTQQ（9.9.x，经典版不支持），登录用作机器人的 QQ 号
5. 双击 `一键启动.cmd` → 12 项自检全过 → 群里 @ 它说话试试

## 日常操作

- **重启** = 再点一次「一键启动」（自动停旧实例，安全）
- **换模型** = 双击「切换模型.cmd」（地址+Key → 拉列表 → 选 → 验证通过才写盘）
- **看日志** = `qq-group-bot/bot.log`（正常）/ `bot.err`（报错走 stderr，媒体问题在这）
- **B站总结** = 群里直接甩链接（免 @）；命令行：
  `bun run bilibili-summarize.mjs <链接> [问题]`；总结自动存档 `B站总结/<BV>_P<P>.md`

## 已知边界

- QQ 语音消息（SILK v3）不支持，机器人会如实说听不了
- 视频 URL 直传：MiMo 上限 300MB（≈720P 20 分钟）；base64 兜底受 50MB 字符串限制
- B站免登录 720P 封顶；会员/付费视频拿不到直链会明着报错
- 上下文全在内存，重启即清零（有意设计）
- 视频请求的 prompt_tokens 是粗估值，不能用来判断服务端是否真的拉到了视频
  （偶发拉取失败时 API 不报错、模型会「装看不见」——引擎已内置拒答检测 + 重取直链重试）

## 许可

机器人代码归仓库所有者所有；SnowLuma 为第三方组件，其 EULA 另见其发布页
（非商业许可，商业使用需书面授权）。
