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
// 前回の同期で実際に配置したファイル一覧の記録。バージョン番号（.update-version）が
// 最新と一致していても、店舗PC側で何らかの理由によりファイルが欠けている場合に、
// スタッフの手作業（ファイル削除など）を一切必要とせず、次回起動時に自動で再同期させるために使う。
const SYNCED_FILES_RECORD = path.join(INSTALL_DIR, '.update-synced-files.json');
const STAGING_DIR = path.join(INSTALL_DIR, '.update-staging');
const PER_REQUEST_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 20000; // 起動が長時間止まらないよう、全体の上限時間を設ける
const MANIFEST_FETCH_ATTEMPTS = 2; // sync-manifest.json取得の最大試行回数（一時的な通信失敗による取りこぼしを防ぐ）
const MANIFEST_RETRY_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  'public/sounds/dog-bark1.mp3',
  'public/sounds/cat-meow1.mp3',
];

// 同期対象ファイルの一覧を、同期先コミット（latestSha）自身のsync-manifest.jsonから取得する。
// 一時的な通信失敗で取りこぼす（＝以後そのshaと一致する限り二度と再取得されない）ことがないよう、
// 数回まで再試行してから、それでも失敗した場合のみこのファイルに埋め込まれた一覧（SYNC_FILES）に
// フォールバックする。
async function getSyncFiles(sha) {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/sync-manifest.json`;
  let lastError;
  for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt++) {
    try {
      const buf = await httpGet(url);
      const manifest = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(manifest.files) && manifest.files.length > 0) return manifest.files;
      lastError = new Error('sync-manifest.jsonの形式が不正です');
    } catch (e) {
      lastError = e;
    }
    if (attempt < MANIFEST_FETCH_ATTEMPTS) {
      log(`同期対象ファイル一覧の取得に失敗しました（${attempt}/${MANIFEST_FETCH_ATTEMPTS}回目: ${lastError.message}）。再試行します...`);
      await delay(MANIFEST_RETRY_DELAY_MS);
    }
  }
  log(`同期対象ファイル一覧の取得に${MANIFEST_FETCH_ATTEMPTS}回失敗したため、内蔵の一覧を使用します（${lastError.message}）`);
  return SYNC_FILES;
}

function log(msg) {
  // 店舗PCのupdate-check.logを見たときに「いつ」の結果か分かるよう日時を付ける
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`[update-check ${ts}] ${msg}`);
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

// 前回同期時に記録したファイル一覧を読み込む（記録が無い・壊れている場合はnull）
function readSyncedFilesRecord() {
  try {
    const list = JSON.parse(fs.readFileSync(SYNCED_FILES_RECORD, 'utf8'));
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch (e) {
    return null;
  }
}

// 記録されているファイルが実際にインストール先に全て存在するかを確認する（ネットワーク不要）
function allFilesPresent(relPaths) {
  return relPaths.every((relPath) => fs.existsSync(destPathFor(INSTALL_DIR, relPath)));
}

// git の smart HTTP（git clone と同じ仕組み）で、ブランチの最新コミットshaを取得する。
// api.github.com は未認証だと「接続元IPごとに1時間60回」までしか使えず、
// モバイル回線・共用回線などで他の利用者と同じIPを共有している店舗では
// 上限超過（HTTP 403）で毎回バージョン確認に失敗し、いつまでも更新されなかった。
// こちらはそのAPI回数制限の対象外なので、まずこちらを使う。
async function getLatestShaViaGit() {
  const buf = await httpGet(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`);
  const text = buf.toString('utf8');
  const m = new RegExp(`([0-9a-f]{40}) refs/heads/${BRANCH}(?:\\n|\\0|$)`, 'm').exec(text);
  if (!m) throw new Error('ブランチ情報が見つかりませんでした');
  return m[1];
}

async function getLatestShaViaApi() {
  const info = await httpGet(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { json: true });
  if (!info || !info.sha) throw new Error('コミット情報を取得できませんでした');
  return info.sha;
}

async function getLatestSha() {
  try {
    return await getLatestShaViaGit();
  } catch (e) {
    log(`最新バージョンの確認（git）に失敗したため、GitHub APIで再確認します（${e.message}）`);
  }
  return getLatestShaViaApi();
}

async function run() {
  let latestSha;
  try {
    latestSha = await getLatestSha();
  } catch (e) {
    log(`バージョン確認に失敗したため、既存のファイルで起動します（${e.message}）`);
    return;
  }

  const currentSha = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : null;
  if (currentSha === latestSha) {
    // バージョン番号だけでなく、前回同期したファイルが実際に全て存在するかも確認する。
    // （通信の一時的な失敗などで一部ファイルだけ取りこぼされたまま「完了」記録されてしまった
    // 　場合でも、スタッフに手作業をお願いすることなく次回起動時に自動で復旧させるため）
    const recordedFiles = readSyncedFilesRecord();
    if (recordedFiles && allFilesPresent(recordedFiles)) {
      log('最新バージョンです');
      return;
    }
    log('バージョンは最新の記録ですが、ファイルの欠落を検出したため念のため再同期します');
  } else {
    log(`更新を検出しました（${currentSha ? currentSha.slice(0, 7) : '未記録'} → ${latestSha.slice(0, 7)}）。ダウンロードします...`);
  }

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
    fs.writeFileSync(SYNCED_FILES_RECORD, JSON.stringify(filesToSync), 'utf8');
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
