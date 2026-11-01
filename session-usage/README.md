# session-usage（会话用量）

ZCode（智谱 Z.AI 的 Agentic Coding 工具）插件：**在每条回复末尾自动显示会话用量统计**，Cherry Studio 风格。本插件是 [cheshire-bot](../../) 仓库附带的独立工具，与机器人本体无关。

## 功能

- **自动页脚**：每条回复末尾自动附加一行 `— 105.1万 Tokens · 28.9 Token/秒`（累计 Token 数与模型生成速度，格式与 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 的消息统计一致）
- **`/usage` 完整面板**：输入/输出 Token、缓存读取/未缓存/缓存写入、推理（估算）、模型生成 TPS、端到端吞吐/耗时、费用（本地估算，需配置单价）
- 数据来自 ZCode 本地模型 I/O 日志（`~/.zcode/cli/rollout/`），不上传任何数据，离线可用

## 安装

1. 打开 ZCode 的 **插件市场 → 添加 → 添加插件市场**
2. 粘贴：`2237423553/cheshire-bot`，勾选风险确认后添加
3. 在 **个人** 页找到 **会话用量 / Session Usage**，点 **安装**
4. **新建一个任务**（重要：ZCode 在会话启动时注册插件钩子，老会话加载不到）发两条消息——第 2 条回复起，页脚自动出现

> 想看完整面板：输入 `/usage`。费用默认显示"—"，编辑 `session-usage/skills/session-usage/scripts/prices.json` 填入模型单价（US$/1M tokens）后自动估算。

## 工作原理

- `UserPromptSubmit` 钩子在每条用户消息时运行统计脚本，读取当前会话的模型 I/O 日志并注入累计用量，模型据此在回复末尾附加页脚（数字截至该条回复开始前）
- ZCode 默认会裁剪模型 I/O 日志（`modelIoFullRetentionEnabled`），页脚显示的是日志保留窗口内的累计

## 兼容性

- 需要系统 PATH 中有 `python`（仅标准库）
- Windows / macOS / Linux 均可

## License

MIT（仅限本插件目录，见 [LICENSE](LICENSE)）
