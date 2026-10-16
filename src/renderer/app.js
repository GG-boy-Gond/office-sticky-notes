'use strict';

const api = window.notes;
const element = (id) => document.getElementById(id);
const list = element('task-list');
let state;
let view = 'todo';
let editing = null;
let selection = '';
let pending = Promise.resolve();
let autosaveTimer;
let clickTimer;
let toastTimer;
let draggingId;
let pointerInteractive = false;

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  const toast = element('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    isError ? 8000 : 3500,
  );
}

function setSaveStatus(text, error = false) {
  element('save-status').textContent = text;
  element('save-status').classList.toggle('error', error);
}

/** Serialize actions so a slow disk cannot reorder successive edits. */
function action(payload) {
  setSaveStatus('正在保存…');
  const job = pending.then(async () => {
    state = await api.act(payload);
    setSaveStatus('已保存在本机');
    render();
    return state;
  });
  pending = job.catch((error) => {
    setSaveStatus('保存失败', true);
    notify(error.message, true);
  });
  return job;
}

function safe(work) {
  Promise.resolve()
    .then(work)
    .catch((error) => notify(error.message || '操作失败，请重试。', true));
}

function dateLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((today - target) / 86400000);
  if (offset === 0) return '今天';
  if (offset === 1) return '昨天';
  if (offset === 2) return '前天';
  return target.toLocaleDateString('zh-CN', {
    ...(year !== today.getFullYear() ? { year: 'numeric' } : {}),
    month: 'long',
    day: 'numeric',
  });
}

function row(task, index, done = false) {
  const id = escapeHtml(task.id);
  if (editing?.id === task.id) {
    return `<div class="task-row editing" data-id="${id}"><span class="task-index">${index + 1}</span>
      <input id="note-editor" class="editor" maxlength="10000" aria-label="便签内容" value="${escapeHtml(editing.value)}" spellcheck="false">
      <button class="task-action" data-action="save" aria-label="保存便签" title="保存 · Enter">✓</button>
      <button class="task-action danger" data-action="delete" aria-label="删除便签" title="删除">×</button></div>`;
  }
  const attributes = done ? '' : 'draggable="true"';
  return `<div class="task-row ${done ? `done-row ${selection === task.id ? 'selected' : ''}` : ''}" data-id="${id}" ${attributes}>
    ${done ? `<span class="task-index">${index + 1}</span>` : '<button class="drag-handle" aria-label="拖动排序" title="拖动排序 · Alt ↑ / ↓">⠿</button>'}
    <button class="task-text" title="${escapeHtml(task.content)}">${escapeHtml(task.content)}</button>
    ${done ? '<button class="task-action" data-action="restore" aria-label="恢复便签" title="恢复为待办">↶</button><button class="task-action danger" data-action="deleteDone" aria-label="删除已完成便签" title="永久删除">×</button>' : '<button class="task-action" data-action="complete" aria-label="完成便签" title="标记完成">✓</button>'}
  </div>`;
}

function emptyState(done) {
  return `<div class="empty-state"><span class="empty-symbol">${done ? '✓' : '✎'}</span><h2>${done ? '完成的事，都记在这里。' : '给今天留一点空间。'}</h2><p>${done ? '双击待办文字，或点击右侧的 ✓<br>完成记录将按日期归档。' : '点击下方空白或「写一条新便签」<br>把脑海里的事，轻轻放下来。'}</p></div>`;
}

function applyAppearance(appearance) {
  const root = document.documentElement;
  root.style.setProperty('--background-color', appearance.backgroundColor);
  root.style.setProperty('--background-opacity', appearance.backgroundOpacity / 100);
  root.style.setProperty('--text-opacity', appearance.textOpacity / 100);
  root.style.setProperty('--task-font-size', `${appearance.fontSize}px`);
  root.style.setProperty(
    '--background-image',
    appearance.backgroundImage ? `url("${appearance.backgroundImage}")` : 'none',
  );
  element('note-window').classList.toggle('text-only', appearance.backgroundOpacity === 0);
  element('background-color').value = appearance.backgroundColor;
  element('background-opacity').value = appearance.backgroundOpacity;
  element('text-opacity').value = appearance.textOpacity;
  element('font-size').value = appearance.fontSize;
  element('background-opacity-value').value = `${appearance.backgroundOpacity}%`;
  element('text-opacity-value').value = `${appearance.textOpacity}%`;
  element('font-size-value').value = `${appearance.fontSize} px`;
  element('background-image-name').textContent = appearance.imageName || '未选择图片';
  element('clear-background').hidden = !appearance.backgroundImage;
}

function saveAppearance(patch) {
  const job = pending.then(async () => {
    state = await api.setAppearance(patch);
    applyAppearance(state.settings.appearance);
  });
  pending = job.catch((error) => {
    applyAppearance(state.settings.appearance);
    notify(error.message, true);
  });
  return pending;
}

function render() {
  if (!state) return;
  applyAppearance(state.settings.appearance);
  const input = element('note-editor');
  const focus = input && document.activeElement === input;
  const start = input?.selectionStart;
  const end = input?.selectionEnd;
  if (view === 'todo') {
    let html = state.todos.map((task, index) => row(task, index)).join('');
    if (editing && !state.todos.some((task) => task.id === editing.id))
      html += row({ id: editing.id }, state.todos.length);
    list.innerHTML = html || emptyState(false);
  } else {
    const groups = new Map();
    for (const task of [...state.done].sort((a, b) => b.completedAt.localeCompare(a.completedAt))) {
      const day = task.completedAt.slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(task);
    }
    list.innerHTML =
      [...groups]
        .map(
          ([day, tasks]) =>
            `<section class="date-group"><h2 class="date-heading">${dateLabel(day)}<small>${day.replaceAll('-', '.')}</small></h2>${tasks.map((task, index) => row(task, index, true)).join('')}</section>`,
        )
        .join('') || emptyState(true);
  }
  element('add-note').hidden = view !== 'todo' || !!editing;
  element('todo-count').textContent = state.todos.length;
  element('done-count').textContent = state.done.length;
  document.querySelectorAll('[data-view]').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  const locked = state.settings.ignoreMouse;
  element('note-window').classList.toggle('locked', locked);
  element('lock-button').setAttribute('aria-pressed', String(locked));
  element('lock-button').title = `鼠标穿透：${locked ? '开启（点击解除）' : '关闭'}`;
  element('lock-shackle').setAttribute(
    'd',
    locked ? 'M8 10V7a4 4 0 0 1 8 0v3 M12 14v3' : 'M8 10V7a4 4 0 0 1 8 0 M12 14v3',
  );
  element('footer-hint').textContent = locked
    ? '顶部工具栏或托盘可解除穿透'
    : view === 'todo'
      ? '单击编辑 · 双击完成'
      : '单击记录 · 恢复或删除';
  element('login-setting').checked = state.app.loginEnabled;
  element('login-setting').disabled = !state.app.loginSupported;
  element('update-message').textContent = state.app.update.message;
  element('update-button').textContent = state.app.update.phase === 'downloaded' ? '安装' : '检查';
  element('app-version').textContent = `OFFICE NOTES · ${state.app.version}`;
  if (focus && element('note-editor')) {
    element('note-editor').focus();
    element('note-editor').setSelectionRange(start, end);
  }
}

async function persistDraft(draft, final = false) {
  clearTimeout(autosaveTimer);
  const value = draft.value.trim();
  if (!value) {
    if (final && state.todos.some((task) => task.id === draft.id)) {
      await action({ type: 'delete', id: draft.id });
      draft.savedValue = '';
    }
    return;
  }
  if (value === draft.savedValue) return;
  await action({ type: 'save', id: draft.id, content: value });
  draft.savedValue = value;
}

async function finishEdit() {
  clearTimeout(clickTimer);
  if (!editing) {
    await pending;
    return;
  }
  const draft = editing;
  await persistDraft(draft, true);
  if (editing === draft) editing = null;
  render();
}

async function startEdit(id) {
  if (editing && editing.id === id) return;
  await finishEdit();
  const task = state.todos.find((note) => note.id === id);
  editing = {
    id: task?.id || crypto.randomUUID(),
    original: task?.content || '',
    value: task?.content || '',
    savedValue: task?.content || '',
    isNew: !task,
  };
  render();
  element('note-editor').focus();
  element('note-editor').setSelectionRange(editing.value.length, editing.value.length);
  element('note-editor').scrollIntoView({ block: 'nearest' });
}

async function cancelEdit() {
  clearTimeout(autosaveTimer);
  const draft = editing;
  if (!draft) return;
  await pending;
  if (draft.isNew && state.todos.some((task) => task.id === draft.id))
    await action({ type: 'delete', id: draft.id });
  else if (!draft.isNew && draft.savedValue !== draft.original)
    await action({ type: 'save', id: draft.id, content: draft.original });
  editing = null;
  render();
}

async function deleteDraft() {
  clearTimeout(autosaveTimer);
  const draft = editing;
  if (!draft) return;
  await pending;
  if (state.todos.some((task) => task.id === draft.id))
    await action({ type: 'delete', id: draft.id });
  editing = null;
  render();
  notify('便签已删除');
}

function celebrate(x, y) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = element('celebration');
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  const context = canvas.getContext('2d');
  context.scale(devicePixelRatio, devicePixelRatio);
  const particles = Array.from({ length: 22 }, (_, index) => ({
    x,
    y,
    vx: Math.cos((index / 22) * Math.PI * 2) * (1.5 + Math.random() * 2.5),
    vy: Math.sin((index / 22) * Math.PI * 2) * (1.5 + Math.random() * 2.5) - 1,
    color: ['#c3e2bd', '#e6cf9e', '#8ebeb0'][index % 3],
  }));
  let frame = 0;
  function draw() {
    context.clearRect(0, 0, innerWidth, innerHeight);
    context.globalAlpha = 1 - frame / 38;
    particles.forEach((particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.06;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, 3, 3);
    });
    frame += 1;
    if (frame < 38) requestAnimationFrame(draw);
    else context.clearRect(0, 0, innerWidth, innerHeight);
  }
  draw();
}

const commands = {
  async export() {
    await finishEdit();
    const result = await api.exportExcel();
    if (!result.canceled) notify('全部便签已导出为 Excel');
  },
  async hide() {
    await finishEdit();
    await api.hide();
  },
  async lock() {
    await finishEdit();
    state = await api.ignoreMouse(!state.settings.ignoreMouse);
    render();
  },
  async settings() {
    await finishEdit();
    element('settings-panel').hidden = false;
    element('note-window').classList.add('settings-open');
    updatePointer(true);
  },
  'close-settings'() {
    element('settings-panel').hidden = true;
    element('note-window').classList.remove('settings-open');
    if (element('settings-panel').contains(document.activeElement)) document.activeElement.blur();
    updatePointer(false);
  },
  async 'select-background'() {
    await pending;
    const result = await api.selectBackgroundImage();
    if (result.canceled) return;
    state = result.state;
    applyAppearance(state.settings.appearance);
    notify('背景图片已保存');
  },
  async 'clear-background'() {
    await pending;
    state = await api.clearBackgroundImage();
    applyAppearance(state.settings.appearance);
    notify('已移除背景图片，使用纯色背景');
  },
  folder: () => api.openDataFolder(),
  async import() {
    await finishEdit();
    const result = await api.importData();
    if (!result.canceled) {
      state = await api.read();
      render();
      notify('已合并导入，现有便签已保留');
    }
  },
  async update() {
    if (state.app.update.phase === 'downloaded') await api.installUpdate();
    else {
      state.app.update = await api.checkUpdates();
      render();
      notify(state.app.update.message);
    }
  },
  async quit() {
    await finishEdit();
    await api.quit();
  },
};

document.addEventListener('click', (event) => {
  const command = event.target.closest('[data-command]');
  if (command) {
    safe(() => commands[command.dataset.command]());
    return;
  }
  const tab = event.target.closest('[data-view]');
  if (tab) {
    safe(async () => {
      await finishEdit();
      view = tab.dataset.view;
      selection = '';
      render();
    });
  }
});

element('add-note').addEventListener('click', () => safe(() => startEdit()));
element('content').addEventListener('click', (event) => {
  if (view === 'todo' && ['content', 'task-list'].includes(event.target.id))
    safe(() => (editing ? finishEdit() : startEdit()));
});

list.addEventListener('input', (event) => {
  if (event.target.id !== 'note-editor' || !editing) return;
  editing.value = event.target.value;
  setSaveStatus('正在编辑…');
  clearTimeout(autosaveTimer);
  const draft = editing;
  autosaveTimer = setTimeout(() => safe(() => persistDraft(draft)), 450);
});

list.addEventListener('click', (event) => {
  const task = event.target.closest('[data-id]');
  if (!task) return;
  const id = task.dataset.id;
  const button = event.target.closest('[data-action]');
  if (button) {
    clearTimeout(clickTimer);
    safe(async () => {
      const type = button.dataset.action;
      if (type === 'save') return finishEdit();
      if (type === 'delete') return deleteDraft();
      await finishEdit();
      await action({ type, id });
      if (type === 'complete') celebrate(event.clientX, event.clientY);
    });
    return;
  }
  if (!event.target.closest('.task-text')) return;
  if (view === 'done') {
    selection = selection === id ? '' : id;
    render();
    return;
  }
  clearTimeout(clickTimer);
  if (event.detail === 1) clickTimer = setTimeout(() => safe(() => startEdit(id)), 270);
});

list.addEventListener('dblclick', (event) => {
  if (view !== 'todo' || !event.target.closest('.task-text')) return;
  clearTimeout(clickTimer);
  const id = event.target.closest('[data-id]').dataset.id;
  safe(async () => {
    await finishEdit();
    await action({ type: 'complete', id });
    celebrate(event.clientX, event.clientY);
  });
});

list.addEventListener('dragstart', (event) => {
  if (editing || view !== 'todo') {
    event.preventDefault();
    return;
  }
  const task = event.target.closest('[data-id]');
  if (!task) return;
  clearTimeout(clickTimer);
  draggingId = task.dataset.id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggingId);
  task.classList.add('dragging');
});

list.addEventListener('dragover', (event) => {
  if (!draggingId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const target = event.target.closest('[data-id]');
  const dragged = list.querySelector('.dragging');
  if (!target || !dragged || target === dragged) return;
  const rect = target.getBoundingClientRect();
  list.insertBefore(
    dragged,
    event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling,
  );
});
list.addEventListener('drop', (event) => event.preventDefault());
list.addEventListener('dragend', () => {
  if (!draggingId) return;
  draggingId = null;
  const ids = [...list.querySelectorAll('[data-id]')].map((task) => task.dataset.id);
  list.querySelector('.dragging')?.classList.remove('dragging');
  if (ids.some((id, index) => state.todos[index]?.id !== id))
    safe(() => action({ type: 'reorder', ids }));
});

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && ['n', 'e', ','].includes(event.key.toLowerCase())) {
    event.preventDefault();
    safe(async () => {
      if (event.key.toLowerCase() === 'n') {
        await finishEdit();
        view = 'todo';
        element('settings-panel').hidden = true;
        element('note-window').classList.remove('settings-open');
        await startEdit();
      } else await commands[event.key.toLowerCase() === 'e' ? 'export' : 'settings']();
    });
  }
  if (event.key === 'Escape') {
    if (!element('settings-panel').hidden) commands['close-settings']();
    else safe(cancelEdit);
  }
  if (event.target.id === 'note-editor' && event.key === 'Enter') {
    event.preventDefault();
    safe(finishEdit);
  }
  if (
    event.altKey &&
    ['ArrowUp', 'ArrowDown'].includes(event.key) &&
    event.target.matches('.drag-handle')
  ) {
    event.preventDefault();
    const id = event.target.closest('[data-id]').dataset.id;
    const ids = state.todos.map((task) => task.id);
    const index = ids.indexOf(id);
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    safe(async () => {
      await action({ type: 'reorder', ids });
      list.querySelector(`[data-id="${CSS.escape(id)}"] .drag-handle`).focus();
    });
  }
});

for (const [id, key] of [
  ['background-color', 'backgroundColor'],
  ['background-opacity', 'backgroundOpacity'],
  ['text-opacity', 'textOpacity'],
  ['font-size', 'fontSize'],
]) {
  const control = element(id);
  const value = () => (control.type === 'color' ? control.value : Number(control.value));
  control.addEventListener('input', () => {
    applyAppearance({ ...state.settings.appearance, [key]: value() });
  });
  control.addEventListener('change', () => saveAppearance({ [key]: value() }));
}

element('login-setting').addEventListener('change', () =>
  safe(async () => {
    try {
      state = await api.setLogin(element('login-setting').checked);
      render();
      notify(state.app.loginEnabled ? '已开启开机启动' : '已关闭开机启动');
    } catch (error) {
      render();
      throw error;
    }
  }),
);

function updatePointer(value) {
  if (pointerInteractive === value) return;
  pointerInteractive = value;
  safe(() => api.pointerInteractive(value));
}

window.addEventListener('mousemove', (event) => {
  const rect = element('toolbar').getBoundingClientRect();
  updatePointer(
    !element('settings-panel').hidden ||
      (event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom),
  );
});
document.addEventListener('mouseleave', () => updatePointer(false));
window.addEventListener('blur', () =>
  safe(async () => {
    if (editing) await persistDraft(editing, true);
  }),
);

api.onState((next) => {
  state = next;
  render();
});
api.onError((message) => notify(message, true));
api.onFlush((token) => {
  finishEdit()
    .then(() => api.flushed(token))
    .catch((error) => api.flushed(token, error.message));
});
safe(async () => {
  state = await api.read();
  render();
  setSaveStatus('已保存在本机');
  if (state.app.recoveryMessage) notify(state.app.recoveryMessage, true);
});
