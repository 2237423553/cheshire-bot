# Cheshire Bot - ONE CLICK start: SnowLuma + bot + self check + admin page.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless BOM,
# so Chinese literals here would turn into mojibake. All Chinese output comes
# from selfcheck.mjs (UTF-8) instead. See the "pit" notes in the knowledge base.

$root    = $PSScriptRoot
$botDir  = Join-Path $root "qq-group-bot"
$snowDir = Join-Path $root "SnowLuma"

Write-Output "======================================================="
Write-Output "   Cheshire Bot  -  ONE CLICK START"
Write-Output "======================================================="
Write-Output ("workdir : " + $root)

# ---- runtimes ---------------------------------------------------------
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
    Write-Output "ERROR: 'bun' not found in PATH. Install bun first."
    exit 1
}
# SnowLuma ships its own node.exe - the native addons in native/ are ABI-locked
# to it, so we MUST use that one instead of any system node.
$snowNode = Join-Path $snowDir "node.exe"
if (-not (Test-Path $snowNode)) {
    Write-Output ("ERROR: SnowLuma runtime not found: " + $snowNode)
    exit 1
}
Write-Output ("bun     : " + $bun)
Write-Output ("node    : " + $snowNode)

# ---- stop previous instances so double-clicking is always safe ---------
# NOTE: do NOT match "*SnowLuma*" - PowerShell -like is case-insensitive and
# would also match the Cherry Studio MCP server (@snowluma\mcp\dist\server.js),
# killing it. Match "runs index.mjs" and "is not mcp" instead.
Get-CimInstance Win32_Process |
    Where-Object {
        ($_.Name -eq "bun.exe" -and $_.CommandLine -like "*bot.mjs*") -or
        ($_.Name -eq "node.exe" -and $_.CommandLine -like "*index.mjs*" -and $_.CommandLine -notlike "*mcp*")
    } |
    ForEach-Object {
        Write-Output ("stop old PID " + $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 1

# ---- 1/3 SnowLuma -----------------------------------------------------
Write-Output ""
Write-Output "[1/3] starting SnowLuma (hidden -> SnowLuma\snowluma.log) ..."
Start-Process -FilePath $snowNode -ArgumentList "index.mjs" `
    -WorkingDirectory $snowDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $snowDir "snowluma.log") `
    -RedirectStandardError (Join-Path $snowDir "snowluma.err")

$up = $false
$port = 5099   # fallback if never detected
# Scan 5099-5109 (same range as selfcheck.mjs): if 5099 is taken, SnowLuma falls back to 5100
for ($i = 0; $i -lt 60; $i++) {
    foreach ($p in 5099..5109) {
        $tcp = New-Object System.Net.Sockets.TcpClient
        try { $tcp.Connect("127.0.0.1", $p); $tcp.Close(); $up = $true; $port = $p; break } catch { }
    }
    if ($up) { break }
    Start-Sleep -Milliseconds 500
}
if ($up) { Write-Output ("        OK - admin webui is listening on port " + $port) }
else     { Write-Output "        WARN - webui not up yet, see SnowLuma\snowluma.err" }

# ---- 2/3 bot ----------------------------------------------------------
Write-Output "[2/3] starting bot (hidden -> qq-group-bot\bot.log) ..."
Start-Process -FilePath $bun -ArgumentList "run", "bot.mjs" `
    -WorkingDirectory $botDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $botDir "bot.log") `
    -RedirectStandardError (Join-Path $botDir "bot.err")
Start-Sleep -Seconds 2

# ---- 3/3 open the admin page so the user can click "inject" ------------
Write-Output "[3/3] opening the admin page in your browser ..."
Start-Process ("http://127.0.0.1:" + $port)

# ---- self check report -------------------------------------------------
Write-Output ""
Push-Location $botDir
& $bun run selfcheck.mjs --launch
Pop-Location

Write-Output "Services keep running in the background after this window closes."
Write-Output ""
# try/catch: ReadKey throws when there is no real console (e.g. output redirected)
try { [void][System.Console]::ReadKey($true) } catch { Start-Sleep -Seconds 5 }
