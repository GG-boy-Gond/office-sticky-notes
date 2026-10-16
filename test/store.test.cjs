'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NotesStore } = require('../src/main/store.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'office-notes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { store: new NotesStore(directory), directory };
}

test('complete, restore, reorder, and restart preserve every task and original creation time', (t) => {
  const { store, directory } = fixture(t);
  store.dispatch({ type: 'save', id: 'a', content: '第一条' });
  store.dispatch({ type: 'save', id: 'b', content: '第二条' });
  const createdAt = store.snapshot().todos[0].createdAt;
  store.dispatch({ type: 'complete', id: 'a' });
  assert.equal(store.snapshot().todos.length, 1);
  assert.equal(store.snapshot().done[0].createdAt, createdAt);
  assert.ok(store.snapshot().done[0].completedAt);
  store.dispatch({ type: 'restore', id: 'a' });
  store.dispatch({ type: 'reorder', ids: ['a', 'b'] });
  const reloaded = new NotesStore(directory).snapshot();
  assert.deepEqual(
    reloaded.todos.map((task) => task.id),
    ['a', 'b'],
  );
  assert.equal(reloaded.todos[0].createdAt, createdAt);
  assert.equal(reloaded.done.length, 0);
});

test('invalid changes do not change memory or disk', (t) => {
  const { store } = fixture(t);
  store.dispatch({ type: 'save', id: 'a', content: '保留这条' });
  const before = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.dispatch({ type: 'reorder', ids: ['missing'] }));
  assert.throws(() => store.dispatch({ type: 'save', id: 'a', content: '  ' }));
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(store.snapshot().todos[0].content, '保留这条');
});

test('a failed atomic replacement leaves the last committed state intact', (t) => {
  const { store } = fixture(t);
  store.dispatch({ type: 'save', id: 'a', content: '原内容' });
  const original = store.persist;
  store.persist = () => {
    throw new Error('simulated disk full');
  };
  assert.throws(() => store.dispatch({ type: 'save', id: 'a', content: '新内容' }), /disk full/);
  assert.equal(store.snapshot().todos[0].content, '原内容');
  store.persist = original;
});

test('damaged data recovers the previous backup and keeps the damaged file', (t) => {
  const { store, directory } = fixture(t);
  store.dispatch({ type: 'save', id: 'a', content: '可恢复的内容' });
  store.dispatch({ type: 'save', id: 'b', content: '下一次内容' });
  fs.writeFileSync(store.file, '{invalid');
  const recovered = new NotesStore(directory);
  assert.equal(recovered.snapshot().todos[0].content, '可恢复的内容');
  assert.ok(recovered.recoveryMessage);
  assert.ok(fs.readdirSync(directory).some((name) => name.includes('.damaged-')));
});

test('damaged data without backup is retained instead of silently reset', (t) => {
  const { store, directory } = fixture(t);
  fs.writeFileSync(store.file, 'damaged');
  assert.throws(() => new NotesStore(directory), /原文件已保留/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), 'damaged');
});

test('legacy import merges, assigns stable IDs, deduplicates, and rejects invalid files atomically', (t) => {
  const { store } = fixture(t);
  store.dispatch({ type: 'save', id: 'existing', content: '现有任务' });
  const document = {
    todoList: [{ content: '旧待办', todo_datetime: '2022/09/03 12:30:00' }],
    doneList: [
      {
        content: '旧记录',
        todo_datetime: '2022/09/02 10:00:00',
        done_datetime: '2022/09/03 10:00:00',
      },
    ],
  };
  store.importDocument(document);
  const id = store.snapshot().todos[1].id;
  store.importDocument(document);
  assert.equal(store.snapshot().todos.length, 2);
  assert.equal(store.snapshot().done.length, 1);
  assert.equal(store.snapshot().todos[1].id, id);
  assert.equal(store.snapshot().todos[1].createdAt, '2022-09-03 12:30:00');
  const before = store.snapshot();
  assert.throws(() =>
    store.importDocument({ todoList: [{ content: '坏数据', todo_datetime: 'no' }], doneList: [] }),
  );
  assert.deepEqual(store.snapshot(), before);
});

test('content that looks like markup is stored verbatim', (t) => {
  const { store } = fixture(t);
  const text = '<img src=x onerror="alert(1)"> & 测试';
  store.dispatch({ type: 'save', id: 'xss', content: text });
  assert.equal(store.snapshot().todos[0].content, text);
});

test('appearance migration preserves older tasks; independent opacity and images survive restart', (t) => {
  const { store, directory } = fixture(t);
  store.dispatch({ type: 'save', id: 'old', content: '保留旧便签' });
  const old = store.snapshot();
  delete old.settings.appearance;
  fs.writeFileSync(store.file, JSON.stringify(old));
  const migrated = new NotesStore(directory);
  assert.equal(migrated.snapshot().settings.appearance.textOpacity, 100);
  assert.equal(migrated.snapshot().settings.appearance.fontSize, 14);
  assert.deepEqual(migrated.snapshot().todos, old.todos);
  migrated.setAppearance({
    backgroundColor: '#123456',
    backgroundOpacity: 0,
    textOpacity: 100,
    fontSize: 24,
  });
  migrated.setAppearance({
    backgroundImage: 'data:image/png;base64,aGVsbG8=',
    imageName: '本地.png',
  });
  const reloaded = new NotesStore(directory).snapshot();
  assert.equal(reloaded.settings.appearance.backgroundOpacity, 0);
  assert.equal(reloaded.settings.appearance.textOpacity, 100);
  assert.equal(reloaded.settings.appearance.backgroundColor, '#123456');
  assert.equal(reloaded.settings.appearance.imageName, '本地.png');
  assert.equal(reloaded.settings.appearance.fontSize, 24);
  assert.deepEqual(reloaded.todos, old.todos);
});

test('invalid appearance cannot overwrite saved tasks or settings', (t) => {
  const { store } = fixture(t);
  const before = fs.readFileSync(store.file, 'utf8');
  for (const patch of [
    { backgroundOpacity: -1 },
    { textOpacity: 101 },
    { textOpacity: 0.5 },
    { backgroundColor: 'red' },
    { backgroundImage: 'file:///C:/private.png' },
    { backgroundImage: 'data:image/svg+xml;base64,aGVsbG8=' },
    { ignoreMouse: true },
    { fontSize: 9 },
    { fontSize: 37 },
    { fontSize: 14.5 },
    { fontSize: '20' },
  ]) {
    assert.throws(() => store.setAppearance(patch));
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  }
});
