# room-manager 開発メモ

## ZIPパッケージの再作成について（重要）

`room-manager-windows-setup.zip`（`windows-setup/build-package.sh`で作成）の再作成・再配布が
必要なのは、インストール・起動の仕組み自体を変更した場合のみです。

- `windows-setup/install.bat`
- `windows-setup/scripts/install.ps1`
- `windows-setup/scripts/run-app.bat`
- `windows-setup/uninstall.bat`
- `windows-setup/scripts/uninstall.ps1`

これら以外のファイル（`server.js` / `db.js` / `routes.js` / `update-check.js` / `public/`配下 /
`CHANGELOG.md` など、`sync-manifest.json`に載っているファイル）の変更は、
GitHubにpushしさえすれば、店舗PC起動時の自動アップデート（`update-check.js`）で
自動的に反映される。そのためのZIP再作成・`present_files`での配布は無駄な処理なので行わない。

上記のインストール関連ファイルを変更した場合のみ、ZIPを作り直し、
`present_files`で渡し、店舗側に新しいZIPで`install.bat`を再実行してもらうよう伝える。

## push運用

この開発環境（サンドボックス）からはGitHubにpushできない（プロキシの403で弾かれる）。
コミットまではここで行ってよいが、`git push`は毎回ユーザー自身に依頼すること。

## リリース時に更新するもの

機能追加・修正のたびに、原則として以下を一緒に更新する。

- `README.md`（機能一覧・該当箇所）
- `windows-setup/操作マニュアル.docx`（該当する操作手順があれば）
- `package.json`のバージョン番号
- `CHANGELOG.md`に新バージョンのエントリ

## その他

- 外部npmパッケージは一切使わない。Node.js組み込み機能のみ（`node:http` / `node:sqlite` /
  `node:https` / `node:fs` / `node:path`）で動作させる。
- リモートは `https://github.com/hassan83/room-manager.git`（public repo）。
