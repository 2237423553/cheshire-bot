// ═══════════════════════════════════════════════════════════════════════
//  四件套探测 —— 换服务商前把「文档里的人工清单」自动化
//
//  ① 基础生成 ② thinking 三档接受度 ③ 工具调用 ④ 图片视觉
//
//  口径（2026-10-21 定）：
//  - 严格串行执行（并行会让限流的服务商互相污染判定）
//  - 失败项 kind：http / error-field / timeout / shape / ok
//  - 工具「没触发但能对话」= 警告不算失败（有的模型对意义不明的假工具不触发，
//    bot 实际用得起来）；视觉「答非所问」= 宽松通过，detail 记原回答
//  - 请求头与 bot.mjs 完全对齐（Bearer + UA + x-opencode-session + extra 放最后）
//
//  命令行自测：bun run probe-suite.mjs <url> <key> [model] [headers]
// ═══════════════════════════════════════════════════════════════════════
import zlib from 'node:zlib';
import { chatOnce } from './providers.mjs';

const T_BASIC = 45 * 1000, T_THINK = 60 * 1000;
const SESSION = 'probe-suite';

// ── 内嵌 64×64 红色 PNG（探测图，模块加载时构建一次）──
// ⚠️ 尺寸别再往下调：8×8 会被 MiMo 当垃圾图处理（下篇坑 21 同族，实测返回空内容）
function buildRedPng(size = 64) {
  const raw = Buffer.alloc(size * (1 + size * 3));   // 每行 = filter byte 0 + size 像素 RGB
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3);
    raw[off] = 0;
    for (let x = 0; x < size; x++) raw.set([255, 0, 0], off + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc);
    return Buffer.concat([len, body, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8bit 真彩色 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const RED_PNG_URL = `data:image/png;base64,${buildRedPng().toString('base64')}`;

function mkItem(kind, detail = '', extra = {}) {
  return { kind, detail: String(detail).slice(0, 200), ...extra };
}

/** 基础生成：通过 = 2xx ∧ 无 error ∧ content 或 reasoning_content 非空 */
async function probeBasic(chatUrl, key, model, extra) {
  const t0 = Date.now();
  let r;
  try {
    r = await chatOnce(chatUrl, key, {
      model, messages: [{ role: 'user', content: '只回复一个字：好' }], max_tokens: 16,
    }, extra, { session: SESSION, timeoutMs: T_BASIC });
  } catch (e) { return mkItem(e.kind ?? 'http', e.message, { ok: false }); }
  if (!r.ok) return mkItem('http', `HTTP ${r.status} ${r.txt.slice(0, 100)}`, { ok: false });
  if (r.json?.error) return mkItem('error-field', JSON.stringify(r.json.error).slice(0, 140), { ok: false });
  const msg = r.json?.choices?.[0]?.message;
  const out = (msg?.content ?? '') + (msg?.reasoning_content ?? '');
  if (!msg || !(out ?? '').trim()) return mkItem('shape', '响应结构不对/内容为空', { ok: false, latencyMs: r.latencyMs });
  return mkItem('ok', `回复：${String(msg.content ?? '').slice(0, 20) || '(纯思考)'}`,
    { ok: true, latencyMs: r.latencyMs, usage: r.json?.usage });
}

/** thinking 三档：accepted = 2xx ∧ 无 error；4xx 带 thinking 字样 = param-rejected（不算模型坏，算不兼容） */
async function probeThinking(chatUrl, key, model, extra) {
  const tiers = {};
  const errors = [];
  for (const t of ['enabled', 'disabled', 'auto']) {
    let r;
    try {
      r = await chatOnce(chatUrl, key, {
        model,
        messages: [{ role: 'user', content: '只回复一个字：好' }],
        max_tokens: 32,
        thinking: { type: t },
      }, extra, { session: SESSION, timeoutMs: t === 'enabled' ? T_THINK : T_BASIC });
    } catch (e) {
      tiers[t] = { accepted: false, kind: e.kind ?? 'timeout', detail: e.message.slice(0, 80) };
      continue;
    }
    const errTxt = JSON.stringify(r.json?.error ?? '');
    if (!r.ok && r.status >= 400 && r.status < 500 && /thinking|unrecognized|unknown|invalid/i.test(errTxt + r.txt)) {
      tiers[t] = { accepted: false, kind: 'param-rejected', detail: `HTTP ${r.status} ${errTxt.slice(0, 80)}` };
    } else if (!r.ok) {
      tiers[t] = { accepted: false, kind: 'http', detail: `HTTP ${r.status} ${r.txt.slice(0, 80)}` };
      errors.push(`thinking:${t}`);
    } else if (r.json?.error) {
      tiers[t] = { accepted: false, kind: 'error-field', detail: JSON.stringify(r.json.error).slice(0, 80) };
      errors.push(`thinking:${t}`);
    } else {
      const msg = r.json?.choices?.[0]?.message ?? {};
      tiers[t] = { accepted: true, reasoningPresent: Boolean(msg?.reasoning_content), latencyMs: r.latencyMs };
    }
  }
  const acc = Object.entries(tiers).filter(([, v]) => v.accepted).map(([k]) => k);
  // 全接受 → auto（模型自适应）；仅部分 → 挑被接受的失序取 auto>enabled 优先；全拒 → null（不传）
  const recommended = acc.length === 3 ? { type: 'auto' }
    : acc.includes('auto') ? { type: 'auto' }
    : acc.includes('enabled') ? { type: 'enabled' }
    : acc.length ? { type: acc[0] }
    : null;
  const detail = acc.length === 3 ? '三档全部接受'
    : acc.length ? `接受的档位：${acc.join('、')}`
    : '三档全被拒绝（建议不传 thinking 参数）';
  return { ok: acc.length > 0 || Object.values(tiers).every((v) => v.kind === 'param-rejected'), tiers, recommended, detail, errors };
}

/** 工具调用：触发 = ok；只回文本 = 警告（no-trigger，不算失败）；4xx = 失败 */
async function probeTools(chatUrl, key, model, extra) {
  const tools = [{
    type: 'function',
    function: { name: 'get_weather', description: '查询城市的当前天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  }];
  let r;
  try {
    r = await chatOnce(chatUrl, key, {
      model,
      messages: [{ role: 'user', content: '查一下北京天气。必须调用 get_weather 工具，不要用文字回答。' }],
      tools, tool_choice: 'auto', max_tokens: 200,
    }, extra, { session: SESSION, timeoutMs: T_BASIC });
  } catch (e) { return mkItem(e.kind ?? 'http', e.message, { ok: false }); }
  if (!r.ok) return mkItem('http', `HTTP ${r.status} ${r.txt.slice(0, 100)}`, { ok: false });
  if (r.json?.error) return mkItem('error-field', JSON.stringify(r.json.error).slice(0, 140), { ok: false });
  const msg = r.json?.choices?.[0]?.message ?? {};
  const called = msg?.tool_calls?.[0]?.function?.name;
  if (called) {
    return mkItem('ok', `触发 ${called}（参数 ${msg.tool_calls[0].function.arguments?.slice(0, 40) ?? ''}）`,
      { ok: true, latencyMs: r.latencyMs, reasoningPresent: Boolean(msg?.reasoning_content) });
  }
  // 有的模型对无意义工具就是文案回复 —— 能对话就还能用，降为警告
  return mkItem('no-trigger', `没触发工具，回了文本：「${String(msg?.content ?? '').slice(0, 40)}」——bot 实际带工具描述时通常能触发，留意即可`,
    { ok: true, warning: true, latencyMs: r.latencyMs, reasoningPresent: Boolean(msg?.reasoning_content) });
}

/** 视觉：合并 content+reasoning 判定（思考模型可能把 max_tokens 花光在思考上，下篇坑 19）；
 *  答含红/red = 精确通过；答非所问 = 宽松通过；4xx = 不支持 */
async function probeVision(chatUrl, key, model, extra) {
  let r;
  try {
    r = await chatOnce(chatUrl, key, {
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '这张图是什么颜色？只回一个颜色词' },
        { type: 'image_url', image_url: { url: RED_PNG_URL } },
      ] }],
      max_tokens: 64,
    }, extra, { session: SESSION, timeoutMs: T_BASIC });
  } catch (e) { return mkItem(e.kind ?? 'http', e.message, { ok: false }); }
  if (!r.ok) return mkItem('http', `HTTP ${r.status} ${r.txt.slice(0, 100)}`, { ok: false });
  if (r.json?.error) return mkItem('error-field', JSON.stringify(r.json.error).slice(0, 140), { ok: false });
  const msg = r.json?.choices?.[0]?.message ?? {};
  const ans = `${msg.content ?? ''} ${msg.reasoning_content ?? ''}`.trim();
  if (!ans) return mkItem('shape', '响应结构不对/内容为空', { ok: false, latencyMs: r.latencyMs });
  if (/red|红/i.test(ans)) return mkItem('ok', `答「${ans.slice(0, 30)}」—— 看图没问题`, { ok: true, latencyMs: r.latencyMs });
  return mkItem('ok', `视觉通了，但答「${ans.slice(0, 30)}」（红色图没答对，宽松通过）`, { ok: true, kindExtra: 'ok-loose', latencyMs: r.latencyMs });
}

/** 跑完整四件套，返回汇总 JSON（面板 /api/probe 与 CLI --probe 共用） */
export async function runProbeSuite(chatUrl, key, model, extraHeaders = {}) {
  const t0 = Date.now();
  const basic = await probeBasic(chatUrl, key, model, extraHeaders);
  const thinking = await probeThinking(chatUrl, key, model, extraHeaders);
  const tools = await probeTools(chatUrl, key, model, extraHeaders);
  const vision = await probeVision(chatUrl, key, model, extraHeaders);

  const items = { basic, thinking, tools, vision };
  const warnings = [], errors = [];
  const mark = (name, it, isWarn) => {
    if (it.ok && !isWarn) return;
    if (it.ok && (isWarn || it.warning)) warnings.push(`${name}：${it.detail}`);
    else errors.push(`${name}（${it.kind}）：${it.detail}`);
  };
  mark('工具调用', tools, tools.kind === 'no-trigger');
  mark('视觉', vision, vision.kind === 'ok-loose');
  for (const [k, err] of Object.entries(thinking.errors ?? [])) {
    // thinking 个别档被拒已在 recommended 里消化，仅 HTTP 类硬错误才算错误
    const tier = thinking.tiers[k.split(':')[1]];
    if (tier && tier.kind !== 'param-rejected') errors.push(`thinking ${k.split(':')[1]}：${tier.detail}`);
  }
  if (!basic.ok) errors.push(`基础生成（${basic.kind}）：${basic.detail}`);
  else if (basic.kind !== 'ok') mark('基础生成', basic, false);

  const hardFail = !basic.ok || tools.ok !== true || vision.ok !== true;
  return {
    url: chatUrl, model, durationMs: Date.now() - t0,
    items, allOk: hardFail ? false : true,
    warnings, errors,
  };
}

// ── 命令行自测：bun run probe-suite.mjs <url> <key> [model] [headers] ──
if (import.meta.main) {
  const [url, key, model, hdrs] = process.argv.slice(2);
  if (!url || !key) {
    console.log('用法：bun run probe-suite.mjs <url> <key> [model] ["X-A: 1"]');
    console.log('       （探测四件套：基础生成 / thinking 三档 / 工具 / 视觉）');
    process.exit(1);
  }
  const { normalizeChatUrl, parseHeaders, maskKey } = await import('./providers.mjs');
  const chat = normalizeChatUrl(url);
  const extra = parseHeaders(hdrs);
  console.log(`四件套探测 ${chat} 模型=${model ?? '(未指定，前端应指定)'} Key=${maskKey(key)}`);
  const out = await runProbeSuite(chat, key, model ?? '', extra);
  const sym = (ok, warn) => (ok === true && !warn ? '√' : ok === true && warn ? '⚠' : '×');
  console.log('');
  console.log(`  基础生成 ${sym(out.items.basic?.ok)} ${out.items.basic?.detail ?? ''} ${out.items.basic?.latencyMs ? `(${Math.round(out.items.basic.latencyMs)}ms)` : ''}`);
  for (const [t, v] of Object.entries(out.items.thinking?.tiers ?? {})) {
    console.log(`  thinking.${t.padEnd(8)} ${v.accepted ? '√ 接受' : '× ' + v.kind}${v.reasoningPresent ? '（有思考）' : ''}${v.latencyMs ? ` ${Math.round(v.latencyMs)}ms` : ''}`);
  }
  console.log(`  推荐思考档: ${JSON.stringify(out.items.thinking?.recommended ?? null)} —— ${out.items.thinking?.detail ?? ''}`);
  console.log(`  工具调用 ${sym(out.items.tools?.ok, out.items.tools?.warning)} ${out.items.tools?.detail ?? ''}`);
  console.log(`  图片视觉 ${sym(out.items.vision?.ok, out.items.vision?.kindExtra === 'ok-loose')} ${out.items.vision?.detail ?? ''}`);
  console.log('');
  if (out.errors.length) console.log(`  ✗ 错误：\n    ${out.errors.join('\n    ')}`);
  if (out.warnings.length) console.log(`  ⚠ 警告：\n    ${out.warnings.join('\n    ')}`);
  console.log(out.allOk ? '  总评：全绿，可以放心切' : '  总评：有失败项（确认后仍可强行保存）');
  console.log(`  耗时 ${Math.round(out.durationMs / 1000)}s`);
}
