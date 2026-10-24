# QQ group bot launcher - ASCII only on purpose.
# Windows PowerShell 5.1 reads .ps1 as ANSI unless BOM, so no non-ASCII literals.
# Paths come from $PSScriptRoot / runtime lookup instead of being typed out.

$dir = $PSScriptRoot
Write-Output ("workdir : " + $dir)

# Prefer the workspace-local bun copy (..\tools\bun.exe) so the bot keeps
# starting even if the PATH bun (bundled with Cherry Studio) disappears.
$bun = Join-Path (Split-Path $PSScriptRoot -Parent) "tools\bun.exe"
if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source }
if (-not $bun) {
    Write-Output "ERROR: 'bun' not found in PATH. Install bun or fix PATH first."
    exit 1
}
Write-Output ("bun     : " + $bun)

# --- precheck: is SnowLuma's OneBot HTTP port up? (bot waits if not, but warn early) ---
$tcp = New-Object System.Net.Sockets.TcpClient
try {
    $tcp.Connect("127.0.0.1", 3000)
    $tcp.Close()
    Write-Output "OneBot  : OK (port 3000 listening)"
} catch {
    Write-Output "OneBot  : NOT READY (port 3000 not listening)"
    Write-Output "        -> Start SnowLuma first, open its WebUI and click process-inject."
    Write-Output "        -> The bot will wait and auto-connect for up to 10 minutes."
}

# --- stop any previous instance so double-clicking never makes two bots ---
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "bun.exe" -and $_.CommandLine -like "*bot.mjs*" } |
    ForEach-Object {
        Write-Output ("stop old PID " + $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 1

# --- start detached (hidden window, survives closing this console) ---
$log = Join-Path $dir "bot.log"
$err = Join-Path $dir "bot.err"
Start-Process -FilePath $bun -ArgumentList "run", "bot.mjs" `
    -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $err

Write-Output "started (hidden + detached)"
Start-Sleep -Seconds 6

Write-Output "---- bot.log ----"
if (Test-Path $log) { Get-Content $log -Tail 12 -Encoding UTF8 }
Write-Output "---- bot.err ----"
if (Test-Path $err) { $e = Get-Content $err -Tail 5 -Encoding UTF8; if ($e) { $e } else { "(empty)" } }
Write-Output ""
Write-Output "Done. The bot keeps running in the background."
