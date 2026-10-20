// ═══════════════════════════════════════════════════════════════════════
//  自检报告 —— 打印一张「按项目打勾」的体检表
//
//  用法：  bun run selfcheck.mjs      （或双击工作区的「复检.cmd」）
//  说明：  基础自检 = 本地检查，秒出
//          功能自检 = 真的打一次 LLM / 搜索接口（消耗极少量额度）
//  安全：  本文件只做探测 —— 不发群消息、不改任何数据
// ═══════════════════════════════════════════════════════════════════════
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { SnowLumaHttpClient } from '@snowluma/sdk';
import { cfg } from './config.mjs';

// foods.mjs 用动态导入包一层 —— 万一清单文件被改坏了，自检要能报「清单加载失败」，
// 而不是自己跟着崩掉、连体检表都打印不出来。
let FOODS = null;
let FOODS_ERR = '';
try {
  FOODS = await import('./foods.mjs');
} catch (e) {
  FOODS_ERR = e.message;
}

// 同理，exa.mjs 也包一层：坏了要能报出来，而不是自检脚本自己崩
let EXA = null;
let EXA_ERR = '';
try {
  EXA = await import('./exa.mjs');
} catch (e) {
  EXA_ERR = e.message;
}

// ─────────── 结果收集 ───────────
const OK = 'ok';       // 通过      √
const BAD = 'bad';     // 异常      ×
const WAIT = 'wait';   // 等你注入  ·

const GLYPH = { ok: '√', bad: '×', wait: '·' };
const rows = [];
const add = (group, name, state, detail = '') => rows.push({ group, name, state, detail });

// 中文按 2 格算宽度，列表才对得齐
const width = (s) => [...s].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// ─────────── 探测工具 ───────────
function tcpProbe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch { /* 忽略 */ } resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', timeout: 25000, windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

// 一次 PowerShell 拿到三个进程的存活情况（别开三次，慢）
function processSnapshot() {
  const out = ps(
    "$ErrorActionPreference='SilentlyContinue';" +
    "$qq=@(Get-Process -Name QQ -ErrorAction SilentlyContinue).Count;" +
    // ⚠️ 不能只用 '*SnowLuma*' —— PowerShell 的 -like 不区分大小写，
    //    会把 Cherry Studio 的 snowluma-mcp（@snowluma\mcp\dist\server.js）误认成 SnowLuma 本体。
    //    认「跑的是 index.mjs」且「不是 mcp」才准。
    "$snow=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*index.mjs*' -and $_.CommandLine -notlike '*mcp*' }).Count;" +
    "$bot=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' }).Count;" +
    "Write-Output (\"qq=\"+$qq+\" snow=\"+$snow+\" bot=\"+$bot)"
  );
  const m = /qq=(\d+)\s+snow=(\d+)\s+bot=(\d+)/.exec(out);
  return m ? { qq: +m[1], snow: +m[2], bot: +m[3] } : { qq: -1, snow: -1, bot: -1 };
}

// ─────────── 功能自检：LLM ───────────
// 请求头必须和 bot.mjs 的 callLLM 一模一样 —— 少一个就报 MissingSessionID
async function probeLLM() {
  const ctrl = new AbortController();
  // 60s：MiMo 自带思考，冷启动时确实会慢到十几秒，30s 会误报超时
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(cfg.llmUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.llmKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'qq-group-bot/1.0',
        'x-opencode-session': 'selfcheck-probe',   // 和 bot.mjs 一样带上，OpenCode Go 建议每个会话一个稳定 ID
        ...(cfg.llmHeaders ?? {}),                 // 自定义头（#接口 / 切换模型.cmd 配的）
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '只回复一个字：好' }],
        // 和 bot.mjs 的 callLLM 保持一致：thinking 为 'default' 或不配时都不传
        ...(cfg.thinking && cfg.thinking !== 'default' ? { thinking: cfg.thinking } : {}),
      }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { state: BAD, detail: `HTTP ${r.status} ${clip(JSON.stringify(j.error ?? j), 40)}` };
    const msg = j.choices?.[0]?.message ?? {};
    const out = clip(msg.content || msg.reasoning_content, 12);
    return { state: OK, detail: `${cfg.model} 响应正常${out ? `：${out}` : ''}` };
  } catch (e) {
    return { state: BAD, detail: e.name === 'AbortError' ? '请求超时(>60s)' : clip(e.message, 40) };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────── 功能自检：Exa 搜索 ───────────
async function probeExa() {
  if (!EXA) return { state: BAD, detail: `exa.mjs 加载失败：${clip(EXA_ERR, 40)}` };
  try {
    const text = await EXA.search('hello world', 'selfcheck smoke test', 1);
    if (!text?.trim()) return { state: BAD, detail: 'MCP 返回为空' };
    return { state: OK, detail: `MCP 可用，返回 ${text.length} 字` };
  } catch (e) {
    return { state: BAD, detail: e.name === 'TimeoutError' ? '请求超时' : clip(e.message, 40) };
  }
}

// ─────────── 功能自检：QQ 身份（要 OneBot 活着）───────────
async function probeIdentity() {
  try {
    const http = new SnowLumaHttpClient({ baseUrl: cfg.obHttp, accessToken: cfg.obHttpToken });
    const me = await http.getLoginInfo();
    if (!me?.user_id) return { state: BAD, detail: '返回里没有 user_id' };
    return { state: OK, detail: `${me.nickname} (UIN ${me.user_id})` };
  } catch (e) {
    return { state: BAD, detail: clip(e.message, 40) };
  }
}

// ─────────── 功能自检：#吃什么 的饭食抽签器 ───────────
// 真跑 6 轮抽签（共 18 道），验证：清单能加载、真随机不重复、中西搭配正常。
// 不联网、不调模型，瞬间出结果。
function probeFood() {
  if (!FOODS) return { state: BAD, detail: `foods.mjs 加载失败：${clip(FOODS_ERR, 40)}` };
  try {
    const total = FOODS.foodCount();
    if (!total) return { state: BAD, detail: '饭食清单是空的 —— foods.mjs 坏了' };

    const seen = new Set();
    const recent = [];
    let west = 0;
    for (let i = 0; i < 6; i++) {
      const m = FOODS.pickThree(recent);
      const names = [m.breakfast.name, m.lunch.name, m.dinner.name];
      west += [m.breakfast, m.lunch, m.dinner].filter((x) => x.west).length;
      names.forEach((n) => seen.add(n));
      recent.push(...names);
    }

    const dup = 18 - seen.size;
    if (dup > 0) return { state: BAD, detail: `清单 ${total} 道，但连抽 18 道就撞了 ${dup} 个` };
    return { state: OK, detail: `清单 ${total} 道 · 连抽 18 道 0 重复 · 含西式 ${west} 道` };
  } catch (e) {
    return { state: BAD, detail: clip(e.message, 40) };
  }
}

// ─────────── 打印体检表 ───────────
function print() {
  const line = '═'.repeat(56);
  const thin = '─'.repeat(56);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  console.log('');
  console.log(line);
  console.log(`  柴郡机器人 · 自检报告        ${now}`);
  console.log(line);

  let group = '';
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      console.log('');
      console.log(`【${group}】`);
    }
    console.log(`  ${GLYPH[r.state]} ${pad(r.name, 18)}${r.detail}`);
  }

  const ok = rows.filter((r) => r.state === OK).length;
  const wait = rows.filter((r) => r.state === WAIT).length;
  const bad = rows.filter((r) => r.state === BAD).length;

  console.log('');
  console.log(thin);
  console.log(`  结果：${ok} / ${rows.length} 通过` +
    (wait ? `　·　${wait} 项待注入` : '') + (bad ? `　·　${bad} 项异常` : ''));
  console.log('');

  if (wait) {
    console.log('  👉 带 · 的项目，去管理后台点一下「进程注入」就会变绿：');
    console.log('       http://127.0.0.1:5099');
    console.log('  👉 点完机器人会自动连上，不用重启；之后双击「复检.cmd」看全绿');
    console.log('');
  }
  if (bad) {
    console.log('  👉 带 × 的项目看上面详情；还是不行就查 bot.err / SnowLuma.err');
    console.log('');
  }
  if (!wait && !bad) {
    console.log('  🎉 全部通过，机器人已经在群里待命了喵~');
    console.log('');
  }
  console.log(line);

  // --launch 时多打一行中文收尾（放在这个 UTF-8 文件里，避免 cmd 的 GBK 乱码）
  if (process.argv.includes('--launch')) {
    console.log('  按任意键关闭本窗口（SnowLuma / 机器人会继续在后台运行）…');
    console.log('');
  }
}

// ─────────── 主流程 ───────────
async function main() {
  // ① 基础自检（本地，秒出）
  add('基础自检', '运行时', OK, `Bun v${process.versions.bun ?? '?'} · Node ${process.versions.node}`);

  const NEED = ['llmKey', 'model', 'llmUrl', 'obHttp', 'obWs',
    'obHttpToken', 'obWsToken', 'exaMcpUrl', 'systemPrompt'];
  const missing = NEED.filter((k) => !cfg[k]);
  add('基础自检', '配置文件', missing.length ? BAD : OK,
    missing.length ? `缺字段：${missing.join(' ')}` : `${NEED.length} 项关键配置齐全`);

  const proc = processSnapshot();
  add('基础自检', 'QQ 进程', proc.qq > 0 ? OK : BAD,
    proc.qq > 0 ? `${proc.qq} 个 QQ.exe` : 'QQ 没开 —— 先登录 QQ');

  // 重复实例是真坑：第二个会抢不到 5099 退到 5100，还会抢 QQ 会话和媒体 rkey
  if (proc.snow === 1) {
    add('基础自检', 'SnowLuma 进程', OK, '运行中（唯一实例）');
  } else if (proc.snow > 1) {
    add('基础自检', 'SnowLuma 进程', BAD,
      `发现 ${proc.snow} 个实例！会抢端口和媒体凭据 —— 只能留 1 个，跑一次「一键启动.cmd」`);
  } else {
    add('基础自检', 'SnowLuma 进程', BAD, '没启动 —— 跑「一键启动.cmd」');
  }

  add('基础自检', '机器人进程', proc.bot > 0 ? OK : BAD,
    proc.bot > 0 ? '运行中' : '没启动 —— 跑「一键启动.cmd」');

  // ② 功能自检（联网，三条一起发省时间）
  // WebUI 端口不写死 5099：5099 被占时 SnowLuma 会自动退到 5100，
  // 只盯 5099 会把「起在 5100 的那个实例」误判成没启动。
  const webPorts = Array.from({ length: 11 }, (_, i) => 5099 + i);
  const [webHits, obHttp, obWs, llm, exa] = await Promise.all([
    Promise.all(webPorts.map(async (p) => (await tcpProbe('127.0.0.1', p)) ? p : 0)),
    tcpProbe('127.0.0.1', 3000),
    tcpProbe('127.0.0.1', 3001),
    probeLLM(),
    probeExa(),
  ]);
  const webui = webHits.filter(Boolean);

  if (webui.length === 1) {
    add('功能自检', '管理后台', OK, `http://127.0.0.1:${webui[0]} 已监听`);
  } else if (webui.length > 1) {
    add('功能自检', '管理后台', BAD,
      `同时开着 ${webui.length} 个后台（${webui.join(' / ')}）—— 有重复实例，只能留 1 个`);
  } else {
    add('功能自检', '管理后台', BAD, '5099-5109 都没监听 —— SnowLuma 未启动');
  }
  add('功能自检', 'OneBot HTTP', obHttp ? OK : WAIT,
    obHttp ? `${cfg.obHttp} 已监听` : '3000 没监听 → 等你点「进程注入」');
  add('功能自检', 'OneBot WS', obWs ? OK : WAIT,
    obWs ? `${cfg.obWs} 已监听` : '3001 没监听 → 等你点「进程注入」');

  if (obHttp) {
    const id = await probeIdentity();
    add('功能自检', 'QQ 身份', id.state, id.detail);
  } else {
    add('功能自检', 'QQ 身份', WAIT, '跳过 —— OneBot 还没注入，连不上');
  }

  add('功能自检', 'LLM 对话', llm.state, llm.detail);
  add('功能自检', '网络搜索', exa.state, exa.detail);

  // #吃什么 的抽签器：真跑 6 轮抽签验证（纯本地、不联网，秒出）
  const food = probeFood();
  add('功能自检', '#吃什么 抽签', food.state, food.detail);

  print();
}

await main();
process.exit(0);
