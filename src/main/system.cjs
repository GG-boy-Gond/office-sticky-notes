'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, shell, Notification, Tray, Menu, nativeImage } = require('electron');
const { createWorkbook } = require('./export.cjs');
const { timestamp } = require('./store.cjs');

function createSystemServices({ root, store, windowController, updates, onState, onQuit }) {
  let tray;
  const win = windowController.win;
  const startupArgs = app.isPackaged ? [] : [root];
  startupArgs.push(`--data-dir=${path.dirname(store.file)}`);
  const loginOptions = { path: process.execPath, args: startupArgs };

  function loginEnabled() {
    if (process.platform === 'linux') return false;
    return app.getLoginItemSettings(loginOptions).openAtLogin;
  }

  function setLogin(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('开机启动设置无效。');
    if (process.platform === 'linux') throw new Error('当前平台请使用系统启动应用设置。');
    app.setLoginItemSettings({ ...loginOptions, openAtLogin: enabled });
    refreshTray();
    return loginEnabled();
  }

  async function exportExcel() {
    const answer = await dialog.showSaveDialog(win, {
      title: '导出全部便签',
      defaultPath: path.join(
        app.getPath('documents'),
        `便签-${timestamp().replace(/[- :]/g, '')}.xlsx`,
      ),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (answer.canceled || !answer.filePath) return { canceled: true };
    await createWorkbook(store.snapshot()).xlsx.writeFile(answer.filePath);
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: '便签已导出',
        body: '点击查看导出的 Excel 文件。',
      });
      notification.on('click', () => shell.showItemInFolder(answer.filePath));
      notification.show();
    }
    return { canceled: false, filePath: answer.filePath };
  }

  async function importData() {
    const answer = await dialog.showOpenDialog(win, {
      title: '导入旧版或新版便签（合并，不覆盖）',
      filters: [{ name: '便签数据', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (answer.canceled || !answer.filePaths[0]) return { canceled: true };
    const file = answer.filePaths[0];
    if ((await fs.stat(file)).size > 20 * 1024 * 1024)
      throw new Error('请选择小于 20 MB 的便签数据文件。');
    const state = store.importDocument(
      JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')),
    );
    onState();
    return { canceled: false, state };
  }

  async function selectBackgroundImage() {
    const answer = await dialog.showOpenDialog(win, {
      title: '选择便签背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      properties: ['openFile'],
    });
    if (answer.canceled || !answer.filePaths[0]) return { canceled: true };
    const file = answer.filePaths[0];
    const limit = 20 * 1024 * 1024;
    if ((await fs.stat(file)).size > limit) throw new Error('请选择小于 20 MB 的背景图片。');
    const buffer = await fs.readFile(file);
    if (buffer.length > limit) throw new Error('请选择小于 20 MB 的背景图片。');
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('无法读取图片，请选择 PNG、JPG、WebP 或 BMP 图片。');
    const { width, height } = image.getSize();
    if (width * height > 40_000_000)
      throw new Error('图片尺寸过大，请选择不超过 4000 万像素的图片。');
    if (Math.max(width, height) > 1920) {
      image = image.resize(width >= height ? { width: 1920 } : { height: 1920 });
    }
    const png = image.toPNG();
    const backgroundImage =
      png.length <= 4 * 1024 * 1024
        ? `data:image/png;base64,${png.toString('base64')}`
        : `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`;
    store.setAppearance({ backgroundImage, imageName: path.basename(file) });
    // Store a copy: renaming or removing the original cannot break the background.
    return { canceled: false };
  }

  function refreshTray() {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示便签', click: windowController.show },
        { type: 'separator' },
        {
          label: '开机启动',
          type: 'checkbox',
          checked: loginEnabled(),
          enabled: process.platform !== 'linux',
          click: (item) => {
            try {
              setLogin(item.checked);
              onState();
            } catch (error) {
              dialog.showErrorBox('设置失败', error.message);
            }
          },
        },
        {
          label: '鼠标穿透',
          type: 'checkbox',
          checked: store.snapshot().settings.ignoreMouse,
          click: (item) => {
            try {
              store.setIgnoreMouse(item.checked);
              windowController.applyMouseMode();
              refreshTray();
              onState();
            } catch (error) {
              dialog.showErrorBox('设置失败', error.message);
            }
          },
        },
        {
          label: '检查更新',
          click: () => {
            windowController.show();
            updates.check();
          },
        },
        {
          label: '关于',
          click: () =>
            dialog.showMessageBox(win, {
              title: '关于桌面便签',
              message: '桌面便签 · Office Notes',
              detail: `版本 ${app.getVersion()}\n本地存储 · 离线可用\n项目参考：xhznl-todo-list\n所有任务数据保存在本机。`,
            }),
        },
        {
          label: '原项目地址',
          click: () => shell.openExternal('https://github.com/xiajingren/xhznl-todo-list'),
        },
        {
          label: '原项目问题反馈',
          click: () => shell.openExternal('https://github.com/xiajingren/xhznl-todo-list/issues'),
        },
        { type: 'separator' },
        { label: '退出', click: onQuit },
      ]),
    );
  }

  const icon = nativeImage.createFromPath(path.join(root, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('桌面便签 · Office Notes');
  tray.on('click', windowController.show);
  tray.on('double-click', windowController.show);
  refreshTray();

  return {
    loginEnabled,
    setLogin,
    exportExcel,
    importData,
    selectBackgroundImage,
    refreshTray,
    destroy: () => tray?.destroy(),
  };
}

module.exports = { createSystemServices };
