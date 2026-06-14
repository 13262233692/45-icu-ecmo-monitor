@echo off
chcp 65001 >nul
echo ================================================
echo   ICU ECMO 监护系统 - 一键启动
echo   请先启动后端，再启动前端
echo ================================================
echo.
echo [1] 启动后端网关 (Java Netty)
echo [2] 启动前端大屏 (React)
echo [3] 启动全部 (后端 + 前端)
echo [4] 仅编译后端 (Maven package)
echo [5] 仅编译前端 (Vite build)
echo [6] 退出
echo.
set /p choice=请选择操作: 

if "%choice%"=="1" (
    start "ECMO Backend" cmd /k "%~dp0start-backend.bat"
    goto :eof
)
if "%choice%"=="2" (
    start "ECMO Frontend" cmd /k "%~dp0start-frontend.bat"
    goto :eof
)
if "%choice%"=="3" (
    start "ECMO Backend" cmd /k "%~dp0start-backend.bat"
    echo 等待后端启动中...
    timeout /t 15 /nobreak >nul
    start "ECMO Frontend" cmd /k "%~dp0start-frontend.bat"
    goto :eof
)
if "%choice%"=="4" (
    cd /d "%~dp0backend"
    call mvn clean package -DskipTests
    pause
    goto :eof
)
if "%choice%"=="5" (
    cd /d "%~dp0frontend"
    if not exist "node_modules" call npm install
    call npm run build
    pause
    goto :eof
)
