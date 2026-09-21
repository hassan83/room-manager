#!/usr/bin/env bash
# room-manager直下の最新アプリファイルを windows-setup/app にコピーし、
# 配布用ZIP（room-manager-windows-setup.zip）をプロジェクト直下に作成する。
# app.js等を更新した後、このスクリプトを実行すれば配布物を作り直せる。
set -e
cd "$(dirname "$0")"

rm -rf app
mkdir -p app
cp ../server.js ../db.js ../routes.js ../package.json ../update-check.js app/
cp -r ../public app/

cd ..
rm -f room-manager-windows-setup.zip
zip -rq room-manager-windows-setup.zip windows-setup \
  -x "windows-setup/app/data.db" \
  -x "windows-setup/.DS_Store"

echo "作成しました: room-manager-windows-setup.zip"
