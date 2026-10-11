'use strict';

/**
 * Fast Cut 主进程：一个窗口、一份菜单、一组 IPC。
 * 这里不写任何裁剪逻辑，全部委托 core/pipeline。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, shell } = require('electron');

const { registerIpc, sendWinState } = require('./api');

let win = null;

/** 把文件拖到 exe 图标上、或"打开方式 → Fast Cut"时，路径就在 argv 里。 */
function fileFromArgv() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const arg = args.find((a) => a && !a.startsWith('-'));
  if (!arg) return null;
  const abs = path.resolve(arg);
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#14161a',
    title: 'Fast Cut',
    show: false,
    // 无边框：标题栏由渲染层自绘，跟界面同一套配色；
    // Windows 依旧保留四边拖拽缩放与任务栏预览。
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false 只为了 preload 里的 webUtils.getPathForFile；渲染层依旧拿不到 Node
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => sendWinState());
  win.on('unmaximize', () => sendWinState());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外链一律走系统浏览器，窗口本身不许被导航走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('fc:menu', { action });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
});

/**
 * 无边框窗口没有原生菜单栏，"文件/剪辑/视图/帮助"整棵树由渲染层自绘，
 * 动作通过 fc:menu 回灌给同一套处理函数（见 app.js 的 onMenuAction）。
 */
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc(() => win);
  createWindow();

  const openFile = fileFromArgv();
  if (openFile) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('fc:menu', { action: 'open', file: openFile });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
