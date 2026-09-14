@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js 18 或更高版本。
  echo 请先安装：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动《圈层谣言攻防战》...
start "圈层谣言攻防战服务" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5173"
echo 游戏已打开。不要关闭后台服务窗口。
exit /b 0
