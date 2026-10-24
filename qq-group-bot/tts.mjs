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

/** 底层请求：429 限流重试带 attempt 封顶（坑 36）；欠费/审核按 body 内容当场明报不重试（坑 37）。 */
async function ttsRequest(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await fetch(cfg.ttsUrl, {
        method: 'POST',
        headers: {
          'api-key': cfg.ttsKey,   // MiMo 官方端点用 api-key 头（不是 Bearer）
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

/** 把一段文本合成为语音，返回 wav Buffer。失败抛 Error（消息直接给群里看）。
 *  tone（可选）：本轮的动态语气描述，会拼到音色描述后面——voicedesign 就是靠描述捏
 *  声线的，描述里带情绪/语速变化，每条语音的语气才不会一个模子（10-23 指挥官要求）。 */
export async function generateSpeech(text, tone = '') {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('没给要念的文本');
  if (t.length > 800) throw new Error('要念的文本太长了（上限 800 字）');
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
 *  style（可选）：演唱风格指令（「欢快地唱」「悲伤地唱」…），走 user 消息。 */
export async function generateSong(lyrics, style = '') {
  const l = String(lyrics ?? '').trim();
  if (!l) throw new Error('没给要唱的歌词');
  if (l.length > 600) throw new Error('歌词太长了（上限 600 字）');
  // (唱歌) 标签必须在目标文本最开头；歌词中文效果最好（官方口径）
  return ttsRequest({
    model: cfg.ttsSingModel,
    messages: [
      { role: 'user', content: style ? `演唱风格：${String(style).trim().slice(0, 60)}` : '投入地唱' },
      { role: 'assistant', content: `(唱歌)${l}` },
    ],
    audio: { format: 'wav', voice: cfg.ttsSingVoice },
  });
}
