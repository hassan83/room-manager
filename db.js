// DBスキーマ定義とモデル層（CRUD・状態遷移）
// Node.js組み込みの node:sqlite を使用（外部npm依存なし）
'use strict';

const { DatabaseSync } = require('node:sqlite');

// waiting: 入室登録済みだがまだ「スタート」を押していない（時間計測前）
// ※清掃中ステータスは廃止（スタート前の待機時間中に清掃できるため、退室後は直接空室に戻す）
const OPEN_STATUSES = ['waiting', 'in_use'];
const OPEN_STATUSES_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
const DEFAULT_WARNING_MINUTES = 5; // 退室予定の何分前に1コールを出すか（初期値）
const MIN_PHASE_MS = 60000; // 開始〜1コール／1コール〜退室、各区間は最低1分確保する

function initDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_name TEXT NOT NULL,
      capacity INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS staff (
      staff_id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      staff_id INTEGER,
      planned_start_at TEXT NOT NULL,
      planned_end_at TEXT NOT NULL,
      planned_warning_at TEXT,
      actual_end_at TEXT,
      status TEXT NOT NULL DEFAULT 'in_use',
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (staff_id) REFERENCES staff(staff_id)
    );
  `);
  // 以降のマイグレーション処理は、データベースファイルが読み取り専用の場合でも
  // アプリ自体は起動できる（ダッシュボードの閲覧はできる）ようにするため、
  // まとめてtry/catchする。スキーマが既に最新であれば通常は書き込みが発生しないが、
  // closeOutLingeringCleaningSessionsのUPDATE文だけは対象0件でも書き込みを試みるため、
  // これを個別に保護しないと読み取り専用データベースでは起動そのものが失敗してしまう。
  try {
    ensureWarningColumn(db);
    ensureStaffIdNullable(db);
    ensureWaitingSupport(db);
    ensureSortOrder(db);
    closeOutLingeringCleaningSessions(db);
    seedIfEmpty(db);
  } catch (e) {
    console.error('[起動時] データベースの初期化処理でエラーが発生しました。読み取り専用の状態で起動を続けます。');
    console.error(`  詳細: ${e.message}`);
  }
  checkWritable(db);
  return db;
}

// 起動時に実際に書き込みができるか確認する（テーブルやカラムが既に揃っている場合、
// ここまでのCREATE TABLE IF NOT EXISTS等は実際には書き込みを行わずに素通りすることがあり、
// データファイルが読み取り専用でも起動自体は成功してしまうため）。
// 書き込めない場合も起動自体は継続し、コンソールに分かりやすい警告を出すだけに留める
// （実際の操作時にはserver.js側でも分かりやすいエラーメッセージに変換して表示する）。
function checkWritable(db) {
  try {
    // BEGIN IMMEDIATE + ROLLBACKだけでは実際のディスク書き込みが発生せず、
    // 読み取り専用ファイルでも成功してしまう（検知できない）ため、
    // 実際に値を書き戻す形でPRAGMA user_versionへの書き込みを試す
    // （同じ値を書き戻すだけなので実質的な副作用はない）
    const current = db.prepare('PRAGMA user_version').get().user_version;
    db.exec(`PRAGMA user_version = ${current}`);
  } catch (e) {
    console.error('[起動時チェック] データベースファイル（data.db）に書き込めません。');
    console.error('  data.dbが読み取り専用になっているか、インストールフォルダの書き込み権限が無い可能性があります。');
    console.error(`  詳細: ${e.message}`);
  }
}

// マスタ管理での並び順設定に対応するため、rooms/staffにsort_order列を追加する。
// 既存データは、これまでの並び順（名前順）をそのまま初期値として割り当てる
// （10刻みにしておくことで、後から間に挿入したい場合にも対応しやすくする）
function ensureSortOrder(db) {
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all();
  if (!roomCols.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE rooms ADD COLUMN sort_order INTEGER');
    const rooms = db.prepare('SELECT room_id FROM rooms ORDER BY room_name').all();
    const stmt = db.prepare('UPDATE rooms SET sort_order = ? WHERE room_id = ?');
    rooms.forEach((r, i) => stmt.run((i + 1) * 10, r.room_id));
  }
  const staffCols = db.prepare('PRAGMA table_info(staff)').all();
  if (!staffCols.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE staff ADD COLUMN sort_order INTEGER');
    const staffRows = db.prepare('SELECT staff_id FROM staff ORDER BY staff_name').all();
    const stmt = db.prepare('UPDATE staff SET sort_order = ? WHERE staff_id = ?');
    staffRows.forEach((s, i) => stmt.run((i + 1) * 10, s.staff_id));
  }
}

// 清掃中ステータスの廃止に伴い、旧バージョンで清掃待ちのまま残っていたセッションを
// 退室済み（closed）として確定させる（部屋は次の入室登録に使えるようになる）
function closeOutLingeringCleaningSessions(db) {
  db.exec(`UPDATE sessions SET status = 'closed' WHERE status = 'cleaning'`);
}

// 「スタート」ボタンで時間計測を開始する機能に対応するため、
// duration_minutes列を追加し、planned_start_at / planned_end_at をNULL許容にする
// （スタート前はまだ開始・終了予定時刻が決まっていないため）
function ensureWaitingSupport(db) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  const hasDuration = columns.some((c) => c.name === 'duration_minutes');
  const startCol = columns.find((c) => c.name === 'planned_start_at');
  const endCol = columns.find((c) => c.name === 'planned_end_at');
  const needsRebuild = !hasDuration || (startCol && startCol.notnull === 1) || (endCol && endCol.notnull === 1);
  if (!needsRebuild) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE sessions_new (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      staff_id INTEGER,
      duration_minutes INTEGER,
      planned_start_at TEXT,
      planned_end_at TEXT,
      planned_warning_at TEXT,
      actual_end_at TEXT,
      status TEXT NOT NULL DEFAULT 'in_use',
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (staff_id) REFERENCES staff(staff_id)
    );
  `);
  // 既存データはduration_minutesが無いので、開始〜終了予定の差分から逆算して埋める
  db.exec(`
    INSERT INTO sessions_new (session_id, room_id, staff_id, duration_minutes, planned_start_at, planned_end_at, planned_warning_at, actual_end_at, status, created_at)
    SELECT session_id, room_id, staff_id,
      CASE WHEN planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL
        THEN CAST(ROUND((julianday(planned_end_at) - julianday(planned_start_at)) * 1440) AS INTEGER)
        ELSE NULL END,
      planned_start_at, planned_end_at, planned_warning_at, actual_end_at, status, created_at
    FROM sessions;
  `);
  db.exec('DROP TABLE sessions;');
  db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// 既存DBでは staff_id が NOT NULL 制約付きの場合があるため、
// 「未選択」（NULL）を保存できるようテーブルを再構築して制約を外す
function ensureStaffIdNullable(db) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  const staffCol = columns.find((c) => c.name === 'staff_id');
  if (!staffCol || staffCol.notnull !== 1) return; // 既にNULL許容、またはテーブル自体がない

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE sessions_new (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      staff_id INTEGER,
      planned_start_at TEXT NOT NULL,
      planned_end_at TEXT NOT NULL,
      planned_warning_at TEXT,
      actual_end_at TEXT,
      status TEXT NOT NULL DEFAULT 'in_use',
      created_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(room_id),
      FOREIGN KEY (staff_id) REFERENCES staff(staff_id)
    );
  `);
  db.exec(`
    INSERT INTO sessions_new (session_id, room_id, staff_id, planned_start_at, planned_end_at, planned_warning_at, actual_end_at, status, created_at)
    SELECT session_id, room_id, staff_id, planned_start_at, planned_end_at, planned_warning_at, actual_end_at, status, created_at FROM sessions;
  `);
  db.exec('DROP TABLE sessions;');
  db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// 既存DBに1コール時刻の列がない場合に追加し、未設定の値を退室予定時刻から逆算して埋める
function ensureWarningColumn(db) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!columns.some((c) => c.name === 'planned_warning_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN planned_warning_at TEXT');
  }
  const rows = db.prepare('SELECT session_id, planned_end_at FROM sessions WHERE planned_warning_at IS NULL').all();
  if (rows.length > 0) {
    const update = db.prepare('UPDATE sessions SET planned_warning_at = ? WHERE session_id = ?');
    for (const row of rows) {
      const warningAt = new Date(new Date(row.planned_end_at).getTime() - DEFAULT_WARNING_MINUTES * 60000);
      update.run(warningAt.toISOString(), row.session_id);
    }
  }
}

function seedIfEmpty(db) {
  const roomCount = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  if (roomCount === 0) {
    const insert = db.prepare('INSERT INTO rooms (room_name, capacity, is_active, sort_order) VALUES (?, ?, 1, ?)');
    ['101', '102', '103', '104', '105', '106', '107', '108'].forEach((name, i) => insert.run(name, 4, (i + 1) * 10));
  }
  const staffCount = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
  if (staffCount === 0) {
    const insert = db.prepare('INSERT INTO staff (staff_name, is_active, sort_order) VALUES (?, 1, ?)');
    ['ユキ', 'レナ', 'ミサキ', 'ハルカ'].forEach((name, i) => insert.run(name, (i + 1) * 10));
  }
}

// ---------- Rooms ----------

function listRoomsWithStatus(db) {
  const rows = db.prepare(`
    SELECT
      r.room_id, r.room_name, r.capacity,
      s.session_id, s.staff_id, st.staff_name, s.duration_minutes,
      s.planned_start_at, s.planned_end_at, s.planned_warning_at, s.status AS session_status,
      lastStaff.staff_name AS last_staff_name
    FROM rooms r
    LEFT JOIN sessions s ON s.room_id = r.room_id AND s.status IN (${OPEN_STATUSES_SQL})
    LEFT JOIN staff st ON st.staff_id = s.staff_id
    LEFT JOIN sessions lastSession ON lastSession.session_id = (
      SELECT session_id FROM sessions WHERE room_id = r.room_id ORDER BY session_id DESC LIMIT 1
    )
    LEFT JOIN staff lastStaff ON lastStaff.staff_id = lastSession.staff_id
    WHERE r.is_active = 1
    ORDER BY r.sort_order, r.room_name
  `).all();

  return rows.map((row) => ({
    room_id: row.room_id,
    room_name: row.room_name,
    capacity: row.capacity,
    status: row.session_status || 'vacant',
    session: row.session_id ? {
      session_id: row.session_id,
      staff_id: row.staff_id,
      staff_name: row.staff_name,
      duration_minutes: row.duration_minutes,
      planned_start_at: row.planned_start_at,
      planned_end_at: row.planned_end_at,
      planned_warning_at: row.planned_warning_at,
    } : null,
    // 空室カードに軽く表示する「前回の担当者」（履歴が無ければnull）
    last_staff_name: row.session_id ? null : row.last_staff_name,
  }));
}

function listAllRooms(db) {
  return db.prepare('SELECT * FROM rooms ORDER BY sort_order, room_name').all();
}

function nextSortOrder(db, table) {
  const row = db.prepare(`SELECT MAX(sort_order) AS m FROM ${table}`).get();
  return (row.m || 0) + 10;
}

function createRoom(db, { room_name, capacity }) {
  const sortOrder = nextSortOrder(db, 'rooms');
  const result = db.prepare('INSERT INTO rooms (room_name, capacity, is_active, sort_order) VALUES (?, ?, 1, ?)')
    .run(room_name, capacity || null, sortOrder);
  return db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(result.lastInsertRowid);
}

// room_name/capacity/is_activeは指定されたものだけを更新し、指定が無い項目は既存値を維持する
// （マスタ管理の名称編集など、一部の項目だけを送るケースに対応するため）
function updateRoom(db, roomId, { room_name, capacity, is_active } = {}) {
  const existing = db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
  if (!existing) {
    const err = new Error('部屋が見つかりません');
    err.statusCode = 404;
    throw err;
  }
  const newName = room_name !== undefined ? room_name : existing.room_name;
  const newCapacity = capacity !== undefined ? (capacity || null) : existing.capacity;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;
  db.prepare('UPDATE rooms SET room_name = ?, capacity = ?, is_active = ? WHERE room_id = ?')
    .run(newName, newCapacity, newActive, roomId);
  return db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
}

// 部屋の並び順を、渡されたIDの並び（ドラッグ&ドロップ後の順序）の通りに一括設定する
function reorderRooms(db, roomIds) {
  const ids = (roomIds || []).map(Number).filter((n) => Number.isInteger(n));
  const stmt = db.prepare('UPDATE rooms SET sort_order = ? WHERE room_id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => stmt.run((i + 1) * 10, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function hasOpenSessionForRoom(db, roomId) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE room_id = ? AND status IN (${OPEN_STATUSES_SQL})`).get(roomId);
  return row.c > 0;
}

function deactivateRoom(db, roomId) {
  db.prepare('UPDATE rooms SET is_active = 0 WHERE room_id = ?').run(roomId);
}

// ---------- Staff ----------

function listActiveStaff(db) {
  return db.prepare('SELECT * FROM staff WHERE is_active = 1 ORDER BY sort_order, staff_name').all();
}

function listAllStaff(db) {
  return db.prepare('SELECT * FROM staff ORDER BY sort_order, staff_name').all();
}

function createStaff(db, { staff_name }) {
  const sortOrder = nextSortOrder(db, 'staff');
  const result = db.prepare('INSERT INTO staff (staff_name, is_active, sort_order) VALUES (?, 1, ?)').run(staff_name, sortOrder);
  return db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(result.lastInsertRowid);
}

// staff_name/is_activeは指定されたものだけを更新し、指定が無い項目は既存値を維持する
function updateStaff(db, staffId, { staff_name, is_active } = {}) {
  const existing = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(staffId);
  if (!existing) {
    const err = new Error('スタッフが見つかりません');
    err.statusCode = 404;
    throw err;
  }
  const newName = staff_name !== undefined ? staff_name : existing.staff_name;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;
  db.prepare('UPDATE staff SET staff_name = ?, is_active = ? WHERE staff_id = ?')
    .run(newName, newActive, staffId);
  return db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(staffId);
}

// スタッフの並び順を、渡されたIDの並び（ドラッグ&ドロップ後の順序）の通りに一括設定する
function reorderStaff(db, staffIds) {
  const ids = (staffIds || []).map(Number).filter((n) => Number.isInteger(n));
  const stmt = db.prepare('UPDATE staff SET sort_order = ? WHERE staff_id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => stmt.run((i + 1) * 10, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function deactivateStaff(db, staffId) {
  db.prepare('UPDATE staff SET is_active = 0 WHERE staff_id = ?').run(staffId);
}

// ---------- Sessions ----------

// 指定の部屋で直近に入室登録されていた担当スタッフを返す（入室登録モーダルの初期値用）
function getLastStaffForRoom(db, roomId) {
  const row = db.prepare(`
    SELECT staff_id FROM sessions WHERE room_id = ? ORDER BY session_id DESC LIMIT 1
  `).get(roomId);
  return row ? row.staff_id : null;
}

// 入室登録は「待機中」で作成する。実際の時間計測は startSession（スタートボタン）が押されてから始まる
function createSession(db, { room_id, staff_id, duration_minutes }) {
  if (hasOpenSessionForRoom(db, room_id)) {
    const err = new Error('この部屋は既に使用中です');
    err.statusCode = 409;
    throw err;
  }
  const now = new Date();
  const result = db.prepare(`
    INSERT INTO sessions (room_id, staff_id, duration_minutes, status, created_at)
    VALUES (?, ?, ?, 'waiting', ?)
  `).run(room_id, staff_id, duration_minutes, now.toISOString());
  return getSession(db, result.lastInsertRowid);
}

// 「スタート」ボタン：待機中のセッションの計測を開始する（1コール・退室予定時刻をここで確定させる）
function startSession(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) {
    const err = new Error('セッションが見つかりません');
    err.statusCode = 404;
    throw err;
  }
  if (session.status !== 'waiting') {
    const err = new Error('このセッションは開始できる状態ではありません');
    err.statusCode = 409;
    throw err;
  }
  const now = new Date();
  const durationMinutes = session.duration_minutes || 60;
  const plannedEnd = new Date(now.getTime() + durationMinutes * 60000);
  let plannedWarning = new Date(plannedEnd.getTime() - DEFAULT_WARNING_MINUTES * 60000);
  if (plannedWarning < now) plannedWarning = now; // 利用時間が1コール分より短い場合は開始と同時に1コール扱い
  db.prepare(`
    UPDATE sessions SET planned_start_at = ?, planned_end_at = ?, planned_warning_at = ?, status = 'in_use'
    WHERE session_id = ?
  `).run(now.toISOString(), plannedEnd.toISOString(), plannedWarning.toISOString(), sessionId);
  return getSession(db, sessionId);
}

// 待機中の登録を取り消す（まだ開始していないので実績は残さず削除し、部屋を空室に戻す）
function cancelSession(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) {
    const err = new Error('セッションが見つかりません');
    err.statusCode = 404;
    throw err;
  }
  if (session.status !== 'waiting') {
    const err = new Error('このセッションは取消できる状態ではありません');
    err.statusCode = 409;
    throw err;
  }
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  return { ok: true };
}

function getSession(db, sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
}

function checkoutSession(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) {
    const err = new Error('セッションが見つかりません');
    err.statusCode = 404;
    throw err;
  }
  if (session.status !== 'in_use') {
    const err = new Error('このセッションは退室処理できる状態ではありません');
    err.statusCode = 409;
    throw err;
  }
  // スタート前の待機時間中に清掃できるようになったため、退室後は清掃中を経由せず直接空室に戻す
  db.prepare(`UPDATE sessions SET actual_end_at = ?, status = 'closed' WHERE session_id = ?`)
    .run(new Date().toISOString(), sessionId);
  return getSession(db, sessionId);
}

function getInUseSessionOrThrow(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) {
    const err = new Error('セッションが見つかりません');
    err.statusCode = 404;
    throw err;
  }
  if (session.status !== 'in_use') {
    const err = new Error('このセッションは時間変更できる状態ではありません');
    err.statusCode = 409;
    throw err;
  }
  return session;
}

// 1コールの時刻を調整する。「1コール〜退室」の区間の長さ（退室フェーズの長さ）は維持したまま、
// 1コール・退室予定時刻の両方を同じ分だけスライドさせる（退室フェーズの長さ自体は変えない）
function adjustSessionWarningTime(db, sessionId, deltaMinutes) {
  const session = getInUseSessionOrThrow(db, sessionId);
  const start = new Date(session.planned_start_at);
  const oldWarning = new Date(session.planned_warning_at);
  const oldEnd = new Date(session.planned_end_at);
  const finalPhaseMs = oldEnd - oldWarning; // 退室フェーズの長さ（この値は変えない）

  let newWarning = new Date(oldWarning.getTime() + deltaMinutes * 60000);
  if (newWarning < start) newWarning = start;
  const newEnd = new Date(newWarning.getTime() + finalPhaseMs);

  db.prepare('UPDATE sessions SET planned_warning_at = ?, planned_end_at = ? WHERE session_id = ?')
    .run(newWarning.toISOString(), newEnd.toISOString(), sessionId);
  return getSession(db, sessionId);
}

// 退室フェーズの長さ（1コール〜退室の区間）を調整する。1コール時刻はそのまま
function adjustSessionEndTime(db, sessionId, deltaMinutes) {
  const session = getInUseSessionOrThrow(db, sessionId);
  const warningAt = new Date(session.planned_warning_at);
  const minEnd = new Date(warningAt.getTime() + MIN_PHASE_MS);
  let newEnd = new Date(new Date(session.planned_end_at).getTime() + deltaMinutes * 60000);
  if (newEnd < minEnd) newEnd = minEnd;
  db.prepare('UPDATE sessions SET planned_end_at = ? WHERE session_id = ?').run(newEnd.toISOString(), sessionId);
  return getSession(db, sessionId);
}

function listSessionsInRange(db, fromDate, toDate) {
  return db.prepare(`
    SELECT
      s.session_id, r.room_name, st.staff_name,
      s.planned_start_at, s.planned_end_at, s.actual_end_at, s.status, s.created_at
    FROM sessions s
    JOIN rooms r ON r.room_id = s.room_id
    LEFT JOIN staff st ON st.staff_id = s.staff_id
    WHERE date(s.created_at) >= date(?) AND date(s.created_at) <= date(?)
    ORDER BY s.created_at DESC
  `).all(fromDate, toDate);
}

module.exports = {
  initDb,
  listRoomsWithStatus,
  listAllRooms,
  createRoom,
  updateRoom,
  reorderRooms,
  deactivateRoom,
  hasOpenSessionForRoom,
  listActiveStaff,
  listAllStaff,
  createStaff,
  updateStaff,
  reorderStaff,
  deactivateStaff,
  createSession,
  startSession,
  cancelSession,
  getLastStaffForRoom,
  getSession,
  checkoutSession,
  adjustSessionWarningTime,
  adjustSessionEndTime,
  listSessionsInRange,
  OPEN_STATUSES,
};
