@echo off
rem Cheshire Bot - ONE CLICK start (SnowLuma + bot + self check)
rem This file stays ASCII on purpose; chcp 65001 makes the UTF-8 Chinese
rem report from selfcheck.mjs render correctly in the console.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_start-all.ps1"
