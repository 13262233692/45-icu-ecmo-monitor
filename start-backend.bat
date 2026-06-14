@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
echo ================================================
echo   ICU ECMO 监护系统 - 后端网关启动
echo   High-Reliability Medical Data Gateway
echo ================================================
echo.

cd /d "%~dp0backend"

where mvn >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Maven not found in PATH. Please install Maven first.
    pause
    exit /b 1
)

where java >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Java not found in PATH. Please install JDK 17+.
    pause
    exit /b 1
)

echo [INFO] Building backend with Maven...
call mvn clean package -DskipTests
if %errorlevel% neq 0 (
    echo [ERROR] Maven build failed.
    pause
    exit /b 1
)

echo.
echo [INFO] Starting ECMO Gateway Application...
echo [INFO] TCP Port: 7000   WebSocket Port: 8080   Simulator: ENABLED
echo.

set JAR_FILE=target\icu-ecmo-monitor-1.0.0.jar
if exist "%JAR_FILE%" (
    java -Xms512m -Xmx2048m -XX:+UseG1GC -jar "%JAR_FILE%"
) else (
    echo [ERROR] JAR file not found: %JAR_FILE%
    pause
    exit /b 1
)

endlocal
