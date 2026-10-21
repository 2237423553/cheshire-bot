@echo off
rem Cheshire Bot - open local API panel (binds 127.0.0.1 only)
chcp 65001 >nul
cd /d "%~dp0qq-group-bot"
echo Starting panel... browser will open automatically.
start "Cheshire API Panel" /min bun run api-panel.mjs --open
echo Panel starting (default http://127.0.0.1:5098 ; if busy it falls back to 5090-5097)
timeout /t 3 >nul
