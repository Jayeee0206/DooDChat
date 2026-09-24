@echo off
setlocal
chcp 65001 >nul
title DooDChat 一次性朋友房间
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [无法启动] 没有找到 Node.js。
  echo 请先安装 Node.js 20 或更高版本，然后重新双击本文件。
  echo 官方下载地址：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node -e "const m=Number(process.versions.node.split('.')[0]);process.exit(m>=20?0:1)"
if errorlevel 1 (
  echo.
  echo [无法启动] Node.js 版本过低。
  echo 当前版本：
  node --version
  echo 请升级到 Node.js 20 或更高版本。
  echo.
  pause
  exit /b 1
)

node "scripts\windows-launcher.js"
if errorlevel 1 (
  echo.
  echo 启动过程没有完成。请阅读上方中文提示，处理后再试。
  echo.
  pause
  exit /b 1
)

echo.
echo DooDChat 已完成安全关闭，本窗口将在 3 秒后关闭。
"%SystemRoot%\System32\timeout.exe" /t 3 /nobreak >nul 2>nul
exit /b 0
