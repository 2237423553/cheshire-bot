// ═══════════════════════════════════════════════════════════════════════
//  语音合成（TTS）客户端 —— 走 MiMo 官方端点（OpenAI 兼容 chat/completions）
//
//  实测（2026-10-23）：
//  - mimo-v2.5-tts-voicedesign：user 消息=音色设计描述（自然语言捏声线，不用参考音频），
//    assistant 消息=要念的文本；audio.format 默认 wav
//  - 响应 choices[0].message.audio.data = base64 音频（10 秒左右约 345KB）
//  - TTS 系列限时免费；RPM 100 / TPM 10M / 上下文 8K
//  - 唱歌是「预置音色」专属：只有 mimo-v2.5-tts 支持 (唱歌) 标签，
//    voicedesign / voiceclone 都不支持（官方互斥设计，10-23 查证）
//  - 拿到的 wav 丢给 OneBot record 段（base64://），SnowLuma 内置 ffmpeg 自动转
//    QQ 要的 NT SILK——所以这里只管合成，不碰音频编码
// ═══════════════════════════════════════════════════════════════════════
import { cfg } from './config.mjs';

const TIMEOUT = 120 * 1000;   // 实测合成几秒就回；超时给足防误报

/** 豆包语音大模型（火山引擎官方协议）走不走：ttsUrl 指到 openspeech.bytedance.com 即切换。
 *  官方接口不是 OpenAI 兼容格式（X-Api-Key + X-Api-Resource-Id 头，req_params 包一层），
 *  所以单独一条请求/解析路径；MiMo 路径原样保留。 */
function isVolc() {
  return /openspeech\.bytedance\.com/i.test(String(cfg.ttsUrl));
}

/** 从豆包单向流（HTTP chunked）里抠出所有拼接的 JSON 对象——响应是多个 JSON 对象
 *  直接相连、没有分隔符，逐段用括号深度扫描切开（字符串里的引号/转义要避让）。 */
function splitJsonObjects(s) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) { objs.push(s.slice(start, i + 1)); start = -1; }
    }
  }
  return objs;
}

/** 豆包官方协议合成：POST /api/v3/tts/unidirectional，响应逐块回
 *  { code, message, data: <base64 音频块> }；code 0=数据块、20000000=流结束、其他=失败。 */
async function volcRequest(text, instructions) {
  const body = {
    req_params: {
      text,
      speaker: cfg.ttsVoice,
      audio_params: { format: 'mp3' },   // 流式块拼出来的 wav 头里 RIFF 尺寸是占位符，mp3 帧格式没这隐患
      ...(instructions.length ? { context_texts: instructions } : {}),   // 语音指令：2.0 音色专属，不计费
    },
  };
  let r;
  try {
    r = await fetch(cfg.ttsUrl, {
      method: 'POST',
      headers: {
        'X-Api-Key': cfg.ttsKey,
        'X-Api-Resource-Id': cfg.ttsModel || 'seed-tts-2.0',   // 豆包模式下 ttsModel 存的是资源 ID
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? '语音合成超时（超过 2 分钟）' : `连不上 TTS 接口：${e.message}`);
  }

  const raw = await r.text();
  if (!r.ok && !raw) throw new Error(`语音合成失败（HTTP ${r.status}）`);
  // 出错时响应是普通 JSON；流式成功时是拼接 JSON 块——统一走切块解析
  const objs = splitJsonObjects(raw);
  const chunks = [];
  for (const o of objs) {
    let j;
    try { j = JSON.parse(o); } catch { continue; }
    const code = Number(j.code ?? 0);
    if (code === 20000000) continue;   // 流结束信号（实测 body：code 非 0 但 message=OK、data=null——文档说「非 0 即失败」是骗人的，以实测为准）
    if (code !== 0) {
      const msg = String(j.message ?? `错误码 ${j.code}`);
      if (/安全|审核|moderation|sensitive/i.test(msg)) {
        throw new Error('⛔ 这段话被 TTS 服务的安全审核拦了——念不了，换个说法试试吧');
      }
      if (/quota|额度|余额|欠费|没钱/i.test(msg)) {
        throw new Error('⛔ TTS API 没钱了——等指挥官去控制台处理，别再试了');
      }
      throw new Error(`语音合成失败：${msg.slice(0, 120)}`);
    }
    if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
  }
  if (!chunks.length) {
    // 兜底：整个响应体就是一段普通错误 JSON（HTTP 非 2xx 也可能到这里）
    let j = {};
    try { j = JSON.parse(raw); } catch { /* 保持空 */ }
    const msg = String(j.message ?? j.msg ?? raw.slice(0, 120) ?? '');
    if (r.status === 401) throw new Error('TTS API Key 无效（401）');
    throw new Error(`语音合成失败（HTTP ${r.status}）：${msg.slice(0, 120)}`);
  }
  return Buffer.concat(chunks);
}

/** 底层请求（MiMo chat/completions 形态）：429 限流重试带 attempt 封顶（坑 36）；
 *  欠费/审核按 body 内容当场明报不重试（坑 37）。
 *  ep（可选）：唱歌借道时换端点/Key（豆包占走主 ttsUrl/ttsKey 之后的专用一对）。 */
async function ttsRequest(body, ep = {}) {
  const url = ep.url || cfg.ttsUrl;
  const key = ep.key || cfg.ttsKey;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'api-key': key,   // MiMo 官方端点用 api-key 头（不是 Bearer）
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? '语音合成超时（超过 2 分钟）' : `连不上 TTS 接口：${e.message}`);
    }

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const msg = String(j.error?.message ?? j.error ?? `HTTP ${r.status}`);
      if (/安全策略|合规|审核|moderation/i.test(msg)) {
        throw new Error('⛔ 这段话被 TTS 服务的安全审核拦了——念不了，换个说法试试吧');
      }
      if (r.status === 401) throw new Error('TTS API Key 无效（401）');
      if (/QUOTA|额度|余额不足|欠费|没钱/i.test(msg)) {
        throw new Error('⛔ TTS API 没钱了——等指挥官去控制台处理，别再试了');
      }
      if (r.status === 429) {
        if (attempt < 3) {
          const wait = Math.min(Number(r.headers.get('retry-after')) || 15, 60);
          console.log(`[bot] TTS 被限流（429），等 ${wait}s 重试（第 ${attempt}/2 次重试）`);
          await new Promise((res) => setTimeout(res, wait * 1000));
          continue;
        }
        throw new Error('TTS 被限流了（重试 2 次都不行）——过几分钟再试一次');
      }
      throw new Error(`语音合成失败（HTTP ${r.status}）：${msg.slice(0, 120)}`);
    }

    const b64 = j.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error('TTS 返回里没有音频数据');
    return Buffer.from(b64, 'base64');
  }
  return null;   // 走不到：循环里要么 return 要么 throw
}

/** 把一段文本合成为语音，返回音频 Buffer（mp3；OneBot record 段交给 SnowLuma 的 ffmpeg 转）。失败抛 Error（消息直接给群里看）。
 *  tone（可选）：本轮的动态语气描述——MiMo voicedesign 拼进音色描述；豆包模式并进语音指令。
 *  upstream（可选）：触发这条语音的那句用户原话——豆包「引用上文」用法（context_texts 里
 *  引用而不合成，模型自动承接语境情绪，10-27 官方文档查证）。
 *  ⚠️ 官方口径：context_texts 数组只第一个元素生效——底色/动态语气/上文必须拼成一条，分两条第二条会被静默丢弃。 */
export async function generateSpeech(text, tone = '', upstream = '') {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('没给要念的文本');
  if (t.length > 800) throw new Error('要念的文本太长了（上限 800 字）');

  if (isVolc()) {
    const ctx = String(cfg.ttsVoiceDesign).trim()
      + (tone ? `这一次的语气：${String(tone).trim().slice(0, 80)}。` : '')
      + (upstream ? `说话的语境：对方刚说：「${String(upstream).trim().slice(0, 120)}」。` : '');
    return volcRequest(t, [ctx]);
  }

  // 底色在前保住「柴郡是谁」，动态语气在后只改这次的情绪/语速
  const voiceDesign = tone
    ? `${cfg.ttsVoiceDesign}这一次的语气：${String(tone).trim().slice(0, 80)}。`
    : cfg.ttsVoiceDesign;

  return ttsRequest({
    model: cfg.ttsModel,
    messages: [
      { role: 'user', content: voiceDesign },
      { role: 'assistant', content: t },
    ],
    audio: { format: 'wav' },
  });
}

/** 唱一段歌词，返回 wav Buffer。唱歌是 mimo-v2.5-tts（预置音色）专属能力，
 *  嗓子是预置音色（ttsSingVoice，非柴郡捏音——官方互斥设计，没法两全）。
 *  说话切到豆包后（ttsUrl 指向 bytedance），唱歌仍借道 MiMo：
 *  用独立的 ttsSingUrl / ttsSingKey，不再共用被豆包占走的 ttsUrl/ttsKey。
 *  style（可选）：演唱风格指令（「欢快地唱」「悲伤地唱」…），走 user 消息。 */
export async function generateSong(lyrics, style = '') {
  const l = String(lyrics ?? '').trim();
  if (!l) throw new Error('没给要唱的歌词');
  if (l.length > 600) throw new Error('歌词太长了（上限 600 字）');
  // 说话切到豆包时唱歌借道 MiMo；Key 没配就如实报（唱歌是 MiMo 专属能力）
  const singUrl = isVolc() && cfg.ttsSingUrl ? cfg.ttsSingUrl : cfg.ttsUrl;
  const singKey = isVolc() && cfg.ttsSingKey ? cfg.ttsSingKey : cfg.ttsKey;
  if (isVolc() && (!cfg.ttsSingKey || /在这里填/.test(String(cfg.ttsSingKey)))) {
    throw new Error('唱歌还差 MiMo 的 Key（ttsSingKey 没配）——唱歌是 MiMo 专属能力喵');
  }
  // (唱歌) 标签必须在目标文本最开头；歌词中文效果最好（官方口径）
  return ttsRequest({
    model: cfg.ttsSingModel,
    messages: [
      { role: 'user', content: style ? `演唱风格：${String(style).trim().slice(0, 60)}` : '投入地唱' },
      { role: 'assistant', content: `(唱歌)${l}` },
    ],
    audio: { format: 'wav', voice: cfg.ttsSingVoice },
  }, { url: singUrl, key: singKey });
}
