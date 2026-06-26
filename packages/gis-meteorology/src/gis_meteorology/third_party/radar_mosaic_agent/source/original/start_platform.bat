@echo off
cd /d "%~dp0"
echo Radar Mosaic Platform
echo %cd%
echo.
D:\anaconda\python.exe -B run_backend.py
pause
