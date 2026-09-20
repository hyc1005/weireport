<#
  启动「实验报告向导」本地网页并打开浏览器
    · 已经在跑 → 直接开浏览器，不重复启动
    · 没在跑   → 后台启动 vite（日志写到 devserver.out.log / devserver.err.log），
                 等端口通了再开浏览器
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve.ps1
    powershell ... -File scripts\serve.ps1 -NoBrowser      # 只起服务不开浏览器
    powershell ... -File scripts\serve.ps1 -Port 6000
#>
[CmdletBinding()]
param(
  [int]$Port = 5273,
  [switch]$NoBrowser
)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$url     = "http://127.0.0.1:$Port/"
$pidFile = Join-Path $root ".devserver.pid"
$outLog  = Join-Path $root "devserver.out.log"
$errLog  = Join-Path $root "devserver.err.log"

function Test-Site([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Open-Site([string]$u) {
  try { Start-Process $u } catch { Write-Host "（没能自动打开浏览器，请手动访问 $u）" -ForegroundColor Yellow }
}

# ---- 1. 已经在运行？ ----
if (Test-Site $url) {
  Write-Host "✔ 本地网页已经在运行：$url" -ForegroundColor Green
  if (-not $NoBrowser) { Open-Site $url }
  exit 0
}

# ---- 2. 找不到 npm 就别硬跑 ----
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npm) {
  Write-Host "✘ 找不到 npm，请先装 Node.js 并确认它在 PATH 里" -ForegroundColor Red
  exit 1
}

# ---- 3. 后台启动 ----
# 给子进程一个独立的空 stdin：否则游离的服务会继承调用方的管道句柄，
# 导致 `npm start | ...` 这类管道一直等不到结束。
$nullIn = Join-Path ([System.IO.Path]::GetTempPath()) "lab-report-wizard.empty"
if (-not (Test-Path -LiteralPath $nullIn)) { New-Item -ItemType File -Path $nullIn -Force | Out-Null }

Write-Host "→ 正在启动本地服务（端口 $Port）…" -ForegroundColor Cyan
$proc = Start-Process -FilePath $npm -ArgumentList "run", "dev" `
  -WorkingDirectory $root -PassThru -WindowStyle Hidden `
  -RedirectStandardInput $nullIn `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$proc.Id | Set-Content -LiteralPath $pidFile -Encoding ascii

# ---- 4. 等端口就绪（最多 30 秒） ----
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Site $url) { $ready = $true; break }
  if ($proc.HasExited) { break }
}

if ($ready) {
  Write-Host "✔ 已启动：$url" -ForegroundColor Green
  Write-Host "  关闭请运行：scripts\stop.ps1 或直接双击 stop.cmd" -ForegroundColor DarkGray
  if (-not $NoBrowser) { Open-Site $url }
  exit 0
}

Write-Host "✘ 启动失败，最后几行日志：" -ForegroundColor Red
if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 20 -Encoding UTF8 }
if ((Test-Path -LiteralPath $errLog) -and (Get-Item -LiteralPath $errLog).Length -gt 0) {
  Write-Host "--- stderr ---" -ForegroundColor DarkGray
  Get-Content -LiteralPath $errLog -Tail 20 -Encoding UTF8
}
exit 1
