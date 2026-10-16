'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

/** Window behavior lives here, independently from notes and system services. */
function createNotesWindow({ store, root, onError, onFlush }) {
  const saved = store.snapshot().window || {};
  const display = screen.getDisplayMatching({
    x: Number.isFinite(saved.x) ? saved.x : 0,
    y: Number.isFinite(saved.y) ? saved.y : 0,
    width: saved.width || 360,
    height: saved.height || 420,
  });
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(320, saved.width || 360));
  const height = Math.min(area.height, Math.max(290, saved.height || 420));
  const x = Math.min(
    area.x + area.width - width,
    Math.max(area.x, saved.x ?? area.x + area.width - width - 28),
  );
  const y = Math.min(area.y + area.height - height, Math.max(area.y, saved.y ?? area.y + 40));
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 320,
    minHeight: 290,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: '桌面便签 · Office Notes',
    icon: path.join(root, 'assets', 'app.png'),
    show: false,
    skipTaskbar: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(root, 'src', 'preload', 'index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  let pointerInteractive = false;
  let boundsTimer;
  let closing = false;
  let canClose = false;

  const applyMouseMode = () => {
    if (!win.isDestroyed()) {
      const ignore = store.snapshot().settings.ignoreMouse && !pointerInteractive;
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  };

  const saveBounds = () => {
    clearTimeout(boundsTimer);
    if (!win.isDestroyed()) {
      try {
        store.saveWindow(win.getBounds());
      } catch (error) {
        onError(error);
      }
    }
  };
  const scheduleBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 350);
  };

  const show = () => {
    if (win.isDestroyed()) return;
    // A disconnected monitor must not leave the only window unreachable.
    const bounds = win.getBounds();
    if (
      !screen
        .getAllDisplays()
        .some(
          ({ workArea }) =>
            bounds.x < workArea.x + workArea.width &&
            bounds.x + bounds.width > workArea.x &&
            bounds.y < workArea.y + workArea.height &&
            bounds.y + bounds.height > workArea.y,
        )
    )
      win.center();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    applyMouseMode();
  };

  win.once('ready-to-show', show);
  win.on('move', scheduleBounds);
  win.on('resize', scheduleBounds);
  win.on('close', async (event) => {
    if (canClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await onFlush();
      saveBounds();
      win.hide();
    } catch (error) {
      onError(error);
    } finally {
      closing = false;
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.loadFile(path.join(root, 'src', 'renderer', 'index.html')).catch(onError);

  return {
    win,
    show,
    applyMouseMode,
    saveBounds,
    setPointerInteractive(value) {
      pointerInteractive = value;
      applyMouseMode();
    },
    allowClose() {
      canClose = true;
      clearTimeout(boundsTimer);
    },
  };
}

module.exports = { createNotesWindow };
