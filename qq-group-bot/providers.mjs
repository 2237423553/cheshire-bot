// ═══════════════════════════════════════════════════════════════════════
//  服务商探测库 —— 「切换模型.cmd / API 面板」共用的纯函数层（无 fs、无状态）
//
//  职责：
//    1. 把指挥官粘进来的地址补成真正的 chat/completions 端点
//       （官网控制台页面/常见大厂首页也认，PRESETS 映射到对应 API）
//    2. 拉模型列表（GET .../models）
//    3. 用一个极小请求验证「URL + Key + 模型」能不能跑通（probeModel）
//    4. 统一底层请求 chatOnce（四件套探测 probe-suite.mjs 也走这里）
//
//  独立成文件是为了能脱离 QQ 单测：`bun run providers.mjs <url> <key>`
// ═══════════════════════════════════════════════════════════════════════
import dns from 'node:dns';

// ── SSRF 闸（10-24 评审加固）──
// 凡是「拿别人给的 URL 去 fetch」的地方都必须过这一道：只许 http/https，
// 主机不许是环回/私网/链路本地（防群友塞 URL 打内网服务和本地面板）。
// allowHosts = 显式白名单（填主机名或 host:port），给刻意支持的本地服务豁免（如 Ollama）。

/** IP 字符串是否落在环回/私网/链路本地/CGNAT 段（IPv4 + IPv6） */
export function isPrivateIp(ip) {
  const v4 = String(ip);
  if (/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4)) return true;   // 100.64/10 CGNAT
  const v6 = v4.replace(/^\[|\]$/g, '').toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^(?:f[cd]|fe[89ab])/.test(v6);   // fc00::/7 唯一本地 / fe80::/10 链路本地
}

/** 校验不通过抛 Error（人话）；通过返回解析好的 URL 对象 */
export async function assertSafeUrl(raw, allowHosts = []) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL 格式不对'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只支持 http/https 地址（收到 ${u.protocol}）`);
  }
  const h = u.hostname.toLowerCase();
  const hp = `${h}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  if (allowHosts.includes(h) || allowHosts.includes(hp)) return u;   // 白名单豁免（本地 Ollama 等）
  if (h === 'localhost' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') ||
      /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) {
    throw new Error(`拒绝请求内网/本机地址（${u.hostname}）`);
  }
  // 域名也得查——可能解析到私网（DNS rebinding）；查不到域名就把错留给 fetch 自然报
  try {
    const addrs = await dns.promises.lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error(`域名 ${u.hostname} 解析到了内网地址，拒绝请求`);
    }
  } catch (e) {
    if (String(e?.message).includes('内网')) throw e;
  }
  return u;
}

/** 官网控制台页面不是 API 地址，按域名映射到真正的端点 */
const PRESETS = [
  [/^https?:\/\/(?:www\.)?opencode\.ai\/console\//i, 'https://opencode.ai/zen/go/v1/chat/completions'],
  [/^https?:\/\/(?:www\.)?commandcode\.ai\/(?:console|provider)/i, 'https://api.commandcode.ai/provider/v1/chat/completions'],
  // ── 2026-10-21 扩充：常见中转/大厂（粘官网首页/控制台页也能映射）──
  [/^https?:\/\/(?:www\.)?platform\.deepseek\.com/i, 'https://api.deepseek.com/v1/chat/completions'],
  [/^https?:\/\/(?:www\.)?(?:kimi\.com|platform\.moonshot\.cn)/i, 'https://api.moonshot.cn/v1/chat/completions'],
  [/^https?:\/\/(?:[a-z0-9-]+\.)*bigmodel\.cn/i, 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],   // 智谱没有 /v1（open./www. 等子域都认）
  [/^https?:\/\/(?:www\.)?siliconflow\.(?:cn|com)/i, 'https://api.siliconflow.cn/v1/chat/completions'],
  [/^https?:\/\/(?:www\.)?openrouter\.ai\/(?:keys|settings|activity)/i, 'https://openrouter.ai/api/v1/chat/completions'],  // openrouter.ai/api/v1 结尾的地址已被通用规则兜住，这里兜它的站点页
  [/^https?:\/\/(?:127\.0\.0\.1|localhost):11434/i, 'http://127.0.0.1:11434/v1/chat/completions'],     // Ollama 本地
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

/** 生图/生视频端点 -> 模型列表端点（掐掉 /images/generations、/videos/generations 再接 /models；
 *  直接套 modelsUrlOf 会拼出 .../images/generations/models 这种 404 地址） */
export function mediaModelsUrlOf(mediaUrl) {
  const s = String(mediaUrl).replace(/\/+$/, '');
  return s.replace(/\/(?:images|videos)\/generations$/i, '/models');
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

/** key 为空时别带 Authorization（Ollama 本地等服务空 key 反而会被拒） */
function authHeaders(key, extra) {
  const base = key
    ? { 'Authorization': `Bearer ${key}` }
    : {};
  return withExtra(base, extra);
}

/** 统一底层请求：拼头 + fetch + 超时 + 错误分类。探测全家桶共用这一个口。
 *  返回 { ok, status, json, txt, latencyMs }；失败（超时/网络）抛 Error。
 *  2xx 但带 error 字段不算传输失败——交给调用方按业务判定。 */
export async function chatOnce(chatUrl, key, body, extraHeaders, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45 * 1000;
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(chatUrl, {
      method: 'POST',
      headers: withExtra({
        ...authHeaders(key, {}),
        'Content-Type': 'application/json',
        'User-Agent': 'qq-group-bot/1.0',
        'x-opencode-session': opts.session ?? 'probe-suite',
      }, extraHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const err = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
      err.kind = 'timeout';
      throw err;
    }
    throw e;
  }
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* 非 JSON 交给调用方 */ }
  return { ok: r.ok, status: r.status, json, txt, latencyMs: Date.now() - t0 };
}

/** 拉模型列表，返回模型 ID 数组。第 4 参可显式指定列表端点（生图/生视频卡用 mediaModelsUrlOf） */
export async function fetchModels(chatUrl, key, extraHeaders, modelsUrl) {
  const url = modelsUrl || modelsUrlOf(chatUrl);
  const r = await fetch(url, {
    headers: withExtra({
      ...authHeaders(key, {}),
      'Accept': 'application/json',
      'User-Agent': 'qq-group-bot/1.0',
    }, extraHeaders),
    signal: AbortSignal.timeout(30 * 1000),   // 10-24 评审：对端挂起时别让面板一直转圈
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

/** 极小请求验证一组配置；HTTP 非 2xx 或带 error 就抛错（chatOnce 的薄包装，行为与老版一致） */
export async function probeModel(chatUrl, key, model, extraHeaders) {
  const { ok, status, json, txt } = await chatOnce(chatUrl, key, {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
  }, extraHeaders, { session: 'probe-switch' });
  if (!ok || json?.error) {
    throw new Error(`HTTP ${status} ${JSON.stringify(json?.error ?? txt).slice(0, 140)}`);
  }
  return json?.choices?.[0]?.message ?? {};
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
