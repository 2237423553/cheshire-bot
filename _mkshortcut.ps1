# Create the one-click desktop shortcut.
# ASCII only (PS 5.1 reads .ps1 as ANSI unless BOM) -> Chinese strings are
# built from [char] codes so nothing can turn into mojibake.

$root    = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')

# "一键启动.cmd"
$oneStart = ([string][char]0x4E00) + [char]0x952E + [char]0x542F + [char]0x52A8 + ".cmd"
# "柴郡一键启动.lnk"
$lnkName  = ([string][char]0x67F4) + [char]0x90E1 + [char]0x4E00 + [char]0x952E + [char]0x542F + [char]0x52A8 + ".lnk"

$cmdPath  = Join-Path $root $oneStart
$iconPath = Join-Path $root "qq-group-bot\bot.ico"
$lnkPath  = Join-Path $desktop $lnkName

if (-not (Test-Path $cmdPath)) {
    Write-Output ("ERROR: launcher not found: " + $cmdPath)
    exit 1
}
if (-not (Test-Path $iconPath)) {
    $iconPath = "C:\Windows\System32\shell32.dll,3"
}

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = "cmd.exe"
$lnk.Arguments        = '/c "' + $cmdPath + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation     = $iconPath
$lnk.Description      = "One click start: SnowLuma + Cheshire QQ bot"
$lnk.Save()

Write-Output ("desktop : " + $desktop)
Write-Output ("created : " + $lnkPath)
Write-Output ("target  : " + $lnk.TargetPath + " " + $lnk.Arguments)
if (Test-Path $iconPath) { Write-Output ("icon    : " + $iconPath) }
