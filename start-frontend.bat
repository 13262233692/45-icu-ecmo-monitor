@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
echo ================================================
echo   ICU ECMO 监护系统 - 前端大屏启动
echo   React + Offscreen Canvas2D Rendering Engine
echo ================================================
echo.

cd /d "%~dp0frontend"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH. Please install Node.js 18+.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing dependencies (first run)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo [INFO] Starting Vite Dev Server...
echo [INFO] Open http://localhost:3000 in your browser
echo.

call npm run dev

endlocal
