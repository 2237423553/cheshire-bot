// ═══════════════════════════════════════════════════════════════════════
//  文生视频客户端 —— 随想 Grok 通道（grok-imagine-video，只支持文生）
//
//  实测（2026-10-21）：
//  - 提交 POST /v1/videos/generations → 立刻返回 { request_id }（异步任务制）
//  - 轮询 GET /v1/videos/<request_id> → { status: pending/done, progress }
//  - 完成后视频在 GET /v1/videos/<request_id>/content（mp4，8s 约 5.5MB）
//  - 注意：grok-imagine-video 只支持文生；grok-imagine-video-1.5 只支持图生（勿混）
//  - 生成是分钟级（实测几十秒到几分钟），轮询上限给足
// ═══════════════════════════════════════════════════════════════════════
import { cfg } from './config.mjs';

const SUBMIT_PATH = '/v1/videos/generations';
const POLL_INTERVAL = 5000;
const POLL_MAX = 8 * 60 * 1000;   // 8 分钟封顶，超了明报失败

function baseOf() {
  // vidgenUrl 填完整提交端点；轮询/下载地址由它反推
  return cfg.vidgenUrl.replace(/\/v1\/videos\/generations.*$/, '');
}

function authHeaders() {
  return {
    'Authorization': `Bearer ${cfg.vidgenKey}`,
    'Content-Type': 'application/json',
  };
}

/** 画一段视频，返回 mp4 Buffer。失败抛 Error（消息给群里看）。
 *  imageDataUrl 有值 = 图生视频（1.5 看家本领）：实测 image_url 填 data URL 字符串即可 */
export async function generateVideo(prompt, imageDataUrl = '') {
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('没给画面描述');

  // ① 提交任务（502/503/504 是中转侧网络波动，重试 2 次；审核/401 是终局错误不重试）
  let rid;
  let lastErr = '';
  for (let attempt = 0; attempt < 3 && !rid; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 3000));
    try {
      const r = await fetch(cfg.vidgenUrl, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          model: cfg.vidgenModel,
          prompt: p,
          n: 1,
          ...(imageDataUrl ? { image_url: imageDataUrl } : {}),
        }),
        signal: AbortSignal.timeout(60 * 1000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const msg = String(j.error?.message ?? j.error ?? `HTTP ${r.status}`);
        if (/安全策略|合规|moderation/i.test(msg)) {
          throw new Error('画面描述被生视频服务的安全审核拦截了——如实告诉指挥官生成不了，换个描述试试');
        }
        if (r.status === 401) throw new Error('生视频 API Key 无效（401）');
        if (r.status === 429) throw new Error('生视频被限流（429），稍后再试');
        if ([502, 503, 504].includes(r.status)) { lastErr = `HTTP ${r.status}`; continue; }
        throw new Error(`提交生视频任务失败（HTTP ${r.status}）：${msg.slice(0, 120)}`);
      }
      rid = j.request_id;
    } catch (e) {
      // 终局错误（审核/401/429/其它明确报错）直接抛；瞬时问题记下最后一搏
      if (e.name === 'TimeoutError') { lastErr = '提交超时'; continue; }
      throw e;
    }
  }
  if (!rid) throw new Error(`提交生视频任务失败（重试 3 次都不行：${lastErr}）——稍后再试`);
  if (!rid) throw new Error('生视频接口没返回 request_id，可能改版了');
  console.log(`[bot] 🎬 生视频任务已提交：${rid}`);

  // ② 轮询到出片
  const deadline = Date.now() + POLL_MAX;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
    let j;
    try {
      const r = await fetch(baseOf() + `/v1/videos/${rid}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30 * 1000),
      });
      j = await r.json().catch(() => ({}));
    } catch {
      continue;   // 单次轮询失败不放弃，下一轮再试
    }
    if (j.status === 'done') {
      // 指挥官限额：成片最长 15 秒（2026-10-21 加）。超限就弃用不发（费用照扣，但绝不让超长片进群）
      const dur = Number(j.video?.duration ?? 0);
      const maxSec = cfg.vidgenMaxSeconds ?? 15;
      if (dur > maxSec) {
        throw new Error(`这次生成了 ${dur}s，超过上限 ${maxSec}s，已弃用不发送`);
      }
      // ③ 下载成片（站内相对路径）
      const url = j.video?.url ?? `/v1/videos/${rid}/content`;
      const dr = await fetch(baseOf() + url, {
        headers: { 'Authorization': `Bearer ${cfg.vidgenKey}` },
        signal: AbortSignal.timeout(120 * 1000),
      });
      if (!dr.ok) throw new Error(`视频下载失败（HTTP ${dr.status}）`);
      const buf = Buffer.from(await dr.arrayBuffer());
      if (!buf.length) throw new Error('视频下载到 0 字节');
      return buf;
    }
    if (j.status && j.status !== 'pending' && j.status !== 'done') {
      throw new Error(`生视频任务失败：${String(j.error?.message ?? j.status).slice(0, 120)}`);
    }
  }
  throw new Error('生视频超时（等了 8 分钟还没出片），稍后再试');
}
