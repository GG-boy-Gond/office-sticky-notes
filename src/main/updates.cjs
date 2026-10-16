'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

/** Updates use this application's own HTTPS feed, never the original author's feed. */
function createUpdateService({ root, onStatus, onBeforeInstall }) {
  let updater;
  let status = { phase: 'unconfigured', message: '尚未配置更新源，当前版本可正常使用。' };
  let feed;
  const configFile = app.isPackaged
    ? path.join(path.dirname(process.execPath), 'update-config.json')
    : path.join(root, 'update-config.json');
  try {
    if (fs.existsSync(configFile)) feed = JSON.parse(fs.readFileSync(configFile, 'utf8')).url;
    if (feed) {
      if (new URL(feed).protocol !== 'https:') throw new Error('更新地址必须使用 HTTPS。');
      if (!app.isPackaged)
        status = { phase: 'development', message: '源码运行模式不安装更新，请使用打包版本。' };
      else {
        updater = require('electron-updater').autoUpdater;
        updater.setFeedURL({ provider: 'generic', url: feed });
        updater.autoDownload = true;
        updater.autoInstallOnAppQuit = false;
        status = { phase: 'idle', message: '更新源已配置。' };
        updater.on('checking-for-update', () => set('checking', '正在检查更新…'));
        updater.on('update-not-available', () => set('current', '当前已是最新版本。'));
        updater.on('update-available', (info) =>
          set('downloading', `发现 ${info.version}，正在下载…`),
        );
        updater.on('download-progress', (progress) =>
          set('downloading', `更新下载中 ${Math.round(progress.percent)}%`),
        );
        updater.on('update-downloaded', (info) =>
          set('downloaded', `${info.version} 已下载，点击安装并重启。`),
        );
        updater.on('error', (error) => set('error', `更新失败：${error.message}`));
      }
    }
  } catch (error) {
    status = { phase: 'error', message: `更新配置无效：${error.message}` };
  }

  function set(phase, message) {
    status = { phase, message };
    onStatus(status);
  }

  return {
    snapshot: () => ({ ...status }),
    async check() {
      if (!updater) return { ...status };
      if (['checking', 'downloading', 'downloaded'].includes(status.phase)) return { ...status };
      try {
        await updater.checkForUpdates();
      } catch (error) {
        set('error', `更新失败：${error.message}`);
      }
      return { ...status };
    },
    async install(win) {
      if (!updater || status.phase !== 'downloaded') throw new Error('没有已下载的更新。');
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['安装并重启', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '安装更新并重新启动桌面便签？',
        detail: '当前编辑内容会先保存。',
      });
      if (answer.response === 0) {
        await onBeforeInstall();
        updater.quitAndInstall(false, true);
      }
    },
  };
}

module.exports = { createUpdateService };
