@echo off
title CardVault
cd /d "%~dp0"
python server.py
if errorlevel 1 (
  echo.
  echo CardVault stopped with an error. If Python is missing, install it from python.org.
  pause
)
