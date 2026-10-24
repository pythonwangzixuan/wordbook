@echo off
chcp 65001 >nul
title 背默通 · 局域网共享
cd /d "%~dp0"
node server.js %1
pause
