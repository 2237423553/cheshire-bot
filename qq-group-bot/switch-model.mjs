// ═══════════════════════════════════════════════════════════════════════
//  本地换模型工具 —— 双击「切换模型.cmd」运行
//
//  流程：输 URL + Key -> 拉模型列表 -> 选一个 -> 验证能跑 -> 写 llmstate.json
//  改的是 llmstate.json，不动 config.mjs；删掉 llmstate.json 就恢复默认。
//
//  也可以带参数直接跑（不用交互）：
//    bun run switch-model.mjs <url> <key> [模型名]
//    bun run switch-model.mjs --show          只看当前配置
//    bun run switch-model.mjs --list          用当前 URL+Key 重拉列表
// ═══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { execFileSync, spawn } from 'node:child_process';
import { cfg } from './config.mjs';
import { normalizeChatUrl, modelsUrlOf, fetchModels, probeModel, maskKey, parseHeaders } from './providers.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dir, 'llmstate.json');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  hi: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function showState() {
  console.log('');
  console.log(c.bold('  当前配置'));
  console.log(`  模型    ${c.hi(cfg.model)}`);
  console.log(`  端点    ${cfg.llmUrl}`);
  console.log(`  Key     ${maskKey(cfg.llmKey)}`);
  const hs = Object.keys(cfg.llmHeaders ?? {});
  if (hs.length) console.log(`  自定义头 ${hs.join(', ')}`);
  console.log(`  来源    ${fs.existsSync(STATE) ? 'llmstate.json（本地覆盖）' : 'config.mjs（默认值）'}`);
  console.log('');
}

function save({ llmUrl, llmKey, model, modelList, llmHeaders }) {
  const o = { llmUrl, llmKey, model, modelList, llmHeaders: llmHeaders ?? {} };
  fs.writeFileSync(STATE, JSON.stringify(o, null, 2), 'utf8');
  return STATE;
}

/**
 * 重启机器人（只重启 bun，SnowLuma 不动）。
 * ⚠️ 必须用 Start-Process + 重定向，和「一键启动」一致：
 *    直接用 spawn(detached, stdio:'ignore') 起 bun 会静默退出（Windows 上 bun 是 shim）。
 *    重定向还有个好处 —— 出问题能在 bot.log / bot.err 里查到。
 */
function restartBot() {
  const log = path.join(__dir, 'bot.log');
  const err = path.join(__dir, 'bot.err');
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    'Start-Sleep -Seconds 1',
    "$bun = (Get-Command bun).Source",
    `Start-Process -FilePath $bun -ArgumentList 'run','bot.mjs' -WorkingDirectory '${__dir}' -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${err}'`,
    'Start-Sleep -Seconds 4',
    "$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' }).Count",
    'Write-Output ("botproc=" + $n)',
  ].join('; ');
  // ⚠️ stdio 全 ignore：重定向的 bun 子进程会继承父进程的 stdout 管道，
  //    一旦捕获输出，PowerShell 就会一直挂着不退出（项目老坑，见知识库下篇）。
  execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    stdio: 'ignore', windowsHide: true, timeout: 60000,
  });
  // 进程数单独查（这次不重定向子进程，可以安全捕获输出）
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Write-Output ('botproc=' + @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' }).Count)",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (!/botproc=[1-9]/.test(out)) throw new Error('重启后没看到机器人进程，检查 bot.err');
  return true;
}

const args = process.argv.slice(2);

if (args.includes('--show')) {
  showState();
  process.exit(0);
}

// ── 非交互：url key [model] [headers] ──
if (args.length >= 2 && !args[0].startsWith('--')) {
  const chatUrl = normalizeChatUrl(args[0]);
  const key = args[1];
  const extra = parseHeaders(args[3]);
  console.log(`\n  端点  ${chatUrl}`);
  console.log(`  列表  ${modelsUrlOf(chatUrl)}`);
  if (Object.keys(extra).length) console.log(`  自定义头  ${JSON.stringify(extra)}`);
  const ids = await fetchModels(chatUrl, key, extra);
  console.log(c.ok(`  拉到 ${ids.length} 个模型`));

  const model = args[2] ?? (ids.includes(cfg.model) ? cfg.model : ids[0]);
  if (!ids.includes(model)) throw new Error(`列表里没有 ${model}`);
  await probeModel(chatUrl, key, model, extra);
  console.log(c.ok(`  验证通过：${model}`));

  save({ llmUrl: chatUrl, llmKey: key, model, modelList: ids, llmHeaders: extra });
  console.log(c.ok(`  已写入 llmstate.json`));
  try { restartBot(); console.log(c.ok('  机器人已重启')); } catch (e) { console.log(c.bad(`  重启失败：${e.message}`)); }
  process.exit(0);
}

// ── 交互 ──
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, dflt = '') => {
  const a = (await rl.question(dflt ? `${q} ${c.dim(`[${dflt}]`)} ` : `${q} `)).trim();
  return a || dflt;
};

showState();

const urlIn = await ask('  URL（可粘贴 opencode 控制台地址）:');
const keyIn = await ask('  API Key:');
if (!urlIn || !keyIn) {
  console.log(c.bad('\n  URL 和 Key 都要填，退出。'));
  process.exit(1);
}

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
  ids = await fetchModels(chatUrl, keyIn, extra);
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
  process.stdout.write(c.dim(`  验证 ${model} ...`));
  await probeModel(chatUrl, keyIn, model, extra);
  console.log(c.ok(' 通过'));
} catch (e) {
  console.log(c.bad(`\n  ${e.message}\n  没切换，原配置保留。`));
  process.exit(1);
}

save({ llmUrl: chatUrl, llmKey: keyIn, model, modelList: ids, llmHeaders: extra });
console.log(c.ok(`\n  已切换为 ${model}`));
console.log(c.dim(`  写入 ${STATE}`));

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
