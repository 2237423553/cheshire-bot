---
description: 展示当前会话的模型用量面板（输入/输出 Token、缓存、TPS、费用估算）
---

统计并展示本次会话的模型用量。

1. 调用 Skill 工具加载 `session-usage` 技能。
2. 严格按该技能的说明运行其中的统计脚本（`python -I "<技能基目录>/scripts/usage.py"`）。
3. 把脚本输出的 Markdown 用量面板原样展示出来，不要改写数字；如用户想看历史会话或精确 JSON，按技能说明加参数。
