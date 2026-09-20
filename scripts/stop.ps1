<#
  关闭「实验报告向导」本地网页
    · 先按 .devserver.pid 结束整棵进程树（npm → node/vite）
    · 再兜底：谁占着端口就结束谁（比如上次是手动 npm run dev 起的）
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop.ps1
    powershell ... -File scripts\stop.ps1 -Port 6000
#>
[CmdletBinding()]
param(
  [int]$Port = 5273
)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$root    = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".devserver.pid"
$killed  = New-Object System.Collections.ArrayList

function Get-ListenPids([int]$p) {
  $result = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conns) { $result = @($conns | Select-Object -ExpandProperty OwningProcess -Unique) }
  } catch { }
  if ($result.Count -eq 0) {
    # 兜底：netstat 解析
    $lines = (& netstat -ano | Select-String -Pattern ":$p\s" | Select-String -Pattern "LISTENING")
    foreach ($l in $lines) {
      $parts = ($l.ToString().Trim() -split "\s+")
      $owner = $parts[$parts.Length - 1]
      if ($owner -match "^\d+$") { $result += [int]$owner }
    }
  }
  return @($result | Select-Object -Unique)
}

# ---- 1. 按 pid 文件结束整棵树 ----
if (Test-Path -LiteralPath $pidFile) {
  $saved = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($saved -match "^\d+$") {
    & taskkill /PID $saved /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { [void]$killed.Add($saved) }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# ---- 2. 端口兜底 ----
foreach ($owner in (Get-ListenPids $Port)) {
  if ($killed -notcontains "$owner") {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    [void]$killed.Add("$owner")
  }
}

# ---- 3. 结果 ----
Start-Sleep -Milliseconds 600
$still = Get-ListenPids $Port

if ($still.Count -gt 0) {
  Write-Host "✘ 端口 $Port 仍被占用（PID: $($still -join ', ')），可能需要管理员权限" -ForegroundColor Red
  exit 1
}
if ($killed.Count -gt 0) {
  Write-Host "✔ 本地网页已关闭（结束进程：$($killed -join ', ')）" -ForegroundColor Green
  exit 0
}
Write-Host "· 本地网页本来就没在运行" -ForegroundColor Yellow
exit 0
