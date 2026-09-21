@echo off
cd /d %~dp0

REM サーバーを最小化した状態でバックグラウンド起動
start "room-manager-server" /min node server.js

REM サーバー起動を待つ
timeout /t 3 /nobreak >nul

REM Chromeをキオスクモード（全画面・操作制限あり）でダッシュボードに接続
REM Chromeのインストール場所が異なる場合は下のパスを書き換えてください
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing http://localhost:3000
