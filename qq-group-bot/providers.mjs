// ═══════════════════════════════════════════════════════════════════════
//  服务商探测 —— 给「#接口 / #切换」用
//
//  职责：
//    1. 把指挥官粘进来的地址补成真正的 chat/completions 端点
//       （官网控制台页面地址也认，会映射到对应 API）
//    2. 拉模型列表（GET .../models）
//    3. 用一个极小请求验证「URL + Key + 模型」能不能跑通
//
//  独立成文件是为了能脱离 QQ 单测：`bun run providers.mjs <url> <key>`
// ═══════════════════════════════════════════════════════════════════════

/** 官网控制台页面不是 API 地址，按域名映射到真正的端点 */
const PRESETS = [
  [/^https?:\/\/(?:www\.)?opencode\.ai\/console\//i, 'https://opencode.ai/zen/go/v1/chat/completions'],
  [/^https?:\/\/(?:www\.)?commandcode\.ai\/(?:console|provider)/i, 'https://api.commandcode.ai/provider/v1/chat/completions'],
];

/** 补成 chat/completions 端点 */
export function normalizeChatUrl(raw) {
  let s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('没给 URL');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  for (const [re, url] of PRESETS) if (re.test(s)) return url;
  if (/\/chat\/completions$/i.test(s)) return s;
  if (/\/v1$/i.test(s)) return s + '/chat/completions';
  return s + '/v1/chat/completions';
}

/** chat 端点 -> 模型列表端点 */
export function modelsUrlOf(chatUrl) {
  const s = String(chatUrl).replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(s) ? s.replace(/\/chat\/completions$/i, '/models') : s + '/models';
}

/** 日志/群里展示用：只露头尾，别把整把钥匙贴出去 */
export function maskKey(k) {
  if (!k) return '（空）';
  return k.length <= 12 ? `${k.slice(0, 3)}…` : `${k.slice(0, 8)}…${k.slice(-4)}`;
}

/**
 * 解析自定义请求头。支持三种写法，混着写也行：
 *   X-Title: My Bot       （冒号，最常用）
 *   X-Title=My Bot        （等号）
 *   多行 / 逗号 / 分号分隔
 * 返回对象；格式不对直接抛错（宁可报错，别静默丢头）。
 */
export function parseHeaders(raw) {
  const out = {};
  for (const line of String(raw ?? '').split(/[\n\r,;]+/)) {
    const s = line.trim();
    if (!s) continue;
    let i = s.indexOf(':');
    if (i < 1) i = s.indexOf('=');
    if (i < 1) throw new Error(`请求头格式不对：${s}（要 Name: Value）`);
    const name = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim();
    if (!name) throw new Error(`请求头缺名字：${s}`);
    out[name] = value;
  }
  return out;
}

/** 把自定义头拼进去（放最后 —— 允许它覆盖默认头，有些服务商要自定义鉴权头） */
function withExtra(base, extra) {
  return { ...base, ...(extra ?? {}) };
}

/** 拉模型列表，返回模型 ID 数组 */
export async function fetchModels(chatUrl, key, extraHeaders) {
  const url = modelsUrlOf(chatUrl);
  const r = await fetch(url, {
    headers: withExtra({
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
      'User-Agent': 'qq-group-bot/1.0',
    }, extraHeaders),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`拉模型列表失败 HTTP ${r.status}：${txt.slice(0, 140)}`);
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error('模型列表不是 JSON —— URL 大概填成网页地址了');
  }
  const ids = (j.data ?? j.models ?? [])
    .map((m) => (typeof m === 'string' ? m : m.id ?? m.name))
    .filter(Boolean);
  if (!ids.length) throw new Error('列表是空的，检查 URL / Key 是否配对');
  return ids;
}

/** 极小请求验证一组配置；HTTP 非 2xx 或带 error 就抛错 */
export async function probeModel(chatUrl, key, model, extraHeaders) {
  const r = await fetch(chatUrl, {
    method: 'POST',
    headers: withExtra({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'qq-group-bot/1.0',
      'x-opencode-session': 'probe-switch',
    }, extraHeaders),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    }),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON 就看原文 */ }
  if (!r.ok || j?.error) {
    throw new Error(`HTTP ${r.status} ${JSON.stringify(j?.error ?? txt).slice(0, 140)}`);
  }
  return j?.choices?.[0]?.message ?? {};
}

// ── 命令行自测：bun run providers.mjs <url> <key> [model] [headers] ──
if (import.meta.main) {
  const [url, key, model, hdrs] = process.argv.slice(2);
  if (!url || !key) {
    console.log('用法：bun run providers.mjs <url> <key> [model] ["X-A: 1, X-B: 2"]');
    process.exit(1);
  }
  const chatUrl = normalizeChatUrl(url);
  const extra = parseHeaders(hdrs);
  console.log('chat  :', chatUrl);
  console.log('models:', modelsUrlOf(chatUrl));
  if (Object.keys(extra).length) console.log('headers:', JSON.stringify(extra));
  const ids = await fetchModels(chatUrl, key, extra);
  console.log(`拉到 ${ids.length} 个模型：`, ids.slice(0, 10).join(', '), ids.length > 10 ? '…' : '');
  const m = model ?? ids[0];
  const msg = await probeModel(chatUrl, key, m, extra);
  console.log(`验证 ${m} 通过，返回：`, JSON.stringify(msg.content ?? msg.reasoning_content ?? '').slice(0, 80));
}
