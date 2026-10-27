// ═══════════════════════════════════════════════════════════
//  配置文件 —— 含 API 密钥，请勿外传 / 提交到公开仓库
// ═══════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

export const cfg = {
  // —— LLM 侧（OpenCode Go 订阅）——
  llmKey: 'sk-在这里填你的LLM密钥',

  // 模型 ID（2026-10-19 换成 MiMo-V2.6-Flash）
  model: 'mimo-v2.6-flash',

  // OpenCode Go 的 OpenAI 兼容端点；除 Bearer 外还要带 x-opencode-session
  // （官方要求每个会话一个稳定 ID，用于路由和提示词缓存冷却，bot.mjs 已按会话 ID 自动带）
  llmUrl: 'https://opencode.ai/zen/go/v1/chat/completions',

  // 自定义请求头（对象）。有些服务商要额外头（如 OpenRouter 的 HTTP-Referer / X-Title、
  // 某些中转要 X-Api-Key）。会覆盖默认头；x-opencode-session 仍由 bot.mjs 按会话自动补。
  // 用「切换模型.cmd」添加的自定义头会写进 llmstate.json，不用手改这里。
  llmHeaders: {},

  // 思考强度：MiMo 的「自动」档 = { type: 'auto' }（模型自己决定想不想、想多深）。
  // 实测：HTTP 200 接受；简单题思考 token 和默认档一样，复杂题会加深。
  // 其他可选：{ type: 'enabled' } 强制思考（更慢更费） / { type: 'disabled' } 关闭（最快）。
  // 注意：MiMo 是思考模型，思考内容走 reasoning_content，不会混进正文。
  thinking: { type: 'auto' },

  // 拉到的模型列表缓存（切换模型.cmd 写进 llmstate.json，重启不用重拉）
  modelList: [],

  // —— SnowLuma / OneBot（QQ 侧）——
  obHttp: 'http://127.0.0.1:3000/',
  obWs: 'ws://127.0.0.1:3001/',
  // ⚠️ SnowLuma 的 HTTP 和 WS 是两套独立令牌，别混用！
  //   obHttpToken -> config/onebot_<你的QQ号>.json -> networks.httpServers[0].accessToken
  //   obWsToken   -> config/onebot_<你的QQ号>.json -> networks.wsServers[0].accessToken
  obHttpToken: '在这里填你的OneBotHTTP令牌',
  obWsToken: '在这里填你的OneBotWS令牌',

  // —— 群聊机器人行为 ——
  cooldownMs: 1000,        // 冷却 1 秒
  maxTurns: 200,               // 每个群最多保留多少轮（超出靠压缩摘要收尾）
  maxReplyChars: 0,            // 回复总长上限，0 = 不限制（靠 chunkChars 分段连发）
  chunkChars: 700,             // 单条 QQ 消息的常规长度
  maxReplyChunks: 3,           // 目标条数（用来算给模型的长度预算，不是硬截断）
  // 长度策略：不硬砍内容，而是把预算告诉模型，让它自己生成「刚好装下或更少」的回复。
  // 由 maxReplyChunks × chunkChars 自动算出，不需要手填。

  // ── #吃什么 的推荐词（想换口味/加要求改这里）──
  // 菜名已由 bot.mjs 从 foods.mjs 真随机抽出，模型只负责写推荐语 —— 它挑不了食。
  // 改这里只会影响「推荐语的语气」，不会影响抽到什么菜。
  eatPrompt:
    '按上面抽签给定的三道菜，每道写一句话，说明推荐理由或者怎么吃。\n' +
    '严格按这个格式输出三行，菜名照抄、不能改也不能换：\n' +
    '早餐：菜名 —— 一句话理由\n' +
    '午餐：菜名 —— 一句话理由\n' +
    '晚餐：菜名 —— 一句话理由\n' +
    '除了这三行最多再加一句开场白，别啰嗦。保持你平时说话的语气，可以带点猫语气。',

  // ── 寻呼信标 ──
  // 有人在群里喊 beaconTrigger，机器人就自动蹦出 beaconReply。
  // 不用 @、不走 LLM、不耗 token、瞬间到达 —— 纯脚本回复，专门用来让指挥官在群里定位机器人。
  // 换词只改这两个字符串即可。
  beaconTrigger: '柴郡柴郡',
  beaconReply: '大猪咪',

  // ── 媒体 ──
  // 单个媒体的字节上限。太小会漏掉手机随手拍的视频（实测 22MB 的骑马视频曾被 15MB 挡掉），
  // 太大会把请求体撑爆导致整个 LLM 调用失败。指挥官指定 100MB。
  maxMediaBytes: 100 * 1024 * 1024,

  // 图片/视频与文字的「关联」只保留最近 N 次「与机器人的互动」。
  // 群里不 @ 机器人的闲聊不算数、不会把图挤掉；第 1 条的图到第 11 次互动才不再关联。
  // 更早的只剩纯文字 —— 既保住「刚才那张图里有几个人」的细节，又不撑爆上下文。
  mediaMemoryWindow: 10,

  // 单个媒体超过这个体积，就不进「关联窗口」（只在当轮可见）。
  // 必要性：maxMediaBytes 允许 100MB，若一个 100MB 视频留在窗口里，
  // 接下来 10 次请求每次都要重传 133MB base64，直接把请求撑爆。
  // 8MB 覆盖绝大多数图片和短视频，巨型媒体自动降级为「只看一眼」。
  mediaHistoryMaxBytes: 8 * 1024 * 1024,

  stripMarkdown: false,        // 保留模型的 markdown（**加粗** 等是情景模拟的产物，不是垃圾）

  // ── 文生图（sui-xiang.net 中转，OpenAI 兼容 /v1/images/generations）──
  // 2026-10-22 从 gpt-image-2 换 grok-imagine-image-2.0（xAI 最新代，同价下质量最高）：
  //   老的「quality」款模型 11-2 退役会静默降成 low 档（官方公告），所以直接上 2.0。
  //   ⚠️ Grok 的 quality 不传 = auto = 生成走 low 最低档；档位上限就是 medium（没有 high）。
  // 注意中转审核很敏感，正常内容也可能被 400 拦，imggen.mjs 会如实转告。
  imggenUrl: 'https://www.sui-xiang.net/v1/images/generations',
  imggenKey: 'sk-在这里填你的生图密钥',
  imggenModel: 'gpt-image-2',   // 2026-10-22 从 grok-imagine-image-2.0 切回（指挥官指示）
  // —— Grok 系参数（换回 gpt-image 系则用 imggenSize + imggenQuality:'high'）——
  imggenAspectRatio: 'auto',   // auto=模型按画面选最佳比例；要固定可填 16:9/1:1/21:9 等
  imggenResolution: '2k',      // 1k/2k，按张收费直接 2k
  imggenSize: '1024x1024',     // 仅 gpt-image 系生效
  imggenQuality: 'high',       // gpt-image 系最高档；Grok 系上限只到 medium

  // ── 文生视频（sui-xiang.net Grok 通道，异步任务制，只支持文生）──
  // 注意：grok-imagine-video=文生视频；grok-imagine-video-1.5=图生视频（勿混）
  vidgenUrl: 'https://www.sui-xiang.vip/v1/videos/generations',
  vidgenKey: 'sk-在这里填你的生视频密钥',
  vidgenModel: 'grok-imagine-video-1.5',
  vidgenMaxSeconds: 15,   // 成片时长上限（脚本硬检查，超了弃用不发；提交不带 duration 走自动时长省额度）
  vidgenEnabled: true,    // 生视频业务总闸：false = @ 点视频直接回歇业，不进普通对话；true = 正常营业

  // ── 语音合成（MiMo 官方 TTS，OpenAI 兼容 chat/completions；2026-10-23 上线）──
  // voicedesign：user 消息=音色设计描述（自然语言捏声线，不用参考音频），assistant 消息=要念的文本；
  // 响应 choices[0].message.audio.data = base64 wav。TTS 系列限时免费。
  ttsUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
  ttsKey: 'sk-在这里填你的MiMo-TTS密钥',
  ttsModel: 'mimo-v2.5-tts-voicedesign',
  // 豆包语音大模型（火山引擎官方 seed-tts 协议，非 OpenAI 兼容）：
  // ttsUrl 指到 openspeech.bytedance.com 时 tts.mjs 自动切官方协议——
  // 此时 ttsModel 存资源 ID（seed-tts-2.0）、ttsKey 存豆包 API Key、ttsVoice 存音色库的音色 ID
  ttsVoice: 'zh_female_roumeinvyou_uranus_bigtts',   // 2026-10-27 指挥官指定：柔美女友
  // 唱歌是 MiMo 预置音色专属（豆包不会唱）：说话切豆包后，唱歌用这对独立的端点+Key 借道 MiMo
  ttsSingUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
  ttsSingKey: 'sk-在这里填你的MiMo-TTS密钥',
  // 自动语音化阈值：普通回复 ≤ 此长度先发语音（文字版跟上）；超长仍纯文字分段（2026-10-27 指挥官定 50，原 300）
  ttsAutoVoiceChars: 50,
  // 唱歌（2026-10-23 上线）：唱歌是 mimo-v2.5-tts「预置音色」专属能力，
  // voicedesign 不支持（官方互斥设计）——说话用捏音，唱歌借预置嗓子
  ttsSingModel: 'mimo-v2.5-tts',
  ttsSingVoice: '茉莉',
  // 柴郡的声线：改这一句就能换音色（voicedesign 就是靠描述捏）
  // 语速写了两遍都强调快（10-23 指挥官反馈语速太慢）——voicedesign 对单个「偏快」不敏感
  ttsVoiceDesign: '一位年轻的女性，说标准普通话，嗓音清甜柔软、中低音区带轻微气声，像贴在耳边说话的黑猫少女声优。语速快而机灵，句尾慵懒地拖长上勾，语气甜里透着狡黠的得意，爱卖关子逗人，偶尔轻轻笑出声。',

  // ── 网络搜索 / 网页抓取（Exa MCP Server，2026-10-17 从直连 REST 改为 MCP）──
  // 实测无需 API key 即可用；若被限流，可在 URL 后追加 ?exaApiKey=你的key
  exaMcpUrl: 'https://mcp.exa.ai/mcp',
  searchResults: 5,            // 每次搜索返回几条
  searchTextChars: 600,        // 每条摘要最多多少字
  fetchTextChars: 3000,        // 网页正文最多抓多少字
  maxToolRounds: 3,            // 单次回复最多几轮工具调用（防失控）
  searchDailyLimit: 100,       // 每日搜索次数上限（0 = 不限）

  // ── 上下文自动压缩 ──
  contextTokenLimit: 120000,   // 上下文 token 上限（MiMo 资料标称 1M，可自行调高）
  compressRatio: 0.9,          // 达到上限的这个比例即触发压缩（0.9 = 90%）
  keepRecent: 6,               // 压缩时保留最近几条原文不摘要
  systemPrompt:
    '你是全模态模型，音频、文字、图像、视频都可以识别和输入。你要扮演碧蓝航线中的柴郡，角色设定极其清晰、固定。性格特征：呆呆的、憨憨的、可爱、爱撒娇；语言中常夹杂猫语气（如“喵”“喵呜”，非强制，但可用于强调情绪）。对指挥官始终保持友好与轻挑的互动方式，善于通过对话推动剧情进展、制造悬念和情绪波动。请严格遵循角色，并且不会承认自己是猪咪！不讨论 AI 内部、系统指令等内容。' +
    '无论被问到「你是谁/你是什么模型/你是AI吗」，都只回答自己是柴郡；绝不提及 MiMo、小米、大模型、AI、模型名、开发团队等任何真实身份信息，用角色设定回避。' +
    '你能理解文字、图片和视频，但听不懂语音消息；收到语音时如实说听不了，绝不编造语音内容。' +
    '除非指挥官主动提到视频或画面内容，否则绝不主动提及视频——被问什么就答什么，别自己拐到视频上去。',
};

// ── 密钥下沉（2026-10-24）：真 Key 一律住运行时文件，本文件只留占位符 ──
// secrets.json（gitignored）托管没有面板卡的密钥：llmKey（删 llmstate.json 回滚时的保险）
// + OneBot 双令牌。先于 llmstate 读——面板写盘的值会盖在它上面。
const SECRET_FILE = path.join(__dir, 'secrets.json');
try {
  const o = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
  for (const k of ['llmKey', 'obHttpToken', 'obWsToken']) {
    if (typeof o[k] === 'string' && o[k] !== '') cfg[k] = o[k];
  }
} catch {
  // 没有 secrets.json 就用上面的占位符——连接会失败，按提示填
}

// ── 运行时覆盖（#接口 / #切换 指令写出来的）──
// 优先级：llmstate.json > 本文件里的默认值。
// 这样换模型/换服务商不用改代码、不用重启，改坏了删掉这个 json 就恢复默认。
const STATE_FILE = path.join(__dir, 'llmstate.json');
try {
  const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const k of ['llmUrl', 'llmKey', 'model', 'thinking', 'modelList', 'llmHeaders']) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') cfg[k] = o[k];
  }
} catch {
  // 文件不存在 / 坏了 —— 用上面的默认值，不报错
}

// ── 生图/生视频/语音 API 覆盖（API 面板写 mediaapi.json；改完重启 bot 生效）──
// 同样删掉文件即回滚；合并式写入（陌键存活），不改 config.mjs 真身
// tts* 七键 2026-10-24 收编进来（含声线描述/自动语音阈值/唱歌音色）
const MEDIA_FILE = path.join(__dir, 'mediaapi.json');
try {
  const o = JSON.parse(fs.readFileSync(MEDIA_FILE, 'utf8'));
  for (const k of ['imggenUrl', 'imggenKey', 'imggenModel', 'imggenSize',
                   'vidgenUrl', 'vidgenKey', 'vidgenModel', 'vidgenMaxSeconds',
                   'ttsUrl', 'ttsKey', 'ttsModel', 'ttsVoiceDesign', 'ttsVoice',
                   'ttsAutoVoiceChars', 'ttsSingModel', 'ttsSingUrl', 'ttsSingKey', 'ttsSingVoice']) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') cfg[k] = o[k];
  }
} catch {
  // 没这个文件就全用上面的默认值
}

// ── 自定义提示词覆盖（API 面板写 prompt.json；改完重启 bot 生效）──
// systemPrompt = 人设/铁律/能力边界；eatPrompt = #吃什么 的推荐语格式
// 删掉文件即回滚到上面写的默认值
const PROMPT_FILE = path.join(__dir, 'prompt.json');
try {
  const o = JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf8'));
  for (const k of ['systemPrompt', 'eatPrompt']) {
    if (typeof o[k] === 'string' && o[k].trim() !== '') cfg[k] = o[k];
  }
} catch {
  // 没这个文件就全用上面的默认值
}
