@echo off
chcp 65001 >nul
title 背默通 · 公网访问（Cloudflare Tunnel）
cd /d "%~dp0"

netstat -ano | findstr /r /c:":8765 .*LISTENING" >nul
if errorlevel 1 (
  echo 正在启动本机服务...
  start "" /min node server.js
  timeout /t 3 >nul
)

set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CF% set CF="C:\Program Files\cloudflared\cloudflared.exe"
if not exist %CF% set CF=cloudflared

echo.
echo 下面日志中会出现形如 https://xxxx.trycloudflare.com 的公网地址
echo 关闭此窗口即断开公网访问（本机服务继续运行）
echo.
%CF% tunnel --url http://localhost:8765 --no-autoupdate
pause
