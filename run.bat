@echo off
setlocal
title Code Studio - keep this window open
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found. The Code Studio launcher needs Node.js 18 or newer.
  echo.
  echo  Install it with this command, then double-click run.bat again:
  echo.
  echo      winget install OpenJS.NodeJS.LTS
  echo.
  echo  Or download it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js
echo.
echo  Code Studio has stopped.
pause
