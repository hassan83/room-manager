'use strict';

let rooms = [];
let staffList = [];

// セッションごとのアラーム停止状態。
// 「1コール」と「時間超過」は別フェーズとして扱い、それぞれ独立にストップボタンで止められる。
// フェーズが変わる（1コール→時間超過）と自動的に再度鳴り始める。
const alarmSilence = new Map(); // session_id -> { warning: boolean, overtime: boolean }

function getAlarmSilence(sessionId) {
  if (!alarmSilence.has(sessionId)) {
    alarmSilence.set(sessionId, { warning: false, overtime: false });
  }
  return alarmSilence.get(sessionId);
}

function clearAlarmSilence(sessionId) {
  alarmSilence.delete(sessionId);
}

// 退室ボタンの2段階確認（誤操作防止のため、1回目は確認メッセージに変わるだけで、
// 2回目を押した時点で実際に退室処理を行う。一定時間操作がなければ自動的に元に戻す）
const checkoutConfirmTimers = new Map(); // session_id -> timeoutId
const CHECKOUT_CONFIRM_TIMEOUT_MS = 4000;

function isCheckoutConfirmPending(sessionId) {
  return checkoutConfirmTimers.has(sessionId);
}

function setCheckoutConfirmPending(sessionId) {
  clearCheckoutConfirmPending(sessionId);
  const timer = setTimeout(() => {
    checkoutConfirmTimers.delete(sessionId);
    renderRooms();
  }, CHECKOUT_CONFIRM_TIMEOUT_MS);
  checkoutConfirmTimers.set(sessionId, timer);
}

function clearCheckoutConfirmPending(sessionId) {
  const timer = checkoutConfirmTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  checkoutConfirmTimers.delete(sessionId);
}

// ---------- テーマ切り替え ----------

const btnThemeToggle = document.getElementById('btnThemeToggle');

function applyThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btnThemeToggle.textContent = isDark ? '☀️' : '🌙';
}
applyThemeIcon();

btnThemeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  applyThemeIcon();
});

// ---------- ユーティリティ ----------

function pad(n) { return String(n).padStart(2, '0'); }

function formatClock(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRemaining(ms) {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}分${pad(s)}秒`;
}

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `通信エラー (${res.status})`);
  }
  return data;
}

let sharedAudioCtx = null;

// ---------- 音量設定 ----------

const MAX_GAIN = 1.0; // 音量100%のときの実際のgain値（DynamicsCompressorNodeで音割れを抑制。200%まで入力可）
const VOLUME_MIN = 0;
const VOLUME_MAX = 200;
const volumeSlider = document.getElementById('volumeSlider');
const volumeNumber = document.getElementById('volumeNumber');
const volumeIcon = document.getElementById('volumeIcon');

function getVolume() {
  const saved = localStorage.getItem('alarmVolume');
  return saved === null ? 70 : Number(saved);
}

function clampVolume(v) {
  if (Number.isNaN(v)) return getVolume();
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(v)));
}

function applyVolumeUi(volume) {
  volumeSlider.value = volume;
  volumeNumber.value = volume;
  volumeIcon.textContent = volume == 0 ? '🔇' : volume < 50 ? '🔉' : '🔊';
}

function setVolume(volume) {
  localStorage.setItem('alarmVolume', String(volume));
  applyVolumeUi(volume);
}

applyVolumeUi(getVolume());

volumeSlider.addEventListener('input', () => {
  setVolume(clampVolume(Number(volumeSlider.value)));
});
// スライダーから指を離したタイミングで音量を試聴できるようにする
volumeSlider.addEventListener('change', () => {
  if (Number(volumeSlider.value) > 0) playAlertBeep();
});

volumeNumber.addEventListener('change', () => {
  const volume = clampVolume(Number(volumeNumber.value));
  setVolume(volume);
  if (volume > 0) playAlertBeep();
});

// ---------- 通知音の種類（「1コール」「退室」で別々に設定可能） ----------

const DEFAULT_SOUND_TYPE = 'classic';
// キー: warning=1コール, overtime=退室
const SOUND_TYPE_STORAGE_KEY = { warning: 'alarmSoundTypeWarning', overtime: 'alarmSoundTypeOvertime' };
const soundTypeSelects = {
  warning: document.getElementById('soundTypeWarning'),
  overtime: document.getElementById('soundTypeOvertime'),
};
const soundTypeTestBtns = {
  warning: document.getElementById('soundTypeWarningTest'),
  overtime: document.getElementById('soundTypeOvertimeTest'),
};

// 旧バージョン（1種類共通設定だった頃）の設定値。新しい個別キーが未設定の場合の初期値として引き継ぐ
function getLegacySoundType() {
  return localStorage.getItem('alarmSoundType');
}

function getSoundType(phase) {
  return localStorage.getItem(SOUND_TYPE_STORAGE_KEY[phase]) || getLegacySoundType() || DEFAULT_SOUND_TYPE;
}

function setSoundType(phase, type) {
  localStorage.setItem(SOUND_TYPE_STORAGE_KEY[phase], type);
}

for (const phase of ['warning', 'overtime']) {
  soundTypeSelects[phase].value = getSoundType(phase);
  soundTypeSelects[phase].addEventListener('change', () => {
    setSoundType(phase, soundTypeSelects[phase].value);
    playAlertBeep(phase);
  });
  soundTypeTestBtns[phase].addEventListener('click', () => playAlertBeep(phase));
}

// ---------- 利用時間の初期値 ----------

const DEFAULT_DURATION_MINUTES = 60;
const defaultDurationInput = document.getElementById('defaultDuration');
const defaultDurationError = document.getElementById('defaultDurationError');

function getDefaultDuration() {
  const saved = localStorage.getItem('defaultDurationMinutes');
  const n = Number(saved);
  return saved !== null && Number.isInteger(n) && n > 0 ? n : DEFAULT_DURATION_MINUTES;
}

function setDefaultDuration(minutes) {
  localStorage.setItem('defaultDurationMinutes', String(minutes));
}

defaultDurationInput.value = getDefaultDuration();
defaultDurationInput.addEventListener('change', () => {
  const value = Number(defaultDurationInput.value);
  if (!Number.isInteger(value) || value <= 0) {
    defaultDurationError.textContent = '1以上の整数（分）で入力してください';
    defaultDurationInput.value = getDefaultDuration();
    return;
  }
  defaultDurationError.textContent = '';
  setDefaultDuration(value);
});

// ---------- ファイル再生の通知音（効果音ラボ https://soundeffect-lab.info/ の素材を「操作音」として組み込み） ----------
const SOUND_FILES = {
  success1: 'sounds/success1.mp3',
  warning1: 'sounds/warning1.mp3',
  'roulette-flash1': 'sounds/electronic-roulette-flashing1.mp3',
};
const audioBufferCache = {};

// 一度デコードした音声はキャッシュし、次回以降は再ダウンロード・再デコードしない
async function loadSoundBuffer(ctx, type) {
  if (audioBufferCache[type]) return audioBufferCache[type];
  const res = await fetch(SOUND_FILES[type]);
  if (!res.ok) throw new Error(`音声ファイルの取得に失敗しました: ${SOUND_FILES[type]}`);
  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  audioBufferCache[type] = audioBuffer;
  return audioBuffer;
}

async function playFileSound(ctx, destination, type, gainValue) {
  const buffer = await loadSoundBuffer(ctx, type);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainValue, ctx.currentTime);
  source.connect(gain);
  gain.connect(destination);
  source.start();
}

// 1つの音（オシレーター1個分）を鳴らす
function playTone(ctx, destination, { freq, waveType = 'sine', duration = 0.3, startDelay = 0, gainValue }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const startTime = ctx.currentTime + startDelay;
  osc.type = waveType;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainValue, startTime);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playAlertBeep(phase = 'warning') {
  const volume = getVolume();
  if (volume <= 0) return;
  try {
    if (!sharedAudioCtx) {
      sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume();
    }
    const limiter = sharedAudioCtx.createDynamicsCompressor();
    // 音量を上げても音割れしないよう出力段でリミッターをかける
    limiter.threshold.setValueAtTime(-12, sharedAudioCtx.currentTime);
    limiter.ratio.setValueAtTime(20, sharedAudioCtx.currentTime);
    limiter.connect(sharedAudioCtx.destination);

    const gainValue = MAX_GAIN * (volume / 100);
    const type = getSoundType(phase);

    if (SOUND_FILES[type]) {
      // 効果音ファイル（成功音・警告音・ルーレット点滅音など）
      playFileSound(sharedAudioCtx, limiter, type, gainValue).catch((e) => {
        console.warn('効果音ファイルの再生に失敗しました', e);
      });
    } else if (type === 'double') {
      // ピコン（2音）：高さの違う短い音を2回続けて鳴らす
      playTone(sharedAudioCtx, limiter, { freq: 880, waveType: 'sine', duration: 0.14, gainValue });
      playTone(sharedAudioCtx, limiter, { freq: 1318, waveType: 'sine', duration: 0.16, startDelay: 0.16, gainValue });
    } else if (type === 'buzzer') {
      // ブザー（低音）：矩形波の低い音
      playTone(sharedAudioCtx, limiter, { freq: 220, waveType: 'square', duration: 0.35, gainValue: gainValue * 0.8 });
    } else if (type === 'chime') {
      // チャイム（明るい音）：三角波の高めの音
      playTone(sharedAudioCtx, limiter, { freq: 1046, waveType: 'triangle', duration: 0.4, gainValue: gainValue * 0.7 });
    } else {
      // classic：これまで通りの単音ビープ
      playTone(sharedAudioCtx, limiter, { freq: 880, waveType: 'sine', duration: 0.3, gainValue });
    }
  } catch (e) {
    console.warn('音声アラート再生に失敗しました', e);
  }
}

// 1秒ごとに全部屋を確認し、鳴らすべきアラームがあれば1回ビープする。
// 描画（renderRooms）とは別タイマーにして、再描画のたびに音が重複しないようにする。
function tickAlarms() {
  for (const room of rooms) {
    if (!room.session) continue;
    const state = computeRoomState(room);
    const silence = getAlarmSilence(room.session.session_id);
    if (state === 'warning' && !silence.warning) {
      playAlertBeep('warning');
    } else if (state === 'overtime' && !silence.overtime) {
      playAlertBeep('overtime');
    }
  }
}
setInterval(tickAlarms, 1000);

// ---------- 時計 ----------

setInterval(() => {
  document.getElementById('clock').textContent = formatClock(new Date());
}, 1000);
document.getElementById('clock').textContent = formatClock(new Date());

// ---------- 部屋データ取得・描画 ----------

async function loadRooms() {
  rooms = await apiFetch('/api/rooms');
  renderRooms();
}

async function loadStaff() {
  staffList = await apiFetch('/api/staff');
}

function computeRoomState(room) {
  if (room.status === 'vacant') return 'vacant';
  if (room.status === 'waiting') return 'waiting';
  const now = new Date();
  if (new Date(room.session.planned_end_at) - now <= 0) return 'overtime';
  if (new Date(room.session.planned_warning_at) - now <= 0) return 'warning';
  return 'in_use';
}

function renderRooms() {
  const grid = document.getElementById('roomGrid');
  grid.innerHTML = rooms.map(renderRoomCard).join('');
}

function renderRoomCard(room) {
  const state = computeRoomState(room);
  const stateLabel = {
    vacant: '空室',
    waiting: '待機中',
    in_use: '使用中',
    warning: 'まもなく終了',
    overtime: '時間超過',
  }[state];

  if (state === 'vacant') {
    const lastStaffHint = room.last_staff_name
      ? `<p class="room-last-staff">前回: ${escapeHtml(room.last_staff_name)}</p>`
      : '';
    return `
      <div class="room-card state-vacant">
        <div class="room-card-header">
          <span class="room-name">${escapeHtml(room.room_name)}</span>
          <span class="badge state-vacant">${stateLabel}</span>
        </div>
        <p class="room-empty-label">未使用</p>
        ${lastStaffHint}
        <button data-action="checkin" data-room-id="${room.room_id}">入室登録</button>
      </div>`;
  }

  if (state === 'waiting') {
    const waitingSession = room.session;
    return `
      <div class="room-card state-waiting">
        <div class="room-card-header">
          <span class="room-name">${escapeHtml(room.room_name)}</span>
          <span class="badge state-waiting">${stateLabel}</span>
        </div>
        <p class="room-staff">担当: ${waitingSession.staff_name ? escapeHtml(waitingSession.staff_name) : '未選択'}</p>
        <p class="room-empty-label">利用時間: ${waitingSession.duration_minutes}分（スタート待ち）</p>
        <div class="waiting-actions">
          <button class="btn-primary" data-action="start" data-session-id="${waitingSession.session_id}">▶ スタート</button>
          <button data-action="cancel" data-session-id="${waitingSession.session_id}">取消</button>
        </div>
      </div>`;
  }

  // in_use / warning / overtime
  const session = room.session;
  const start = new Date(session.planned_start_at);
  const end = new Date(session.planned_end_at);
  const warningAt = new Date(session.planned_warning_at);
  const now = new Date();
  // 1コール時刻を境に「前半（1コールまで）」「後半（1コール〜退室）」の2区間で管理する
  const warningRemainingMs = warningAt - now;
  const checkoutRemainingMs = end - now;

  let phaseTotalMs, phaseElapsedMs;
  if (state === 'in_use') {
    phaseTotalMs = warningAt - start;
    phaseElapsedMs = now - start;
  } else {
    phaseTotalMs = end - warningAt;
    phaseElapsedMs = now - warningAt;
  }
  const progressPct = Math.min(100, Math.max(0, (phaseElapsedMs / phaseTotalMs) * 100));

  // 現在のフェーズでアラームが鳴っている（＝ストップボタンが押されていない）かどうか
  const silence = getAlarmSilence(session.session_id);
  const isAlarming = (state === 'warning' && !silence.warning) || (state === 'overtime' && !silence.overtime);

  // 1コールまでの残り：0を下回ったら0で固定表示
  const warningLabel = formatRemaining(Math.max(0, warningRemainingMs));
  // 退室までの残り：1コールに達するまでは退室フェーズの長さ（1コール〜退室の区間）を固定表示し、
  // 達したらそこから実際のカウントダウンを開始する。1コールの調整だけではこの区間の長さは変わらない
  const checkoutLabel = warningRemainingMs > 0
    ? formatRemaining(end - warningAt)
    : checkoutRemainingMs <= 0
      ? `+${formatRemaining(checkoutRemainingMs)}`
      : formatRemaining(checkoutRemainingMs);
  const warningItemClass = warningRemainingMs > 0 ? 'is-active' : 'is-muted';
  const checkoutItemClass = warningRemainingMs > 0 ? 'is-muted' : 'is-active';

  // 退室ボタンの2段階確認：1回目のクリックではまだ退室処理をせず、ボタンの文言を確認メッセージに変える
  const checkoutPending = isCheckoutConfirmPending(session.session_id);

  return `
    <div class="room-card state-${state}">
      <div class="room-card-header">
        <span class="room-name">${escapeHtml(room.room_name)}</span>
        <span class="badge state-${state}">${stateLabel}</span>
      </div>
      <p class="room-staff">担当: ${session.staff_name ? escapeHtml(session.staff_name) : '未選択'}</p>
      <div class="countdown-group">
        <div class="countdown-item ${warningItemClass}">
          <span class="countdown-label">1コールまで</span>
          <span class="countdown-value">${warningLabel}</span>
        </div>
        <div class="countdown-item ${checkoutItemClass}">
          <span class="countdown-label">退室まで</span>
          <span class="countdown-value">${checkoutLabel}</span>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      ${isAlarming ? `<button class="btn-alarm-stop" data-action="stop-alarm" data-session-id="${session.session_id}" data-target="${state}">🔕 ストップ（鳴動中）</button>` : ''}
      <div class="time-adjust">
        <div class="time-adjust-row">
          <span class="time-adjust-label">1コール</span>
          <button class="btn-minus" data-action="adjust-time" data-target="warning" data-session-id="${session.session_id}" data-minutes="-5">-5分</button>
          <button class="btn-minus" data-action="adjust-time" data-target="warning" data-session-id="${session.session_id}" data-minutes="-1">-1分</button>
          <button class="btn-plus" data-action="adjust-time" data-target="warning" data-session-id="${session.session_id}" data-minutes="1">+1分</button>
          <button class="btn-plus" data-action="adjust-time" data-target="warning" data-session-id="${session.session_id}" data-minutes="5">+5分</button>
        </div>
        <div class="time-adjust-row">
          <span class="time-adjust-label">退室</span>
          <button class="btn-minus" data-action="adjust-time" data-target="checkout" data-session-id="${session.session_id}" data-minutes="-5">-5分</button>
          <button class="btn-minus" data-action="adjust-time" data-target="checkout" data-session-id="${session.session_id}" data-minutes="-1">-1分</button>
          <button class="btn-plus" data-action="adjust-time" data-target="checkout" data-session-id="${session.session_id}" data-minutes="1">+1分</button>
          <button class="btn-plus" data-action="adjust-time" data-target="checkout" data-session-id="${session.session_id}" data-minutes="5">+5分</button>
        </div>
      </div>
      <button class="btn-danger${checkoutPending ? ' btn-danger-confirm' : ''}" data-action="checkout" data-session-id="${session.session_id}">${checkoutPending ? '本当に退出させますか？' : '退室'}</button>
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// カード内ボタンのクリックをまとめて処理
document.getElementById('roomGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  try {
    if (action === 'checkin') {
      await openCheckinModal(Number(btn.dataset.roomId));
    } else if (action === 'start') {
      await apiFetch(`/api/sessions/${btn.dataset.sessionId}/start`, { method: 'POST' });
      await loadRooms();
    } else if (action === 'cancel') {
      if (!confirm('この入室登録を取り消しますか？')) return;
      await apiFetch(`/api/sessions/${btn.dataset.sessionId}/cancel`, { method: 'POST' });
      await loadRooms();
    } else if (action === 'stop-alarm') {
      const sessionId = Number(btn.dataset.sessionId);
      const silence = getAlarmSilence(sessionId);
      if (btn.dataset.target === 'warning') silence.warning = true;
      else if (btn.dataset.target === 'overtime') silence.overtime = true;
      renderRooms(); // 次の1秒を待たずにボタンを即座に消す
    } else if (action === 'checkout') {
      const sessionId = Number(btn.dataset.sessionId);
      if (!isCheckoutConfirmPending(sessionId)) {
        // 1回目のクリック：まだ退室処理はせず、ボタンの文言を確認メッセージに変えるだけ
        setCheckoutConfirmPending(sessionId);
        renderRooms();
        return;
      }
      // 2回目のクリック：実際に退室処理を行う
      clearCheckoutConfirmPending(sessionId);
      await apiFetch(`/api/sessions/${sessionId}/checkout`, { method: 'POST' });
      clearAlarmSilence(sessionId);
      await loadRooms();
    } else if (action === 'adjust-time') {
      await apiFetch(`/api/sessions/${btn.dataset.sessionId}/adjust-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: Number(btn.dataset.minutes), target: btn.dataset.target }),
      });
      // 時間変更後、1コール・時間超過のタイミングが変わるためアラームの停止状態をリセットする
      clearAlarmSilence(Number(btn.dataset.sessionId));
      await loadRooms();
    }
  } catch (err) {
    alert(err.message);
  }
});

// 1秒ごとにカウントダウン表示を更新
setInterval(renderRooms, 1000);
// 5秒ごとにサーバーの最新状態と同期（他端末からの操作にも追従できるように）
setInterval(loadRooms, 5000);

// ---------- 入室登録モーダル ----------

const checkinOverlay = document.getElementById('checkinOverlay');

async function openCheckinModal(preselectRoomId) {
  const vacantRooms = rooms.filter((r) => r.status === 'vacant');
  const roomSelect = document.getElementById('checkinRoom');
  roomSelect.innerHTML = vacantRooms.map((r) => `<option value="${r.room_id}">${escapeHtml(r.room_name)}</option>`).join('');
  if (preselectRoomId) roomSelect.value = String(preselectRoomId);

  const staffSelect = document.getElementById('checkinStaff');
  staffSelect.innerHTML = '<option value="">未選択</option>' +
    staffList.map((s) => `<option value="${s.staff_id}">${escapeHtml(s.staff_name)}</option>`).join('');

  document.getElementById('checkinDuration').value = getDefaultDuration();
  document.getElementById('checkinError').textContent = '';
  checkinOverlay.classList.remove('hidden');

  // 部屋を指定して開いた場合、その部屋の前回担当スタッフを初期選択にする
  if (preselectRoomId) {
    try {
      const { staff_id } = await apiFetch(`/api/rooms/${preselectRoomId}/last-staff`);
      if (staff_id && staffList.some((s) => s.staff_id === staff_id)) {
        staffSelect.value = String(staff_id);
      }
    } catch (e) {
      // 取得に失敗しても入室登録自体は続けられるようにする（既定の選択のまま）
      console.warn('前回担当スタッフの取得に失敗しました', e);
    }
  }
}

document.getElementById('btnCheckin').addEventListener('click', () => { openCheckinModal(); });
document.getElementById('checkinCancel').addEventListener('click', () => checkinOverlay.classList.add('hidden'));

document.getElementById('checkinSubmit').addEventListener('click', async () => {
  const room_id = document.getElementById('checkinRoom').value;
  const staff_id = document.getElementById('checkinStaff').value;
  const duration_minutes = document.getElementById('checkinDuration').value;
  const errorEl = document.getElementById('checkinError');
  if (!room_id) {
    errorEl.textContent = '空室がありません';
    return;
  }
  if (!Number.isInteger(Number(duration_minutes)) || Number(duration_minutes) <= 0) {
    errorEl.textContent = '利用時間は1以上の整数（分）で入力してください';
    return;
  }
  try {
    await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id, staff_id, duration_minutes }),
    });
    checkinOverlay.classList.add('hidden');
    await loadRooms();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- 設定モーダル ----------

const settingsOverlay = document.getElementById('settingsOverlay');

document.getElementById('btnSettings').addEventListener('click', () => {
  settingsOverlay.classList.remove('hidden');
});
document.getElementById('settingsClose').addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});

// ---------- 履歴・CSV出力モーダル ----------

const historyOverlay = document.getElementById('historyOverlay');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

document.getElementById('btnHistory').addEventListener('click', async () => {
  document.getElementById('historyFrom').value = todayStr();
  document.getElementById('historyTo').value = todayStr();
  historyOverlay.classList.remove('hidden');
  await searchHistory();
});
document.getElementById('historyClose').addEventListener('click', () => historyOverlay.classList.add('hidden'));
document.getElementById('historySearch').addEventListener('click', searchHistory);

async function searchHistory() {
  const from = document.getElementById('historyFrom').value || todayStr();
  const to = document.getElementById('historyTo').value || todayStr();
  const rowsData = await apiFetch(`/api/sessions?from=${from}&to=${to}`);
  const tbody = document.querySelector('#historyTable tbody');
  const statusLabel = { waiting: '待機中', in_use: '使用中', closed: '退室済' };
  tbody.innerHTML = rowsData.map((s) => `
    <tr>
      <td>${s.created_at.slice(0, 10)}</td>
      <td>${escapeHtml(s.room_name)}</td>
      <td>${s.staff_name ? escapeHtml(s.staff_name) : '未選択'}</td>
      <td>${formatDateTime(s.planned_start_at)}</td>
      <td>${formatDateTime(s.planned_end_at)}</td>
      <td>${formatDateTime(s.actual_end_at)}</td>
      <td>${statusLabel[s.status] || s.status}</td>
    </tr>`).join('');
  document.getElementById('historyDownload').href = `/api/sessions/export?from=${from}&to=${to}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- マスタ管理モーダル ----------

const adminOverlay = document.getElementById('adminOverlay');

document.getElementById('btnAdmin').addEventListener('click', async () => {
  adminOverlay.classList.remove('hidden');
  await refreshAdminLists();
});
document.getElementById('adminClose').addEventListener('click', async () => {
  adminOverlay.classList.add('hidden');
  await loadStaff();
  await loadRooms();
});

async function refreshAdminLists() {
  const [adminRooms, adminStaff] = await Promise.all([
    apiFetch('/api/admin/rooms'),
    apiFetch('/api/admin/staff'),
  ]);

  document.getElementById('adminRoomList').innerHTML = adminRooms
    .filter((r) => r.is_active)
    .map((r) => `<li>${escapeHtml(r.room_name)}<button data-type="room" data-id="${r.room_id}">削除</button></li>`)
    .join('');

  document.getElementById('adminStaffList').innerHTML = adminStaff
    .filter((s) => s.is_active)
    .map((s) => `<li>${escapeHtml(s.staff_name)}<button data-type="staff" data-id="${s.staff_id}">削除</button></li>`)
    .join('');
}

document.getElementById('adminRoomAdd').addEventListener('click', async () => {
  const input = document.getElementById('adminRoomName');
  if (!input.value.trim()) return;
  await apiFetch('/api/admin/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_name: input.value.trim() }),
  });
  input.value = '';
  await refreshAdminLists();
});

document.getElementById('adminStaffAdd').addEventListener('click', async () => {
  const input = document.getElementById('adminStaffName');
  if (!input.value.trim()) return;
  await apiFetch('/api/admin/staff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_name: input.value.trim() }),
  });
  input.value = '';
  await refreshAdminLists();
});

document.querySelectorAll('.admin-list').forEach((list) => {
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    if (!confirm('削除しますか？')) return;
    try {
      const endpoint = btn.dataset.type === 'room' ? 'rooms' : 'staff';
      await apiFetch(`/api/admin/${endpoint}/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshAdminLists();
    } catch (err) {
      alert(err.message);
    }
  });
});

// ---------- バージョン・更新履歴 ----------

const changelogOverlay = document.getElementById('changelogOverlay');

// CHANGELOG.mdの簡易パーサー（## 見出し / - 箇条書きのみ対応）
function renderChangelog(markdown) {
  const lines = markdown.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('## ')) {
      closeList();
      html += `<h3>${escapeHtml(line.slice(3))}</h3>`;
    } else if (line.startsWith('# ')) {
      // 先頭の大見出し（「更新履歴」）は現在バージョン表示と重複するため省略
      continue;
    } else if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${escapeHtml(line.slice(2))}</li>`;
    } else {
      closeList();
      html += `<p>${escapeHtml(line)}</p>`;
    }
  }
  closeList();
  return html;
}

async function loadVersionInfo() {
  try {
    const info = await apiFetch('/api/version');
    const label = info.version ? `v${info.version}` : 'v?';
    document.getElementById('btnVersion').textContent = label;
    document.getElementById('changelogCurrentVersion').textContent =
      info.commit ? `現在のバージョン: v${info.version}（${info.commit.slice(0, 7)}）` : `現在のバージョン: v${info.version}`;
  } catch (err) {
    document.getElementById('btnVersion').textContent = 'v?';
  }
}

document.getElementById('btnVersion').addEventListener('click', async () => {
  changelogOverlay.classList.remove('hidden');
  const body = document.getElementById('changelogBody');
  body.textContent = '読み込み中...';
  try {
    const res = await fetch('/api/changelog');
    const text = await res.text();
    body.innerHTML = renderChangelog(text);
  } catch (err) {
    body.textContent = '更新履歴を読み込めませんでした';
  }
});

document.getElementById('changelogClose').addEventListener('click', () => {
  changelogOverlay.classList.add('hidden');
});

// ---------- 初期化 ----------

(async function init() {
  await Promise.all([loadStaff(), loadRooms(), loadVersionInfo()]);
})();
