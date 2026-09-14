$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host '未检测到 Node.js 18+，请安装：https://nodejs.org/'; Read-Host '按回车退出'; exit 1 }
Start-Process node -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
Start-Sleep -Seconds 2
Start-Process 'http://localhost:5173'
