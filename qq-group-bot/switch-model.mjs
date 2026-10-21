// ═══════════════════════════════════════════════════════════════════════
//  本地换模型工具 —— 双击「切换模型.cmd」运行
//
//  流程：URL（默认当前值，回车沿用）-> Key（掩码输入）-> 自定义头 -> 拉列表
//        -> 选模型 -> 快速验证 -> （可选）四件套深度探测 -> 选思考档
//        -> 写 llmstate.json -> 重启？
//
//  改的是 llmstate.json，不动 config.mjs；删掉 llmstate.json 就恢复默认。
//  写盘统一走 llm-state.mjs（唯一写入口），重启统一走 botctl.mjs。
//
//  也可以带参数直接跑（不用交互）：
//    bun run switch-model.mjs <url> <key> [模型名] [headers] [--restart]
//    bun run switch-model.mjs --show          只看当前配置
//    bun run switch-model.mjs --list          用当前 URL+Key 重拉列表
//    bun run switch-model.mjs --probe [模型]  对当前/指定模型跑四件套深度探测
// ═══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { cfg } from './config.mjs';
import { normalizeChatUrl, modelsUrlOf, fetchModels, probeModel, maskKey, parseHeaders } from './providers.mjs';
import { saveState, loadState, STATE_PATH, listProfiles, activeProfileId } from './llm-state.mjs';
import { restartBot, isBotRunning } from './botctl.mjs';
import { runProbeSuite } from './probe-suite.mjs';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  hi: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const THINK_LABELS = {
  default: '不传思考参数',
  auto: 'auto（模型自己决定）',
  enabled: 'enabled（强制思考）',
  disabled: 'disabled（不思考）',
};
const thinkingLabel = (t) =>
  !t ? 'config.mjs 默认'
  : typeof t === 'string' ? (THINK_LABELS[t] ?? t)
  : THINK_LABELS[t?.type] ?? JSON.stringify(t);

function showState() {
  const st = loadState();
  console.log('');
  console.log(c.bold('  当前配置'));
  console.log(`  模型     ${c.hi(cfg.model)}`);
  console.log(`  端点     ${cfg.llmUrl}`);
  console.log(`  Key      ${maskKey(cfg.llmKey)}`);
  console.log(`  思考档   ${thinkingLabel(cfg.thinking)}`);
  const hs = Object.keys(cfg.llmHeaders ?? {});
  if (hs.length) console.log(`  自定义头  ${hs.join(', ')}`);
  console.log(`  来源     ${st ? 'llmstate.json（本地覆盖）' : 'config.mjs（默认值）'}`);
  const db = listProfiles();
  if (db.profiles.length) {
    const act = db.profiles.find((p2) => p2.id === db.activeId);
    console.log(`  档案     ${db.profiles.length} 套${act ? `，当前生效：${act.name}` : ''}（Web 面板可管理）`);
  }
  console.log(`  机器人   ${isBotRunning() ? c.ok('运行中') : c.bad('没在跑')}`);
  console.log('');
}

// ── Key 掩码输入：raw 模式逐字符回显 *；不可用（管道/非 TTY）降级明文 ──
async function askKey(rl, prompt, dflt) {
  if (dflt) prompt += c.dim(` [回车沿用 ${dflt}] `);
  process.stdout.write(prompt);
  let rawOK = false;
  try {
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); rawOK = true; }
  } catch { /* bun/Windows 兼容问题时走明文 */ }
  if (!rawOK) {
    const a = await rl.question('');
    return a.trim();
  }
  // ⚠️ raw 模式和 readline 并存：先暂停 rl 的监听，输完恢复
  rl.pause();
  return await new Promise((resolve) => {
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        cleanup(); rl.resume(); process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {          // Ctrl+C
        cleanup(); process.stdout.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (ch >= ' ') {
        buf += ch; process.stdout.write('*');
      }
    };
    const cleanup = () => { process.stdin.setRawMode(false); process.stdin.removeListener('data', onData); };
    process.stdin.on('data', onData);
  });
}

const args = process.argv.slice(2);

if (args.includes('--show')) {
  showState();
  process.exit(0);
}

// ── --list：用当前 URL+Key 重拉列表（实装，旧版只有注释）──
if (args.includes('--list')) {
  try {
    const ids = await fetchModels(cfg.llmUrl, cfg.llmKey, cfg.llmHeaders ?? {});
    console.log(c.ok(`\n  当前端点拉到 ${ids.length} 个模型（${maskKey(cfg.llmKey)}）：\n`));
    ids.forEach((m, i) => {
      const mark = m === cfg.model ? c.ok('▶') : ' ';
      console.log(`  ${mark} ${String(i + 1).padStart(2)}. ${m}`);
    });
  } catch (e) {
    console.log(c.bad(`\n  拉列表失败：${e.message}`));
    process.exit(1);
  }
  process.exit(0);
}

// ── --probe [model]：四件套深度探测（不改任何配置）──
if (args.includes('--probe')) {
  const model = args[args.indexOf('--probe') + 1] ?? cfg.model;
  console.log(`\n  四件套探测 ${cfg.llmUrl} / ${c.hi(model)}，结果只显示不落盘\n`);
  try {
    const out = await runProbeSuite(cfg.llmUrl, cfg.llmKey, model, cfg.llmHeaders ?? {});
    const it = out.items;
    const sym = (ok, warn) => (ok === true && !warn ? c.ok('√') : ok === true && warn ? c.hi('⚠') : c.bad('×'));
    const tiers = Object.entries(it.thinking.tiers ?? {});
    console.log(`  基础生成    ${sym(it.basic?.ok)}  ${it.basic?.detail ?? ''} ${it.basic?.latencyMs ? `(${Math.round(it.basic.latencyMs)}ms)` : ''}`);
    for (const [t, v] of tiers) {
      console.log(`  thinking.${String(t).padEnd(8)} ${v.accepted ? c.ok('√ 接受') : c.bad('× ' + v.kind)}${v.reasoningPresent ? c.dim('（有思考）') : ''}${v.latencyMs ? c.dim(` ${Math.round(v.latencyMs)}ms`) : ''}`);
    }
    console.log(`  推荐思考档  ${JSON.stringify(it.thinking?.recommended ?? 'default')}  ${c.dim(it.thinking?.detail ?? '')}`);
    console.log(`  工具调用    ${sym(it.tools?.ok, it.tools?.warning)}  ${it.tools?.detail ?? ''}`);
    console.log(`  图片视觉    ${sym(it.vision?.ok, it.vision?.kindExtra === 'ok-loose')}  ${it.vision?.detail ?? ''}`);
    console.log('');
    if (out.warnings.length) console.log(`  ${c.hi('⚠ 警告')}\n    ${out.warnings.join('\n    ')}`);
    if (out.errors.length) console.log(`  ${c.bad('✗ 错误')}\n    ${out.errors.join('\n    ')}`);
    console.log(`  ${c.bold(out.allOk ? '总评：全绿，可以放心切' : '总评：有失败项 —— 请对照确认再决定')}`);
    console.log(c.dim(`  耗时 ${Math.round(out.durationMs / 1000)}s`));
  } catch (e) {
    console.log(c.bad(`  探测失败：${e.message}`));
    process.exit(1);
  }
  process.exit(0);
}

// ── 非交互：url key [model] [headers] [--restart]（异常友好化，验证不过不写盘；--restart 才重启）──
if (args.length >= 2 && !args[0].startsWith('--')) {
  const wantRestart = args.includes('--restart');
  const positional = args.filter((a) => a !== '--restart').slice(0, 4);
  try {
    const [url, key, model, hdrs] = positional;
    const chatUrl = normalizeChatUrl(url);
    const extra = parseHeaders(hdrs);
    console.log(`\n  端点  ${chatUrl}`);
    console.log(`  列表  ${modelsUrlOf(chatUrl)}`);
    if (Object.keys(extra).length) console.log(`  自定义头  ${JSON.stringify(extra)}`);
    const ids = await fetchModels(chatUrl, key, extra);
    console.log(c.ok(`  拉到 ${ids.length} 个模型`));

    const m = model ?? (ids.includes(cfg.model) ? cfg.model : ids[0]);
    if (!ids.includes(m)) throw new Error(`列表里没有 ${m}`);
    await probeModel(chatUrl, key, m, extra);
    console.log(c.ok(`  验证通过：${m}`));

    saveState({ llmUrl: chatUrl, llmKey: key, model: m, modelList: ids, llmHeaders: extra });
    console.log(c.ok(`  已写入 llmstate.json`));
    if (wantRestart) {
      try { restartBot(); console.log(c.ok('  机器人已重启')); }
      catch (e) { console.log(c.bad(`  重启失败：${e.message}`)); }
    } else {
      console.log(c.dim('  未重启（加 --restart 让它立即生效，或下次启动生效）'));
    }
  } catch (e) {
    console.log(c.bad(`\n  切换失败：${e.message}\n  没写盘，原配置保留。`));
    process.exit(1);
  }
  process.exit(0);
}

// ── 交互 ──
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, dflt = '') => {
  const a = (await rl.question(dflt ? `${q} ${c.dim(`[${dflt}]`)} ` : `${q} `)).trim();
  return a || dflt;
};

showState();

const urlIn = await ask('  URL（可粘贴官网控制台/常见大厂地址；回车沿用当前）:', cfg.llmUrl);
console.log(c.dim(`  Key：回车沿用当前（${maskKey(cfg.llmKey)}），或输入新 Key（输入内容显示为 *）`));
const keyIn = await askKey(rl, '  API Key:', maskKey(cfg.llmKey));
if (!keyIn && !cfg.llmKey) {
  console.log(c.bad('\n  没有 Key 可沿用，退出。'));
  process.exit(1);
}
const useKey = keyIn || cfg.llmKey;
const urlChanged = normalizeChatUrl(urlIn) !== normalizeChatUrl(cfg.llmUrl);

// 自定义请求头：直接回车 = 沿用当前配置；输入 "-" = 清空
const curHdrs = Object.entries(cfg.llmHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
console.log(c.dim('\n  自定义请求头（可留空）。写法示例：'));
console.log(c.dim('    HTTP-Referer: https://example.com'));
console.log(c.dim('    X-Title: MyBot'));
console.log(c.dim('  多个头换行或用逗号分隔。直接回车 = 保持现状，输入 - = 清空。'));
const hdrIn = (await rl.question('  请求头: ')).trim();
let extra = {};
if (hdrIn === '-') {
  extra = {};
} else if (!hdrIn) {
  extra = { ...(cfg.llmHeaders ?? {}) };
} else {
  try {
    extra = parseHeaders(hdrIn);
  } catch (e) {
    console.log(c.bad(`\n  ${e.message}`));
    process.exit(1);
  }
}
if (Object.keys(extra).length) console.log(c.dim(`  将带上：${Object.keys(extra).join(', ')}`));

let chatUrl, ids;
try {
  chatUrl = normalizeChatUrl(urlIn);
  console.log(c.dim(`\n  端点 -> ${chatUrl}`));
  console.log(c.dim(`  列表 -> ${modelsUrlOf(chatUrl)}`));
  ids = await fetchModels(chatUrl, useKey, extra);
} catch (e) {
  console.log(c.bad(`\n  ${e.message}`));
  process.exit(1);
}

console.log(c.ok(`\n  拉到 ${ids.length} 个模型：\n`));
ids.forEach((m, i) => {
  const mark = m === cfg.model ? c.ok('▶') : ' ';
  console.log(`  ${mark} ${String(i + 1).padStart(2)}. ${m}`);
});

const pick = await ask('\n  选序号或直接输模型名:', String(ids.indexOf(cfg.model) + 1 || 1));
let model = /^\d+$/.test(pick) ? ids[Number(pick) - 1] : pick;
if (!model || !ids.includes(model)) {
  console.log(c.bad('\n  没这个模型，退出。'));
  process.exit(1);
}

try {
  process.stdout.write(c.dim(`  快速验证 ${model} ...`));
  await probeModel(chatUrl, useKey, model, extra);
  console.log(c.ok(' 通过'));
} catch (e) {
  console.log(c.bad(`\n  ${e.message}\n  没切换，原配置保留。`));
  process.exit(1);
}

// 四件套深度探测（可选，y 才跑）
if ((await ask('  跑四件套深度探测？（基础/思考档/工具/视觉，y/N)', 'N')).toLowerCase() === 'y') {
  try {
    const out = await runProbeSuite(chatUrl, useKey, model, extra);
    const it = out.items;
    if (it.basic?.ok) console.log(c.ok(`  基础生成 √ ${out.items.basic.detail}`));
    else console.log(c.bad(`  基础生成 × ${it.basic?.detail}`));
    const tiers = Object.entries(it.thinking.tiers ?? {});
    console.log(c.dim(`  思考档接受：${tiers.map(([t, v]) => `${t}=${v.accepted ? '√' : v.kind}`).join(' ')} → 推荐 ${JSON.stringify(it.thinking.recommended ?? 'default')}`));
    console.log(`  工具调用 ${it.tools.ok ? (it.tools.warning ? c.hi('⚠ ' + it.tools.detail) : c.ok('√ ' + it.tools.detail)) : c.bad('× ' + it.tools.detail)}`);
    console.log(`  图片视觉 ${it.vision.ok ? (it.vision.kindExtra === 'ok-loose' ? c.hi('△ ' + it.vision.detail) : c.ok('√ ' + it.vision.detail)) : c.bad('× ' + it.vision.detail)}`);
    if (out.errors.length) console.log(c.bad(`  错误：${out.errors.join('；')}`));
    if (out.warnings.length) console.log(c.hi(`  警告：${out.warnings.join('；')}`));
  } catch (e) {
    console.log(c.bad(`  四件套没跑成（不影响切换）：${e.message}`));
  }
}

// 思考档：默认保持现状
const tkIn = await ask('  思考档 1=保持现状 2=不传 3=auto 4=enabled 5=disabled', '1');
const THINK_CHOICE = { '2': 'default', '3': { type: 'auto' }, '4': { type: 'enabled' }, '5': { type: 'disabled' } };
// 保持现状 = 写入当前生效值（llmstate 覆盖 config，得显式带上才稳）
const thinking = THINK_CHOICE[tkIn] ?? cfg.thinking ?? 'default';

saveState({ llmUrl: chatUrl, llmKey: useKey, model, thinking, modelList: ids, llmHeaders: extra });
console.log(c.ok(`\n  已切换为 ${model}（思考档：${thinkingLabel(thinking)}）`));
console.log(c.dim(`  写入 ${STATE_PATH}`));

const doRestart = (await ask('  现在重启机器人？(Y/n)', 'Y')).toLowerCase();
if (doRestart !== 'n') {
  try {
    restartBot();
    console.log(c.ok('  机器人已重启，新模型生效'));
  } catch (e) {
    console.log(c.bad(`  重启失败：${e.message}（手动跑一次「一键启动」也行）`));
  }
} else {
  console.log(c.dim('  没重启 —— 下次启动机器人时生效'));
}

rl.close();
