'use strict';

// マスタ管理（部屋・スタッフ）画面
// ダッシュボードのモーダルではなく独立した画面として動作する。
// 部屋・スタッフはタブで切り替え、並び替えはドラッグ&ドロップで行う。

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `通信エラー (${res.status})`);
  }
  return data;
}

// ---------- タブ切り替え ----------

document.querySelectorAll('.admin-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.admin-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.tab);
    });
  });
});

// ---------- 一覧の描画 ----------

// 編集中の項目（部屋・スタッフそれぞれ1件まで）。一覧の再描画をまたいで状態を保持する
let editingRoomId = null;
let editingStaffId = null;

// マスタ管理の一覧1行分のHTMLを生成する（部屋・スタッフ共通）
function renderAdminItem({ type, id, name, editing }) {
  if (editing) {
    return `
      <li class="admin-item is-editing" data-id="${id}">
        <input type="text" class="admin-edit-input" data-type="${type}" data-id="${id}" value="${escapeHtml(name)}">
        <div class="admin-item-actions">
          <button data-action="save-edit" data-type="${type}" data-id="${id}">保存</button>
          <button data-action="cancel-edit" data-type="${type}" data-id="${id}">キャンセル</button>
        </div>
      </li>`;
  }
  return `
    <li class="admin-item" draggable="true" data-id="${id}">
      <span class="drag-handle" aria-hidden="true" title="ドラッグして並び替え">⠿</span>
      <span class="admin-item-name">${escapeHtml(name)}</span>
      <div class="admin-item-actions">
        <button data-action="edit" data-type="${type}" data-id="${id}">編集</button>
        <button data-action="delete" data-type="${type}" data-id="${id}">削除</button>
      </div>
    </li>`;
}

async function refreshAdminLists() {
  const [adminRooms, adminStaff] = await Promise.all([
    apiFetch('/api/admin/rooms'),
    apiFetch('/api/admin/staff'),
  ]);

  const activeRooms = adminRooms.filter((r) => r.is_active);
  const activeStaff = adminStaff.filter((s) => s.is_active);

  document.getElementById('adminRoomList').innerHTML = activeRooms
    .map((r) => renderAdminItem({ type: 'room', id: r.room_id, name: r.room_name, editing: editingRoomId === r.room_id }))
    .join('');

  document.getElementById('adminStaffList').innerHTML = activeStaff
    .map((s) => renderAdminItem({ type: 'staff', id: s.staff_id, name: s.staff_name, editing: editingStaffId === s.staff_id }))
    .join('');

  // 編集モードの入力欄があれば、開いた直後にすぐ入力できるようフォーカスする
  const editingInput = document.querySelector('.admin-edit-input');
  if (editingInput) {
    editingInput.focus();
    editingInput.select();
  }
}

// ---------- 追加 ----------

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

// ---------- 編集・削除・ドラッグ&ドロップ並び替え ----------

document.querySelectorAll('.admin-list').forEach((list) => {
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, type, id } = btn.dataset;
    const numId = Number(id);
    const endpoint = type === 'room' ? 'rooms' : 'staff';

    if (action === 'delete') {
      if (!confirm('削除しますか？')) return;
      try {
        await apiFetch(`/api/admin/${endpoint}/${numId}`, { method: 'DELETE' });
        await refreshAdminLists();
      } catch (err) {
        alert(err.message);
      }
    } else if (action === 'edit') {
      if (type === 'room') editingRoomId = numId; else editingStaffId = numId;
      await refreshAdminLists();
    } else if (action === 'cancel-edit') {
      if (type === 'room') editingRoomId = null; else editingStaffId = null;
      await refreshAdminLists();
    } else if (action === 'save-edit') {
      const input = list.querySelector(`.admin-edit-input[data-type="${type}"][data-id="${id}"]`);
      const newName = input.value.trim();
      if (!newName) {
        alert(type === 'room' ? '部屋名を入力してください' : 'スタッフ名を入力してください');
        return;
      }
      try {
        const field = type === 'room' ? 'room_name' : 'staff_name';
        await apiFetch(`/api/admin/${endpoint}/${numId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: newName }),
        });
        if (type === 'room') editingRoomId = null; else editingStaffId = null;
        await refreshAdminLists();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  // 編集中の入力欄でEnter＝保存、Escape＝キャンセル
  list.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('admin-edit-input')) return;
    const { type, id } = e.target.dataset;
    if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector(`button[data-action="save-edit"][data-type="${type}"][data-id="${id}"]`)?.click();
    } else if (e.key === 'Escape') {
      list.querySelector(`button[data-action="cancel-edit"][data-type="${type}"][data-id="${id}"]`)?.click();
    }
  });

  // ドラッグ中の項目を、ドロップ位置に応じてその場でDOM上の順序を入れ替える
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[draggable="true"]');
    if (!li) return;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefoxなど、setDataを呼ばないとdragイベントが発火しないブラウザ向け
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });

  list.addEventListener('dragend', (e) => {
    const li = e.target.closest('li');
    if (li) li.classList.remove('dragging');
  });

  list.addEventListener('dragover', (e) => {
    const dragging = list.querySelector('.dragging');
    if (!dragging) return;
    e.preventDefault();
    const afterElement = getDragAfterElement(list, e.clientY);
    if (afterElement == null) {
      list.appendChild(dragging);
    } else if (afterElement !== dragging) {
      list.insertBefore(dragging, afterElement);
    }
  });

  list.addEventListener('drop', async (e) => {
    const dragging = list.querySelector('.dragging');
    if (!dragging) return;
    e.preventDefault();
    const type = list.id === 'adminRoomList' ? 'room' : 'staff';
    const endpoint = type === 'room' ? 'rooms' : 'staff';
    const orderedIds = [...list.querySelectorAll('li[data-id]')].map((li) => Number(li.dataset.id));
    try {
      await apiFetch(`/api/admin/${endpoint}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: orderedIds }),
      });
    } catch (err) {
      alert(err.message);
      await refreshAdminLists(); // 失敗時はサーバー側の状態に合わせて表示をもとに戻す
    }
  });
});

// ドラッグ中のY座標から、挿入先として最も近い（自分より下にある）要素を返す
function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll('li[draggable="true"]:not(.dragging)')];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

// ---------- 初期化 ----------

refreshAdminLists();
