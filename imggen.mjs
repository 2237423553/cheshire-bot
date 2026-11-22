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

/** 显式启用的 OpenAI multipart 编辑协议。绝不推测 URL/能力、不降级、不自动转文生图。
 * 429 限流按「先重试后认命」教义等一把再试（11-19 实锤：11-17 首次编辑的 429 就是瞬时的，
 * 当场认输会让群里白吃一次失败提示）。其余错误仍当场明报。
 * options 仅用于离线 mock 注入；运行时默认使用 cfg/fetch。prompt 不做 trim/改写。 */
export async function editImage(prompt, image, { config = cfg, fetchImpl = fetch } = {}) {
  if (!config.imggenEditUrl || config.imggenEditProtocol !== 'openai-multipart') {
    throw new Error('图生图尚未启用：需确认服务商支持编辑协议，并配置 imggenEditUrl 和 imggenEditProtocol=openai-multipart；不会转文生图');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('缺少本轮改图文字');
  if (!Buffer.isBuffer(image) || !image.length) throw new Error('缺少真实参考图片');
  return editImageInner(prompt, image, 0, { config, fetchImpl });
}

async function editImageInner(prompt, image, attempt, { config, fetchImpl }) {
  // 真实字节识别格式，不把任意错误页当图片上传。
  const mime = image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : image[0] === 255 && image[1] === 216 && image[2] === 255 ? 'image/jpeg'
    : image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw new Error('参考图片仅支持 PNG、JPEG、WebP');
  const form = new FormData();
  form.set('model', config.imggenModel);
  form.set('prompt', prompt);
  form.set('image', new Blob([image], { type: mime }), 'reference.' + mime.split('/')[1]);
  form.set('n', '1');
  if (config.imggenQuality) form.set('quality', config.imggenQuality);
  if (config.imggenSize) form.set('size', config.imggenSize);
  const r = await fetchImpl(config.imggenEditUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${config.imggenKey}` },
    body: form, signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || j.code) {
    const kind = classifyUpstreamError(r.status, j.error ?? j);
    if (kind === 'quota') throw new Error('图生图 API 额度已用完，请充值或调整 Key 限额；未转文生图');
    if (kind === 'moderation') throw new Error('图生图被服务商安全审核拒绝；用户原文未修改，未自动重试');
    if (kind === 'key') throw new Error('图生图 API Key 无效或无权限');
    // 429 先重试后认命：Retry-After 给多久等多久（封顶 90s），最多 2 把重试
    if (kind === 'rate') {
      if (attempt >= 2) throw new Error('图生图接口限流（429 重试 2 次都不行），中转在限流高峰——过几分钟再试');
      const wait = Math.min(Number(r.headers.get('retry-after')) || 30, 90);
      console.warn(`[bot] 图生图限流（429），等 ${wait}s 重试（第 ${attempt + 1}/2 次）`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      return editImageInner(prompt, image, attempt + 1, { config, fetchImpl });
    }
    throw new Error(`图生图编辑接口失败（HTTP ${r.status}），请检查编辑协议/权限/额度；未转文生图`);
  }
  const d = j.data?.[0];
  if (d?.b64_json) {
    const output = Buffer.from(d.b64_json, 'base64');
    if (output.length) return output;
  }
  // 首版只接受 b64_json；不从不受信任的响应 URL 发起额外请求。
  throw new Error('编辑接口未返回有效 b64_json 图片，请核对服务商响应协议');
}

/** 画一张图，返回 PNG Buffer。失败抛 Error（消息直接给模型/群里看）。
 *  外壳只做参数校验；真正的抓取在内层（429 限流时内层自己等一把重试，最多重试 3 次）。 */
export async function generateImage(prompt) {
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('没给画面描述');
  return generateImageInner(p, 0);
}

async function generateImageInner(prompt, attempt, netRetry = false) {
  if (attempt >= 4) throw new Error(netRetry
    ? '连不上生图接口（中转网络抖动，重试 3 次都不行）——过几分钟再试一次喵'
    : '生图被限流了（429 重试 3 次都不行），中转在限流高峰——过几分钟再试一次');
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
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('生图超时（超过 3 分钟）');
    // 瞬时网络抖动（2026-11-06 群内实锤：中转偶发「socket connection was closed
    // unexpectedly」，现场 6 连发复测全通=掐线瞬时）——缓 3s 重试一把再认命，
    // 且绝不把 Bun 英文底层报错原样漏进群
    console.warn(`[bot] 生图接口网络抖动（${e.message}），3s 后重试（第 ${Math.min(attempt + 1, 3)}/3 次）`);
    await new Promise((res) => setTimeout(res, 3000));
    return generateImageInner(prompt, attempt + 1, true);
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
    // 404/5xx = 中转瞬时抖动（2026-11-10 群内实锤：健康端点偶发 404 Not Found，
    // 半小时后原样复测 200 出图）——按「先重试后认命」教义并入梯队，缓 3s 再来；
    // 真挂了的路径 3 把之后仍走原报错人话，不会无限锤
    if (r.status === 404 || r.status >= 500) {
      console.warn(`[bot] 生图接口 HTTP ${r.status} 瞬时抖动，3s 后重试（第 ${Math.min(attempt + 1, 3)}/3 次）`);
      await new Promise((res) => setTimeout(res, 3000));
      return generateImageInner(prompt, attempt + 1, netRetry);
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
