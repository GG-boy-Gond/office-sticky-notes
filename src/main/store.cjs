'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_APPEARANCE, validateAppearance } = require('./appearance.cjs');

const MAX_CONTENT_LENGTH = 10000;

function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timestamp(date = new Date()) {
  return `${localDate(date)} ${date.toTimeString().slice(0, 8)}`;
}

function contentOf(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('便签内容不能为空。');
  if (value.length > MAX_CONTENT_LENGTH) throw new Error('便签内容不能超过 10000 个字符。');
  return value.trim();
}

function initialState() {
  return {
    schemaVersion: 1,
    revision: 0,
    todos: [],
    done: [],
    settings: { ignoreMouse: false, appearance: { ...DEFAULT_APPEARANCE } },
    window: { width: 360, height: 420 },
  };
}

function validTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value) &&
    !Number.isNaN(Date.parse(value.replace(' ', 'T')))
  );
}

function validate(state) {
  if (
    !state ||
    state.schemaVersion !== 1 ||
    !Array.isArray(state.todos) ||
    !Array.isArray(state.done)
  ) {
    throw new Error('便签文件格式不正确或版本不受支持。');
  }
  const ids = new Set();
  for (const task of [...state.todos, ...state.done]) {
    if (typeof task.id !== 'string' || !task.id || ids.has(task.id))
      throw new Error('便签 ID 无效或重复。');
    ids.add(task.id);
    contentOf(task.content);
    if (!validTimestamp(task.createdAt)) throw new Error('便签创建时间无效。');
  }
  for (const task of state.done) {
    if (!validTimestamp(task.completedAt)) throw new Error('便签完成时间无效。');
  }
  if (!state.settings || typeof state.settings.ignoreMouse !== 'boolean')
    throw new Error('设置格式无效。');
  // Older notes files gain defaults without changing tasks or their identifiers.
  state.settings.appearance = validateAppearance(state.settings.appearance ?? {});
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new Error('数据版本无效。');
  return state;
}

/** The main process is the only writer; every change replaces one complete document. */
class NotesStore {
  constructor(directory) {
    this.file = path.join(directory, 'notes.json');
    this.backup = path.join(directory, 'notes.backup.json');
    this.recoveryMessage = '';
    fs.mkdirSync(directory, { recursive: true });
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      const state = initialState();
      this.persist(state, false);
      return state;
    }
    try {
      return validate(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      // Never silently reset a damaged database to empty.
      if (!fs.existsSync(this.backup)) {
        throw new Error(`便签文件无法读取，原文件已保留：${this.file}\n${error.message}`, {
          cause: error,
        });
      }
      const recovered = validate(JSON.parse(fs.readFileSync(this.backup, 'utf8')));
      fs.copyFileSync(this.file, `${this.file}.damaged-${Date.now()}`);
      this.persist(recovered, false);
      this.recoveryMessage = '数据文件异常，已恢复上一次备份；损坏文件已保留。';
      return recovered;
    }
  }

  persist(state, saveBackup = true) {
    const temporaryFile = `${this.file}.tmp`;
    const fd = fs.openSync(temporaryFile, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (saveBackup && fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
      fs.renameSync(temporaryFile, this.file);
    } catch (error) {
      fs.rmSync(temporaryFile, { force: true });
      throw error;
    }
  }

  snapshot() {
    return structuredClone(this.state);
  }

  transaction(mutate) {
    const next = this.snapshot();
    mutate(next);
    next.revision += 1;
    validate(next);
    this.persist(next);
    this.state = next;
    return this.snapshot();
  }

  dispatch(action) {
    if (!action || typeof action.type !== 'string') throw new Error('无效的便签操作。');
    return this.transaction((state) => {
      const index = state.todos.findIndex((task) => task.id === action.id);
      const doneIndex = state.done.findIndex((task) => task.id === action.id);
      switch (action.type) {
        case 'save': {
          const content = contentOf(action.content);
          if (index >= 0) state.todos[index].content = content;
          else {
            if (doneIndex >= 0) throw new Error('这条便签已完成，请先恢复。');
            const id = action.id || randomUUID();
            if (typeof id !== 'string' || !id || id.length > 100) throw new Error('便签 ID 无效。');
            state.todos.push({ id, content, createdAt: timestamp() });
          }
          break;
        }
        case 'delete':
          if (index < 0) throw new Error('这条待办已不存在。');
          state.todos.splice(index, 1);
          break;
        case 'complete': {
          if (index < 0) throw new Error('这条待办已不存在。');
          const [task] = state.todos.splice(index, 1);
          state.done.unshift({ ...task, completedAt: timestamp() });
          break;
        }
        case 'restore': {
          if (doneIndex < 0) throw new Error('这条已完成便签不存在。');
          const [task] = state.done.splice(doneIndex, 1);
          delete task.completedAt;
          state.todos.push(task);
          break;
        }
        case 'deleteDone':
          if (doneIndex < 0) throw new Error('这条已完成便签不存在。');
          state.done.splice(doneIndex, 1);
          break;
        case 'reorder': {
          if (
            !Array.isArray(action.ids) ||
            action.ids.length !== state.todos.length ||
            new Set(action.ids).size !== state.todos.length
          ) {
            throw new Error('排序与当前便签列表不一致。');
          }
          const byId = new Map(state.todos.map((task) => [task.id, task]));
          state.todos = action.ids.map((id) => {
            if (!byId.has(id)) throw new Error('排序包含未知便签。');
            return byId.get(id);
          });
          break;
        }
        default:
          throw new Error('不支持的便签操作。');
      }
    });
  }

  setIgnoreMouse(value) {
    if (typeof value !== 'boolean') throw new Error('无效的设置。');
    return this.transaction((state) => {
      state.settings.ignoreMouse = value;
    });
  }

  setAppearance(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('外观设置无效。');
    return this.transaction((state) => {
      state.settings.appearance = validateAppearance({ ...state.settings.appearance, ...patch });
    });
  }

  saveWindow(bounds) {
    if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])))
      return;
    return this.transaction((state) => {
      state.window = { ...bounds };
    });
  }

  importDocument(document) {
    let incoming;
    if (document?.schemaVersion === 1) incoming = validate(document);
    else if (document && Array.isArray(document.todoList) && Array.isArray(document.doneList)) {
      const convert = (task, completed) => {
        const createdAt = String(task.todo_datetime || task.todo_date || timestamp()).replaceAll(
          '/',
          '-',
        );
        const note = { id: randomUUID(), content: contentOf(task.content), createdAt };
        if (completed)
          note.completedAt = String(task.done_datetime || task.done_date || timestamp()).replaceAll(
            '/',
            '-',
          );
        return note;
      };
      incoming = initialState();
      incoming.todos = document.todoList.map((task) => convert(task, false));
      incoming.done = document.doneList.map((task) => convert(task, true));
      validate(incoming);
    } else throw new Error('请选择旧版 data.json 或新版 notes.json 文件。');

    // Merge existing content and deduplicate repeated imports.
    return this.transaction((state) => {
      const keyOf = (task) =>
        JSON.stringify([task.content, task.createdAt, task.completedAt || '']);
      const known = new Set([...state.todos, ...state.done].map(keyOf));
      for (const collection of ['todos', 'done']) {
        for (const task of incoming[collection]) {
          const key = keyOf(task);
          if (known.has(key)) continue;
          known.add(key);
          state[collection].push({ ...task, id: randomUUID() });
        }
      }
    });
  }
}

module.exports = { NotesStore, initialState, validate, localDate, timestamp };
