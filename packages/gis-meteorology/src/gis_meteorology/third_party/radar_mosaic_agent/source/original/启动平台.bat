@echo off
cd /d "%~dp0"
echo ========================================
echo   Radar Mosaic - Force Start
echo ========================================
echo.

echo [1/3] Stopping old processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5055 ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul
echo Done.
timeout /t 2 /nobreak >nul

echo [2/3] Cleaning cache...
if exist "__pycache__" rmdir /s /q "__pycache__" 2>nul
echo Done.

echo [3/3] Starting backend...
echo.
echo ========================================
echo   Server starting on http://127.0.0.1:5055
echo   Keep this window open
echo   Press Ctrl+C to stop
echo ========================================
echo.
D:\anaconda\python.exe -B run_backend.py
pause
