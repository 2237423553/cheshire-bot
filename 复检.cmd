@echo off
rem Cheshire Bot - re-run the self check (after clicking "inject")
chcp 65001 >nul
pushd "%~dp0qq-group-bot"
bun run selfcheck.mjs --launch
popd
pause >nul
