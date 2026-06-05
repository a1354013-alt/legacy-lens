@echo off
setlocal

cd /d "%~dp0"

echo Starting Legacy Lens demo...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-demo.ps1"

if errorlevel 1 (
  echo.
  echo Legacy Lens demo failed to start.
  echo Please check the error message above.
  pause
  exit /b 1
)

pause