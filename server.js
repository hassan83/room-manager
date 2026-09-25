// 部屋管理Webアプリ サーバー本体
// 外部npmパッケージ不使用（Node.js組み込み機能のみ）
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const { initDb } = require('./db');
const { registerRoutes } = require('./routes');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'data.db');
const UPDATE_CHECK_SCRIPT = path.join(__dirname, 'update-check.js');
const UPDATE_VERSION_PATH = path.join(__dirname, '.update-version');
const UPDATE_LOG_PATH = path.join(__dirname, 'update-check.log');
// 起動中も定期的にアップデートを確認する間隔。
// これまではPC起動（ログオン）時にしか確認しておらず、PCを付けっぱなしにしている店舗では
// いつまでも古いバージョンのまま動き続けていたため。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LISTEN_RETRY_COUNT = 10;
const LISTEN_RETRY_DELAY_MS = 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
};

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern.replace(/:[^/]+/g, (match) => {
      paramNames.push(match.slice(1));
      return '([^/]+)';
    });
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, regex, paramNames, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }
  put(pattern, handler) { this.add('PUT', pattern, handler); }
  delete(pattern, handler) { this.add('DELETE', pattern, handler); }

  async dispatch(method, pathname, ctx) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      await route.handler({ ...ctx, params });
      return true;
    }
    return false;
  }
}

// SQLite等が投げる生のエラーメッセージ（英語で原因が分かりにくい）を、
// 店舗スタッフでも対処法が分かるような日本語メッセージに置き換える。
// 該当しないエラーはそのまま返す。
function friendlyErrorMessage(err) {
  const msg = (err && err.message) || '';
  if (/readonly database/i.test(msg)) {
    return 'データベースファイル（data.db）が読み取り専用になっているため保存できません。' +
      'data.dbを右クリック→プロパティで「読み取り専用」のチェックが入っていないか、' +
      'インストールフォルダに書き込み権限があるかを確認してください。';
  }
  if (/database is locked/i.test(msg)) {
    return 'データベースが他の処理で使用中のため保存できませんでした。少し待ってからもう一度お試しください。' +
      '繰り返し発生する場合は、部屋管理ボードが複数起動していないか確認してください。';
  }
  if (/disk (i\/o error|full)/i.test(msg)) {
    return 'ディスクの空き容量不足、またはディスクの異常により保存できませんでした。パソコンの空き容量を確認してください。';
  }
  return msg;
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('リクエストボディの形式が不正です'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const safePath = path.normalize(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    // 自動アップデート後に、ブラウザに残った古い画面ファイルが使われ続けないようにする
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function main() {
  const db = initDb(DB_PATH);
  const router = new Router();
  registerRoutes(router, db);

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    if (!pathname.startsWith('/api/')) {
      serveStatic(res, pathname);
      return;
    }

    try {
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await readJsonBody(req);
      }
      const ctx = { req, res, db, query: parsedUrl.searchParams, body, sendJson };
      const handled = await router.dispatch(req.method, pathname, ctx);
      if (!handled) {
        sendJson(res, 404, { error: 'Not Found' });
      }
    } catch (err) {
      const statusCode = err.statusCode || 400;
      sendJson(res, statusCode, { error: friendlyErrorMessage(err) || 'エラーが発生しました' });
    }
  });

  // 自動再起動の直後などで、直前のサーバーがまだポートを解放しきっていない場合に備えて少し待って再試行する
  let listenRetriesLeft = LISTEN_RETRY_COUNT;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && listenRetriesLeft > 0) {
      listenRetriesLeft--;
      setTimeout(() => server.listen(PORT), LISTEN_RETRY_DELAY_MS);
      return;
    }
    console.error(`サーバーを起動できませんでした（${err.message}）`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`部屋管理サーバー起動: http://localhost:${PORT}`);
  });

  startPeriodicUpdateCheck(server);
}

function readUpdateVersion() {
  try {
    return fs.readFileSync(UPDATE_VERSION_PATH, 'utf8').trim() || null;
  } catch (e) {
    return null;
  }
}

// 起動中も定期的にupdate-check.jsを実行し、ファイルが更新されていたらサーバーを再起動して反映する。
// 起動時点のバージョン（.update-version）と比べるので、このサーバーの起動後に
// 別経路（デスクトップのショートカットからの再起動など）で更新されたファイルも同様に反映される。
function startPeriodicUpdateCheck(server) {
  // 開発用のgit作業フォルダでは、編集中のファイルをGitHub上の内容で上書きしないよう無効にする
  if (fs.existsSync(path.join(__dirname, '.git')) || process.env.ROOM_MANAGER_AUTO_UPDATE === '0') return;
  if (!fs.existsSync(UPDATE_CHECK_SCRIPT)) return;

  const startedVersion = readUpdateVersion();
  let running = false;

  const check = () => {
    if (running) return;
    running = true;
    let logFd = null;
    try {
      logFd = fs.openSync(UPDATE_LOG_PATH, 'a');
    } catch (e) {
      // ログが書けなくても更新確認自体は行う
    }
    const child = spawn(process.execPath, [UPDATE_CHECK_SCRIPT], {
      cwd: __dirname,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      windowsHide: true,
    });
    const done = () => {
      running = false;
      if (logFd !== null) {
        try { fs.closeSync(logFd); } catch (e) { /* 無視 */ }
        logFd = null;
      }
    };
    child.on('error', (e) => {
      console.error(`アップデート確認を実行できませんでした（${e.message}）`);
      done();
    });
    child.on('exit', () => {
      done();
      const current = readUpdateVersion();
      if (current && current !== startedVersion) {
        restartServer(server);
      }
    });
  };

  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  timer.unref();
}

// 新しいファイルで動かすため、自分と同じ内容のサーバーを新たに起動してから終了する
function restartServer(server) {
  console.log('アップデートを反映するため、サーバーを再起動します...');
  const relaunch = () => {
    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (e) {
      // 新しいサーバーを起動できなかった場合は、このサーバーで受付を再開して動かし続ける
      console.error(`サーバーの再起動に失敗しました（${e.message}）`);
      server.listen(PORT);
      return;
    }
    process.exit(0);
  };
  server.close(relaunch);
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}

main();
