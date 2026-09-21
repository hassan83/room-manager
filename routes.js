// APIルーティング定義
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db_ = require('./db');

const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');
const CHANGELOG_PATH = path.join(__dirname, 'CHANGELOG.md');
const UPDATE_VERSION_PATH = path.join(__dirname, '.update-version');

const STATUS_LABEL = {
  waiting: '待機中',
  in_use: '使用中',
  closed: '退室済',
};

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function formatJst(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildCsv(sessions) {
  const header = ['日付', '部屋名', '担当スタッフ', '開始時刻', '終了予定時刻', '実退室時刻', '利用時間(分)', 'ステータス'];
  const lines = [header.map(csvEscape).join(',')];

  for (const s of sessions) {
    // 待機中のまま（スタート前）のセッションは開始・終了時刻が未確定
    const start = s.planned_start_at ? new Date(s.planned_start_at) : null;
    const end = s.actual_end_at || s.planned_end_at ? new Date(s.actual_end_at || s.planned_end_at) : null;
    const durationMinutes = start && end ? Math.round((end - start) / 60000) : '';
    const date = (start || new Date(s.created_at)).toISOString().slice(0, 10);
    lines.push([
      date,
      s.room_name,
      s.staff_name || '未選択',
      formatJst(s.planned_start_at),
      formatJst(s.planned_end_at),
      formatJst(s.actual_end_at),
      durationMinutes,
      STATUS_LABEL[s.status] || s.status,
    ].map(csvEscape).join(','));
  }
  // UTF-8 BOM付き（Excelでの日本語文字化け防止。改行はCRLF）
  return '﻿' + lines.join('\r\n');
}

function registerRoutes(router, db) {
  // ---------- 部屋（ダッシュボード表示用） ----------

  router.get('/api/rooms', ({ res, sendJson }) => {
    sendJson(res, 200, db_.listRoomsWithStatus(db));
  });

  // ---------- バージョン情報 ----------

  router.get('/api/version', ({ res, sendJson }) => {
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
    } catch (e) {
      // package.jsonが読めない場合もバージョン不明のまま続行する
    }
    let commit = null;
    try {
      commit = fs.readFileSync(UPDATE_VERSION_PATH, 'utf8').trim() || null;
    } catch (e) {
      // 自動アップデート未実行（開発環境など）の場合はnullのまま
    }
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { version, commit });
  });

  router.get('/api/changelog', ({ res }) => {
    let content = '更新履歴を読み込めませんでした';
    try {
      content = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    } catch (e) {
      // CHANGELOG.mdが無い場合はエラーメッセージのまま返す
    }
    // アップデート直後に古い内容がブラウザキャッシュから表示され続けることがないようにする
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  });

  // ---------- スタッフ（入室登録の選択肢用） ----------

  router.get('/api/staff', ({ res, sendJson }) => {
    sendJson(res, 200, db_.listActiveStaff(db));
  });

  // 部屋ごとの前回担当スタッフ（入室登録モーダルの初期値用）
  router.get('/api/rooms/:id/last-staff', ({ res, sendJson, params }) => {
    const staffId = db_.getLastStaffForRoom(db, Number(params.id));
    sendJson(res, 200, { staff_id: staffId });
  });

  // ---------- 入退室セッション ----------

  router.post('/api/sessions', ({ res, sendJson, body }) => {
    const { room_id, staff_id, duration_minutes } = body;
    if (!room_id || !duration_minutes) {
      return sendJson(res, 400, { error: '部屋・利用時間は必須です' });
    }
    const session = db_.createSession(db, {
      room_id: Number(room_id),
      staff_id: staff_id ? Number(staff_id) : null,
      duration_minutes: Number(duration_minutes),
    });
    sendJson(res, 201, session);
  });

  // 待機中のセッションの時間計測を開始する（スタートボタン）
  router.post('/api/sessions/:id/start', ({ res, sendJson, params }) => {
    const session = db_.startSession(db, Number(params.id));
    sendJson(res, 200, session);
  });

  // 待機中の登録を取り消す（間違えて登録した場合など）
  router.post('/api/sessions/:id/cancel', ({ res, sendJson, params }) => {
    db_.cancelSession(db, Number(params.id));
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/sessions/:id/checkout', ({ res, sendJson, params }) => {
    const session = db_.checkoutSession(db, Number(params.id));
    sendJson(res, 200, session);
  });

  router.post('/api/sessions/:id/adjust-time', ({ res, sendJson, params, body }) => {
    const minutes = Number(body.minutes);
    if (!minutes) return sendJson(res, 400, { error: '変更する分数が不正です' });
    const session = body.target === 'warning'
      ? db_.adjustSessionWarningTime(db, Number(params.id), minutes)
      : db_.adjustSessionEndTime(db, Number(params.id), minutes);
    sendJson(res, 200, session);
  });

  // ---------- 履歴・CSV出力 ----------

  router.get('/api/sessions', ({ res, sendJson, query }) => {
    const from = query.get('from') || new Date().toISOString().slice(0, 10);
    const to = query.get('to') || from;
    sendJson(res, 200, db_.listSessionsInRange(db, from, to));
  });

  router.get('/api/sessions/export', ({ res, query }) => {
    const from = query.get('from') || new Date().toISOString().slice(0, 10);
    const to = query.get('to') || from;
    const sessions = db_.listSessionsInRange(db, from, to);
    const csv = buildCsv(sessions);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sessions_${from}_${to}.csv"`,
    });
    res.end(csv);
  });

  // ---------- マスタ管理：部屋 ----------

  router.get('/api/admin/rooms', ({ res, sendJson }) => {
    sendJson(res, 200, db_.listAllRooms(db));
  });

  router.post('/api/admin/rooms', ({ res, sendJson, body }) => {
    if (!body.room_name) return sendJson(res, 400, { error: '部屋名は必須です' });
    sendJson(res, 201, db_.createRoom(db, body));
  });

  router.put('/api/admin/rooms/:id', ({ res, sendJson, params, body }) => {
    if (body.room_name !== undefined && !body.room_name.trim()) {
      return sendJson(res, 400, { error: '部屋名は必須です' });
    }
    sendJson(res, 200, db_.updateRoom(db, Number(params.id), body));
  });

  // 部屋の並び順を1つ上／下に入れ替える（マスタ管理画面の▲▼ボタン用）
  router.post('/api/admin/rooms/:id/move', ({ res, sendJson, params, body }) => {
    db_.moveRoom(db, Number(params.id), body.direction);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/admin/rooms/:id', ({ res, sendJson, params }) => {
    const roomId = Number(params.id);
    if (db_.hasOpenSessionForRoom(db, roomId)) {
      return sendJson(res, 409, { error: '待機中・使用中の部屋は削除できません' });
    }
    db_.deactivateRoom(db, roomId);
    sendJson(res, 200, { ok: true });
  });

  // ---------- マスタ管理：スタッフ ----------

  router.get('/api/admin/staff', ({ res, sendJson }) => {
    sendJson(res, 200, db_.listAllStaff(db));
  });

  router.post('/api/admin/staff', ({ res, sendJson, body }) => {
    if (!body.staff_name) return sendJson(res, 400, { error: 'スタッフ名は必須です' });
    sendJson(res, 201, db_.createStaff(db, body));
  });

  router.put('/api/admin/staff/:id', ({ res, sendJson, params, body }) => {
    if (body.staff_name !== undefined && !body.staff_name.trim()) {
      return sendJson(res, 400, { error: 'スタッフ名は必須です' });
    }
    sendJson(res, 200, db_.updateStaff(db, Number(params.id), body));
  });

  // スタッフの並び順を1つ上／下に入れ替える（マスタ管理画面の▲▼ボタン用）
  router.post('/api/admin/staff/:id/move', ({ res, sendJson, params, body }) => {
    db_.moveStaff(db, Number(params.id), body.direction);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/admin/staff/:id', ({ res, sendJson, params }) => {
    db_.deactivateStaff(db, Number(params.id));
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerRoutes };
