// ═══════════════════════════════════════════════════════════════════════
//  B站视频理解 —— 直链直传 MiMo（2026-10-20 实测打通）
//
//  链路：BV号/b23.tv 短链
//        → view API 拿标题/分P/cid（免登录）
//        → playurl API（platform=html5）拿「音画合一 mp4 直链」（免登录 720P 封顶）
//        → video_url 直传模型看片（实测直链不校验 Referer，模型服务器裸拉 206）
//
//  约束备忘：
//    · 直链带 upsig 签名 + deadline，几小时过期 → 现取现喂，绝不囤链接
//    · 720P 码率 ≈1.95Mbps → 300MB ≈ 20 分钟；超长走下载/字幕路线，这里管不了
//    · 会员/付费/充电视频拿不到 durl，会明着报错
//    · 720P 以上要 SESSDATA + DASH 音画分离流 —— 不做，总结场景 720P 够用
//
//  bot.mjs（群聊）和 ../bilibili-summarize.mjs（命令行）共用这套引擎。
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.mjs';

const UA_API = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
// MiMo URL 直传官方上限 300MB，留点余量防签名参数差异
const MAX_VIDEO_BYTES = 290 * 1024 * 1024;

/** 从一段文本里抠出B站视频入口：BV 号优先，其次 b23.tv 短链。没有返回 null */
export function extractBvLink(text) {
  const s = String(text ?? '');
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return bv[0];
  const short = s.match(/https?:\/\/b23\.tv\/[0-9A-Za-z]+/i);
  return short ? short[0] : null;
}

function pageOf(url) {
  const m = String(url).match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

/** 输入归一成 BV 号（b23.tv 短链要跟一次重定向） */
export async function resolveBV(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('没给链接或 BV 号');

  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0], page: pageOf(s) };

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const r = await fetch(s, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': UA_API },
    signal: AbortSignal.timeout(30_000),
  });
  const finalUrl = r.url ?? '';
  const bv2 = finalUrl.match(/BV[0-9A-Za-z]{10}/);
  if (!bv2) throw new Error(`短链没解析出 BV 号（最终落到：${finalUrl.slice(0, 120)}）`);
  return { bvid: bv2[0], page: pageOf(s) || pageOf(finalUrl) };
}

/** view API 拿标题 / 分P / cid */
export async function fetchView(bvid) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { 'User-Agent': UA_API },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`view API 失败 code=${j.code}：${j.message}`);
  const d = j.data;
  return {
    title: d.title,
    desc: d.desc ?? '',
    duration: d.duration ?? 0,
    owner: d.owner?.name ?? '未知UP主',
    pages: (d.pages ?? []).map((p) => ({ cid: p.cid, part: p.part, duration: p.duration })),
  };
}

/** playurl API 拿音画合一 mp4 直链；720P 超限自动降 360P */
export async function fetchDirectUrl(bvid, cid, log = () => {}) {
  for (const qn of [64, 16]) {
    const u = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&platform=html5&high_quality=1`;
    const r = await fetch(u, {
      headers: { 'User-Agent': UA_API, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`playurl API 失败 code=${j.code}：${j.message}`);
    const durl = j.data?.durl?.[0];
    if (!durl?.url) throw new Error('playurl 返回里没有 durl.url（视频可能是会员/付费/充电专属，走不通）');
    const mb = ((durl.size ?? 0) / 1024 / 1024).toFixed(1);
    if ((durl.size ?? 0) <= MAX_VIDEO_BYTES) return { url: durl.url, quality: j.data.quality, sizeMB: mb };
    log(`${qn === 64 ? '720P' : '360P'} 有 ${mb}MB，超 ${Math.floor(MAX_VIDEO_BYTES / 1048576)}MB 上限，${qn === 64 ? '降 360P 再试' : '没办法了'}`);
  }
  throw new Error('720P/360P 都超 300MB 上限 —— 视频太长，总结不了（得下载压缩或走字幕路线）');
}

/** 秒 → 「x分x秒」 */
export function fmtDur(sec) {
  sec = Math.round(sec ?? 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

async function callLLM(body) {
  const r = await fetch(cfg.llmUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.llmKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bilibili-summarize/1.0',
      'x-opencode-session': 'bilibili-summarize', // 稳定会话 ID（OpenCode 要求，坑8）
      ...(cfg.llmHeaders ?? {}),                  // 自定义头放最后，允许覆盖
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60_000), // 视频理解慢，给足 15 分钟
  });
  const j = await r.json();
  if (j.error) throw new Error(`LLM ${r.status}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j;
}

// ── 存档：总结落盘到 ../B站总结/，之后可批量进知识库。失败不影响主流程 ──
function archive(info, content, question) {
  try {
    const outDir = path.join(import.meta.dir, '..', 'B站总结');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${info.bvid}_P${info.page}.md`);
    fs.writeFileSync(
      file,
      `# ${info.title}${info.pages > 1 ? `（P${info.page}：${info.part}）` : ''}\n\n` +
      `- 链接：https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}\n` +
      `- UP主：${info.owner}｜时长：${info.durationText}\n` +
      `- 总结时间：${new Date().toLocaleString('zh-CN')}${question ? `\n- 提问：${question}` : ''}\n\n` +
      content + '\n',
      'utf8',
    );
  } catch (e) {
    console.warn('[bilibili] 存档失败（不影响总结）：', e.message);
  }
}

/**
 * 高层入口：链接/BV号 → 看片 → 总结（含存档）。
 * onStep(line) 用于进度汇报（命令行打日志 / 机器人发「正在看」的依据），可省略。
 */
export async function summarizeVideo(input, question = '', onStep = () => {}) {
  const { bvid, page } = await resolveBV(input);
  onStep(`视频 ${bvid}（P${page}）`);

  const view = await fetchView(bvid);
  const pg = view.pages[Math.min(page, view.pages.length) - 1];
  if (!pg) throw new Error(`分P ${page} 不存在（共 ${view.pages.length}P）`);
  onStep(`《${view.title}》 UP主：${view.owner} | ${fmtDur(pg.duration)} | 共${view.pages.length}P`);

  const prompt =
    `这是一个B站视频：《${view.title}》（UP主：${view.owner}，时长 ${fmtDur(pg.duration)}）。\n` +
    `请完整观看视频后，${question ? `回答这个问题：${question}` : '给我一份总结，格式如下：\n' +
      '## 一句话概括\n## 内容要点（分点，教程类按步骤列出）\n## 值得注意的细节\n## 结论/建议'}\n` +
    `用中文回答。`;

  // ⚠️ 偶发坑（2026-10-20 群内首秀踩到）：服务端偶尔拉不动直链，此时 API 照样 200、
  // 照样计费两万 tok，模型却「装看不见」回一段「无法访问外部视频」——不报错就是黑洞。
  // 对策：识别这种拒答，重新取直链（新签名新节点）再喂，最多 3 次；仍不行就明着报错。
  const REFUSAL_RE = /无法(直接)?(访问|观看|查看|处理)|不能(直接)?(观看|访问|处理)(外部)?(视频|链接)|无法观看/i;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { url: directUrl, quality, sizeMB } = await fetchDirectUrl(bvid, pg.cid, (m) => onStep(m));
    onStep(`直链到手：${quality}P / ${sizeMB}MB（第 ${attempt} 次，签名链接现取现喂）`);

    const j = await callLLM({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            // 与 bot.mjs 视频同款参数：URL 直传 + MiMo 精细度
            { type: 'video_url', video_url: { url: directUrl }, fps: 2, media_resolution: 'default' },
          ],
        },
      ],
      thinking: cfg.thinking, // MiMo「自动」档，实测 200 接受
    });

    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new Error(`LLM 没返回正文：${JSON.stringify(j).slice(0, 300)}`);

    if (!REFUSAL_RE.test(content)) {
      const info = {
        bvid, page,
        title: view.title, owner: view.owner, part: pg.part || `P${page}`,
        durationText: fmtDur(pg.duration), pages: view.pages.length,
        quality, sizeMB, attempt,
      };
      archive(info, content, question);
      return { ...info, summary: content, usage: j.usage ?? null };
    }
    if (attempt < 3) onStep('模型说看不到视频（服务端拉直链失败？），重取直链再试…');
  }
  throw new Error('模型连看 3 次都说看不到视频（服务端拉直链一直失败），稍后再发一次试试喵');
}
