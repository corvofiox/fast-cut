'use strict';

/**
 * ffmpeg / ffprobe 可执行文件解析。
 * 优先级：显式传入的目录（可多个，打包内置的静态版排最前）> 环境变量 FAST_CUT_FFMPEG_DIR
 * > 常见安装目录 > PATH。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COMMON_DIRS = process.platform === 'win32'
  ? [
    'D:\\Software\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\ffmpeg\\bin',
    path.join(os.homedir(), 'scoop', 'shims'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
  ]
  : [
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/ffmpeg',
  ];

const EXE = process.platform === 'win32' ? '.exe' : '';

function resolveBin(name, explicitDirs) {
  const dirs = [];
  for (const d of [].concat(explicitDirs || []).filter(Boolean)) dirs.push(d);
  if (process.env.FAST_CUT_FFMPEG_DIR) dirs.push(process.env.FAST_CUT_FFMPEG_DIR);
  dirs.push(...COMMON_DIRS);

  for (const dir of dirs) {
    const p = path.join(dir, name + EXE);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 继续找 */ }
  }

  // PATH 兜底（依赖 spawn 的行为）：直接返回裸名，让系统解析
  const fromPath = findInPath(name);
  if (fromPath) return fromPath;

  return null;
}

function findInPath(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const p = path.join(dir, name + EXE);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* ignore */ }
  }
  return null;
}

const ffmpegPath = () => resolveBin('ffmpeg');
const ffprobePath = () => resolveBin('ffprobe');

module.exports = { resolveBin, ffmpegPath, ffprobePath };
