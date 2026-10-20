@echo off
rem Cheshire Bot - switch LLM model (local, interactive)
chcp 65001 >nul
cd /d "%~dp0qq-group-bot"
bun run switch-model.mjs
echo.
pause >nul
