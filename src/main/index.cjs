'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { app, ipcMain, dialog, Menu, shell } = require('electron');
const { NotesStore } = require('./store.cjs');
const { createNotesWindow } = require('./window.cjs');
const { createSystemServices } = require('./system.cjs');
const { createUpdateService } = require('./updates.cjs');

const root = path.join(__dirname, '..', '..');
const dataArgument = process.argv.find((value) => value.startsWith('--data-dir='));
if (dataArgument) {
  const directory = path.resolve(dataArgument.slice('--data-dir='.length));
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

// Keep transparent windows reliable on this computer's graphics driver.
app.disableHardwareAcceleration();
app.setAppUserModelId('local.office.stickynotes');

function logError(error) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'errors.log'),
      `${new Date().toISOString()} ${error.stack || error}\n`,
    );
  } catch {
    /* Reporting must not overwrite the original failure. */
  }
}

process.on('uncaughtException', (error) => {
  logError(error);
  console.error(error);
  dialog.showErrorBox('桌面便签启动错误', error.message);
  app.exit(1);
});

let controller;
let store;
let system;
let updates;
let quitting = false;
let quitRequested = false;
const flushRequests = new Map();

function report(error) {
  logError(error);
  console.error(error);
  if (controller && !controller.win.isDestroyed()) {
    controller.win.webContents.send('notes:error', error.message || String(error));
  } else dialog.showErrorBox('桌面便签', error.message || String(error));
}

function snapshot() {
  return {
    ...store.snapshot(),
    app: {
      version: app.getVersion(),
      dataPath: path.dirname(store.file),
      loginEnabled: system?.loginEnabled() || false,
      loginSupported: process.platform !== 'linux',
      update: updates.snapshot(),
      recoveryMessage: store.recoveryMessage,
    },
  };
}

function broadcast() {
  if (controller && !controller.win.isDestroyed())
    controller.win.webContents.send('notes:state', snapshot());
}

function flushEditor() {
  if (!controller || controller.win.isDestroyed() || controller.win.webContents.isDestroyed())
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const token = randomUUID();
    const timer = setTimeout(() => {
      flushRequests.delete(token);
      reject(new Error('界面未能及时确认保存。请稍后重试，或重新显示便签。'));
    }, 7000);
    flushRequests.set(token, { resolve, reject, timer });
    controller.win.webContents.send('notes:flush', token);
  });
}

async function requestQuit() {
  if (quitRequested || quitting) return;
  quitRequested = true;
  try {
    await flushEditor();
    controller.saveBounds();
    quitting = true;
    controller.allowClose();
    app.quit();
  } catch (error) {
    report(error);
  } finally {
    quitRequested = false;
  }
}

function registerHandlers() {
  // All renderer requests use a fixed whitelist and are tied to this window's main frame.
  function handle(channel, callback) {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        if (
          event.sender !== controller.win.webContents ||
          event.senderFrame !== event.sender.mainFrame
        ) {
          throw new Error('不允许的窗口请求。');
        }
        return { ok: true, value: await callback(payload) };
      } catch (error) {
        console.error(channel, error);
        return { ok: false, error: error.message || '操作失败，请重试。' };
      }
    });
  }
  handle('notes:read', snapshot);
  handle('notes:action', (action) => {
    store.dispatch(action);
    return snapshot();
  });
  handle('notes:ignore', (ignore) => {
    store.setIgnoreMouse(ignore);
    controller.applyMouseMode();
    system.refreshTray();
    return snapshot();
  });
  handle('notes:appearance', (patch) => {
    // Images may only come from the main process file picker.
    if (
      !patch ||
      Object.keys(patch).some(
        (key) => !['backgroundColor', 'backgroundOpacity', 'textOpacity', 'fontSize'].includes(key),
      )
    )
      throw new Error('不支持的外观操作。');
    store.setAppearance(patch);
    return snapshot();
  });
  handle('notes:background-image', async () => {
    const result = await system.selectBackgroundImage();
    return { canceled: result.canceled, state: snapshot() };
  });
  handle('notes:clear-background-image', () => {
    store.setAppearance({ backgroundImage: '', imageName: '' });
    return snapshot();
  });
  handle('notes:pointer', (interactive) => {
    if (typeof interactive !== 'boolean') throw new Error('无效的鼠标状态。');
    controller.setPointerInteractive(interactive);
  });
  handle('notes:hide', () => controller.win.hide());
  handle('notes:export', () => system.exportExcel());
  handle('notes:import', () => system.importData());
  handle('notes:login', (enabled) => {
    system.setLogin(enabled);
    return snapshot();
  });
  handle('notes:folder', async () => {
    const error = await shell.openPath(path.dirname(store.file));
    if (error) throw new Error(error);
  });
  handle('notes:update', () => updates.check());
  handle('notes:install-update', () => updates.install(controller.win));
  handle('notes:quit', () => {
    setImmediate(requestQuit);
  });
  handle('notes:flushed', ({ token, error } = {}) => {
    const pending = flushRequests.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    flushRequests.delete(token);
    if (error) pending.reject(new Error(error));
    else pending.resolve();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => controller?.show());
  app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(null);
      store = new NotesStore(app.getPath('userData'));
      controller = createNotesWindow({ store, root, onError: report, onFlush: flushEditor });
      updates = createUpdateService({
        root,
        onStatus: broadcast,
        onBeforeInstall: async () => {
          await flushEditor();
          controller.saveBounds();
          quitting = true;
          controller.allowClose();
        },
      });
      system = createSystemServices({
        root,
        store,
        windowController: controller,
        updates,
        onState: broadcast,
        onQuit: requestQuit,
      });
      registerHandlers();
      controller.win.webContents.on('render-process-gone', (_event, details) => {
        logError(new Error(`Renderer process stopped: ${JSON.stringify(details)}`));
        dialog.showErrorBox(
          '界面已停止响应',
          `数据已保存在本机。请退出后重新启动。\n${details.reason}`,
        );
      });
      if (!process.argv.includes('--test-mode')) setTimeout(() => updates.check(), 4000).unref();
    })
    .catch((error) => {
      logError(error);
      console.error(error);
      dialog.showErrorBox('启动失败', error.message);
      quitting = true;
      app.quit();
    });

  app.on('before-quit', (event) => {
    if (!quitting && controller) {
      event.preventDefault();
      requestQuit();
    }
  });
  app.on('will-quit', () => {
    system?.destroy();
  });
  app.on('activate', () => controller?.show());
}
