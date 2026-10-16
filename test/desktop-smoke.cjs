'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.join(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const executable = packaged
  ? path.join(root, 'outputs', 'desktop', 'win-unpacked', 'Office Notes.exe')
  : require('electron');
const output = path.join(root, 'outputs', 'verification');
const data = path.join(root, 'work', `desktop-test-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(data, { recursive: true });
const args = [
  ...(packaged ? [] : [root]),
  `--data-dir=${data}`,
  '--test-mode',
  ...(process.env.OFFICE_TEST_NESTED_SANDBOX === '1' ? ['--no-sandbox'] : []),
];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
let application;
const errors = [];
const checks = [];

async function waitUntil(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${message}`);
}

function saved() {
  return JSON.parse(fs.readFileSync(path.join(data, 'notes.json'), 'utf8'));
}

function pass(message) {
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function main() {
  application = await electron.launch({
    executablePath: executable,
    args,
    cwd: root,
    env: environment,
    timeout: 30000,
  });
  let page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('RENDERER', message.text());
  });
  await page.locator('#add-note').waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  pass('isolated renderer loads without Node.js access');
  await page.screenshot({ path: path.join(output, 'empty.png') });

  async function add(content) {
    await page.locator('#add-note').click();
    await page.locator('#note-editor').fill(content);
    await page.locator('#note-editor').press('Enter');
    await page.locator('#note-editor').waitFor({ state: 'hidden' });
  }

  await add('整理本周工作计划');
  await add('下午三点，和团队确认项目进度');
  await add('读完那本一直想读的书');
  await page.locator('.task-text').first().click();
  await page.locator('#note-editor').fill('整理本周工作计划 · 周五前完成');
  await waitUntil(() => saved().todos[0].content.endsWith('周五前完成'), 'autosave');
  await page.locator('#note-editor').press('Escape');
  await waitUntil(
    () => saved().todos[0].content === '整理本周工作计划',
    'cancel restores original',
  );
  pass('create, autosave, and Escape rollback preserve content');

  await page.locator('.task-text').first().click();
  await page.locator('#note-editor').fill('整理本周工作计划 · 周五前完成');
  await page.locator('[data-view="done"]').click();
  await waitUntil(() => saved().todos[0].content.endsWith('周五前完成'), 'tab switch flush');
  await page.locator('[data-view="todo"]').click();

  const originalIds = saved().todos.map((task) => task.id);
  await page.locator('.drag-handle').nth(1).focus();
  await page.locator('.drag-handle').nth(1).press('Alt+ArrowUp');
  await waitUntil(() => saved().todos[0].id === originalIds[1], 'keyboard reorder persisted');
  pass('tab navigation flushes drafts; keyboard ordering persists immediately');

  const lastId = saved().todos[2].id;
  await page
    .locator('.task-row')
    .nth(2)
    .dragTo(page.locator('.task-row').first(), { targetPosition: { x: 25, y: 2 } });
  await waitUntil(() => saved().todos[0].id === lastId, 'native drag reorder persisted');
  pass('native drag-and-drop ordering persists immediately');
  await page.screenshot({ path: path.join(output, 'todo.png') });

  await page.locator('.task-text').first().dblclick();
  await waitUntil(() => saved().done.length === 1, 'double click completion');
  await page.locator('[data-view="done"]').click();
  await page.locator('.date-heading').waitFor();
  assert.ok((await page.locator('.date-heading').textContent()).includes('今天'));
  await page.screenshot({ path: path.join(output, 'done.png') });
  await page.locator('[data-action="restore"]').first().click();
  await waitUntil(() => saved().done.length === 0 && saved().todos.length === 3, 'restore');
  pass('double-click completion, date groups, and restore work');

  await page.locator('[data-view="todo"]').click();
  await page.locator('[data-action="complete"]').first().click();
  await waitUntil(() => saved().done.length === 1, 'completion button');
  await page.locator('[data-view="done"]').click();
  await page.locator('[data-action="deleteDone"]').first().click();
  await waitUntil(() => saved().done.length === 0, 'delete archive');
  await page.locator('[data-view="todo"]').click();
  pass('completion button and permanent archive deletion work');

  const importFile = path.join(data, 'legacy.json');
  fs.writeFileSync(
    importFile,
    JSON.stringify({
      todoList: [
        {
          content: '<img src=x onerror="alert(1)"> 原样文字',
          todo_datetime: '2022/09/03 10:00:00',
        },
      ],
      doneList: [
        {
          content: '旧版已完成记录',
          todo_datetime: '2022/09/02 10:00:00',
          done_datetime: '2022/09/03 12:00:00',
        },
      ],
    }),
  );
  const exportFile = path.join(data, 'notes-export.xlsx');
  await application.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.importFile] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.exportFile });
    },
    { importFile, exportFile },
  );
  await page.locator('[data-command="settings"]').click();
  await page.locator('[data-command="import"]').click();
  await waitUntil(() => saved().todos.length === 3 && saved().done.length === 1, 'legacy import');
  await page.locator('[data-command="import"]').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(saved().todos.length, 3);
  await page.locator('[data-command="close-settings"]').click();
  assert.equal(await page.locator('#task-list img').count(), 0);
  await page.locator('[data-command="export"]').click();
  await waitUntil(() => fs.existsSync(exportFile), 'Excel export');
  const ExcelJS = require('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(exportFile);
  assert.equal(book.getWorksheet('todo list').rowCount, 4);
  assert.equal(book.getWorksheet('done list').rowCount, 2);
  pass('legacy import deduplicates; markup stays text; Excel contains both lists');

  await page.locator('[data-command="lock"]').click();
  await waitUntil(() => saved().settings.ignoreMouse === true, 'mouse passthrough enabled');
  await page.locator('[data-command="lock"]').click();
  await waitUntil(() => saved().settings.ignoreMouse === false, 'mouse passthrough disabled');
  pass('mouse passthrough toggle persists and remains reversible');

  await page.locator('.task-text').first().click();
  await page.locator('#note-editor').fill('隐藏前输入的内容也要保存');
  await page.locator('[data-command="hide"]').click();
  await waitUntil(() => saved().todos[0].content === '隐藏前输入的内容也要保存', 'hide flush');
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  const second = spawn(executable, args, {
    cwd: root,
    env: environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  second.on('error', (error) => errors.push(error.message));
  await waitUntil(
    () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    'second instance restores window',
  );
  pass('hide flushes drafts; second launch reveals the existing window');

  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 380, height: 460, x: 120, y: 100 }),
  );
  await page.locator('[data-command="settings"]').click();
  await application.evaluate(({ app }) => {
    const originalGet = app.getLoginItemSettings.bind(app);
    const originalSet = app.setLoginItemSettings.bind(app);
    let enabled = false;
    globalThis.notesLoginTest = {
      calls: [],
      restore: () => {
        app.getLoginItemSettings = originalGet;
        app.setLoginItemSettings = originalSet;
      },
    };
    app.getLoginItemSettings = () => ({ openAtLogin: enabled });
    app.setLoginItemSettings = (options) => {
      enabled = options.openAtLogin;
      globalThis.notesLoginTest.calls.push(options);
    };
  });
  await page.locator('#login-setting').check();
  await page.locator('#login-setting').uncheck();
  const loginCalls = await application.evaluate(() => globalThis.notesLoginTest.calls);
  assert.deepEqual(
    loginCalls.map((call) => call.openAtLogin),
    [true, false],
  );
  assert.ok(
    loginCalls.every(
      (call) => call.args.includes(`--data-dir=${data}`) && path.isAbsolute(call.path),
    ),
  );
  await application.evaluate(() => {
    globalThis.notesLoginTest.restore();
    delete globalThis.notesLoginTest;
  });
  pass('startup toggle passes the executable and stable data directory to system integration');
  await page.locator('[data-command="update"]').click();
  assert.ok((await page.locator('#update-message').textContent()).includes('尚未配置'));
  await page.evaluate(() => {
    document.getElementById('toast').hidden = true;
  });
  await page.screenshot({ path: path.join(output, 'settings.png') });
  // Input events preview without writing; release/change commits the chosen size.
  await page.locator('#font-size').evaluate((input) => {
    input.value = '36';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(saved().settings.appearance.fontSize, 14);
  for (const selector of ['.task-text', '#preview-text']) {
    assert.equal(
      await page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node).fontSize),
      '36px',
    );
  }
  await page.locator('#font-size').dispatchEvent('change');
  await waitUntil(() => saved().settings.appearance.fontSize === 36, 'font size saved');
  await page.locator('[data-command="close-settings"]').click();
  await page.locator('.task-text').first().click();
  assert.equal(
    await page.locator('#note-editor').evaluate((node) => getComputedStyle(node).fontSize),
    '36px',
  );
  await page.locator('#note-editor').press('Escape');
  await page.locator('[data-view="done"]').click();
  assert.equal(
    await page
      .locator('.task-text')
      .first()
      .evaluate((node) => getComputedStyle(node).fontSize),
    '36px',
  );
  await page.locator('[data-view="todo"]').click();
  await page.locator('[data-command="settings"]').click();
  await page.locator('#font-size').press('Home');
  await waitUntil(() => saved().settings.appearance.fontSize === 10, 'minimum font size');
  await page.locator('#font-size').evaluate((input) => {
    input.value = '20';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitUntil(() => saved().settings.appearance.fontSize === 20, 'preferred font size');
  assert.equal(
    await page
      .locator('.setting-row strong')
      .first()
      .evaluate((node) => getComputedStyle(node).fontSize),
    '12px',
  );
  await page.locator('#font-size').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'font-size-settings.png') });
  pass(
    'font size previews live, saves on change, covers todo/history/editor, and keeps settings readable',
  );
  await page.locator('#background-color').evaluate((input) => {
    input.value = '#324d69';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitUntil(
    () => saved().settings.appearance.backgroundColor === '#324d69',
    'color persisted',
  );
  await page.locator('#background-opacity').press('Home');
  await waitUntil(
    () => saved().settings.appearance.backgroundOpacity === 0,
    'transparent background',
  );
  await page.locator('#text-opacity').press('Home');
  await waitUntil(() => saved().settings.appearance.textOpacity === 0, 'transparent text');
  assert.equal(
    await page
      .locator('.task-text')
      .first()
      .evaluate((node) => getComputedStyle(node).opacity),
    '0',
  );
  assert.equal(
    await page.locator('#settings-panel').evaluate((node) => getComputedStyle(node).opacity),
    '1',
  );
  await page.locator('#text-opacity').press('End');
  await waitUntil(() => saved().settings.appearance.textOpacity === 100, 'opaque text');
  await page.locator('[data-command="close-settings"]').click();
  await page.mouse.move(-20, -20);
  const transparent = await page.evaluate(() => ({
    background: getComputedStyle(document.getElementById('note-background')).opacity,
    text: getComputedStyle(document.querySelector('.task-text')).opacity,
    toolbar: getComputedStyle(document.getElementById('toolbar')).opacity,
    window: getComputedStyle(document.getElementById('note-window')).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  }));
  assert.deepEqual(transparent, {
    background: '0',
    text: '1',
    toolbar: '0',
    window: 'rgba(0, 0, 0, 0)',
    body: 'rgba(0, 0, 0, 0)',
  });
  await page.screenshot({ path: path.join(output, 'text-only.png'), omitBackground: true });
  const alpha = await application.evaluate(
    ({ nativeImage }, file) => {
      const image = nativeImage.createFromPath(file);
      const { width } = image.getSize();
      const pixels = image.toBitmap();
      return {
        blank: pixels[(20 * width + 20) * 4 + 3],
        textVisible: pixels.some((value, index) => index % 4 === 3 && value > 0),
      };
    },
    path.join(output, 'text-only.png'),
  );
  assert.deepEqual(alpha, { blank: 0, textVisible: true });
  await page.mouse.move(200, 60);
  assert.equal(
    await page.locator('#toolbar').evaluate((node) => getComputedStyle(node).opacity),
    '1',
  );
  await page.locator('[data-command="settings"]').click();
  await page.locator('#background-opacity').press('End');
  await waitUntil(() => saved().settings.appearance.backgroundOpacity === 100, 'opaque background');
  await page.locator('#text-opacity').press('ArrowLeft');
  await waitUntil(() => saved().settings.appearance.textOpacity === 99, 'independent text setting');
  pass(
    'color and both opacity sliders persist; zero background leaves text visible and controls recover on hover',
  );

  const imageFile = path.join(data, '背景.png');
  fs.copyFileSync(path.join(root, 'assets', 'app.png'), imageFile);
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, imageFile);
  await page.locator('[data-command="select-background"]').click();
  await waitUntil(() => saved().settings.appearance.imageName === '背景.png', 'image copied');
  const copiedImage = saved().settings.appearance.backgroundImage;
  assert.ok(copiedImage.startsWith('data:image/png;base64,'));
  fs.unlinkSync(imageFile);
  assert.ok(
    await page
      .locator('#note-background')
      .evaluate((node) => getComputedStyle(node).backgroundImage.includes('data:image/png')),
  );
  await page.evaluate(() => {
    document.getElementById('toast').hidden = true;
    document.getElementById('settings-panel').scrollTop = 0;
  });
  await page.screenshot({ path: path.join(output, 'appearance-settings.png') });
  await page.locator('[data-command="close-settings"]').click();
  await page.screenshot({ path: path.join(output, 'image-background.png') });
  await page.locator('[data-command="settings"]').click();
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.locator('[data-command="select-background"]').click();
  await page.locator('[data-command="clear-background"]').click();
  await waitUntil(() => saved().settings.appearance.backgroundImage === '', 'image removed');
  assert.equal(saved().settings.appearance.backgroundColor, '#324d69');
  assert.equal(
    await page
      .locator('#note-background')
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    'none',
  );
  const invalidImage = path.join(data, 'invalid.png');
  fs.writeFileSync(invalidImage, 'invalid image');
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, invalidImage);
  await page.locator('[data-command="select-background"]').click();
  await waitUntil(
    () =>
      page
        .locator('#toast')
        .textContent()
        .then((text) => text.includes('无法读取图片')),
    'invalid image error',
  );
  assert.equal(saved().settings.appearance.backgroundImage, '');
  // Keep a copied image for the restart check after deleting its source file.
  fs.writeFileSync(imageFile, fs.readFileSync(path.join(root, 'assets', 'app.png')));
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, imageFile);
  await page.locator('[data-command="select-background"]').click();
  await waitUntil(
    () => saved().settings.appearance.backgroundImage === copiedImage,
    'image restored',
  );
  fs.unlinkSync(imageFile);
  pass(
    'local image picker copies images; cancellation, removal, and invalid images preserve settings',
  );
  await page.locator('[data-command="close-settings"]').click();
  await application.close();
  application = null;
  const before = saved();

  application = await electron.launch({
    executablePath: executable,
    args,
    cwd: root,
    env: environment,
    timeout: 30000,
  });
  page = await application.firstWindow();
  await page.locator('#add-note').waitFor();
  assert.deepEqual(saved().todos, before.todos);
  assert.deepEqual(saved().done, before.done);
  assert.deepEqual(saved().settings.appearance, before.settings.appearance);
  assert.equal(
    await page
      .locator('.task-text')
      .first()
      .evaluate((node) => getComputedStyle(node).fontSize),
    '20px',
  );
  assert.ok(
    await page
      .locator('#note-background')
      .evaluate((node) => getComputedStyle(node).backgroundImage.includes('data:image/png')),
  );
  pass(
    'restart restores color, independent opacity, and copied background after original image is deleted',
  );
  const bounds = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  assert.equal(bounds.width, 380);
  assert.equal(bounds.height, 460);
  pass('restart preserves notes, ordering, history, and window dimensions');
  assert.deepEqual(errors, []);
  pass('no uncaught renderer errors');

  fs.writeFileSync(
    path.join(output, packaged ? 'packaged-results.json' : 'source-results.json'),
    JSON.stringify(
      {
        passed: true,
        mode: packaged ? 'packaged' : 'source',
        nestedSandboxCompatibility: process.env.OFFICE_TEST_NESTED_SANDBOX === '1',
        checks,
        data,
      },
      null,
      2,
    ),
  );
  console.log(`Verified ${checks.length} desktop scenarios.`);
}

main()
  .catch(async (error) => {
    console.error(error);
    if (application) {
      const page = application.windows()[0];
      if (page) {
        console.error(
          'UI:',
          await page
            .locator('body')
            .innerText()
            .catch(() => 'unavailable'),
        );
        await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      }
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (application) await application.close().catch(() => {});
  });
