'use strict';

/**
 * 主进程侧的 IPC 处理器：把 core/pipeline 包成渲染层能调用的动作。
 *
 * 安全边界：渲染层只能传"源路径 + 区间数字 + 输出目录 + 文件名"，
 * 不能传任何 ffmpeg 参数片段；这里再做一次白名单校验与文件名清洗。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, dialog, ipcMain, shell } = require('electron');

const {
  probeSource, scanKeyframes, exportSegments, createToken, planFor, numbered, groupByKeep,
} = require('../../core/pipeline');
const { snap } = require('../../core/segments');
const { resolveBin } = require('../../core/ffmpegPath');
const { run: spawnRun } = require('../../core/probe');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'ts', 'mts'];

/** 超过这个时长，"一遍全解码抽帧"就不划算了，改走逐点 seek（见 doBuildThumbs）。 */
const SEEK_AFTER = 20 * 60;

const state = {
  settings: { ffmpegDir: null },
  /** 已导入源缓存：绝对路径 → { file, media, bins }，避免每次导出重扫关键帧 */
  loaded: new Map(),
  /** 当前导出作业：并发互斥 + 取消 */
  job: null,
  /** 后台关键帧扫描：文件绝对路径 → Promise */
  scans: new Map(),
  /** 已抽好的时间轴胶片条：文件绝对路径 → payload，渲染层随时可以再来要一次 */
  thumbs: new Map(),
  /** 正在抽帧的文件：绝对路径 → Promise，避免同一份素材抽两遍 */
  thumbJobs: new Map(),
  /** 动态层级请求的序号：新的"要看哪一段"一来，上一批还没抽完的就直接作废 */
  filmToken: 0,
  getWindow: null,
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'fast-cut-settings.json');
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    state.settings = { ...state.settings, ...raw };
  } catch { /* 首次运行没有配置文件 */ }
  return state.settings;
}

function writeSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(state.settings, null, 2), 'utf8');
  } catch (err) {
    dialog.showErrorBox('设置保存失败', err.message);
  }
}

/** 打包版内置的 ffmpeg：electron-builder 把 vendor/ffmpeg 放到 resources/ffmpeg。 */
function bundledFfmpegDir() {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, 'ffmpeg');
  return fs.existsSync(dir) ? dir : null;
}

/**
 * 打包版只认随包携带的那份 ffmpeg：不读设置里残留的旧目录，也不去翻 PATH。
 * 开发态没有 resources/ffmpeg，才回落到环境变量 / PATH / 常见安装目录。
 */
function resolveBins() {
  const bundled = bundledFfmpegDir();
  const dirs = bundled ? [bundled] : [state.settings.ffmpegDir].filter(Boolean);
  return {
    ffmpeg: resolveBin('ffmpeg', dirs),
    ffprobe: resolveBin('ffprobe', dirs),
  };
}

async function ffmpegVersion(ffmpeg) {
  if (!ffmpeg) return null;
  try {
    const { stdout } = await spawnRun(ffmpeg, ['-hide_banner', '-version']);
    const m = /ffmpeg version (\S+)/.exec(stdout);
    return m ? m[1] : String(stdout).split('\n')[0].trim();
  } catch (err) {
    return `无法执行：${err.message}`;
  }
}

async function doLoad(file) {
  const bins = resolveBins();
  if (!bins.ffmpeg || !bins.ffprobe) {
    throw new Error('未找到 ffmpeg / ffprobe。请安装 FFmpeg 并加入 PATH，或在"设置"里指定其 bin 目录。');
  }
  const abs = path.resolve(String(file));
  const cached = state.loaded.get(abs);
  if (cached) return publicSource(cached);

  // 探流很快（只读容器头），先让界面能播；扫全片关键帧放后台，长视频不挡预览。
  const loaded = await probeSource(abs, bins);
  state.loaded.set(abs, loaded);

  // 胶片条只要时长就能抽，没必要排在关键帧扫描后面
  buildThumbs(loaded);

  const hit = readKeyCache(abs, loaded.stat);
  if (hit) {
    applyKeyframes(loaded, hit);
    return publicSource(loaded);
  }
  scanInBackground(loaded);
  return publicSource(loaded);
}

/** 关键帧扫描结果缓存：同一份文件（路径+修改时间+大小）第二次导入是瞬时的。 */
function cacheDir() {
  return path.join(app.getPath('userData'), 'keyframe-cache');
}

function cachePathOf(abs, stat) {
  const key = crypto.createHash('sha1').update(`${abs}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  return path.join(cacheDir(), `${key}.json`);
}

function readKeyCache(abs, stat) {
  try {
    const data = JSON.parse(fs.readFileSync(cachePathOf(abs, stat), 'utf8'));
    return Array.isArray(data.keyframes) && data.keyframes.length ? data.keyframes : null;
  } catch {
    return null;                       // 没缓存 / 读不动，都不影响功能
  }
}

function writeKeyCache(abs, stat, keyframes) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePathOf(abs, stat), JSON.stringify({ file: abs, keyframes }), 'utf8');
  } catch { /* 缓存写失败就下次再扫 */ }
}

function applyKeyframes(loaded, keyframes) {
  loaded.media.keyframes = keyframes;
  loaded.media.lastKeyframe = keyframes.length ? snap(keyframes[keyframes.length - 1]) : null;
  if (!loaded.media.duration) loaded.media.duration = loaded.media.lastKeyframe || 0;
}

function scanInBackground(loaded) {
  const t0 = Date.now();
  const job = scanKeyframes(loaded)
    .then((kf) => {
      writeKeyCache(loaded.file, loaded.stat, kf);
      buildThumbs(loaded);   // 容器没写时长的素材靠这里补抽（已抽过就是空操作）
      emit('fc:scan', {
        file: loaded.file, ok: true, keyframes: kf, ms: Date.now() - t0,
        duration: loaded.media.duration, lastKeyframe: loaded.media.lastKeyframe,
      });
      return kf;
    })
    .catch((err) => {
      emit('fc:scan', { file: loaded.file, ok: false, message: err.message });
    })
    .finally(() => { state.scans.delete(loaded.file); });
  state.scans.set(loaded.file, job);
}

/**
 * 时间轴上的胶片条：用 ffmpeg 按固定间隔抽帧成小 jpg，缓存到 userData。
 * 交给渲染层按"源时间 → 成片时间"映射画进片段里，所以拖动改顺序后缩略图也跟着对得上。
 *
 * 抽帧只依赖时长，因此不等关键帧扫描；同一份文件只跑一次。失败必须报出去——
 * 静默吞掉的后果是用户只看到一条空时间轴，没有任何地方解释为什么。
 */
function buildThumbs(loaded) {
  if (!state.thumbJobs.has(loaded.file)) {
    const job = doBuildThumbs(loaded)
      .then((skipped) => { if (skipped) state.thumbJobs.delete(loaded.file); })
      .catch((err) => {
        state.thumbJobs.delete(loaded.file);
        emit('fc:thumbs', { file: loaded.file, error: String(err && err.message || err).slice(0, 200) });
      });
    state.thumbJobs.set(loaded.file, job);
  }
  return state.thumbJobs.get(loaded.file);
}

async function doBuildThumbs(loaded) {
  const dir = thumbDir(loaded.file, loaded.stat);
  const duration = Number(loaded.media.duration) || 0;
  if (!duration) return true;          // 容器没写时长：等关键帧扫描补上再试
  const step = Math.max(0.25, duration / Math.min(240, Math.max(8, Math.round(duration))));
  const want = Math.max(1, Math.floor(duration / step));
  const height = Math.round((Number(loaded.media.video?.height) || 90) * (160 / (Number(loaded.media.video?.width) || 160))) || 90;
  if (countJpg(dir) < want) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    /**
     * `fps=1/step` 那一遍要把整片解码一次：实测 1080p60 HEVC 的录像，
     * 17 分钟约 110 秒、6.4 小时就是四十分钟。所以超过 SEEK_AFTER 的素材改成
     * 逐点 seek 取关键帧——每张恒定几百毫秒，与片长无关，240 张四分半钟收齐。
     * 两条路都边写边推，胶片条从左往右自己长出来。
     */
    if (duration > SEEK_AFTER) {
      await seekThumbs(loaded, dir, step, want, height);
    } else {
      const ticker = setInterval(() => {
        const n = countJpg(dir);
        if (n > 0 && n < want) sendThumbs(loaded, dir, step, n, height, false);
      }, 500);
      try {
        await spawnRun(loaded.bins.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', loaded.file, '-an',
          '-vf', `fps=${1 / step},scale=160:-2`, '-q:v', '5', path.join(dir, 'f%05d.jpg'),
        ]);
      } finally {
        clearInterval(ticker);
      }
    }
  }
  sendThumbs(loaded, dir, step, want, height, true);
  return false;
}

/** 每张缩略图单独 seek 取帧，并发跑；一张失败就停在这里，不写坏序列。 */
async function seekThumbs(loaded, dir, step, want, height) {
  const bin = loaded.bins.ffmpeg;
  let next = 0;
  let done = 0;
  let emitted = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= want) return;
      const at = i * step + step / 2;
      const ok = await spawnRun(bin, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-noaccurate_seek', '-ss', at.toFixed(3), '-i', loaded.file,
        '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '5',
        path.join(dir, `f${String(i + 1).padStart(5, '0')}.jpg`),
      ], { timeoutMs: 60000 }).then(() => true).catch(() => false);
      if (!ok) { next = want; return; }        // 断号会让渲染层按序号算时间，宁可截断
      done++;
      if (done - emitted >= 8) { emitted = done; sendThumbs(loaded, dir, step, done, height, false); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, want) }, worker));
}

/** final 的才进缓存供 fc:thumbs:get 补取，中途的部分结果只推不存。 */
function sendThumbs(loaded, dir, step, count, height, final) {
  const payload = { file: loaded.file, dir, step, count, height, final };
  if (final) state.thumbs.set(loaded.file, payload);
  emit('fc:thumbs', payload);
  return payload;
}

/** 一份素材的所有胶片缓存都归在这个目录下，总览是 base，各缩放层级是 L<间隔>。 */
function cacheRoot(abs, stat) {
  const key = crypto.createHash('sha1').update(`${abs}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  return path.join(app.getPath('userData'), 'thumb-cache', key);
}

function thumbDir(abs, stat) {
  return path.join(cacheRoot(abs, stat), 'base');
}

/** 动态层级的缓存目录：格子号直接写在文件名里，所以同一档换窗口只补差集。 */
function levelDir(abs, stat, step) {
  return path.join(cacheRoot(abs, stat), `L${step.toFixed(6)}`);
}

const FILM_MIN_STEP = 1 / 240;      // 再细就没意义了：一帧都不到
const FILM_MAX_STEP = 7200;
const FILM_MAX_TILES = 48;          // 一次最多抽这么多格，够铺两屏还有余

/**
 * 按当前缩放抽可视窗口那一小段胶片。
 *
 * 整片抽一遍的间隔是固定的，一放大就暴露两个毛病：格子比源图宽 → 拉糊，
 * 源图比格子宽 → 相邻格互相压。所以缩放时改抽"这一档 + 这一段"：
 * 格子号 = floor(源时间 / step)，文件名带格子号，于是同一档换窗口只补差集，
 * 往回拖也不用重抽。一次请求最多 48 格，每格一次精确 seek，恒定几百毫秒。
 */
async function doFilmLevel(loaded, step, from, to) {
  const duration = Number(loaded.media.duration) || 0;
  if (!duration) return;
  let i0 = Math.max(0, Math.floor(from / step));
  let i1 = Math.min(Math.max(0, Math.ceil(duration / step) - 1), Math.floor(to / step));
  if (i1 < i0) return;
  if (i1 - i0 + 1 > FILM_MAX_TILES) {
    const mid = (i0 + i1) / 2;
    i0 = Math.max(0, Math.round(mid - FILM_MAX_TILES / 2));
    i1 = Math.min(i0 + FILM_MAX_TILES - 1, Math.ceil(duration / step) - 1);
  }
  const dir = levelDir(loaded.file, loaded.stat, step);
  fs.mkdirSync(dir, { recursive: true });
  const nameOf = (i) => path.join(dir, `t${String(i).padStart(7, '0')}.jpg`);
  const have = [];
  for (let i = i0; i <= i1; i++) if (fs.existsSync(nameOf(i))) have.push(i);
  const send = (final) => emit('fc:film', { file: loaded.file, step, dir, have: have.slice(), final });
  send(have.length === i1 - i0 + 1);
  const missing = [];
  for (let i = i0; i <= i1; i++) if (!have.includes(i)) missing.push(i);
  if (!missing.length) return;
  const token = ++state.filmToken;
  let next = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      if (token !== state.filmToken || failed >= 3) return;   // 用户拖走了，或这份文件根本读不动
      const k = next++;
      if (k >= missing.length) return;
      const i = missing[k];
      // 最后一格的中心会越过片尾：夹回片内，否则 ffmpeg seek 到 EOF 抽不出图，整批被判失败
      const at = Math.min(duration - 0.05, (i + 0.5) * step);
      const ok = await spawnRun(loaded.bins.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', at.toFixed(3), '-i', loaded.file,
        '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '5', nameOf(i),
      ], { timeoutMs: 60000 }).then(() => true).catch(() => false);
      // 格子号是绝对位置，中间缺一格只是那一格空着（底下的总览会露出来），
      // 不像总览那样必须连续 —— 所以这里跳过就行，别把后面能抽的全陪葬掉。
      if (!ok) { failed++; continue; }
      failed = 0;
      have.push(i);
      if (have.length % 4 === 0) send(false);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
  if (token === state.filmToken) send(true);
}

function countJpg(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).length;
  } catch {
    return 0;
  }
}

function emit(channel, payload) {
  const win = state.getWindow && state.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publicSource(loaded) {
  const { file, media } = loaded;
  return { file, media, scanning: !(media.keyframes && media.keyframes.length) };
}

function needLoaded(file) {
  const abs = path.resolve(String(file));
  const loaded = state.loaded.get(abs);
  if (!loaded) throw new Error('源文件未导入，请重新导入');
  return loaded;
}

/**
 * 用导出的同一套纯函数算出"吸附后真实会从哪一秒开始"，让 UI 显示的偏差提示
 * 和实际产物一致——吸附误差是 P0 信息，不能靠渲染层另算一套。
 */
function previewPlan(payload) {
  const loaded = needLoaded(payload.file);
  const segments = sanitizeSegments(payload.segments);
  const { plan, warnings, keeps, keepSecs } = planFor(loaded, segments, {
    precise: !!payload.precise,
    ordered: isReordered(segments),
  });
  return { plan, warnings, keeps, keepSecs, ordered: isReordered(segments) };
}

/** 数组顺序不再等于源顺序 = 用户拖动改过位置，必须走"按顺序逐段导出"这条路。 */
function isReordered(segments) {
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].start - 1e-6) return true;
  }
  return false;
}

/** 区间清洗：只接受有限非负数字，最多 200 段。 */
function sanitizeSegments(segments) {
  if (!Array.isArray(segments)) throw new Error('区间参数格式错误');
  const out = [];
  for (const seg of segments.slice(0, 200)) {
    const start = Number(seg && seg.start);
    const end = Number(seg && seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= 0) continue;
    out.push({ start, end });
  }
  if (out.length === 0) throw new Error('没有有效的保留区间');
  return out;
}

/** 文件名清洗：剥掉路径与 Windows 非法字符，避免越权写到别的目录。 */
function sanitizeBaseName(name) {
  const bare = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
  const trimmed = bare.replace(/\.(mp4|mov|m4v|mkv|avi|webm|flv|ts|mts)$/i, '');
  return (trimmed || 'cut').slice(0, 120);
}

function extForSource(media, file) {
  const fromFile = path.extname(String(file)).toLowerCase();
  if (fromFile) return fromFile;
  const firstFormat = String(media.format || '').split(',')[0];
  return firstFormat ? `.${firstFormat}` : '.mp4';
}

async function startExport(win, payload) {
  if (state.job) throw new Error('已有导出任务在进行中');

  const loaded = needLoaded(payload.file);
  const abs = path.resolve(String(payload.file));
  const segments = sanitizeSegments(payload.segments);
  const outDir = path.resolve(String(payload.outDir || ''));
  if (!fs.existsSync(outDir)) throw new Error(`输出目录不存在：${outDir}`);
  const ext = extForSource(loaded.media, abs);
  const outPath = path.join(outDir, sanitizeBaseName(payload.baseName) + ext);

  if (!loaded.media.keyframes || !loaded.media.keyframes.length) {
    throw new Error('关键帧还没扫完，稍等一下再导出');
  }
  const split = !!payload.split;
  const targets = targetsFor(loaded, segments, outPath, ext, split, !!payload.precise);
  assertNotOverwrite(abs, targets);

  const token = createToken();
  state.job = { token, outPath, startedAt: Date.now() };
  const send = (evt) => {
    if (!win.isDestroyed()) win.webContents.send('fc:progress', evt);
  };

  try {
    const result = await exportSegments(loaded, segments, {
      outPath,
      precise: !!payload.precise,
      split,
      crf: 18,
      ordered: isReordered(segments),
      token,
      onProgress: send,
    });
    if (!result.ok) {
      const failed = result.results.flatMap((r) => (r.checks || []).filter((c) => !c.ok));
      const detail = failed.map((c) => `${c.name}：${c.detail}`).join('\n');
      // 需求文档 §3：自检不过就是"半成品"，删掉，不给人误用的机会
      for (const p of result.outputs) {
        try { fs.rmSync(p, { force: true }); } catch { /* 被占用时留给用户手动清理 */ }
      }
      const hint = failed.some((c) => c.name === '完整解码无错误') && segments.length > 1
        ? '\n\n多段拼接在部分编码（如 HEVC 的开 GOP）下会丢参考帧。请改用「每段一个文件」，或减少切点、把切点落在关键帧上。'
        : '';
      throw new Error(`自检未通过，已删除产物：\n${detail || '未知原因'}${hint}`);
    }
    return { ...result, outPath };
  } finally {
    state.job = null;
  }
}

/** 本次导出会写哪些文件：拼接模式 1 个，「每段一个文件」按保留区间各 1 个。 */
function targetsFor(loaded, segments, outPath, ext, split, precise) {
  if (!split) return [outPath];
  const { plan } = planFor(loaded, segments, { precise, ordered: isReordered(segments) });
  return groupByKeep(plan).map((_, i) => numbered(outPath, i, ext));
}

/**
 * 需求文档 §6"不写用户源文件"：ffmpeg 是 -y 覆盖模式，所以在真正动手前
 * 先确认目标既不等于源文件、也不是已存在的文件——宁可让用户改名，也不静默覆盖。
 */
function assertNotOverwrite(sourceAbs, targets) {
  for (const p of targets) {
    if (path.resolve(p).toLowerCase() === path.resolve(sourceAbs).toLowerCase()) {
      throw new Error(`导出文件名与源文件相同，会被覆盖：${path.basename(p)}。请换一个文件名。`);
    }
    if (fs.existsSync(p)) {
      throw new Error(`目标文件已存在：${path.basename(p)}。为避免覆盖已有文件，请换一个文件名或换一个目录。`);
    }
  }
}

function registerIpc(getWindow) {
  readSettings();
  state.getWindow = getWindow;

  ipcMain.handle('fc:env', async () => {
    const bins = resolveBins();
    return {
      ok: !!(bins.ffmpeg && bins.ffprobe),
      bins,
      version: await ffmpegVersion(bins.ffmpeg),
      platform: process.platform,
      appVersion: app.getVersion(),
      bundled: !!bundledFfmpegDir(),
      settings: { ...state.settings },
      extensions: VIDEO_EXTENSIONS,
    };
  });

  ipcMain.handle('fc:pickFile', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择视频文件',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: VIDEO_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('fc:load', async (_e, file) => doLoad(file));

  // 胶片条是主进程抽好再推的，但推送可能赶在渲染层认这个源之前 —— 给一次主动补取的机会
  ipcMain.handle('fc:thumbs:get', (_e, file) => state.thumbs.get(path.resolve(String(file))) || null);

  /**
   * 胶片条按缩放动态抽帧。渲染层只报"哪一档、哪一段"，文件路径一律回查已导入的源：
   * 传进来的路径没导入过就是空操作，绝不拿它去起 ffmpeg。
   */
  ipcMain.on('fc:film:want', (_e, req) => {
    const abs = path.resolve(String((req && req.file) || ''));
    const loaded = state.loaded.get(abs);
    if (!loaded) return;
    const step = Number(req.step);
    const from = Number(req.from);
    const to = Number(req.to);
    if (!Number.isFinite(step) || step < FILM_MIN_STEP || step > FILM_MAX_STEP) return;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    doFilmLevel(loaded, Number(step.toFixed(6)), from, to).catch((err) => {
      emit('fc:film', {
        file: abs, step, dir: '', have: [], final: true,
        error: String((err && err.message) || err).slice(0, 200),
      });
    });
  });

  ipcMain.handle('fc:chooseDir', async (_e, current) => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('videos'),
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('fc:export:start', (_e, payload) => startExport(getWindow(), payload));

  ipcMain.handle('fc:previewPlan', (_e, payload) => previewPlan(payload));

  ipcMain.handle('fc:export:cancel', () => {
    if (!state.job) return false;
    state.job.token.cancel('已取消');
    return true;
  });

  ipcMain.handle('fc:reveal', (_e, file) => {
    const abs = path.resolve(String(file));
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
  });

  ipcMain.handle('fc:openFile', (_e, file) => shell.openPath(path.resolve(String(file))));

  ipcMain.handle('fc:settings:get', () => ({ ...state.settings, bins: resolveBins() }));

  ipcMain.handle('fc:keymap:get', () => state.settings.keymap || {});

  ipcMain.handle('fc:keymap:set', (_e, keymap) => {
    const clean = {};
    if (keymap && typeof keymap === 'object') {
      for (const [action, keys] of Object.entries(keymap)) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(action)) continue;
        const list = [].concat(keys || []).filter((k) => typeof k === 'string' && /^[a-z0-9+ ]{1,24}$/.test(k));
        if (list.length) clean[action] = list;
      }
    }
    state.settings.keymap = clean;
    writeSettings();
    return clean;
  });

  // 无边框窗口的自绘标题栏。放在这里而不是主入口：registerIpc 被自检跑过，
  // 主入口的那段初始化没有测试覆盖，漏个 import 就会做成"进程活着但没有窗口"。
  ipcMain.on('fc:win:min', () => { const w = getWindow(); if (w) w.minimize(); });
  ipcMain.on('fc:win:max', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('fc:win:close', () => { const w = getWindow(); if (w) w.close(); });
  ipcMain.handle('fc:app:about', () => dialog.showMessageBox(getWindow(), {
    type: 'info',
    title: 'Fast Cut',
    message: 'Fast Cut v0.1',
    detail: '只做裁剪的极简视频工具：流拷贝导出，不重编码、不上传、不写源文件。\n配套文档：docs/01-需求文档.md、docs/02-技术方案.md',
    buttons: ['知道了'],
  }));
  ipcMain.handle('fc:app:quit', () => app.quit());
}

/** 最大化 / 还原时回推状态，标题栏据此换图标与 tooltip。 */
function sendWinState() {
  const w = state.getWindow && state.getWindow();
  if (w && !w.isDestroyed()) emit('fc:winState', { maximized: w.isMaximized() });
}

module.exports = { registerIpc, state, doLoad, sendWinState };
