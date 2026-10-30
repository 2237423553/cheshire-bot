// ═══════════════════════════════════════════════════════════════════════
//  文生图客户端 —— 走 sui-xiang.net 中转（OpenAI 兼容 /v1/images/generations）
//
//  实测（2026-10-20）：
//  - gpt-image-2 返回 b64_json（PNG，1024x1024 约 2~3MB），没有 url 字段
//  - 中转的安全审核很敏感：「a cute cartoon cat」都能被 400 拦下，
//    「golden sunset over calm ocean」正常。被拦时要如实告诉指挥官是审核拦了
//  - 生成要等十几秒到一分钟，超时给足
// ═══════════════════════════════════════════════════════════════════════
import { cfg } from './config.mjs';
import { classifyUpstreamError } from './providers.mjs';

const TIMEOUT = 180 * 1000;   // 实测冷启动能到一分钟以上，宁可贵等也不要误报

/** 画一张图，返回 PNG Buffer。失败抛 Error（消息直接给模型/群里看）。
 *  外壳只做参数校验；真正的抓取在内层（429 限流时内层自己等一把重试，最多重试 3 次）。 */
export async function generateImage(prompt) {
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('没给画面描述');
  return generateImageInner(p, 0);
}

async function generateImageInner(prompt, attempt) {
  if (attempt >= 4) throw new Error('生图被限流了（429 重试 3 次都不行），中转在限流高峰——过几分钟再试一次');
  let r;
  try {
    r = await fetch(cfg.imggenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.imggenKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.imggenModel,
        prompt,
        // 两套参数体系按模型分家：
        //   gpt-image 系：size（如 1024x1024）+ quality（low/medium/high）
        //   xAI Grok 系：aspect_ratio + resolution(1k/2k) + quality
        //   ⚠️ Grok 的 quality 不传 = auto = 生成走 low 最低档（官方文档实测口径），
        //      档位上限就是 medium —— 所以必须显式传，指挥官按张收费拉满档。
        ...(String(cfg.imggenModel).includes('grok-imagine')
          ? {
              aspect_ratio: cfg.imggenAspectRatio || 'auto',
              resolution: cfg.imggenResolution || '2k',
              quality: cfg.imggenQuality || 'medium',
            }
          : { size: cfg.imggenSize, quality: cfg.imggenQuality || undefined }),
        response_format: 'b64_json',
        n: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    // TimeoutError/AbortError 异名同源（不同运行时叫法不同），都按超时翻成人话
    throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? '生图超时（超过 3 分钟）' : `连不上生图接口：${e.message}`);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    // 统一走分类器（10-30 评审：审核/欠费正则 5 处漂移，现在只此一张表；连 error.code 也认）
    const kind = classifyUpstreamError(r.status, j.error ?? undefined);
    const msg = String(j.error?.message ?? j.error ?? `HTTP ${r.status}`);
    if (kind === 'moderation') {
      // 审核=当场拒绝、不重试（重试也没用），翻译成人话如实转告
      throw new Error('⛔ 这张图被生图服务的安全审核拒绝了（它审核很严，正常内容也可能误拒）——画不了，换个描述试试吧');
    }
    if (kind === 'key') throw new Error('生图 API Key 无效（401）');
    // 中转把「没钱」也用 429 包着发——认出来当场明报，不重试
    if (kind === 'quota') {
      throw new Error('⛔ 生图 API 没钱了（额度用完）——等指挥官去控制台充值或调限额，别再试了');
    }
    // 429 = 中转限流（今天连画几张很容易撞上）。有 Retry-After 就等一把重试一次，
    // 还不行就明说「限流了等几分钟」，别让群里以为机器人坏了
    if (kind === 'rate') {
      const wait = Math.min(Number(r.headers.get('retry-after')) || 30, 90);
      console.log(`[bot] 生图被限流（429），等 ${wait}s 重试（第 ${attempt + 1}/3 次重试）`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      return generateImageInner(prompt, attempt + 1);
    }
    throw new Error(`生图失败（HTTP ${r.status}）：${msg.slice(0, 120)}`);
  }

  const d = Array.isArray(j.data) ? j.data[0] ?? {} : {};
  if (d.b64_json) {
    const buf = Buffer.from(d.b64_json, 'base64');
    if (!buf.length) throw new Error('生图接口返回了空图片');
    return buf;
  }
  if (d.url) {
    // 兼容返回 url 的模型：现下一把，拿不到就算了
    const ir = await fetch(d.url, { signal: AbortSignal.timeout(60 * 1000) });
    if (!ir.ok) throw new Error(`图片下载失败（HTTP ${ir.status}）`);
    return Buffer.from(await ir.arrayBuffer());
  }
  throw new Error('生图接口返回里既没有 b64_json 也没有 url，可能改版了');
}
