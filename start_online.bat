@echo off
chcp 65001 >nul
title 🐺 6人狼人殺 — 全球外網連線啟動器
cd /d "%~dp0"
python start_online.py
pause
