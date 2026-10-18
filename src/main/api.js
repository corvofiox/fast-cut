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
const { analyzeSources, withTargetCodec, planPerSource } = require('../../core/compat');
const { snap } = require('../../core/segments');
const { resolveBin } = require('../../core/ffmpegPath');
const { run: spawnRun } = require('../../core/probe');
const { EXPORT_CONTAINERS, byId, familyOfExt, unmuxableSubtitles } = require('../../core/containers');
const { isTextSubtitle } = require('../../core/subtitles');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'ts', 'mts'];

/** 超过这个时长，"一遍全解码抽帧"就不划算了，改走逐点 seek（见 doBuildThumbs）。 */
const SEEK_AFTER = 20 * 60;

const state = {
  settings: { ffmpegDir: null, snapKeyframes: true },
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
async function doFilmLevel(loaded, step, from, to, srcIndex = null) {
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
  /**
   * 回包必须带上 `srcIndex`（多素材，2026-10-18）：渲染层要按源分组存放格子图，
   * 否则第二段素材的帧会被塞进第一份素材的图集里——画出来就是别的素材的画面。
   */
  const tag = Number.isInteger(srcIndex) ? { srcIndex } : {};
  const send = (final) => emit('fc:film', { file: loaded.file, step, dir, have: have.slice(), final, ...tag });
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
 * 把渲染层传来的 `files` 列表解析成"源数组"（2026-10-18 多素材）。
 *
 * 渲染层现在维护的是"一份或几份素材"，用 `files: [路径…]` 表达。
 * 为了向后兼容，仍然接受老的单个 `file` 字段。
 * 每份都必须已经导入过（`state.loaded` 里有），否则报错让用户重新导入——
 * 绝不在这里偷偷重新探流：探流+扫关键帧是重活，静默做会让导出莫名卡几十秒。
 */
function resolveSources(payload) {
  const list = Array.isArray(payload && payload.files) && payload.files.length
    ? payload.files
    : (payload && payload.file ? [payload.file] : []);
  if (!list.length) throw new Error('没有可用的素材');
  return list.map((f, i) => {
    const abs = path.resolve(String(f));
    const loaded = state.loaded.get(abs);
    if (!loaded) throw new Error(`素材未导入，请重新导入：${path.basename(abs)}`);
    return { id: String(i), file: abs, media: loaded.media, bins: loaded.bins, loaded };
  });
}

/**
 * 用导出的同一套纯函数算出切割计划：每条保留区间实际从哪一秒起、导出多少帧、
 * 入点那一小段要不要重编码。界面显示的那些代价必须来自这里，不能另算一套。
 */
function previewPlan(payload) {
  const sources = resolveSources(payload);
  const loaded = sources[0];
  const segments = sanitizeSegments(payload.segments);
  // 先定目标封装：字幕装不装得下会影响自检的比对口径
  const target = targetFor(payload.container, loaded, path.resolve(String(loaded.file)));
  const split = !!payload.split;

  /**
   * 多素材兼容性判定 + "基准参数"选择（2026-10-18）。
   *
   * 参数全部一致 → 可以"跟随源"纯流拷贝；不一致 → 界面必须要求选封装与编码，
   * 并由系统把不一致的源整段重编码到基准参数（实测：只选编码不统一参数会静默丢帧）。
   */
  const compat = analyzeSources(sources);
  const targetCodec = String(payload.codec || '').trim().toLowerCase() || null;
  const baseline = compat ? withTargetCodec(compat.baseline, targetCodec) : null;
  const perSource = compat && baseline ? planPerSource(sources, compat.baseline, targetCodec) : null;
  const needsCodec = !!compat && !compat.uniform && payload.container === 'source' && !targetCodec;

  const { plan, warnings, keeps, keepSecs, clipToKeep } = planFor(sources, segments, {
    ordered: isReordered(segments),
    dropSubtitles: target.dropSubtitles,
    precise: payload.precise === undefined ? true : !!payload.precise,
    // 「每段一个文件」会改变分组边界（相邻片段不得被并成一组），预览必须和导出一致
    split,
    // 参数不一致的源：整段重编码（预览就要如实显示成"整段重编码"，不能等导出才发现）
    forceReencodeFor: perSource
      ? (si, src) => {
        const one = perSource.find((p) => p.id === src.id) || perSource[si];
        return !!(one && one.reencode);
      }
      : () => false,
  });
  const groups = groupByKeep(plan);
  /**
   * 分组 id → 它落在**第几个输出文件**（1 起）。
   *
   * 界面以前拿"组号"当文件号写（"组2 · 第 2 个文件"），但那只是分组出现顺序：
   * 实测 6 段、1+2 并一组、4+5 并一组时，实际文件是
   * `文件1←组1 / 文件2←第3段 / 文件3←组2 / 文件4←第6段`——组2 是第 **3** 个文件。
   * 组号只用来认"哪几段一伙"，文件号必须来自真实分组顺序，否则用户按提示找文件会找错。
   */
  const fileNoOfGroup = {};
  for (let i = 0; i < groups.length; i++) {
    const key = plan[groups[i][0]] && plan[groups[i][0]].outGroup;
    if (key == null) continue;
    const gid = groupIdOfOutGroup(key);
    if (gid != null && fileNoOfGroup[gid] === undefined) fileNoOfGroup[gid] = i + 1;
  }
  return {
    plan, warnings, keeps, keepSecs, ordered: isReordered(segments),
    // 片段 → 保留区间：合并组把几段并成一条 keep 后，界面必须按它查代价与吸附差
    clipToKeep,
    /**
     * 多素材兼容性（单素材时是 null）：
     *  - `uniform`：参数是否完全一致（true 才能选"跟随源"纯流拷贝）
     *  - `diffs`：逐项差异，界面红字要逐条列出
     *  - `baseline`：基准参数（最强的源），界面显示"统一到 WxH@fps"
     *  - `perSource`：每个源要不要重编码及原因
     *  - `needsCodec`：参数不一致却还选着"跟随源" → 界面必须拦下并高亮封装/编码两项
     */
    compat: compat ? {
      uniform: compat.uniform,
      summary: compat.summary,
      diffs: compat.diffs,
      baseline,
      perSource,
      needsCodec,
    } : null,
    // 分组 id → 输出文件序号（1 起）。界面写"组N → 第 M 个文件"用这个
    fileNoOfGroup,
    // 分组（「每段一个文件」按它出文件）：界面显示"N 个文件"必须用这个数。
    // 拼接模式下产物恒为一个文件，所以这里回 1 —— 分组只在 split 时才有意义，
    // 别让界面在拼接模式显示"2 个文件"却只写出一个。
    split, groups: split ? groups.length : 1,
    // 回显本次计划用的切割模式：smoke 等它一致后再读时间轴的绘制统计，避免读到旧渲染
    precise: payload.precise === undefined ? true : !!payload.precise,
    // 字幕怎么办，界面要提前说：SRT/ASS 这类文本字幕重新计时；其余（位图、mov_text 等）重排不了（自检会拦）
    subtitleMode: (() => {
      const subs = loaded.media.subtitleCodecs || [];
      if (!subs.length) return 'none';
      if (target.dropSubtitles) return 'dropped';
      return subs.every(isTextSubtitle) ? 'retime' : 'unsupported';
    })(),
    container: {
      ext: target.ext,
      label: target.container ? target.container.label : '跟随源',
      droppedSubtitles: target.droppedSubCodecs,
    },
  };
}

/** 数组顺序不再等于源顺序 = 用户拖动改过位置，必须走"按顺序逐段导出"这条路。 */
/**
 * 数组顺序不再等于源顺序 = 用户拖动改过位置，必须走"按顺序逐段导出"这条路。
 *
 * **多素材时（2026-10-18）判据不能只看 `start`**：不同素材的时间轴各自从 0 起，
 * 它们的 `start` 之间没有可比性。实测把第二段素材的片段拖到第一段前面后，
 * 三段 `start` 全是 0，这个函数返回 false → 主进程以为"没改过顺序"，
 * 走规整流程把片段**按源重新排序**打回原样——用户拖了顺序，导出却还是旧顺序
 * （实测产物内容 红/蓝/红，期望 蓝/红/红）。
 *
 * 所以：**只要涉及多个源，就以数组顺序为准**（多素材的顺序是用户显式摆的，
 * 而且各源时间不可比，规整排序本来也无从下手）。
 */
function isReordered(segments) {
  const srcs = new Set(segments.map((s) => (Number.isInteger(s && s.srcIndex) ? s.srcIndex : 0)));
  if (srcs.size > 1) return true;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].start - 1e-6) return true;
  }
  return false;
}

/**
 * `outGroup` 键（`g<id>` / `k<keepIndex>`）→ 用户分组 id。
 * 没分组的 `k…` 返回 null：它们各成一个文件，界面不需要"组号"。
 */
function groupIdOfOutGroup(key) {
  const m = /^g(\d+)$/.exec(String(key || ''));
  return m ? Number(m[1]) : null;
}

/** 区间清洗：只接受有限非负数字，最多 200 段。`group` 是「并成一次导出」的分组号（可选）。 */
function sanitizeSegments(segments) {
  if (!Array.isArray(segments)) throw new Error('区间参数格式错误');
  const out = [];
  for (const seg of segments.slice(0, 200)) {
    const start = Number(seg && seg.start);
    const end = Number(seg && seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= 0) continue;
    const one = { start, end };
    // 分组号必须是整数：它只用来判"哪几段进同一个文件"，非整数一律当没分组
    const g = Number(seg && seg.group);
    if (Number.isInteger(g) && g >= 0) one.group = g;
    /**
     * 来源序号（多素材，2026-10-18）：**必须原样带下去**。
     * 丢了它，不同素材的区间会被当成同一份素材的两段——实测两份 10s 素材
     * 追加后 keeps 只剩 1 条、计划总时长 10s（第二份凭空消失），
     * 而自检照样"通过"（计划本身就只有一段，怎么算都对）。
     */
    const si = Number(seg && seg.srcIndex);
    if (Number.isInteger(si) && si >= 0) one.srcIndex = si;
    out.push(one);
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

/**
 * 目标封装：默认跟随源，也允许用户显式换容器（remux —— 仍然流拷贝，只换封装）。
 * 只认白名单里的 id；装不下的字幕轨在这里一次算清：参数拼装据此排除字幕流，
 * 自检据此核对"该省略的确实省略了"，界面据此提前告诉用户，谁都不偷偷做事。
 */
function targetFor(requested, loaded, abs) {
  const id = String(requested || 'source').toLowerCase();
  let ext;
  let container = null;
  if (id === 'source') {
    ext = extForSource(loaded.media, abs);
  } else {
    const picked = byId(id);
    if (!picked) throw new Error(`不支持的导出容器：${requested}`);
    ext = picked.ext;
    container = { family: picked.family, label: picked.label, ext: picked.ext };
  }
  const droppedSubCodecs = unmuxableSubtitles(familyOfExt(ext), loaded.media.subtitleCodecs);
  return { ext, container, dropSubtitles: droppedSubCodecs.length > 0, droppedSubCodecs };
}

async function startExport(win, payload) {
  if (state.job) throw new Error('已有导出任务在进行中');

  const sources = resolveSources(payload);
  const loaded = sources[0];
  const abs = path.resolve(String(loaded.file));
  const segments = sanitizeSegments(payload.segments);
  const outDir = path.resolve(String(payload.outDir || ''));
  if (!fs.existsSync(outDir)) throw new Error(`输出目录不存在：${outDir}`);
  const target = targetFor(payload.container, loaded, abs);
  const ext = target.ext;
  const outPath = path.join(outDir, sanitizeBaseName(payload.baseName) + ext);

  // 每份素材的关键帧都得扫完才能切（多素材时逐份检查，报错要指名是哪一份）
  for (const s of sources) {
    if (!s.media.keyframes || !s.media.keyframes.length) {
      throw new Error(`「${path.basename(s.file)}」的关键帧还没扫完，稍等一下再导出`);
    }
  }
  const split = !!payload.split;
  // 吸附（precise=false，应用层默认）与精确（precise=true，本层与 core 的缺省）两种切割模式；
  // 行数按同一套计划算。渲染层每次都显式发 precise，这里的缺省只服务脚本/无 UI 调用。
  const precise = payload.precise === undefined ? true : !!payload.precise;

  /**
   * 多素材的参数统一决策（2026-10-18）。
   *
   * 参数全一致 → 不传 normalizeTo，全程流拷贝（零损失）。
   * 不一致 → 必须：
   *   a) 有明确的封装与编码选择（不选就拒绝导出，界面已用红字拦过一次，这里是兜底）；
   *   b) 把不一致的源整段重编码到"基准参数"（最强的源，见 compat.pickBaseline）。
   * 这条兜底很重要：实测只换编码不统一参数，产物会静默丢帧（273/300 帧而解码不报错）。
   */
  const compat = analyzeSources(sources);
  const targetCodec = String(payload.codec || '').trim().toLowerCase() || (compat ? compat.baseline.codec : null);
  let normalizeTo = null;
  let reencodeSources = [];
  if (compat && !compat.uniform) {
    if (!payload.codec) {
      throw new Error('这些素材的参数不一致（分辨率/帧率/编码/音频），无法直接流拷贝拼接：'
        + '请在导出面板里选择**封装**与**编码格式**后重试。');
    }
    const base = withTargetCodec(compat.baseline, targetCodec);
    normalizeTo = {
      width: base.width, height: base.height, fps: base.fps,
      sar: base.sar, pixFmt: base.pixFmt, codec: targetCodec, audio: base.audio,
    };
    reencodeSources = planPerSource(sources, compat.baseline, targetCodec)
      .filter((p) => p.reencode).map((p) => p.id);
  }

  const targets = targetsFor(sources, segments, outPath, ext, split, target.dropSubtitles, precise);
  assertNotOverwrite(abs, targets);

  const token = createToken();
  state.job = { token, outPath, startedAt: Date.now() };
  const send = (evt) => {
    if (!win.isDestroyed()) win.webContents.send('fc:progress', evt);
  };

  try {
    const result = await exportSegments(sources, segments, {
      outPath,
      split,
      crf: 18,
      ordered: isReordered(segments),
      precise,
      container: target.container,
      dropSubtitles: target.dropSubtitles,
      normalizeTo,
      reencodeSources,
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
      const hint = failed.some((c) => c.name === '解码无错误') && segments.length > 1
        ? '\n\n这条产物在解码时报错。可以试试「每段一个文件」（一条区间恰好只有一段时才真的不走拼接），或减少切点、让入点落在关键帧上。'
        : '';
      throw new Error(`自检未通过，已删除产物：\n${detail || '未知原因'}${hint}`);
    }
    return { ...result, outPath };
  } finally {
    state.job = null;
  }
}

/**
 * 本次导出会写哪些文件：拼接模式 1 个，「每段一个文件」按保留区间各 1 个。
 * 多素材时按源数组算同一套计划（分组边界与导出完全一致，否则会漏建/多建目标文件）。
 */
function targetsFor(sources, segments, outPath, ext, split, dropSubtitles, precise = true) {
  if (!split) return [outPath];
  const { plan } = planFor(sources, segments, {
    ordered: isReordered(segments), dropSubtitles, precise, split,
  });
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
      /** 可以 remux 成的容器（界面据此填下拉，判据仍只在 core/containers.js 里） */
      containers: EXPORT_CONTAINERS.map(({ id, label }) => ({ id, label })),
    };
  });

  ipcMain.handle('fc:pickFile', async (_e, opts) => {
    // 追加导入（2026-10-18）需要一次选多个：传 { multiple: true } 就放开多选
    const multiple = !!(opts && opts.multiple);
    const r = await dialog.showOpenDialog(getWindow(), {
      title: multiple ? '追加素材（可多选）' : '选择视频文件',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: '视频文件', extensions: VIDEO_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled) return multiple ? [] : null;
    // 多选返回数组、单选返回单个路径——调用方按自己的模式取值
    return multiple ? r.filePaths : r.filePaths[0];
  });

  /**
   * 追加导入：把新素材并进当前素材列表（2026-10-18）。
   *
   * 只负责"导入并探流/扫关键帧"，**不碰时间轴**——怎么插入片段是渲染层的决定
   * （接在末尾、每条素材一条片段）。这样主进程不需要知道剪辑状态，
   * 与导入单份素材走完全同一套 `doLoad`（缓存、探针、缩略图都复用）。
   */
  ipcMain.handle('fc:append', async (_e, files) => {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean).slice(0, 20);
    const out = [];
    for (const f of list) {
      try {
        out.push(await doLoad(f));
      } catch (err) {
        out.push({ file: path.resolve(String(f)), error: String(err.message || err).split('\n')[0] });
      }
    }
    return out;
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
    doFilmLevel(loaded, Number(step.toFixed(6)), from, to, req.srcIndex).catch((err) => {
      emit('fc:film', {
        file: abs, step, dir: '', have: [], final: true,
        ...(Number.isInteger(req.srcIndex) ? { srcIndex: req.srcIndex } : {}),
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

  // 播放头磁吸关键帧的开关状态：跟着设置一起持久化，下次启动还是用户选的那一档
  ipcMain.handle('fc:snap:set', (_e, on) => {
    state.settings.snapKeyframes = !!on;
    writeSettings();
    return state.settings.snapKeyframes;
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
    message: `Fast Cut v${app.getVersion()}`,
    detail: '给录制视频做粗剪的 Windows 工具：轻、快、不掉画质。默认吸附关键帧、整段流拷贝（零重编码、最快）；勾选「精确模式」则切点逐帧精确，只重编码入点那一小段。不上传、不写源文件。',
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
