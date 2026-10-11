'use strict';

/**
 * 渲染层与主进程之间唯一的桥。只暴露白名单方法，不暴露 ipcRenderer 本身。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 拖拽进窗口的 File 对象 → 绝对路径。Electron 32+ 去掉了 file.path，改用 webUtils。 */
function pathForFile(file) {
  if (webUtils && typeof webUtils.getPathForFile === 'function') {
    const p = webUtils.getPathForFile(file);
    if (p) return p;
  }
  return file.path || null;
}

contextBridge.exposeInMainWorld('fc', {
  env: () => ipcRenderer.invoke('fc:env'),
  pickFile: () => ipcRenderer.invoke('fc:pickFile'),
  load: (file) => ipcRenderer.invoke('fc:load', file),
  getThumbs: (file) => ipcRenderer.invoke('fc:thumbs:get', file),
  // 胶片条按缩放动态抽帧：报"哪一档、哪一段"，抽完主进程推回来
  requestFilm: (req) => ipcRenderer.send('fc:film:want', req),
  chooseDir: (current) => ipcRenderer.invoke('fc:chooseDir', current),
  exportStart: (payload) => ipcRenderer.invoke('fc:export:start', payload),
  previewPlan: (payload) => ipcRenderer.invoke('fc:previewPlan', payload),
  exportCancel: () => ipcRenderer.invoke('fc:export:cancel'),
  reveal: (file) => ipcRenderer.invoke('fc:reveal', file),
  openFile: (file) => ipcRenderer.invoke('fc:openFile', file),
  getSettings: () => ipcRenderer.invoke('fc:settings:get'),
  getKeymap: () => ipcRenderer.invoke('fc:keymap:get'),
  setKeymap: (map) => ipcRenderer.invoke('fc:keymap:set', map),
  // 无边框窗口的自绘标题栏：最小化 / 最大化还原 / 关闭，以及最大化状态回推
  winMin: () => ipcRenderer.send('fc:win:min'),
  winMax: () => ipcRenderer.send('fc:win:max'),
  winClose: () => ipcRenderer.send('fc:win:close'),
  appAbout: () => ipcRenderer.invoke('fc:app:about'),
  appQuit: () => ipcRenderer.invoke('fc:app:quit'),
  onWinState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:winState', listener);
    return () => ipcRenderer.off('fc:winState', listener);
  },
  pathForFile,
  onProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:progress', listener);
    return () => ipcRenderer.off('fc:progress', listener);
  },
  onMenu: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:menu', listener);
    return () => ipcRenderer.off('fc:menu', listener);
  },
  onThumbs: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:thumbs', listener);
    return () => ipcRenderer.off('fc:thumbs', listener);
  },
  // 按缩放动态抽的那一层：主进程边抽边推，每推一次带上"已经有哪些格子"
  onFilm: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:film', listener);
    return () => ipcRenderer.off('fc:film', listener);
  },
  onScan: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('fc:scan', listener);
    return () => ipcRenderer.off('fc:scan', listener);
  },
});
