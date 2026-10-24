// ═══════════════════════════════════════════════════════════════════════
//  API 配置面板（本地 Web）—— 双击「切换面板.cmd」或 bun run api-panel.mjs --open
//
//  - 只绑 127.0.0.1（回环），不触发 Windows 防火墙弹窗
//  - 随机 token 注入页面，所有 /api 校验 X-Panel-Token + Origin（防其它本地进程/网页乱点）
//  - 所有响应 Key 打码；报错先 sanitizeErr 再落 console；无访问日志
//  - 写盘统一走 llm-state.mjs（唯一写入口，原子写）；进程控制走 botctl.mjs
//  - 端口 5098 起，被占向 5090–5097 顺延；占用者若是本面板则提示已在运行
// ═══════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.mjs';
import { normalizeChatUrl, modelsUrlOf, mediaModelsUrlOf, fetchModels, probeModel, maskKey, assertSafeUrl } from './providers.mjs';
import { loadState, saveState, listProfiles, upsertProfile, deleteProfile, applyProfile, writeJsonAtomic, readJson } from './llm-state.mjs';
import { restartBot, isBotRunning } from './botctl.mjs';
import { runProbeSuite } from './probe-suite.mjs';
import * as imggen from './imggen.mjs';
import { PAGE_HTML } from './panel-page.mjs';

const TOKEN = crypto.randomUUID();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SWITCH_PATH = path.join(__dir, 'switches.json');
const MEDIA_PATH = path.join(__dir, 'mediaapi.json');
const SWITCH_KEYS = ['imggen', 'vidgenEnabled', 'bilibili', 'search', 'repeat', 'beacon'];
const MEDIA_KEYS = ['imggenUrl', 'imggenKey', 'imggenModel', 'imggenSize', 'vidgenUrl', 'vidgenKey', 'vidgenModel', 'vidgenMaxSeconds',
                    'ttsUrl', 'ttsKey', 'ttsModel', 'ttsVoiceDesign', 'ttsAutoVoiceChars', 'ttsSingModel', 'ttsSingVoice'];
const PROMPT_PATH = path.join(__dir, 'prompt.json');
const PROMPT_LIMIT = 8000;   // 提示词最长字符（防手滑把 10 万字灌进每条消息）
const OPEN_BROWSER = process.argv.includes('--open');
const PORTS = [5098, 5097, 5096, 5095, 5094, 5093, 5092, 5091, 5090];

const thinkingLabel = (t) =>
  !t ? 'config.mjs 默认'
  : typeof t === 'string' ? (t === 'default' ? '不传思考参数' : t)
  : t.type ? `${t.type}（模型${t.type === 'auto' ? '自己决定' : t.type === 'enabled' ? '强制思考' : '不思考'}）`
  : JSON.stringify(t);

/** 报错落日志前把钥匙抹掉 */
function sanitizeErr(e) {
  return String(e?.stack ?? e).replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/(sk-|oc_sk_)\w+/gi, '$1***');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function fail(e, status = 400) {
  console.error('[panel]', sanitizeErr(e));
  return json({ error: String(e?.message ?? e).slice(0, 300) }, status);
}
function needToken(req) {
  if (req.headers.get('x-panel-token') !== TOKEN) throw Object.assign(new Error('面板令牌不对'), { status: 403 });
  const origin = req.headers.get('origin');
  // 127.0.0.1 和 localhost 都认（10-24 评审：只认 127.0.0.1 前缀时用 localhost 打开面板会全程 403）；
  // 端口不限死——面板端口会顺延。真正的门闩是上面的 X-Panel-Token。
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    throw Object.assign(new Error('来源不对（拒绝跨面板调用）'), { status: 403 });
  }
}
async function bodyJson(req) {
  try { return await req.json(); } catch { return {}; }
}

// ── 业务攒数 ──
function stateInfo() {
  const st = loadState();
  return {
    llmUrl: cfg.llmUrl, model: cfg.model, thinking: cfg.thinking, thinkingLabel: thinkingLabel(cfg.thinking),
    llmKeyMasked: maskKey(cfg.llmKey), hasKey: Boolean(cfg.llmKey),
    llmHeaders: cfg.llmHeaders ?? {},
    modelList: cfg.modelList ?? [],
    stateSource: st ? 'llmstate' : 'default',
    botRunning: isBotRunning(),
  };
}

/** 解析面板传来的探测/保存参数：url 补全、key 空沿用当前、headers 对象直通 */
function resolveForm({ url, key, headers }) {
  const chatUrl = normalizeChatUrl(url || cfg.llmUrl);   // 空串/null = 沿用当前端点；映射表在服务端一处生效
  const useKey = key || cfg.llmKey;                      // 空串 = 沿用当前 Key
  const hdrs = headers && typeof headers === 'object' ? headers : {};
  return { chatUrl, useKey, hdrs };
}

// SSRF 闸白名单（10-24 评审）：刻意支持的本地服务——Ollama 默认端口
const LOCAL_URL_HOSTS = ['127.0.0.1:11434', 'localhost:11434'];

async function route(req, port) {
  const u = new URL(req.url);
  const path = u.pathname;

  if (path === '/' && req.method === 'GET') {
    return new Response(PAGE_HTML.replace('__PANEL_TOKEN__', TOKEN), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });
  needToken(req);   // 所有 /api 都要令牌

  // —— 只读 ——
  if (path === '/api/state' && req.method === 'GET') {
    return json({ ...stateInfo(), panelPort: port });
  }
  if (path === '/api/profiles' && req.method === 'GET') {
    const db = listProfiles();
    return json({
      activeId: db.activeId,
      profiles: db.profiles.map((p) => ({ ...p, llmKey: undefined, llmKeyMasked: maskKey(p.llmKey), hasKey: Boolean(p.llmKey) })),
    });
  }

  // —— 写入类 ——
  if (path === '/api/models' && req.method === 'POST') {
    const b = await bodyJson(req);
    const { chatUrl, useKey, hdrs } = resolveForm(b);
    await assertSafeUrl(chatUrl, LOCAL_URL_HOSTS);   // SSRF 闸：拉列表会对 URL 发请求
    const models = await fetchModels(chatUrl, useKey, hdrs);
    return json({ ok: true, models, modelsUrl: modelsUrlOf(chatUrl) });
  }
  if (path === '/api/probe' && req.method === 'POST') {
    const b = await bodyJson(req);
    const { chatUrl, useKey, hdrs } = resolveForm(b);
    await assertSafeUrl(chatUrl, LOCAL_URL_HOSTS);   // SSRF 闸：四件套对 URL 发请求
    const model = String(b.model ?? '').trim();
    if (!model) return json({ error: '没给模型 ID' }, 400);
    const out = await runProbeSuite(chatUrl, useKey, model, hdrs);
    return json(out);
  }
  if (path === '/api/save' && req.method === 'POST') {
    const b = await bodyJson(req);
    const { chatUrl, useKey, hdrs } = resolveForm(b);
    const model = String(b.model ?? '').trim();
    if (!model) return json({ error: '没给模型 ID' }, 400);
    // 思考档：'keep' = 写当前生效值；'default' = 不传；其余传 {type:...}
    const thinking = b.thinking === 'keep' ? (cfg.thinking ?? 'default')
      : b.thinking === 'default' ? 'default'
      : b.thinking && b.thinking.type ? b.thinking
      : (cfg.thinking ?? 'default');
    let modelName = null;
    if (b.name) {
      // 快速验证一把再入档案（学报过头的 key 只存验证能跑的组合）
      await probeModel(chatUrl, useKey, model, hdrs);
      const p = upsertProfile({ name: b.name, llmUrl: chatUrl, llmKey: useKey, model, thinking, llmHeaders: hdrs });
      modelName = p.name;
    }
    if (b.switch !== false) {
      saveState({ llmUrl: chatUrl, llmKey: useKey, model, thinking, modelList: b.modelList ?? cfg.modelList, llmHeaders: hdrs });
    }
    return json({ ok: true, model, thinking, profileName: modelName });
  }
  if (path === '/api/restart' && req.method === 'POST') {
    restartBot();   // 耗时约 6s，失败抛错
    return json({ ok: true });
  }
  if (path === '/api/profiles' && req.method === 'POST') {
    const b = await bodyJson(req);
    const { chatUrl, useKey, hdrs } = resolveForm(b);
    const p = upsertProfile({ id: b.id, name: b.name, llmUrl: chatUrl, llmKey: useKey, model: b.model, llmHeaders: hdrs });
    return json({ ok: true, id: p.id });
  }
  if (path === '/api/profiles' && req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    deleteProfile(id);
    return json({ ok: true });
  }
  if (path === '/api/profiles/apply' && req.method === 'POST') {
    const b = await bodyJson(req);
    if (b.verify) {
      const p2 = listProfiles().profiles.find((x) => x.id === b.id);
      if (!p2) return json({ error: '没这个档案' }, 404);
      await probeModel(p2.llmUrl, p2.llmKey, p2.model, p2.llmHeaders ?? {});   // 启用前快验一把
    }
    applyProfile(b.id);
    return json({ ok: true });
  }

  // ── 功能开关（switches.json；bot 逐条消息现读，保存即生效不用重启）──
  if (path === '/api/switches' && req.method === 'GET') {
    const saved = readJson(SWITCH_PATH) ?? {};
    const vidDflt = cfg.vidgenEnabled !== false;   // 生视频的缺省跟 config 真身（其余键缺省=开）
    return json({
      switches: Object.fromEntries(SWITCH_KEYS.map((k) => [k, saved[k] ?? (k === 'vidgenEnabled' ? vidDflt : true)])),
      defaults: { vidgenEnabled: vidDflt },
      hint: 'vidgenEnabled 缺省跟 config.mjs 的 vidgenEnabled，其余缺省=开',
    });
  }
  if (path === '/api/switches' && req.method === 'POST') {
    const b = await bodyJson(req);
    const cur = readJson(SWITCH_PATH) ?? {};
    const merged = { ...cur };
    for (const k of SWITCH_KEYS) if (k in b) merged[k] = Boolean(b[k]);
    writeJsonAtomic(SWITCH_PATH, merged);
    console.log(`[panel] 功能开关已保存：${JSON.stringify(Object.fromEntries(SWITCH_KEYS.filter((k) => k in b).map((k) => [k, merged[k]])))}`);
    return json({ ok: true, switches: merged });
  }

  // ── 生图/生视频 API（mediaapi.json；config.mjs 启动时合并，改完要重启 bot）──
  if (path === '/api/media' && req.method === 'GET') {
    return json({
      imggen: { url: cfg.imggenUrl, keyMasked: maskKey(cfg.imggenKey), hasKey: Boolean(cfg.imggenKey), model: cfg.imggenModel, size: cfg.imggenSize },
      vidgen: { url: cfg.vidgenUrl, keyMasked: maskKey(cfg.vidgenKey), hasKey: Boolean(cfg.vidgenKey), model: cfg.vidgenModel, maxSeconds: cfg.vidgenMaxSeconds },
      tts: { url: cfg.ttsUrl, keyMasked: maskKey(cfg.ttsKey), hasKey: Boolean(cfg.ttsKey), model: cfg.ttsModel,
             voiceDesign: cfg.ttsVoiceDesign, autoChars: cfg.ttsAutoVoiceChars, singVoice: cfg.ttsSingVoice },
      note: 'Key 打码；改完重启 bot 生效',
    });
  }
  if (path === '/api/media' && req.method === 'POST') {
    const b = await bodyJson(req);
    const cur = readJson(MEDIA_PATH) ?? {};
    const merged = { ...cur };
    // key 空串 = 沿用现有；显式给了才覆盖
    for (const k of MEDIA_KEYS) {
      if (!(k in b)) continue;
      const v = k === 'vidgenMaxSeconds' ? Math.max(1, Number(b[k]) || 15)
        : k === 'ttsAutoVoiceChars' ? Math.max(1, Number(b[k]) || 300)   // 数字键防字符串落盘
        : String(b[k] ?? '').trim();
      if (k.endsWith('Key')) { if (v) merged[k] = v; }
      else if (v !== '') merged[k] = v;
    }
    writeJsonAtomic(MEDIA_PATH, merged);
    console.log('[panel] 生图/生视频 API 配置已保存（重启 bot 生效）');
    return json({ ok: true, note: '重启 bot 后生效' });
  }
  // 生图/生视频卡的「拉模型列表」：端点掐掉 generations 接 /models；key 空串 = 沿用当前
  if (path === '/api/media-models' && req.method === 'POST') {
    const b = await bodyJson(req);
    const side = b.side === 'vidgen' ? 'vidgen' : 'imggen';
    const url = String(b.url ?? '').trim() || (side === 'imggen' ? cfg.imggenUrl : cfg.vidgenUrl);
    const key = String(b.key ?? '') || (side === 'imggen' ? cfg.imggenKey : cfg.vidgenKey);
    await assertSafeUrl(mediaModelsUrlOf(url), LOCAL_URL_HOSTS);   // SSRF 闸：校验的是真要请求的 /models 地址
    const models = await fetchModels(url, key, undefined, mediaModelsUrlOf(url));
    return json({ ok: true, models });
  }
  if (path === '/api/imggen-test' && req.method === 'POST') {
    // 真花一张图的钱实测（最小 prompt，生成结果不进群、直接丢弃）
    const buf = await imggen.generateImage('a simple red circle on a white background');
    return json({ ok: true, bytes: buf.length });
  }

  // ── 自定义提示词（prompt.json；config.mjs 启动时合并，改完重启 bot 生效）──
  if (path === '/api/prompt' && req.method === 'GET') {
    const saved = readJson(PROMPT_PATH) ?? {};
    return json({
      systemPrompt: cfg.systemPrompt, eatPrompt: cfg.eatPrompt,
      overridden: { systemPrompt: typeof saved.systemPrompt === 'string', eatPrompt: typeof saved.eatPrompt === 'string' },
      limit: PROMPT_LIMIT,
    });
  }
  if (path === '/api/prompt' && req.method === 'POST') {
    const b = await bodyJson(req);
    const cur = readJson(PROMPT_PATH) ?? {};
    const merged = { ...cur };
    for (const k of ['systemPrompt', 'eatPrompt']) {
      if (!(k in b)) continue;
      const v = String(b[k] ?? '');
      if (v.trim() === '') { delete merged[k]; continue; }   // 存空 = 恢复 config 默认
      if (v.length > PROMPT_LIMIT) return json({ error: `${k} 超过 ${PROMPT_LIMIT} 字上限（现在 ${v.length} 字）` }, 400);
      merged[k] = v;
    }
    writeJsonAtomic(PROMPT_PATH, merged);
    console.log('[panel] 自定义提示词已保存（重启 bot 生效）');
    return json({ ok: true, note: '重启 bot 后生效', reset: Object.keys(merged).filter((k) => !merged[k]) });
  }
  return json({ error: '未知接口' }, 404);
}

// ── 启动：先探测「5098 占用者是不是本面板」，再挑空口启动 ──
async function isOurPanelOn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return (await r.text()).includes('柴郡 API 面板');
  } catch { return false; }
}

let server = null, port = 0;
for (const p of PORTS) {
  if (await isOurPanelOn(p)) {
    console.log(`[panel] 面板已经在 http://127.0.0.1:${p} 跑着，不重复起`);
    if (OPEN_BROWSER) spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${p}`], { stdio: 'ignore' });
    process.exit(0);
  }
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: p, fetch: (req) => route(req, p).catch((e) => fail(e, e?.status ?? 500)) });
    port = p;
    break;
  } catch { /* 被别的程序占了，试下一个口 */ }
}
if (!server) {
  console.error('[panel] 5090–5098 全被占了，腾一个口再启动');
  process.exit(1);
}

console.log(`[panel] API 面板已启动：http://127.0.0.1:${port}（仅本机可访问）`);
console.log('[panel] 复检/CLI/面板共用 llmstate.json；CLI 和面板别同时改配置');
if (OPEN_BROWSER) {
  spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { stdio: 'ignore' });
  console.log('[panel] 已请求浏览器打开页面');
}
