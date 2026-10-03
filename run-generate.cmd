@echo off
rem Run generate.js from Task Scheduler. Log goes to logs\generate-YYYYMMDD.log
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set D=%%i
node generate.js >> "logs\generate-%D%.log" 2>&1
exit /b %ERRORLEVEL%
