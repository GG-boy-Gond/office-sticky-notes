'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// No raw IPC, filesystem, process, or Node.js object is exposed to the page.
contextBridge.exposeInMainWorld('notes', {
  read: () => invoke('notes:read'),
  act: (action) => invoke('notes:action', action),
  ignoreMouse: (value) => invoke('notes:ignore', value),
  setAppearance: (patch) => invoke('notes:appearance', patch),
  selectBackgroundImage: () => invoke('notes:background-image'),
  clearBackgroundImage: () => invoke('notes:clear-background-image'),
  pointerInteractive: (value) => invoke('notes:pointer', value),
  hide: () => invoke('notes:hide'),
  exportExcel: () => invoke('notes:export'),
  importData: () => invoke('notes:import'),
  setLogin: (value) => invoke('notes:login', value),
  openDataFolder: () => invoke('notes:folder'),
  checkUpdates: () => invoke('notes:update'),
  installUpdate: () => invoke('notes:install-update'),
  quit: () => invoke('notes:quit'),
  flushed: (token, error) => invoke('notes:flushed', { token, error }),
  onState: (listener) => subscribe('notes:state', listener),
  onError: (listener) => subscribe('notes:error', listener),
  onFlush: (listener) => subscribe('notes:flush', listener),
});
