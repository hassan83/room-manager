$ErrorActionPreference = "Stop"

$AppName    = "RoomManager"
$TaskName   = "RoomManagerAutoStart"
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName

Write-Host "=== 部屋管理アプリ アンインストール ==="
Write-Host ""

# 起動中のサーバー・キオスク画面を先に停止する（起動中のままだとファイル削除に失敗するため）
try {
    $target = (Join-Path $InstallDir "server.js").ToLower()
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($target) }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($procs) { Write-Host "起動中のサーバーを停止しました。"; Start-Sleep -Seconds 1 }
} catch {}
try {
    $kiosk = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*--kiosk*" -and $_.CommandLine -like "*localhost:3000*" }
    foreach ($p in $kiosk) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

schtasks /delete /tn "$TaskName" /f 2>$null | Out-Null
Write-Host "自動起動の登録を解除しました。"

try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "部屋管理ボード起動.lnk"
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
        Write-Host "デスクトップショートカットを削除しました。"
    }
} catch {}

Write-Host ""
Write-Host "インストール先: $InstallDir"
$answer = Read-Host "アプリ本体とデータベース（利用履歴）も削除しますか？ (Y/N)"
if ($answer -eq "Y" -or $answer -eq "y") {
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "削除しました: $InstallDir"
    }
} else {
    Write-Host "ファイルは残しています: $InstallDir"
    Write-Host "（データベースを残したまま再インストールする場合は、そのままinstall.batを実行してください）"
}

Write-Host ""
Write-Host "アンインストールが完了しました。"
