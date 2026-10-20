@echo off
rem Launch the QQ group bot (ASCII only - avoids batch codepage issues)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_start.ps1"
pause
