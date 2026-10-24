// ═══════════════════════════════════════════════════════════════════════
//  机器人进程控制 —— restartBot / isBotRunning（CLI 和 Web 面板共用）
//
//  ⚠️ 必须用 Start-Process + 重定向，和「一键启动」一致：
//     直接用 spawn(detached, stdio:'ignore') 起 bun 会静默退出（Windows 上 bun 是 shim）。
//     重定向还有个好处 —— 出问题能在 bot.log / bot.err 里查到。
//  （从 switch-model.mjs 原样搬出，别重写；两个 Windows 坑注释保留。）
// ═══════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 优先用工作区自带的 bun（../tools/bun.exe）：PATH 里那把是 CherryStudio 捆绑的，
// 它哪天升级/卸载会把机器人的启动链路一起带走（10-24 加固）。没有本地副本才退回 PATH。
const LOCAL_BUN = path.join(__dir, '..', 'tools', 'bun.exe');

/** 数正在跑的 bot.mjs 进程数（独立查询，不重定向子进程，可安全捕获输出） */
export function countBotProcs() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Write-Output ('botproc=' + @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' }).Count)",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return Number(/botproc=(\d+)/.exec(out)?.[1] ?? 0);
}

export function isBotRunning() {
  try { return countBotProcs() > 0; } catch { return false; }
}

/**
 * 重启机器人（只重启 bun，SnowLuma 不动）。成功返回 true，失败抛 Error。
 */
export function restartBot() {
  const log = path.join(__dir, 'bot.log');
  const err = path.join(__dir, 'bot.err');
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    'Start-Sleep -Seconds 1',
    "$bun = " + (fs.existsSync(LOCAL_BUN) ? `'${LOCAL_BUN.replace(/'/g, "''")}'` : "(Get-Command bun).Source"),
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
  if (countBotProcs() < 1) throw new Error('重启后没看到机器人进程，检查 bot.err');
  return true;
}
