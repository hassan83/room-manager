// 起動時の自動アップデートチェック（GitHubリポジトリの最新コミットを確認し、更新があれば反映する）
// - Node.js標準機能のみで動作（外部npm依存なし）
// - インターネットに繋がらない／GitHubに到達できない場合は、何もせず既存のファイルで起動を続ける
// - data.db（利用データ）や、インストーラ・自動起動設定（run-app.bat / install.ps1 / uninstall.ps1）は対象外
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'hassan83/room-manager';
const BRANCH = 'main';
const INSTALL_DIR = __dirname;
const VERSION_FILE = path.join(INSTALL_DIR, '.update-version');
const STAGING_DIR = path.join(INSTALL_DIR, '.update-staging');
const PER_REQUEST_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 15000; // 起動が長時間止まらないよう、全体の上限時間を設ける

// 自動更新の対象ファイル一覧（フォールバック用）。
// ※本来の一覧は同期先コミットの sync-manifest.json から毎回取得する（getSyncFiles参照）。
// 　これは、同期対象ファイルの一覧そのものにファイルを追加した回の更新では、
// 　「今動いている（まだ古い）update-check.jsが持つ古い一覧」で1回目のダウンロードが
// 　行われてしまい、新しく追加したファイル自体はその回では同期されない、という
// 　問題を避けるため（新しい一覧はsha一致時点で以後二度と取得されなくなるので、
// 　1回でも取りこぼすと以後ずっと同期されないままになってしまう）。
const SYNC_FILES = [
  'server.js',
  'db.js',
  'routes.js',
  'package.json',
  'update-check.js',
  'sync-manifest.json',
  'CHANGELOG.md',
  'public/index.html',
  'public/app.js',
  'public/admin.html',
  'public/admin.js',
  'public/style.css',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/sounds/success1.mp3',
  'public/sounds/warning1.mp3',
  'public/sounds/electronic-roulette-flashing1.mp3',
];

// 同期対象ファイルの一覧を、同期先コミット（latestSha）自身のsync-manifest.jsonから取得する。
// 取得できなければ、このファイルに埋め込まれた一覧（SYNC_FILES）にフォールバックする。
async function getSyncFiles(sha) {
  try {
    const url = `https://raw.githubusercontent.com/${REPO}/${sha}/sync-manifest.json`;
    const buf = await httpGet(url);
    const manifest = JSON.parse(buf.toString('utf8'));
    if (Array.isArray(manifest.files) && manifest.files.length > 0) return manifest.files;
  } catch (e) {
    log(`同期対象ファイル一覧の取得に失敗したため、内蔵の一覧を使用します（${e.message}）`);
  }
  return SYNC_FILES;
}

function log(msg) {
  console.log(`[update-check] ${msg}`);
}

function httpGet(url, { json = false, redirectsLeft = 3 } = {}) {
  return new Promise((resolve, reject) => {
    // socketのtimeoutオプションはDNS解決中はカバーされないため、
    // AbortControllerでDNS解決も含めたリクエスト全体に確実な上限時間を設ける
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
    timer.unref(); // このタイマーだけでプロセスの終了が遅れないようにする
    const clear = () => clearTimeout(timer);

    const req = https.get(url, {
      headers: { 'User-Agent': 'room-manager-updater' },
      signal: controller.signal,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        clear();
        res.resume();
        httpGet(res.headers.location, { json, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        clear();
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} (${url})`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clear();
        const buf = Buffer.concat(chunks);
        try {
          resolve(json ? JSON.parse(buf.toString('utf8')) : buf);
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', (e) => { clear(); reject(e); });
    });
    req.on('error', (e) => {
      clear();
      if (e.name === 'AbortError') reject(new Error(`タイムアウト (${url})`));
      else reject(e);
    });
  });
}

function withOverallTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    // unref()しておくことで、本処理が先に終わった場合にこのタイマーだけでプロセスが
    // 終了を待たされる（＝起動が余計に遅くなる）ことを防ぐ
    timer = setTimeout(() => reject(new Error('全体のタイムアウト')), ms);
    timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function destPathFor(baseDir, relPath) {
  return path.join(baseDir, ...relPath.split('/'));
}

async function run() {
  let latestSha;
  try {
    const info = await httpGet(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { json: true });
    latestSha = info && info.sha;
    if (!latestSha) throw new Error('コミット情報を取得できませんでした');
  } catch (e) {
    log(`バージョン確認に失敗したため、既存のファイルで起動します（${e.message}）`);
    return;
  }

  const currentSha = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : null;
  if (currentSha === latestSha) {
    log('最新バージョンです');
    return;
  }

  log(`更新を検出しました（${currentSha ? currentSha.slice(0, 7) : '未記録'} → ${latestSha.slice(0, 7)}）。ダウンロードします...`);

  // 同期対象ファイルの一覧は、同期先コミット自身のsync-manifest.jsonから取得する
  // （今動いているスクリプトの古い一覧を使うと、新しく追加したファイルがその回だけ
  // 　取りこぼされ、以後同じsha同士の比較になり永久に同期されなくなるため）
  const filesToSync = await getSyncFiles(latestSha);

  // まず一時フォルダに全ファイルをダウンロードし、すべて成功してから本番に反映する
  // （途中で失敗した場合に、新旧ファイルが混在した壊れた状態になるのを防ぐため）
  try {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    for (const relPath of filesToSync) {
      const url = `https://raw.githubusercontent.com/${REPO}/${latestSha}/${relPath}`;
      const content = await httpGet(url);
      const stagedPath = destPathFor(STAGING_DIR, relPath);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.writeFileSync(stagedPath, content);
    }

    for (const relPath of filesToSync) {
      const stagedPath = destPathFor(STAGING_DIR, relPath);
      const destPath = destPathFor(INSTALL_DIR, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(stagedPath, destPath);
    }

    fs.writeFileSync(VERSION_FILE, latestSha, 'utf8');
    log('更新が完了しました');
  } catch (e) {
    log(`更新中にエラーが発生したため、既存のファイルで起動します（${e.message}）`);
  } finally {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  }
}

withOverallTimeout(run(), OVERALL_TIMEOUT_MS).catch((e) => {
  log(`スキップしました（${e.message}）`);
});
