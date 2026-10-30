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
import { classifyUpstreamError } from './providers.mjs';

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
        const kind = classifyUpstreamError(r.status, j.error ?? undefined);
        if (kind === 'moderation') {
          // 审核=当场拒绝，不重试（重试也没用）
          throw new Error('⛔ 这个描述被生视频服务的安全审核拒绝了——生成不了，换个描述试试吧');
        }
        if (kind === 'key') throw new Error('生视频 API Key 无效（401）');
        // 中转把「没钱」也用 429 包着发——认出来当场明报，不重试
        if (kind === 'quota') {
          throw new Error('⛔ 生视频 API 没钱了（额度用完）——等指挥官去控制台充值或调限额，别再试了');
        }
        if (r.status === 429) throw new Error('生视频被限流（429），稍后再试');
        if ([502, 503, 504].includes(r.status)) { lastErr = `HTTP ${r.status}`; continue; }
        throw new Error(`提交生视频任务失败（HTTP ${r.status}）：${msg.slice(0, 120)}`);
      }
      rid = j.request_id;
      // 10-30 评审：ok 但拿不到 request_id（响应体解析失败 / 接口改版）**立刻抛**，
      // 不能当瞬时错误重试 —— 首次提交可能已被受理，原样再提一单就是双倍计费
      if (!rid) throw new Error('生视频接口没返回 request_id，可能改版了');
    } catch (e) {
      // 终局错误（审核/401/429/改版/其它明确报错）直接抛；瞬时问题记下最后一搏
      if ((e.name === 'TimeoutError' || e.name === 'AbortError')) { lastErr = '提交超时'; continue; }
      throw e;
    }
  }
  if (!rid) throw new Error(`提交生视频任务失败（重试 3 次都不行：${lastErr}）——稍后再试`);
  console.log(`[bot] 🎬 生视频任务已提交：${rid}`);

  // ② 轮询到出片（间隔递增 5s→×1.5 封顶 15s：几十秒内的小任务保证响应速度，
  // 后面每把多半只带回同一个 progress，白转 96 次没必要）
  const deadline = Date.now() + POLL_MAX;
  let interval = POLL_INTERVAL;
  let notFound = 0;   // 连续 404 计数：任务在服务端被清了就别再傻等
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, interval));
    interval = Math.min(interval * 1.5, 15000);
    let j = null, ok = false, status = 0;
    try {
      const r = await fetch(baseOf() + `/v1/videos/${rid}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(30 * 1000),
      });
      ok = r.ok; status = r.status;
      j = await r.json().catch(() => null);
    } catch {
      continue;   // 单次轮询失败不放弃，下一轮再试
    }
    // 10-30 评审：轮询也要看状态 —— 失效任务不再白转满 8 分钟报误导性「超时」
    if (status === 404) {
      if (++notFound >= 2) throw new Error('生视频任务已不存在（任务可能被服务端清掉或超时清理）——重新生成一次吧');
      continue;   // 单次 404 容忍一把（中转偶发抖动）
    }
    if (!ok || j?.error) {
      const msg = String(j?.error?.message ?? j?.error ?? `HTTP ${status}`);
      const kind = classifyUpstreamError(status, j?.error ?? undefined);
      if (kind === 'moderation') {
        throw new Error('⛔ 这个描述被生视频服务的安全审核拒绝了——生成不了，换个描述试试吧');
      }
      if (kind === 'quota') {
        throw new Error('⛔ 生视频 API 没钱了（额度用完）——等指挥官去控制台充值或调限额，别再试了');
      }
      if (j?.error) throw new Error(`生视频任务失败：${msg.slice(0, 120)}`);
      continue;   // 轮询侧非 2xx（401/429/5xx）但没带 error 体：真挂账下次再试一把，下一轮继续
    }
    if (j.status === 'done') {
      // 指挥官限额：成片最长 15 秒（2026-10-21 加）。超限就弃用不发（费用照扣，但绝不让超长片进群）
      const dur = Number(j.video?.duration ?? 0);
      const maxSec = cfg.vidgenMaxSeconds ?? 15;
      if (dur > maxSec) {
        throw new Error(`这次生成了 ${dur}s，超过上限 ${maxSec}s，已弃用不发送`);
      }
      // ③ 下载成片（站内相对路径）。任务已 done、费用已扣，下载失败绝不直接放弃：
      // 429/5xx/超时都重试（中转实测会在下载这步限流），最多 4 把
      const url = j.video?.url ?? `/v1/videos/${rid}/content`;
      // 成片地址可能是站内相对路径，也可能返回绝对 URL——字符串硬拼会把绝对地址拼坏
      //（10-24 评审）。绝对的原样用，相对的才挂 baseOf()
      const dlUrl = /^https?:\/\//i.test(url) ? url : baseOf() + url;
      let buf = null;
      let dlErr = '';
      let drHeaders = {};   // 上一把下载响应的头（取 Retry-After 用）
      for (let d = 0; d < 4 && !buf; d++) {
        if (d > 0) {
          // 有 Retry-After 就按它等，没有就固定歇 10s
          const wait = Math.min(Number(drHeaders['retry-after'] ?? 0) * 1000 || 10000, 60000);
          console.log(`[bot] 🎬 视频下载失败（${dlErr}），${Math.round(wait / 1000)}s 后重试（第 ${d}/3 次）`);
          await new Promise((res) => setTimeout(res, wait));
        }
        try {
          const dr = await fetch(dlUrl, {
            headers: { 'Authorization': `Bearer ${cfg.vidgenKey}` },
            signal: AbortSignal.timeout(120 * 1000),
          });
          drHeaders = dr.headers;
          if (!dr.ok) { dlErr = `HTTP ${dr.status}`; continue; }
          const b = Buffer.from(await dr.arrayBuffer());
          if (!b.length) { dlErr = '下载到 0 字节'; continue; }
          buf = b;
        } catch (e) {
          dlErr = (e.name === 'TimeoutError' || e.name === 'AbortError') ? '下载超时' : String(e.message ?? e).slice(0, 80);
        }
      }
      drHeaders = {};
      if (!buf) throw new Error(`视频下载失败（重试 3 次都不行：${dlErr}）——成片还在服务器上，稍后让柴郡重发或换个说法再生成一次`);
      return buf;
    }
    // 状态白名单化（10-30 评审）：done 已在上方处理；检测到明确失败态才抛；
    // [pending]/running/processing/queued 乃至服务商自造的其它「还在跑」词一律继续等
    // ——旧版非 pending/done 一律当失败抛，会误杀正在跑的正常任务
    if (j.status && /fail|error|cancel|reject/i.test(String(j.status))) {
      throw new Error(`生视频任务失败：${String(j.error?.message ?? j.status).slice(0, 120)}`);
    }
  }
  throw new Error('生视频超时（等了 8 分钟还没出片），稍后再试');
}
