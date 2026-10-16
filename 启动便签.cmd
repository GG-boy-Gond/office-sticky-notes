@echo off
setlocal
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if exist "%~dp0outputs\desktop\win-unpacked\Office Notes.exe" (
  start "" /D "%~dp0outputs\desktop\win-unpacked" "%~dp0outputs\desktop\win-unpacked\Office Notes.exe" "--data-dir=%~dp0data"
  exit /b 0
)
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" "--data-dir=%~dp0data"
  exit /b 0
)
echo Please run npm ci in this folder first.
pause
