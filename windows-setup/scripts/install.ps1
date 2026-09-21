$ErrorActionPreference = "Stop"

$AppName    = "RoomManager"
$TaskName   = "RoomManagerAutoStart"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Split-Path -Parent $ScriptDir
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName

Write-Host "=== 部屋管理アプリ セットアップ ==="
Write-Host "インストール先: $InstallDir"
Write-Host ""

# 既に起動中の（旧バージョンの）サーバー・キオスク画面があれば停止する
# ※これをしないまま上書きすると、ポート使用中や旧プロセスが残ることで
#   「更新したのに古い画面のまま」「動作がおかしい」といった状態になるため
function Stop-RoomManagerServer {
    param([string]$InstallDir)
    try {
        $target = (Join-Path $InstallDir "server.js").ToLower()
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($target) }
        if ($procs) {
            foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Host "  -> 起動中だった旧バージョンのサーバーを停止しました。"
            Start-Sleep -Seconds 1
        } else {
            Write-Host "  -> 起動中のサーバーはありませんでした。"
        }
    } catch {
        Write-Host "  -> 既存プロセスの確認をスキップしました（$($_.Exception.Message)）"
    }
}
function Stop-RoomManagerKiosk {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*--kiosk*" -and $_.CommandLine -like "*localhost:3000*" }
        if ($procs) {
            foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Host "  -> 起動中だった旧バージョンのキオスク画面を閉じました。"
        }
    } catch {}
}
Write-Host "[1/4] 既存の起動中アプリを確認しています..."
Stop-RoomManagerServer -InstallDir $InstallDir
Stop-RoomManagerKiosk

# 2. アプリ本体をコピー（data.db 等の実行時データは上書きしない）
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}
Write-Host "[2/4] アプリファイルをコピーしています..."
Copy-Item -Path (Join-Path $PackageRoot "app\*") -Destination $InstallDir -Recurse -Force
Copy-Item -Path (Join-Path $ScriptDir "run-app.bat") -Destination $InstallDir -Force

# 3. Node.jsの確認・準備
Write-Host "[3/4] Node.jsを確認しています..."
$nodeExePath = Join-Path $InstallDir "node-runtime\node.exe"
$existingNode = Get-Command node -ErrorAction SilentlyContinue

if (Test-Path $nodeExePath) {
    Write-Host "  -> 同梱のNode.jsが既にあります。"
} elseif ($existingNode) {
    Write-Host "  -> システムにインストール済みのNode.jsを使用します: $($existingNode.Source)"
} else {
    Write-Host "  -> Node.jsが見つからないため、自動的にダウンロードします（インターネット接続が必要です）..."
    try {
        $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
        $candidate = $index | Where-Object { $_.version -like "v22.*" -and $_.lts } | Select-Object -First 1
        if (-not $candidate) {
            throw "Node.js v22系のLTSバージョンが見つかりませんでした。"
        }
        $nodeVersion = $candidate.version
        $zipUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
        $zipPath = Join-Path $env:TEMP "node-$nodeVersion.zip"

        Write-Host "     Node.js $nodeVersion をダウンロード中..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

        Write-Host "     展開中..."
        $extractDir = Join-Path $env:TEMP "node-extract-$nodeVersion"
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

        $extractedFolder = Get-ChildItem $extractDir | Where-Object { $_.PSIsContainer } | Select-Object -First 1
        $runtimeDir = Join-Path $InstallDir "node-runtime"
        if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
        Move-Item -Path $extractedFolder.FullName -Destination $runtimeDir

        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "     Node.jsの準備が完了しました。"
    } catch {
        Write-Host ""
        Write-Host "【エラー】Node.jsの自動ダウンロードに失敗しました。"
        Write-Host "詳細: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "インターネットに接続してから install.bat を再実行するか、"
        Write-Host "https://nodejs.org/ からNode.js(LTS版)を手動でインストールしてから再度お試しください。"
        exit 1
    }
}

# 4. タスクスケジューラに登録（ログオン時に自動起動、管理者権限は不要）
Write-Host "[4/4] 自動起動を設定しています..."
$runAppPath = Join-Path $InstallDir "run-app.bat"
$trArg = "`"$runAppPath`""
schtasks /create /tn "$TaskName" /tr $trArg /sc onlogon /rl limited /f | Out-Null
Write-Host "  -> タスク「$TaskName」を登録しました。"

# デスクトップにも手動起動用のショートカットを作成
try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "部屋管理ボード起動.lnk"
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $runAppPath
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = "部屋管理ボードを起動します"
    $shortcut.Save()
    Write-Host "  -> デスクトップにショートカットを作成しました。"
} catch {
    Write-Host "  -> デスクトップショートカットの作成はスキップしました（$($_.Exception.Message)）"
}

Write-Host ""
Write-Host "=== セットアップが完了しました ==="
Write-Host "次回のPC起動（ログオン）時から自動的にダッシュボードが立ち上がります。"
Write-Host "データの保存先: $InstallDir\data.db"
Write-Host ""

$answer = Read-Host "今すぐ起動して動作確認しますか？ (Y/N)"
if ($answer -eq "Y" -or $answer -eq "y") {
    Start-Process -FilePath $runAppPath
}
