// ═══════════════════════════════════════════════════════════════════════
//  API 面板页面 —— 纯 HTML/CSS/JS 单文件（无框架），由 api-panel.mjs 注入 token 后下发
// ═══════════════════════════════════════════════════════════════════════

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>柴郡 API 面板</title>
<style>
  :root { --bg:#11151c; --card:#1a2029; --line:#2a3240; --tx:#d8dee9; --dim:#7d8794; --ok:#4caf87; --bad:#e06c75; --warn:#e5c07b; --acc:#61afef; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--tx); font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; padding:18px; max-width:880px; margin:0 auto; }
  h1 { font-size:18px; margin-bottom:4px; } h1 small { color:var(--dim); font-weight:normal; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-top:12px; }
  .card h2 { font-size:13px; color:var(--acc); margin-bottom:10px; letter-spacing:1px; }
  table { width:100%; border-collapse:collapse; font-size:13px; } td { padding:3px 6px; vertical-align:top; }
  .kv td:first-child { color:var(--dim); width:88px; white-space:nowrap; }
  input,textarea,select,button { font:inherit; color:var(--tx); background:#0e1218; border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  input,textarea { width:100%; } textarea { font-family:Consolas,monospace; font-size:12px; }
  input:focus,textarea:focus { outline:none; border-color:var(--acc); }
  button { background:#20303f; border-color:#31404f; cursor:pointer; white-space:nowrap; }
  button:hover { border-color:var(--acc); } button:disabled { opacity:.45; cursor:default; }
  button.pri { background:#1d3a52; border-color:#2a5a80; color:#cfe8ff; font-weight:bold; }
  button.dan { color:var(--bad); }
  .row { display:flex; gap:8px; align-items:center; } .row > * { flex:1; }
  .row > button { flex:0 0 auto; }
  .hint { color:var(--dim); font-size:12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; }
  .g { background:var(--ok); } .r { background:var(--bad); }
  .res-ok { color:var(--ok); } .res-bad { color:var(--bad); } .res-warn { color:var(--warn); }
  .probe td:first-child { width:110px; } .probe .lat { color:var(--dim); font-size:12px; }
  .prof td { border-top:1px solid var(--line); padding:7px 6px; }
  .prof button { padding:2px 10px; font-size:12px; margin-left:4px; }
  .drop { position:absolute; z-index:9; left:0; right:0; top:calc(100% + 2px); background:#151a22; border:1px solid var(--line); border-radius:8px; max-height:220px; overflow-y:auto; box-shadow:0 6px 18px #0009; }
  .drop div { padding:5px 10px; cursor:pointer; font-size:13px; }
  .drop div:hover, .drop div.hl { background:#20303f; }
  #bar { position:fixed; left:0; right:0; bottom:0; background:#0c0f14ee; border-top:1px solid var(--line); padding:8px 18px; font-size:13px; }
  #bar.ok { color:var(--ok); } #bar.bad { color:var(--bad); } #bar.busy { color:var(--warn); }
  .foot { color:var(--dim); font-size:11px; margin:14px 0 46px; }
  .eye { width:34px !important; flex:0 0 34px !important; padding:6px 0 !important; text-align:center; }
  input[type=radio]{ width:auto; accent-color:var(--acc); }
  label.rg { margin-right:12px; color:var(--dim); font-size:13px; }
</style></head><body>
<h1>柴郡 API 面板 <small>· 只 listen 127.0.0.1，除非指挥官点头别暴露出去</small></h1>

<div class="card"><h2>当前配置</h2>
<table class="kv"><tr><td>模型</td><td><b id="cur_model">…</b> <span class="hint" id="cur_src"></span></td></tr>
<tr><td>端点</td><td id="cur_url">…</td></tr>
<tr><td>Key</td><td id="cur_key">…</td></tr>
<tr><td>思考档</td><td id="cur_think">…</td></tr>
<tr><td>自定义头</td><td id="cur_hdr">…</td></tr>
<tr><td>机器人</td><td><span class="dot" id="bot_dot"></span><span id="bot_txt">…</span>
  <button style="margin-left:10px" onclick="doRestart(true)">重启机器人</button></td></tr></table></div>

<div class="card"><h2>新配置</h2>
<table class="kv">
<tr><td>档案名</td><td><input id="f_name" placeholder="（选填）另存的叫什么，如 OpenCode Go / DeepSeek 官方"></td></tr>
<tr><td>URL</td><td><input id="f_url" placeholder="API 端点 / /v1 结尾 / 官网控制台页 / 大厂地址（DeepSeek、Kimi、智谱、SiliconFlow、OpenRouter、Ollama 本地都认）"></td></tr>
<tr><td>Key</td><td><div class="row"><input id="f_key" type="password" placeholder="留空 = 沿用当前 Key"><button class="eye" onclick="toggleKey()">👁</button></div></td></tr>
<tr><td>自定义头</td><td><textarea id="f_hdr" rows="2" placeholder="Name: Value，多行/逗号分隔；留空 = 沿用当前"></textarea></td></tr>
<tr><td>思考档</td><td>
  <label class="rg"><input type="radio" name="tk" value="keep" checked>保持现状</label>
  <label class="rg"><input type="radio" name="tk" value="default">不传</label>
  <label class="rg"><input type="radio" name="tk" value="auto">auto</label>
  <label class="rg"><input type="radio" name="tk" value="enabled">enabled</label>
  <label class="rg"><input type="radio" name="tk" value="disabled">disabled</label></td></tr>
<tr><td>模型</td><td><div class="row"><div style="position:relative;flex:1"><input id="f_model" autocomplete="off" placeholder="先拉列表，或直接输模型 ID"><div id="mdl_drop" class="drop" style="display:none"></div></div><button onclick="loadModels()">拉取模型列表</button></div>
  <div class="hint" id="mdl_hint"></div></td></tr>
</table>
<div class="row" style="margin-top:10px">
  <button class="pri" onclick="probeAndSwitch()">探测四件套并切换</button>
  <button onclick="saveOnly(false)">跳过探测直接切换</button>
  <button onclick="saveOnly(true)">只存档案不切换</button>
</div></div>

<div class="card" id="probe_card" style="display:none"><h2>四件套探测结果</h2>
<table class="probe" id="probe_tbl"></table>
<div class="row" style="margin-top:10px" id="probe_btns"></div></div>

<div class="card"><h2>配置档案</h2>
<table class="prof" id="prof_tbl"><tr><td class="hint">还没有存过档案</td></tr></table>
<div class="hint">档案含真 Key，存在本目录 llm-profiles.json（已挡在仓库外）。<b>CLI 和面板别同时改配置。</b></div></div>

<div class="card"><h2>功能开关</h2>
<div class="row"><div class="hint" id="sw_txt">读取中…</div><button onclick="openSw()">打开开关子窗</button></div>
<div class="hint">机器人每条消息现读开关 —— 改完<b>即刻生效，不用重启</b></div></div>

<div class="card"><h2>生图 API</h2>
<table class="kv">
<tr><td>端点</td><td><input id="m_url"></td></tr>
<tr><td>Key</td><td><div class="row"><input id="m_key" type="password" placeholder="留空 = 沿用当前"><button class="eye" onclick="mtoggle()">👁</button></div></td></tr>
<tr><td>模型</td><td><input id="m_model"></td></tr>
<tr><td>尺寸</td><td><input id="m_size" placeholder="1024x1024"></td></tr></table>
<div class="row" style="margin-top:8px"><button class="pri" onclick="saveMedia('imggen')">保存生图配置</button><button onclick="testImggen()">花一张图的钱实测</button></div>
<div class="hint">实测 = 真生成一张最小图（结果不进群、直接丢弃）；保存后重启机器人生效</div></div>

<div class="card"><h2>生视频 API</h2>
<table class="kv">
<tr><td>端点</td><td><input id="v_url"></td></tr>
<tr><td>Key</td><td><div class="row"><input id="v_key" type="password" placeholder="留空 = 沿用当前"><button class="eye" onclick="vtoggle()">👁</button></div></td></tr>
<tr><td>模型</td><td><input id="v_model"></td></tr>
<tr><td>时长上限</td><td><input id="v_max" type="number" min="1" max="60"> <span class="hint">秒（超出弃用不发）</span></td></tr></table>
<div class="row" style="margin-top:8px"><button class="pri" onclick="saveMedia('vidgen')">保存生视频配置</button></div>
<div class="hint">没放实测按钮——生视频按次计费，验证就烧一把额度；营业与否用「功能开关」里的生视频闸</div></div>

<div id="sw_modal" style="display:none;position:fixed;inset:0;background:#000b;z-index:99" onclick="if(event.target===this)closeSw()">
<div style="background:var(--card);max-width:380px;margin:90px auto;border:1px solid var(--line);border-radius:12px;padding:16px 20px">
<h2 style="color:var(--acc);font-size:13px;margin-bottom:10px">功能开关（保存即刻生效，不用重启）</h2>
<div id="sw_list"></div>
<div class="row" style="margin-top:12px"><button class="pri" onclick="saveSw()">保存</button><button onclick="closeSw()">取消</button></div>
</div></div>

<div class="foot">写盘 = llmstate.json（运行时真源，删掉恢复 config.mjs 默认）· 功能开关 = switches.json · 生图/生视频 = mediaapi.json · 探测消耗 &lt;3K token/次 · 源码 qq-group-bot/api-panel.mjs</div>
<div id="bar"></div>
<script>window.PT = "__PANEL_TOKEN__";</script>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let lastProbe = null, lastForm = null, MODELS = [];

// ── 模型自定义下拉：点开/输入即弹全部列表（datalist 会拿输入当过滤条件，不合用）──
function renderDrop() {
  const q = $('f_model').value.trim().toLowerCase();
  const list = q ? MODELS.filter((m) => m.toLowerCase().includes(q)) : MODELS;
  const d = $('mdl_drop');
  d.innerHTML = (list.length ? list : ['（没有匹配的模型，回车/留空直接用输入值）'])
    .map((m) => '<div data-v="' + esc(m) + '">' + esc(m) + '</div>').join('');
  d.style.display = 'block';
  d.querySelectorAll('div').forEach((el) => el.onclick = () => {
    $('f_model').value = el.dataset.v; hideDrop(); $('mdl_hint').textContent = '已选 ' + el.dataset.v;
  });
}
function hideDrop() { $('mdl_drop').style.display = 'none'; }
function initDrop() {
  const inp = $('f_model');
  inp.addEventListener('focus', () => { if (MODELS.length) renderDrop(); });
  inp.addEventListener('input', () => { if (MODELS.length) renderDrop(); });
  inp.addEventListener('blur', () => setTimeout(hideDrop, 150));   // 留 150ms 给点击事件
}

function bar(msg, cls) { const b = $('bar'); b.textContent = msg; b.className = cls || ''; }

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Panel-Token': window.PT, ...(opts.headers || {}) } });
  if (r.status === 403) throw new Error('面板令牌校验失败 —— 刷新页面重开');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function formFrom() {
  const hdrTxt = $('f_hdr').value.trim();
  let headers = {};
  if (hdrTxt) {
    for (const line of hdrTxt.split(/[\\n\\r,;]+/)) {
      const s = line.trim(); if (!s) continue;
      let i = s.indexOf(':'); if (i < 1) i = s.indexOf('=');
      if (i < 1) throw new Error('请求头格式不对：' + s);
      headers[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  }
  return { name: $('f_name').value.trim(), url: $('f_url').value.trim(),
           key: $('f_key').value, model: $('f_model').value.trim(),
           headers, thinking: (document.querySelector('input[name=tk]:checked') || {}).value || 'keep' };
}
/** 顶层入口统一走这里：formFrom 抛错落到状态栏，绝不整卡无响应 */
function getForm() {
  try { return formFrom(); } catch (e) { bar(e.message, 'bad'); return null; }
}
function formTo(f, keepKey) {
  return { url: f.url, key: f.key, model: f.model, headers: f.headers, name: f.name, thinking: f.thinking };
}
function setForm(f) {
  $('f_url').value = f.url || ''; $('f_key').value = ''; $('f_model').value = f.model || '';
  $('f_name').value = f.name || '';
  $('f_hdr').value = Object.entries(f.headers || {}).map(([k, v]) => k + ': ' + v).join('\\n');
  if (f.thinking) document.querySelectorAll('input[name=tk]').forEach(r => {
    const v = typeof f.thinking === 'string' ? f.thinking : f.thinking.type;
    if (r.value === v) r.checked = true; });
}

function toggleKey() { const k = $('f_key'); k.type = k.type === 'password' ? 'text' : 'password'; }

async function refresh() {
  try {
    const st = await api('/api/state');
    $('cur_model').textContent = st.model;
    $('cur_src').textContent = st.stateSource === 'llmstate' ? '（llmstate.json 覆盖）' : '（config.mjs 默认）';
    $('cur_url').textContent = st.llmUrl;
    $('cur_key').textContent = st.hasKey ? st.llmKeyMasked + '（打码）' : '未设置';
    $('cur_think').textContent = st.thinkingLabel;
    $('cur_hdr').textContent = Object.keys(st.llmHeaders || {}).length ? Object.keys(st.llmHeaders).join(', ') : '—';
    $('bot_txt').textContent = st.botRunning ? '运行中' : '没在跑';
    $('bot_dot').className = 'dot ' + (st.botRunning ? 'g' : 'r');
    loadProfiles();
  } catch (e) { bar('刷新失败：' + e.message, 'bad'); }
}
function loadProfiles() {
  api('/api/profiles').then((db) => {
    const rows = [];
    for (const p of db.profiles) {
      const pb = p.probe?.items ?? {};
      const dots = p.probe ? ['basic','thinking','tools','vision'].map(k => (pb[k]?.ok ? '●' : '○')).join('') : '—';
      rows.push('<tr><td><b>' + esc(p.name) + '</b>' + (p.id === db.activeId ? ' <span class="res-ok">· 生效中</span>' : '')
        + '<br><span class="hint">' + esc(p.model || '') + ' · ' + esc(p.llmUrl) + '</span></td>'
        + '<td><span class="hint">探测</span> ' + esc(dots) + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + '<button onclick="applyProf(\\'' + p.id + '\\')">启用</button>'
        + '<button class="dan" onclick="delProf(\\'' + p.id + '\\')">删除</button></td></tr>');
    }
    $('prof_tbl').innerHTML = rows.length ? rows.join('') : '<tr><td class="hint">还没有存过档案</td></tr>';
  }).catch((e) => bar('档案读取失败：' + e.message, 'bad'));
}

async function loadModels() {
  const f = getForm(); if (!f) return;
  if (!f.url) return bar('先填 URL', 'bad');
  bar('正在拉模型列表…', 'busy');
  try {
    const j = await api('/api/models', { method: 'POST', body: JSON.stringify(formTo(f)) });
    MODELS = j.models;
    $('mdl_hint').textContent = '拉到 ' + j.models.length + ' 个模型（点击模型框打开完整列表，输入可过滤）';
    renderDrop();
    bar('列表拉到了（' + j.models.length + ' 个）', 'ok');
  } catch (e) { bar('拉列表失败：' + e.message, 'bad'); $('mdl_hint').textContent = ''; }
}

async function runProbe() {
  const f = getForm(); if (!f) return null;
  const urlN = f.url; // 服务端会补全
  bar('四件套探测中（基础/思考三档/工具/视觉）… 约半分钟', 'busy');
  try {
    const j = await api('/api/probe', { method: 'POST', body: JSON.stringify({ url: urlN, key: f.key, model: f.model, headers: f.headers }) });
    renderProbe(j);
    bar('探测完成，耗时 ' + Math.round(j.durationMs / 1000) + 's' + (j.allOk ? '，全绿' : '，有失败项'), j.allOk ? 'ok' : 'bad');
    return j;
  } catch (e) { bar('探测失败：' + e.message, 'bad'); return null; }
}

function cell(ok, warn, txt, lat) {
  const cls = ok === true ? (warn ? 'res-warn' : 'res-ok') : 'res-bad';
  const mark = ok === true ? (warn ? '⚠' : '√') : '×';
  return '<td class="' + cls + '">' + mark + '</td><td>' + esc(txt) + (lat ? ' <span class="lat">' + Math.round(lat) + 'ms</span>' : '') + '</td>';
}
function renderProbe(j) {
  lastProbe = j;
  const it = j.items ?? {};
  const rows = [];
  rows.push('<tr><td>基础生成</td>' + cell(it.basic?.ok, false, it.basic?.detail ?? '', it.basic?.latencyMs) + '</tr>');
  const tv = it.thinking?.tiers ?? {};
  for (const t of ['enabled', 'disabled', 'auto']) {
    const v = tv[t] || {};
    rows.push('<tr><td>thinking.' + t + '</td>' + cell(v.accepted, false, v.accepted ? (v.reasoningPresent ? '接受（有思考）' : '接受') : (v.kind + ' ' + (v.detail || '')), v.latencyMs) + '</tr>');
  }
  rows.push('<tr><td>推荐思考档</td><td></td><td>' + esc(JSON.stringify(it.thinking?.recommended ?? 'default')) + ' · ' + esc(it.thinking?.detail ?? '') + '</td></tr>');
  rows.push('<tr><td>工具调用</td>' + cell(it.tools?.ok, it.tools?.warning, it.tools?.detail ?? '', it.tools?.latencyMs) + '</tr>');
  rows.push('<tr><td>图片视觉</td>' + cell(it.vision?.ok, it.vision?.kindExtra === 'ok-loose', it.vision?.detail ?? '', it.vision?.latencyMs) + '</tr>');
  $('probe_tbl').innerHTML = rows.join('');
  $('probe_card').style.display = '';
  const btns = $('probe_btns'); btns.innerHTML = '';
  if (!j.allOk) {
    const b = document.createElement('button'); b.className = 'dan'; b.textContent = '⚠ 有失败项，仍然切换';
    b.onclick = () => doSave(false); btns.appendChild(b);
  }
  const b2 = document.createElement('button'); b2.textContent = '另存探测结果为档案';
  b2.onclick = () => doSave(true); btns.appendChild(b2);
}

async function doSave(asProfile) {
  const f = getForm(); if (!f) return;
  if (!f.url || !f.model) return bar('URL 和模型都要有', 'bad');
  bar('写盘中…', 'busy');
  try {
    const j = await api('/api/save', { method: 'POST', body: JSON.stringify({
      url: f.url, key: f.key, model: f.model, thinking: f.thinking, headers: f.headers,
      name: asProfile ? (f.name || '未命名') : null, switch: !asProfile,
    }) });
    if (asProfile) { bar('档案已存：' + j.profileName + '（未切换）', 'ok'); }
    else bar('已切换为 ' + j.model + '，写盘完成', 'ok');
    refresh();
    if (!asProfile) {
      if (confirm('写盘成功。现在重启机器人让新模型生效？')) await doRestart(false, true);
    }
  } catch (e) { bar('保存失败：' + e.message, 'bad'); }
}
async function probeAndSwitch() {
  const f = getForm(); if (!f) return;
  if (!f.url || !f.model) return bar('URL 和模型都要有', 'bad');
  const j = await runProbe();
  if (!j) return;
  if (!j.allOk && !confirm('有失败项：\\n' + (j.errors.join('\\n') + '\\n' + j.warnings.join('\\n')) + '\\n\\n仍然切换吗？')) return;
  await doSave(false);
}
async function saveOnly(asProfile) {
  const f = getForm(); if (!f) return;
  if (!f.url || !f.model) return bar('URL 和模型都要有', 'bad');
  await doSave(asProfile);
}

async function doRestart(fromCard, afterSwitch) {
  if (!afterSwitch && !confirm('确认重启机器人？（只重启 bot，SnowLuma 不动，约 6 秒）')) return;
  bar('重启中…', 'busy');
  try {
    await api('/api/restart', { method: 'POST', body: '{}' });
    bar('机器人已重启，约 4 秒后自动恢复', 'ok');
  } catch (e) { bar('重启失败：' + e.message + '（也可以跑一次「一键启动」）', 'bad'); }
  await new Promise(r => setTimeout(r, 1000)); refresh();
}

async function applyProf(id) {
  if (!confirm('启用这套配置？会覆盖当前 llmstate.json（当前配置已被档案保存的才安全）。')) return;
  bar('启用档案中…', 'busy');
  try {
    await api('/api/profiles/apply', { method: 'POST', body: JSON.stringify({ id, verify: true }) });
    bar('档案已启用（启用前快速验证通过）', 'ok');
    refresh();
    if (confirm('现在重启机器人？')) await doRestart(false, true);
  } catch (e) { bar('启用失败：' + e.message, 'bad'); }
}
async function delProf(id) {
  if (!confirm('删除这套档案？（不影响当前生效配置）')) return;
  try { await api('/api/profiles?id=' + id, { method: 'DELETE' }); bar('已删除', 'ok'); refresh(); }
  catch (e) { bar('删除失败：' + e.message, 'bad'); }
}

// ── 功能开关子窗 ──
const SW_LABELS = {
  imggen: '画画 / 改稿路由（关了 @ 点画图回「暂停营业」）',
  vidgenEnabled: '生视频（文生 + 图生）',
  bilibili: 'B站链接免 @ 总结',
  search: '联网搜索（Exa，关了模型就没搜索工具）',
  repeat: '+1 复读',
  beacon: '寻呼信标「柴郡柴郡」',
};
function swSummary(sw) {
  const on = Object.keys(SW_LABELS).filter((k) => sw[k]);
  const off = Object.keys(SW_LABELS).filter((k) => !sw[k]);
  return '开：' + (on.length ? on.map((k) => SW_LABELS[k].split('（')[0].split('「')[0]).join(' · ') : '无')
    + (off.length ? '　｜　关：' + off.map((k) => SW_LABELS[k].split('（')[0].split('「')[0]).join(' · ') : '');
}
async function openSw() {
  try {
    const j = await api('/api/switches');
    $('sw_list').innerHTML = Object.entries(SW_LABELS).map(([k, l]) =>
      '<label style="display:block;margin:7px 0"><input type="checkbox" id="sw_' + k + '"' + (j.switches[k] ? ' checked' : '') + '> '
      + esc(l) + (k === 'vidgenEnabled' ? ' <span class="hint">（缺省跟 config：' + j.defaults.vidgenEnabled + '）</span>' : '') + '</label>').join('');
    $('sw_txt').textContent = swSummary(j.switches);
    $('sw_modal').style.display = '';
  } catch (e) { bar('读开关失败：' + e.message, 'bad'); }
}
function closeSw() { $('sw_modal').style.display = 'none'; }
async function saveSw() {
  const flags = {};
  for (const k of Object.keys(SW_LABELS)) flags[k] = $('sw_' + k).checked;
  try {
    const j = await api('/api/switches', { method: 'POST', body: JSON.stringify(flags) });
    $('sw_txt').textContent = swSummary(j.switches);
    bar('开关已保存，即刻生效（不用重启）', 'ok');
    closeSw();
  } catch (e) { bar('开关保存失败：' + e.message, 'bad'); }
}

// ── 生图/生视频 API ──
function mtoggle() { const k = $('m_key'); k.type = k.type === 'password' ? 'text' : 'password'; }
function vtoggle() { const k = $('v_key'); k.type = k.type === 'password' ? 'text' : 'password'; }
async function loadMedia() {
  try {
    const j = await api('/api/media');
    $('m_url').value = j.imggen.url || ''; $('m_model').value = j.imggen.model || ''; $('m_size').value = j.imggen.size || '';
    $('v_url').value = j.vidgen.url || ''; $('v_model').value = j.vidgen.model || ''; $('v_max').value = j.vidgen.maxSeconds || 15;
  } catch (e) { bar('读生图/生视频配置失败：' + e.message, 'bad'); }
}
async function saveMedia(side) {
  const b = side === 'imggen'
    ? { imggenUrl: $('m_url').value.trim(), imggenKey: $('m_key').value, imggenModel: $('m_model').value.trim(), imggenSize: $('m_size').value.trim() }
    : { vidgenUrl: $('v_url').value.trim(), vidgenKey: $('v_key').value, vidgenModel: $('v_model').value.trim(), vidgenMaxSeconds: Number($('v_max').value) || 15 };
  try {
    await api('/api/media', { method: 'POST', body: JSON.stringify(b) });
    bar('已保存（' + (side === 'imggen' ? '生图' : '生视频') + '）——重启机器人后生效', 'ok');
    if (confirm('现在重启机器人让 API 配置生效？')) await doRestart(false, true);
  } catch (e) { bar('保存失败：' + e.message, 'bad'); }
}
async function testImggen() {
  if (!confirm('真生成一张最小测试图（花一张图的钱，结果不进群直接丢弃）？')) return;
  bar('生图实测中（十几秒到一分钟）…', 'busy');
  try {
    const j = await api('/api/imggen-test', { method: 'POST', body: '{}' });
    bar('生图通了！返回 ' + Math.round(j.bytes / 1024) + 'KB 图（未进群）', 'ok');
  } catch (e) { bar('生图实测失败：' + e.message, 'bad'); }
}

refresh();
initDrop();
loadMedia();
</script></body></html>`;
