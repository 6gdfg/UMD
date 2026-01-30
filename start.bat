@echo off
chcp 65001 >nul
echo ========================================
echo   UMD卡牌游戏服务器启动脚本
echo ========================================
echo.

REM 检查Node.js是否安装
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未检测到Node.js
    echo 请先安装Node.js: https://nodejs.org/
    pause
    exit /b 1
)

echo ✅ Node.js版本:
node -v
echo.

REM 检查是否已安装依赖
if not exist "node_modules\" (
    echo 📦 正在安装依赖...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

REM 检查是否已编译
if not exist "dist\" (
    echo 🔨 正在编译TypeScript...
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo ❌ 编译失败
        pause
        exit /b 1
    )
    echo.
)

echo 🚀 启动服务器...
echo.
call npm start

pause
