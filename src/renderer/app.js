'use strict';

/**
 * Fast Cut 渲染层：只管状态与 DOM，所有 ffmpeg 动作通过 window.fc（preload）走主进程。
 *
 * 剪辑模型（和主流剪辑软件一致）：时间轴显示**成片时间**，素材被分割成若干片段首尾相接，
 * 删掉一个片段后面的自动并拢。预览仍然是单个 <video> 直读源文件，所以这里必须维护
 * "成片时间 ↔ 源时间"的双向映射，播放跨过接缝时把 <video> seek 到下一段的源起点。
 */

const $ = (id) => document.getElementById(id);

const MIN_KEEP = 1 / 240;      // 小于一帧（240fps 上界）视为空
const EPS = 1e-6;

const state = {
  env: null,
  src: null,            // { file, media }
  clips: [],            // [{start,end,ps,pe}] 源时间 + 成片时间，顺序即时间顺序
  sel: -1,
  rate: 1,              // 走带速率：正 = 正放，负 = 倒带（<video> 不接受负值，倒带走 seek 循环）
  plan: null,
  busy: false,
  scanning: false,
  snapKf: true,          // 播放头磁吸关键帧：开 = 拖刻度条时吸到最近关键帧（片段边界恒吸）
  thumbs: null,        // { dir, step, count } 时间轴胶片条
  cut: { index: 0, total: 1, ratio: 0 },
  outputs: [],
};

const history = { stack: [], i: -1 };
const pb = { index: 0 };      // 播放头当前落在第几个片段
let lastSnap = null;          // 最近一次拖放的磁吸结果，给 #hud 用
let tl = null;
let rafId = 0;
let rewindTimer = 0;          // 倒带步进的 setTimeout 句柄
let rewindWatchdog = 0;       // seek 卡死时的兜底定时器
const rewind = { stepDurMs: 0, frameDurS: 1 / 30, nextWall: 0 };

// ---------------------------------------------------------------- 工具

function tc(t) {
  const s = Math.max(0, Number(t) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const msPart = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
}

function tcShort(t) {
  return Number(t) >= 3600 ? tc(t) : tc(t).slice(3);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '未知大小';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fileUrl(p) {
  return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`);
}

function baseName(p) {
  const bare = String(p).split(/[\\/]/).pop() || 'video';
  return bare.replace(/\.[^.]+$/, '');
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p));
  return m ? `.${m[1].toLowerCase()}` : '.mp4';
}

function fpsOf(media) {
  return (media.video && (media.video.fps || media.video.nominalFps)) || 30;
}

const round3 = (t) => Math.round(t * 1000) / 1000;
const clamp = (t, lo, hi) => Math.min(Math.max(t, lo), hi);

function toast(msg, kind) {
  const box = $('toast');
  box.textContent = msg;
  box.className = kind === 'warn' ? 'warn' : '';
  box.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add('hidden'), 4200);
}

function showError(msg) {
  const box = $('error');
  box.textContent = msg ? String(msg) : '';
  box.classList.toggle('hidden', !msg);
  if (msg) openExportPop(true);      // 错误藏在收起的面板里等于没报
}

// ---------------------------------------------------------------- 顶栏弹出面板

/** ☰ 是贴着按钮的下载式菜单；导入 / 导出用居中模态，与快捷键面板同一套交互。 */
const POPS = ['menuPop', 'exportMask', 'importMask'];

const popIsOpen = (id) => {
  const el = $(id);
  return !!el && !el.classList.contains('hidden');
};

const popShow = (id, on) => {
  const el = $(id);
  if (el) el.classList.toggle('hidden', !on);
};

const popCloseAll = () => POPS.forEach((id) => popShow(id, false));

/** 互斥：开一个顺手收掉其余的。 */
const popToggle = (id) => {
  const on = !popIsOpen(id);
  popCloseAll();
  popShow(id, on);
};

const openExportPop = (on) => popShow('exportMask', on);

function cleanErr(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/** 重算每个片段的成片起止时间（删除/改切点后必做）。 */
function relayout() {
  let acc = 0;
  for (const c of state.clips) {
    c.ps = round3(acc);
    c.pe = round3(acc + (c.end - c.start));
    acc = c.pe;
  }
  return acc;
}

function programTotal() {
  return state.clips.length ? state.clips[state.clips.length - 1].pe : 0;
}

function keptSeconds() {
  return round3(state.clips.reduce((s, c) => s + (c.end - c.start), 0));
}

/**
 * 每条保留段"实际从哪儿开始切"。剪辑位置是硬性要求，入点永不回溯，
 * 所以这张表只可能来自真实切割计划；计划还没回来时就是空的（界面显示"源 X–Y"，不加任何角标）。
 */
function snapMap() {
  const parts = state.plan && state.plan.plan;
  if (!Array.isArray(parts) || !parts.length) return {};
  const map = {};
  for (const p of parts) {
    if (p.keepIndex == null || map[p.keepIndex] != null) continue;
    // copy 段吸附后起点可能早于用户入点（多带开头）；reencode 段起点就是用户入点。
    // timeline 的多带可视化按"实际导出起点 < 片段源起点"判定，直接给 start 即可。
    map[p.keepIndex] = p.start;
  }
  return map;
}

/**
 * 每条保留段的代价：入点落在关键帧上是纯拷贝，否则入点那一小段有损重编码，
 * 再不然整段重编码（一个 GOP 内 / 源编码没有同编码重编码器）。时间轴角标和预估行都用它。
 */
function costMap() {
  const parts = state.plan && state.plan.plan;
  if (!Array.isArray(parts) || !parts.length) return {};
  const flags = {};
  for (const p of parts) {
    if (p.keepIndex == null) continue;
    const f = flags[p.keepIndex] || (flags[p.keepIndex] = { copy: false, reencode: false, head: false, codec: false });
    if (p.kind === 'copy') f.copy = true;
    else {
      f.reencode = true;
      if (p.role === 'head') f.head = true;
      if (p.codecChange) f.codec = true;
    }
  }
  const map = {};
  for (const [ki, f] of Object.entries(flags)) {
    // 换编码最严重，其次是"整段都在重编码"，再次是"只重编码入点那一小段"，最轻是纯拷贝
    map[ki] = f.codec ? 'codec' : f.reencode && !f.copy ? 'whole' : f.head ? 'head' : 'copy';
  }
  return map;
}

function countCost(cost) {
  const map = costMap();
  return Object.values(map).filter((c) => c === cost).length;
}

// ---------------------------------------------------------------- 启动

async function boot() {
  tl = window.createTimeline({
    root: $('timeline'),
    canvas: $('tlCanvas'),
    lane: $('tlLane'),
    playheadEl: $('tlPlayhead'),
    scrollEl: $('tlScroll'),
    thumbEl: $('tlThumb'),
    callbacks: {
      onScrub: (srcT, progT, snap) => { onScrub(srcT, progT, snap); },
      onSelect: (i) => { state.sel = i; renderClips(); },
      onBoundary: (i, srcT) => trimBoundary(i, srcT),
      onBoundaryCommit: () => { pushHistory(); refreshPlan(); },
      onMergeBoundary: (i) => mergeBoundary(i),
      onReorder: (from, to) => reorderClip(from, to),
      onFilmWant: (want) => askFilm(want),
    },
  });

  bindUi();
  await loadKeys();
  await loadSnapPref();
  await refreshEnv();
}

/**
 * 播放头磁吸关键帧的开关状态从设置里读回来。读失败就当默认开——
 * 磁吸是默认行为，不能因为读不到设置就把用户晾在自由拖动里。
 */
async function loadSnapPref() {
  let on = true;
  try {
    const s = await window.fc.getSettings();
    if (s && typeof s.snapKeyframes === 'boolean') on = s.snapKeyframes;
  } catch { /* 首次运行没有配置文件 */ }
  state.snapKf = on;
  if (tl) tl.setKeyframeSnap(on);
  updateToolButtons();
}

/**
 * ffmpeg 随包携带、不可更改，所以这里不再有引擎徽章：
 * 正常情况用户永远看不到它；只有打包缺件或被杀毒软件拦下时才提示。
 */
async function refreshEnv() {
  try {
    state.env = await window.fc.env();
  } catch (err) {
    state.env = { ok: false, version: null, settings: {} };
  }
  paintContainers();
  // 版本角标取 app.getVersion()（package.json 的 version），写死会在每次发版后变成假话
  const badge = $('verBadge');
  if (badge) badge.textContent = `v${state.env.appVersion || '0.1.0'}`;
  if (state.env.ok) {
    $('emptyNote').textContent = '导入只读取文件信息（ffprobe 探流 + 扫关键帧），不转码、不复制、不上传。';
  } else {
    $('emptyNote').textContent = '没有可用的内置 ffmpeg，请把 Fast Cut 完整解压后再运行，或重新下载安装包。';
    toast('内置 ffmpeg 不可用：请完整解压 Fast Cut 目录', 'warn');
  }
  $('btnImportEmpty').disabled = !state.env.ok;
}

/** 容器下拉：第一项恒为"跟随源"，其余取自 core/containers.js 的白名单（判据只在主进程那份）。 */
function paintContainers() {
  const sel = $('outContainer');
  const keep = sel.value;
  sel.innerHTML = '';
  sel.append(new Option('跟随源', 'source'));
  for (const c of state.env.containers || []) sel.append(new Option(c.label, c.id));
  sel.value = [].some.call(sel.options, (o) => o.value === keep) ? keep : 'source';
}

function containerChoice() {
  return $('outContainer').value || 'source';
}

// ---------------------------------------------------------------- 导入

async function pickAndImport() {
  const file = await window.fc.pickFile();
  if (file) await importFile(file);
}

async function importFile(file) {
  if (state.busy) { toast('导出进行中，请先等待或取消', 'warn'); return; }
  try {
    const src = await window.fc.load(file);
    await applySource(src);
  } catch (err) {
    showError(`导入失败：${cleanErr(err)}`);
    toast('导入失败，详见右侧说明', 'warn');
  }
}

async function applySource(src) {
  const replacing = !!state.src && state.src.file !== src.file;
  if (replacing && state.clips.length > 1 &&
      !window.confirm('更换源文件会丢掉当前的分割与删除记录，继续？')) return;

  state.src = src;
  state.sel = 0;
  state.rate = 1;
  state.plan = null;
  state.outputs = [];
  state.scanning = !!src.scanning;
  state.thumbs = null;
  state.clips = [{ start: 0, end: round3(src.media.duration), ps: 0, pe: round3(src.media.duration) }];
  pb.index = 0;
  history.stack = [snapshot()];
  history.i = 0;

  $('resultRow').classList.add('hidden');
  $('checks').innerHTML = '';
  $('warnings').classList.add('hidden');
  showError('');

  $('srcName').textContent = src.file;
  $('srcName').title = src.file;
  $('empty').classList.add('hidden');
  $('outDir').value = defaultOutDir(src.file);
  $('outName').value = `${baseName(src.file)}-cut`;
  $('outExt').textContent = extOf(src.file);

  updateInfo();
  tl.setSource(src.media);
  $('player').src = fileUrl(src.file);
  syncTimeline();
  pullThumbs(src.file);
  if (state.scanning) toast('已开始预览；正在后台扫描关键帧，长视频可能要等一会儿', 'warn');
}

/**
 * 认下这个源之后再主动要一次胶片条：主进程抽得早的话，推送会赶在
 * state.src 就位之前到达而被丢掉（换素材、走缓存的第二次导入尤其容易撞上）。
 */
function pullThumbs(file) {
  tl.setThumbs(null);
  window.fc.getThumbs(file).then((payload) => applyThumbs(payload));
}

function applyThumbs(payload) {
  if (!payload || !state.src || payload.file !== state.src.file) return;
  if (payload.error) { toast(`时间轴预览图生成失败：${payload.error}`, 'warn', 6000); return; }
  state.thumbs = payload;
  tl.setThumbs(payload);
}

/**
 * 缩放/平移换了档位：让主进程按这一档抽可视窗口那几十格。
 * 拖一下手柄会连着换好几档，所以延后一点再问，中间那些档位没人看就不用抽。
 */
let filmTimer = null;
function askFilm(want) {
  if (filmTimer) clearTimeout(filmTimer);
  filmTimer = setTimeout(() => {
    filmTimer = null;
    if (state.src) window.fc.requestFilm({ file: state.src.file, ...want });
  }, 160);
}

function applyFilm(payload) {
  if (!payload || !state.src || payload.file !== state.src.file) return;
  if (payload.error) { toast(`这一档预览图抽失败了：${payload.error}`, 'warn', 6000); return; }
  tl.setLevel(payload);
}

/** 后台扫描回包：补上关键帧刻度，并放开导出。 */
function onScanResult(payload) {
  if (!state.src || payload.file !== state.src.file) return;
  state.scanning = false;
  if (!payload.ok) {
    showError(`关键帧扫描失败：${payload.message}`);
    toast('关键帧扫描失败：无法判断哪些段能整段流拷贝，导出会把每段都重编码', 'warn');
    updateExportEnabled();
    return;
  }
  state.src.media.keyframes = payload.keyframes;
  state.src.media.lastKeyframe = payload.lastKeyframe;
  if (payload.duration) state.src.media.duration = payload.duration;
  tl.setSource(state.src.media);
  updateInfo();
  syncTimeline();
  const headN = countCost('head');
  const copyN = state.plan && state.plan.plan ? state.plan.plan.filter((p) => p.kind === 'copy').length : 0;
  toast(`关键帧扫描完成：${payload.keyframes.length} 个（其中 ${headN} 段需重编码入点）；用时 ${(payload.ms / 1000).toFixed(2)} 秒`);
}

function defaultOutDir(file) {
  const i = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
  return i > 0 ? file.slice(0, i) : file;
}

function updateInfo() {
  const m = state.src && state.src.media;
  if (!m) return;
  const v = m.video || {};
  const rows = [
    ['文件', (String(m.file).split(/[\\/]/).pop() || '').slice(0, 28), ''],
    ['容器', m.format || '?', ''],
    ['视频', `${v.codec || '?'}${v.profile ? ` ${v.profile}` : ''}`, ''],
    ['分辨率', `${v.width}×${v.height}`, ''],
    ['像素格式', v.pixFmt || '?', ''],
    ['帧率', v.fps ? `${v.fps.toFixed(v.fps % 1 ? 3 : 2)} fps` : '?', m.video && m.video.vfr ? 'warn' : ''],
    ['源时长', tc(m.duration), ''],
    ['大小', fmtBytes(m.sizeBytes), ''],
    ['码率', m.bitRate ? `${(m.bitRate / 1e6).toFixed(2)} Mbps` : '?', ''],
  ];
  const audios = (m.audioTracks || []).map((a) => `${a.codec}${a.channels ? ` ${a.channels}ch` : ''}`).join(' / ');
  rows.push(['音轨', `${(m.audioTracks || []).length} 条${audios ? `：${audios}` : ''}`, '']);
  rows.push(['字幕轨', String(m.subtitleTracks || 0), '']);
  if (m.rotation) rows.push(['旋转', `${m.rotation}°`, '']);
  const kfCount = (m.keyframes || []).length;
  const gap = gopStats(m.keyframes);
  rows.push(['关键帧', state.scanning ? '扫描中…' : `${kfCount} 个${gap ? ` · 间隔约 ${gap}` : ''}`, state.scanning ? 'warn' : '']);

  const dl = $('info');
  dl.innerHTML = '';
  for (const [k, val, cls] of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'row';
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    if (cls) dd.className = cls;
    wrap.append(dt, dd);
    dl.appendChild(wrap);
  }
}

function gopStats(keyframes) {
  const kfs = keyframes || [];
  if (kfs.length < 2) return '';
  let min = Infinity;
  let max = 0;
  let sum = 0;
  for (let i = 1; i < kfs.length; i++) {
    const d = kfs[i] - kfs[i - 1];
    min = Math.min(min, d);
    max = Math.max(max, d);
    sum += d;
  }
  const avg = sum / (kfs.length - 1);
  const s = (x) => `${x.toFixed(x < 10 ? 2 : 1)}s`;
  return max - min < 0.01 ? s(avg) : `${s(avg)}（最长 ${s(max)}）`;
}

// ---------------------------------------------------------------- 预览与播放头

function playheadProgram() {
  const c = state.clips[pb.index];
  if (!c) return 0;
  return clamp(c.ps + (Number($('player').currentTime) - c.start), 0, programTotal());
}

/** 把播放头落到成片时间 pt 上：换算回源时间并让 <video> seek。 */
function seekProgram(pt) {
  if (!state.src) return;
  const clamped = clamp(pt, 0, programTotal());
  const i = tl.clipIndexAtProg(clamped);
  pb.index = i >= 0 ? i : 0;
  const srcT = tl.progToSrc(clamped);
  $('player').currentTime = clamp(srcT, 0, state.src.media.duration);
  tl.setProgramTime(clamped);
  lastSnap = null;        // 键盘 / 按钮移动播放头，谈不上磁吸
  onTimeUpdate();
}

function seekSource(srcT) {
  const pt = tl.srcToProg(srcT);
  seekProgram(pt == null ? 0 : pt);
}

function onScrub(srcT, progT, snap) {
  if (!state.src) return;
  // 手动拖播放头 = 接管：倒带循环还在跑的话会跟手指抢位置，先掐掉
  if (state.rate < 0) haltPlayback();
  $('player').currentTime = clamp(srcT, 0, state.src.media.duration);
  const i = tl.clipIndexAtProg(progT);
  if (i >= 0) pb.index = i;
  lastSnap = snap || null;
  updateHud();
  onTimeUpdate();
}

function onTimeUpdate() {
  const p = $('player');
  // 倒带时视频停在画面泵正在追的旧位置上，播放头/时间码要跟**逻辑播放头**（墙上时钟）走，
  // 不能被 player.currentTime 拉回去——两条线的解耦在这也要守住
  const pt = state.rate < 0 ? tl.currentProgramTime() : playheadProgram();
  const srcT = tl.progToSrc(pt);
  $('timecode').innerHTML = `${tcShort(pt)} <span class="sep">/</span> ${tcShort(programTotal())}`;
  const fps = state.src ? fpsOf(state.src.media) : 30;
  $('frameNo').textContent = state.src ? `帧 ${Math.round(srcT * fps)}` : '帧 --';
  tl.setProgramTime(pt);
  if (p.paused) updateHud();      // 沿用本次落位的磁吸结果重画，别把它抹掉
}

/**
 * 走带行只留一个时间读数（#timecode）。#hud 不重复报当前时间，
 * 只补两件时间码给不了的事：这次落位有没有被磁吸、以及删过素材之后
 * 与成片位置不再相等的源位置。
 */
function updateHud() {
  const hud = $('hud');
  const on = !!(lastSnap && lastSnap.kind === 'keyframe');
  if (!state.src) { hud.textContent = ''; hud.classList.remove('snap-on'); return; }
  const parts = [];
  if (lastSnap) parts.push(lastSnap.kind === 'keyframe' ? '磁吸·关键帧' : '磁吸·分割点');
  const pt = tl.currentProgramTime();
  const srcT = tl.progToSrc(pt);
  if (Math.abs(srcT - pt) > 0.001) parts.push(`源 ${tcShort(srcT)}`);
  hud.textContent = parts.join(' · ');
  // 关键帧磁吸生效时给 HUD 上强调色，与走带行的磁吸开关同一套视觉语言
  hud.classList.toggle('snap-on', on);
}

/**
 * 走带档位。粗档越按越快（L 正放 / J 倒带），细档越按越慢（Shift+L 慢放 / Shift+J 慢倒）。
 * 两张表都按"离 1× 越来越远"排，所以推进逻辑对两者是同一条：
 * 粗档找第一个比当前更大的倍率，细档找第一个比当前更小的。
 * 表里只有**倍率**，方向由按键决定（J 系一律取负）。
 */
const RATE_FAST = [1, 2, 4, 8, 16];
const RATE_SLOW = [1, 0.75, 0.5, 0.25];

/**
 * 播放头磁吸关键帧开关。片段边界磁吸不受它影响（恒开）——
 * 吸到某一刀只是定位，不会改变剪辑结构；关键帧磁吸关掉后，
 * 拖刻度条就是自由拖动，想要精确落位时再用逐帧/跳关键帧键。
 */
function toggleKeyframeSnap() {
  state.snapKf = !state.snapKf;
  const btn = $('btnSnapKf');
  btn.classList.toggle('on', state.snapKf);
  btn.setAttribute('aria-pressed', String(state.snapKf));
  btn.title = state.snapKf
    ? '播放头磁吸关键帧（拖动刻度条时自动吸到最近的关键帧）'
    : '播放头自由拖动（不吸关键帧；片段边界仍会吸附）';
  if (tl) tl.setKeyframeSnap(state.snapKf);
  // 开关一翻，上一次的磁吸结论就作废了：开着时留下的"磁吸·关键帧"必须撤掉
  lastSnap = null;
  updateHud();
  updateToolButtons();
  window.fc.saveSnap(state.snapKf);
}

/** 停掉倒带循环（setTimeout 句柄 + seek 卡死的看门狗一起清）。 */
function stopRewind() {
  clearTimeout(rewindTimer); rewindTimer = 0;
  clearTimeout(rewindWatchdog); rewindWatchdog = 0;
}

/**
 * 倒带循环：**`<video>` 不接受负的 `playbackRate`**（设 -1 直接抛 `NotSupportedError`），
 * 所以倒放只能自己把播放头往回推——每个显示帧一次 seek。到片头就停。
 *
 * 节奏与驱动方式有两点讲究，都是踩过坑的：
 *  1. **不能用 rAF 驱动**：窗口被遮挡时 rAF 直接停发，倒带整个冻结（smoke 里实测
 *     `rate=-1` 但播放头纹丝不动）。setTimeout 后台会被节流到 ≥1s/次，但至少还在走。
 *  2. **每帧等 `seeked` 落定再走下一步**：seek 落定要 30~100ms（HEVC 大 GOP 更慢），
 *     60fps 的 rAF 远快于它，上一次 seek 还没出画面就被改目标 → 画面冻结（v1 的病根）。
 *     落后就**跳帧追墙上时钟**（`skip`），画面帧率 = seek 能达到的最大速率，时间不漂移。
 *
 * 真正"像正放一样"丝滑的倒放（解码整个 GOP 再倒序显示）需要 WebCodecs 抓帧，
 * 1 秒 1080p 素材的原始帧就要 ~500MB 内存，v0.1 不做；seek 步进的顿挫是浏览器
 * 预览的固有限制，导出走 ffmpeg 完全不受影响。
 */
function rewindStep() {
  rewindTimer = 0;
  if (!state.src || state.rate >= 0) return;
  const now = performance.now();
  // 墙上时钟一律用**毫秒**（performance.now() 的原生单位），frameDur/stepDur 也是毫秒；
  // 这段已经为单位混用栽过两跤：ms 差除以秒制 stepDur → skip ×1000 → 一按就到片头
  const lateMs = Math.min(1000, Math.max(0, now - rewind.nextWall));   // 落后多少 ms（切后台夹到 1s）
  rewind.nextWall = now + rewind.stepDurMs;
  const skip = Math.floor(lateMs / rewind.stepDurMs);                  // 落后几帧跳几帧
  const cur = tl.currentProgramTime();
  const target = cur - rewind.frameDurS * (1 + skip);
  if (target <= rewind.frameDurS * 0.5) { seekProgram(0); pausePlayback(); return; }
  seekProgram(target);                        // 播放头与画面一起到位
  // 等这一帧真正解出来（seeked 续拍，见 bindUi 的监听器）；seek 卡死由看门狗兜底
  clearTimeout(rewindWatchdog);
  rewindWatchdog = setTimeout(() => {
    rewindWatchdog = 0;
    if (state.rate < 0 && !rewindTimer) rewindTimer = setTimeout(rewindStep, 0);
  }, 300);
}

function startRewind() {
  stopRewind();
  const fps = fpsOf(state.src.media) || 30;
  rewind.frameDurS = 1 / fps;                                        // 帧长（秒）
  rewind.stepDurMs = (1000 / fps) / Math.abs(state.rate);            // 每个显示帧占的墙上时间（毫秒）
  rewind.nextWall = performance.now();
  rewindTimer = setTimeout(rewindStep, 0);
}

/** 设定走带速率：r > 0 正放（交给 playbackRate），r < 0 倒带（自己推播放头）。 */
function applyRate(r) {
  state.rate = r;
  const p = $('player');
  if (r < 0) {
    // 倒带时播放器必须停住，否则它一边往前放、我们一边往回 seek。
    // **同步 cancel 正放的 rAF**：pause 事件是异步的，等它来 cancel 的话，
    // 旧 tick 可能再跑一帧、把 currentTime 拉回片段起点（tick 的"出界拉回"分支），
    // seekProgram 刚发的目标就被吞了——表现为切倒带后播放头纹丝不动。
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (!p.paused) p.pause();
    startRewind();
  } else {
    stopRewind();
    p.playbackRate = r;
  }
  const tag = $('rateTag');
  tag.textContent = r === 1 ? '' : `${r}×`;
  // 倒带时播放器是暂停的，按钮显示 ▶，光看按钮分不出"停住"和"正在倒"——用颜色区分
  tag.classList.toggle('rew', r < 0);
}

function resumePlay() {
  const p = $('player');
  if (playheadProgram() >= programTotal() - 0.01) seekProgram(0);
  p.play().catch(() => toast('无法播放：该编码可能不被内置预览器支持，导出不受影响', 'warn'));
}

function togglePlay() {
  const p = $('player');
  if (!state.src) return;
  if (p.paused) { applyRate(1); resumePlay(); }
  else p.pause();
}

function pausePlayback() {
  if (!state.src) return;
  const wasRewinding = state.rate < 0;
  stopRewind();
  applyRate(1);
  const p = $('player');
  // 从倒带停下来的那一刻，把视频对齐到逻辑播放头的最终位置——
  // 停之前画面泵可能还差一帧没追上，不补这一下画面会停在半路
  if (wasRewinding) {
    const srcT = tl.progToSrc(tl.currentProgramTime());
    p.currentTime = clamp(srcT, 0, state.src.media.duration);
  }
  if (!p.paused) p.pause();
  else { $('btnPlay').textContent = '▶'; onTimeUpdate(); }
}

/**
 * 走带档位推进。`dir > 0` = L 系（正放），`dir < 0` = J 系（倒带）；
 * `fine` 选细档（越按越慢），否则粗档（越按越快）。
 *
 * 停着起步、或**反向切档**时都从 1× 那一档重新开始：正在 4× 正放时按 J，
 * 应该从 -1× 起倒、再按才加快，而不是一下跳到 -4×。
 */
function stepRate(dir, fine) {
  if (!state.src) return;
  const table = fine ? RATE_SLOW : RATE_FAST;
  const p = $('player');
  const active = !p.paused || state.rate < 0;     // 正在倒带时 player 是停的，也算"在动"
  const sameDir = state.rate >= 0 ? dir > 0 : dir < 0;
  if (!active || !sameDir) {
    applyRate(dir);
    if (dir > 0) resumePlay();                    // 倒带由 applyRate 自己起循环，正放要显式起播
    return;
  }
  const cur = Math.abs(state.rate);
  // 粗档往前找更大的倍率，细档往前找更小的：两张表都按"离 1× 更远"排
  const j = fine
    ? table.findIndex((r) => r < cur - 1e-6)
    : table.findIndex((r) => r > cur + 1e-6);
  if (j < 0) {
    toast(dir > 0
      ? (fine ? '已经是最慢的 0.25×' : '已经是最快的 16×')
      : (fine ? '倒带已经是最慢的 0.25×' : '倒带已经是最快的 16×'), 'warn');
    return;
  }
  applyRate(table[j] * dir);
}

/** 播放循环：跨过片段接缝时把 <video> 跳到下一段的源起点，到片尾就停。 */
function tick() {
  rafId = 0;
  if (!state.src) return;
  if (state.rate < 0) return;                 // 倒带走自己的泵，正放循环不掺和
  const p = $('player');
  if (p.paused) { onTimeUpdate(); return; }
  const c = state.clips[pb.index];
  if (!c) { p.pause(); return; }
  const fps = fpsOf(state.src.media);
  const slack = (0.5 / fps) * Math.max(1, state.rate);     // 倍速下一帧跨度更大，容差跟着放大
  if (p.currentTime >= c.end - slack) {
    const next = state.clips[pb.index + 1];
    if (!next) { p.currentTime = c.end; p.pause(); onTimeUpdate(); return; }
    pb.index += 1;
    p.currentTime = next.start + 0.5 / fps;
  } else if (p.currentTime < c.start - 0.05) {
    p.currentTime = c.start + 0.5 / fps;
  }
  onTimeUpdate();
  if (!p.paused) rafId = requestAnimationFrame(tick);
}

/**
 * 逐帧 / 跳关键帧 / 跳分割点这类"一次性定位"动作进来前先把走带停下。
 * 必须同时掐掉倒带循环：倒带时 player 本来就是停的，光 pause() 停不住它。
 */
function haltPlayback() {
  stopRewind();
  applyRate(1);
  const p = $('player');
  if (!p.paused) p.pause();
}

function stepFrames(dir, count) {
  if (!state.src) return;
  haltPlayback();
  const fps = fpsOf(state.src.media);
  seekProgram(tl.currentProgramTime() + dir * (count || 1) / fps);
}

/** 跳到源时间轴上最近的上/下一个关键帧（还在成片上的才算）。 */
function stepKeyframe(dir) {
  if (!state.src) return;
  haltPlayback();
  const srcT = tl.progToSrc(tl.currentProgramTime());
  const kfs = (state.src.media.keyframes || []).filter((k) => tl.srcToProg(k) != null);
  const target = dir > 0 ? kfs.find((k) => k > srcT + 1 / 120) : kfs.slice().reverse().find((k) => k < srcT - 1 / 120);
  if (target == null) { toast('这一侧没有更近的关键帧了', 'warn'); return; }
  seekProgram(tl.srcToProg(target));
}

function stepClip(dir) {
  if (!state.src) return;
  haltPlayback();
  const pt = tl.currentProgramTime();
  const edges = state.clips.map((c) => c.ps).concat(programTotal());
  const target = dir > 0 ? edges.find((e) => e > pt + 1e-6) : edges.slice().reverse().find((e) => e < pt - 1e-6);
  if (target != null) seekProgram(target);
}

// ---------------------------------------------------------------- 分割 / 删除 / 微调

/** 分割点（成片时间）：0、每段结尾。Q/E 就以"最近的分割点"为边界。 */
function programEdges() {
  const edges = [0];
  for (const c of state.clips) edges.push(c.pe);
  return edges;
}

function edgeBefore(pt, tol) {
  let best = 0;
  for (const e of programEdges()) if (e < pt - tol && e > best) best = e;
  return best;
}

function edgeAfter(pt, tol) {
  let best = programTotal();
  for (const e of programEdges()) if (e > pt + tol && e < best) best = e;
  return best;
}

/**
 * 删掉成片区间 [a,b) 对应的素材：与它重叠的片段按源时间被切掉中间一块，
 * 剩下的部分保留并重新并拢。这是 Q / E 的公共底层。
 */
function deleteProgramRange(a, b, label) {
  const fps = state.src ? fpsOf(state.src.media) : 30;
  const tol = 0.5 / fps;
  if (b - a <= tol) { toast('播放头正贴在分割点上，这一侧没有可删的内容', 'warn'); return false; }
  const out = [];
  for (const c of state.clips) {
    if (c.pe <= a + tol || c.ps >= b - tol) { out.push({ start: c.start, end: c.end }); continue; }
    const s0 = c.start + (Math.max(a, c.ps) - c.ps);
    const s1 = c.start + (Math.min(b, c.pe) - c.ps);
    if (s0 - c.start > tol) out.push({ start: c.start, end: s0 });
    if (c.end - s1 > tol) out.push({ start: s1, end: c.end });
  }
  if (!out.length) { toast('不能把素材全删空，至少得留一段', 'warn'); return false; }
  const removed = round3(b - a);
  state.clips = out;
  relayout();
  const pt = clamp(a, 0, programTotal());
  state.sel = clamp(tl.clipIndexAtProg(pt), 0, state.clips.length - 1);
  pb.index = state.sel;
  pushHistory();
  syncTimeline();
  seekProgram(pt);
  toast(`${label} ${removed.toFixed(3)}s`);
  return true;
}

/** Q：删掉上一个分割点 → 播放头之间的素材 */
function rippleDeleteBefore() {
  if (!state.src) return;
  const pt = tl.currentProgramTime();
  const tol = 0.5 / fpsOf(state.src.media);
  deleteProgramRange(edgeBefore(pt, tol), pt, '已删除前一段');
}

/** E：删掉播放头 → 下一个分割点之间的素材 */
function rippleDeleteAfter() {
  if (!state.src) return;
  const pt = tl.currentProgramTime();
  const tol = 0.5 / fpsOf(state.src.media);
  deleteProgramRange(pt, edgeAfter(pt, tol), '已删除后一段');
}

function splitAtPlayhead() {
  if (!state.src) return;
  const srcT = tl.progToSrc(tl.currentProgramTime());
  const i = tl.clipIndexAtProg(tl.currentProgramTime());
  const c = state.clips[i];
  if (!c) return;
  if (srcT - c.start < MIN_KEEP || c.end - srcT < MIN_KEEP) { toast('离片段边界不足一帧，不再分割', 'warn'); return; }
  state.clips.splice(i, 1, { start: c.start, end: srcT }, { start: srcT, end: c.end });
  relayout();
  state.sel = i + 1;
  pb.index = i + 1;
  pushHistory();
  syncTimeline();
  toast(`已在 ${tcShort(srcT)} 分割`);
}


/**
 * Backspace：删掉**鼠标选中的高亮段**（点胶片/列表选中的那段），后面自动并拢。
 *
 * 高亮（state.sel）与播放头停靠段（pb.index）是两个独立的东西——单击胶片只选中、
 * 不动播放头，两者可以停在不同段上。删除跟随高亮才符合直觉（`448b6ff` 之前跟随
 * 播放头，用户点选了第 3 段按 Backspace 却删掉播放头所在的第 1 段）。
 * Q/E 的"删到上/下一个分割点"仍以播放头为基准，那是它们的定义。
 */
function deleteClipAtPlayhead() {
  if (!state.src) return;
  let i = Number.isInteger(state.sel) ? state.sel : -1;
  if (i < 0 || !state.clips[i]) i = tl.clipIndexAtProg(tl.currentProgramTime());
  if (i < 0 || !state.clips[i]) return;
  if (state.clips.length === 1) { toast('只剩一段，删掉就没东西可导出了', 'warn'); return; }
  const c = state.clips[i];
  state.clips.splice(i, 1);
  relayout();
  state.sel = clamp(i - 1, 0, state.clips.length - 1);
  pushHistory();
  syncTimeline();
  // 播放头留在原成片时刻（被删段若不在播放头下，其它段的素材位置整体前移，画面跟着重算）
  seekProgram(clamp(tl.currentProgramTime(), 0, programTotal()));
  toast(`已删除 ${(c.end - c.start).toFixed(3)}s`);
}

/** 拖动改顺序：数组顺序就是导出顺序，交给内核时走"按顺序逐段"这条路。 */
function reorderClip(from, to) {
  if (from == null || to == null || from < 0 || !state.clips[from]) return;
  const at = clamp(to > from ? to - 1 : to, 0, state.clips.length - 1);
  if (at === from) return;                       // 原地拖回：不留快照、不弹提示
  const moved = state.clips.splice(from, 1)[0];
  state.clips.splice(at, 0, moved);
  relayout();
  state.sel = clamp(at, 0, state.clips.length - 1);
  pushHistory();
  syncTimeline();
  // 播放头留在原处（它只归手柄管），但同一位置下面的素材换了，画面要跟着重算一次
  seekProgram(tl.currentProgramTime());
  toast(`已移到第 ${state.sel + 1} 位`);
}

/** 拖分割线：左右两个片段同时改切点（源时间）。 */
function trimBoundary(index, srcT) {
  const a = state.clips[index];
  const b = state.clips[index + 1];
  if (!a || !b || !state.src) return;
  const lo = a.start + MIN_KEEP;
  const hi = Math.min(state.src.media.duration, b.end - MIN_KEEP);
  const t = round3(clamp(srcT, lo, hi));
  a.end = t;
  b.start = t;
  relayout();
  syncTimeline(false);
}

function mergeBoundary(i) {
  const a = state.clips[i];
  const b = state.clips[i + 1];
  if (!a || !b) return;
  if (Math.abs(a.end - b.start) > 0.002) {
    toast('这两段在源里不相邻（中间被删过），不能合并', 'warn');
    return;
  }
  state.clips.splice(i, 2, { start: a.start, end: b.end });
  relayout();
  state.sel = i;
  pushHistory();
  syncTimeline();
  toast('已合并相邻片段');
}

function resetClips() {
  if (!state.src) return;
  const dur = round3(state.src.media.duration);
  state.clips = [{ start: 0, end: dur }];
  relayout();
  state.sel = 0;
  pb.index = 0;
  pushHistory();
  syncTimeline();
  toast('已恢复整条素材');
}



/** 删除入点→出点之间的素材：先切成三段，再删中间那段。 */

// ---------------------------------------------------------------- 撤销 / 重做

function snapshot() {
  return state.clips.map((c) => ({ start: c.start, end: c.end }));
}

function pushHistory() {
  history.stack = history.stack.slice(0, history.i + 1);
  history.stack.push(snapshot());
  if (history.stack.length > 80) history.stack.shift();
  history.i = history.stack.length - 1;
}

function stepHistory(delta, label) {
  const next = history.i + delta;
  if (next < 0 || next >= history.stack.length) { toast(`没有可${label}的操作`, 'warn'); return; }
  history.i = next;
  state.clips = history.stack[next].map((c) => ({ ...c }));
  relayout();
  state.sel = clamp(state.sel, 0, state.clips.length - 1);
  pb.index = state.sel;
  syncTimeline();
  toast(label === '撤销' ? '已撤销' : '已重做');
}

// ---------------------------------------------------------------- 面板

function syncTimeline(withPlan = true) {
  tl.setClips(state.clips, state.sel, snapMap());
  renderClips();
  updateEstimate();
  updateExportEnabled();
  updateToolButtons();
  lastSnap = null;
  updateHud();
  if (withPlan) refreshPlan();
}

let planTimer = null;
function refreshPlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(runPlan, 120);
}

let planSeq = 0;              // 计划请求代序：勾选切模式时防旧响应覆盖新计划（乱序完成时后者胜）
async function runPlan() {
  if (!state.src || !state.clips.length) return;
  const seq = ++planSeq;
  try {
    const plan = await window.fc.previewPlan({
      file: state.src.file,
      segments: state.clips.map((c) => ({ start: c.start, end: c.end })),
      container: containerChoice(),
      precise: isPreciseMode(),
    });
    if (seq !== planSeq) return;   // 已有更新的请求在路上，这份过期了
    state.plan = plan;
  } catch (err) {
    showError(cleanErr(err));
    return;
  }
  // 新计划必须推进时间轴：snapMap 变了（吸附差/自动降级角标都随模式变），
  // 只刷列表 DOM 的话 tl 的 snapInfo 还是旧计划的——多带可视化与角标全踩旧数据
  syncTimeline(false);
  updateEstimate();
  updateExportEnabled();
}

/** 导出模态的「精确模式」勾选：默认不勾 = 吸附关键帧整段流拷贝。 */
function isPreciseMode() {
  const box = $('optPrecise');
  return box ? box.checked : true;
}

function renderClips() {
  const ul = $('keepList');
  ul.innerHTML = '';
  state.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = i === state.sel ? 'sel' : '';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    const time = document.createElement('span');
    time.className = 'tc';
    time.textContent = `${tcShort(c.ps)} → ${tcShort(c.pe)}`;
    const len = document.createElement('span');
    len.className = 'len tc';
    len.textContent = `${(c.end - c.start).toFixed(3)}s`;
    li.append(idx, time, len);

    const cost = costMap()[i];
    const src = document.createElement('span');
    src.className = 'snap' + (cost && cost !== 'copy' ? ' lossy' : '');
    const label = { copy: '纯拷贝', head: '入点小段重编码', whole: '整段重编码', codec: '整段换编码' }[cost] || '待计划';
    src.textContent = `源 ${tcShort(c.start)}–${tcShort(c.end)} · ${label}`;
    src.title = {
      copy: '整段流拷贝（不转码）',
      head: '入点那一小段有损重编码，其余仍流拷贝',
      whole: '这一整段在同一个 GOP 内：有损重编码',
      codec: '整段重编码并更换编码格式',
    }[cost] || '';
    li.appendChild(src);

    li.addEventListener('click', () => { state.sel = i; tl.setSelected(i); seekProgram(c.ps); renderClips(); });
    ul.appendChild(li);
  });
  $('keepCount').textContent = String(state.clips.length);
  $('keepTotal').textContent = `合计 ${keptSeconds().toFixed(3)} s`;
  const hints = $('planHints');
  hints.innerHTML = '';
  for (const w of (state.plan && state.plan.warnings) || []) {
    const div = document.createElement('div');
    div.textContent = `⚠ ${w}`;
    hints.appendChild(div);
  }
}

/** 预估行是 innerHTML 拼的，凡是来自文件元数据/主进程的字样都先过这一道。 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function updateEstimate() {
  const box = $('estimate');
  if (!state.src || !state.clips.length) { box.textContent = '—'; return; }
  const keepSecs = keptSeconds();
  const parts = state.plan && state.plan.plan;
  // 成片时长按计划实算（整帧取整后的真值），计划没回来时退回用户选区
  const planSecs = Array.isArray(parts) && parts.length
    ? round3(parts.reduce((a, p) => a + p.duration, 0)) : null;
  const estSecs = planSecs == null ? keepSecs : planSecs;
  const split = $('optSplit').checked;
  const cut = round3(Math.max(0, (state.src.media.duration || 0) - keepSecs));
  const rate = state.src.media.bitRate || 8e6;
  const bytes = rate / 8 * estSecs * 1.05;
  const lines = [
    `<b>${split ? state.clips.length : 1} 个文件</b> · 成片 <b>${tc(estSecs)}</b> · <b>${fmtBytes(bytes)}</b>`,
  ];
  const headN = countCost('head');
  const wholeN = countCost('whole');
  const codecN = countCost('codec');
  const autoN = (() => {
    const list = Array.isArray(parts) ? parts : [];
    return new Set(list.filter((p) => p.autoPrecise).map((p) => p.keepIndex)).size;
  })();
  const snapN = (() => {
    const list = Array.isArray(parts) ? parts : [];
    return new Set(list.filter((p) => p.kind === 'copy' && p.role === 'whole' && /前移到关键帧|从 0 开始/.test(p.note || '')).map((p) => p.keepIndex)).size;
  })();
  if (!isPreciseMode()) {
    // 吸附模式的预估：把"多带了什么"如实列出
    const extra = (Array.isArray(parts) ? parts : []).reduce((a, p) => a + Math.max(0, (p.snapFrom != null ? p.snapFrom - p.start : 0)), 0);
    if (extra > 0.05) lines.push(`⚠ 吸附关键帧：会多带开头共 ${extra.toFixed(3)}s（切点对准关键帧可避免，或勾「精确模式」）`);
    if (autoN) lines.push(`✂ ${autoN} 段吸附会吞掉已删的间隙：已自动改为局部精确（入点小段重编码）`);
  }
  if (headN) lines.push(`✂ ${headN} 段入点那一小段重编码：其余仍流拷贝`);
  if (wholeN) lines.push(`✂ ${wholeN} 段整段在同一个 GOP 内：有损重编码`);
  const srcCodec = state.src.media.video && state.src.media.video.codec;
  if (codecN) lines.push(`⚠ ${codecN} 段整段换编码重编码：源编码 ${esc(srcCodec || '?')} 没有同编码的重编码器`);
  const parts2 = (state.plan && state.plan.plan) || [];
  const trimmed = parts2.reduce((a, p) => Math.max(a, p.trimmed || 0), 0);
  if (trimmed) lines.push(`· 源含双向预测帧：拷贝段的末端留了 ${trimmed} 帧余量，不会把你删掉的素材带回来`);
  const mode = state.plan && state.plan.subtitleMode;
  const subTracks = (state.src.media.subtitleCodecs || []).length;
  if (mode === 'unsupported' && parts2.length > 1) {
    lines.push(`⚠ 源含 ${subTracks} 条字幕轨但不是可重排的文本字幕（只支持 SRT/ASS）：分段流拷贝会漏掉/串动字幕，导出会被自检拒绝。出路：让每个入点都落在关键帧上（实测整段流拷贝的那一刀字幕一条不缺），或改选会省略这条字幕轨的容器、把字幕当外挂文件另行处理`);
  } else if (mode === 'retime') {
    lines.push(`· ${subTracks} 条字幕轨按保留区间重新计时（文本重排，不改编码）`);
  }
  if (planSecs != null && Math.abs(planSecs - keepSecs) > 0.05) {
    lines.push(`· 计划比选区${planSecs > keepSecs ? '多' : '少'} ${Math.abs(planSecs - keepSecs).toFixed(3)}s（整帧取整）`);
  }
  if (state.src.media.video && state.src.media.video.vfr) lines.push('⚠ 疑似 VFR（标称与实测帧率差 1% 以上）：每段整段重编码为定帧率，时长与剪辑位置才准');
  // 换封装的代价必须在这里说清楚，而不是等 ffmpeg 报 "Could not find tag for codec"
  const cont = state.plan && state.plan.container;
  if (cont) {
    $('outExt').textContent = cont.ext;
    const dropped = cont.droppedSubtitles || [];
    if (dropped.length) {
      lines.push(`⚠ ${esc(cont.label)} 装不下字幕轨（${esc(dropped.join('、'))}），将整条省略；要保留字幕请选 MKV`);
    }
  }
  box.innerHTML = lines.join('<br>');
}

function updateToolButtons() {
  const has = !!state.src;
  $('btnUndo').disabled = !has || history.i <= 0 || state.busy;
  $('btnRedo').disabled = !has || history.i >= history.stack.length - 1 || state.busy;
  $('btnReset').disabled = !has || state.busy || (state.clips.length === 1 && state.clips[0].start <= 0.001);
  for (const id of ['btnPrevKf', 'btnNextKf', 'btnStepBack', 'btnStepFwd', 'btnPlay']) $(id).disabled = !has || state.busy;
  $('btnSnapKf').classList.toggle('on', state.snapKf);
  $('btnSnapKf').setAttribute('aria-pressed', String(!!state.snapKf));
}

function updateExportEnabled() {
  const secs = keptSeconds();
  const why = !state.src ? '先导入视频'
    : !(state.env && state.env.ok) ? '未找到可用的 ffmpeg'
      : state.scanning ? '正在关键帧扫描，扫完才能确定哪些段能整段流拷贝'
        : !state.clips.length ? '素材全被删了，至少留一段'
          : secs < MIN_KEEP ? '剩余素材总长小于一帧，无法导出'
            : !$('outDir').value ? '先选择导出目录'
              : state.busy ? '导出进行中' : '';
  $('btnExport').disabled = !!why;
  $('btnExport').title = why || (isPreciseMode()
    ? '精确模式：剪辑位置精确到帧，入点不回溯，拷贝段整段流拷贝'
    : '吸附模式（默认）：切点前移到最近关键帧，整段流拷贝、零重编码');
}

// ---------------------------------------------------------------- 导出

async function runExport() {
  if (!state.src || state.busy) return;
  const segments = state.clips.map((c) => ({ start: c.start, end: c.end }));
  if (!segments.length) return;

  const payload = {
    file: state.src.file,
    segments,
    outDir: $('outDir').value,
    baseName: $('outName').value,
    split: $('optSplit').checked,
    precise: isPreciseMode(),
    container: containerChoice(),
  };

  setBusy(true);
  showError('');
  $('checks').innerHTML = '';
  $('warnings').classList.add('hidden');
  $('resultRow').classList.add('hidden');
  $('progress').classList.remove('hidden');
  setProgress('准备中…', 0, '');

  try {
    const res = await window.fc.exportStart(payload);
    state.outputs = res.outputs || [];
    showChecks(res.results);
    const warnList = res.warnings || [];
    if (warnList.length) {
      $('warnings').textContent = warnList.map((w) => `⚠ ${w}`).join('\n');
      $('warnings').classList.remove('hidden');
    }
    $('resultRow').classList.remove('hidden');
    setProgress('导出完成', 100, state.outputs.map((p) => String(p).split(/[\\/]/).pop()).join('、'));
    openExportPop(true);      // 用户可能中途关了面板，结果要看得见
    toast(`已导出 ${state.outputs.length} 个文件，自检通过`);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('已取消')) {
      setProgress('已取消', 0, '未完成的输出文件已删除');
      toast('导出已取消');
    } else {
      showError(msg);
      setProgress('导出失败', 0, '');
      toast('导出失败，详见右侧说明', 'warn');
    }
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  $('btnExport').classList.toggle('hidden', busy);
  $('btnCancelExport').classList.toggle('hidden', !busy);
  $('btnImportEmpty').disabled = busy;
  for (const id of ['optPrecise', 'optSplit', 'outName', 'outContainer', 'btnChooseDir']) $(id).disabled = busy;
  updateToolButtons();
  updateExportEnabled();
}

function setProgress(phase, pct, detail) {
  $('progressPhase').textContent = phase;
  $('progressPct').textContent = `${Math.round(pct)}%`;
  $('progressFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('progressDetail').textContent = detail || '';
}

function onProgress(evt) {
  if (!evt) return;
  switch (evt.phase) {
    case 'prepare':
      setProgress(`准备导出 ${evt.segments.length} 段`, 2, `合计 ${Number(evt.keepSecs).toFixed(3)} s`);
      break;
    case 'normalize':
      setProgress('封装归一（纯拷贝，不重编码）', 3, evt.note || '');
      break;
    case 'cut':
      state.cut = { index: evt.index, total: evt.total || 1, ratio: 0 };
      setProgress(`切割 ${evt.index + 1}/${evt.total}（${evt.kind === 'copy' ? '流拷贝' : '重编码'}）`,
        pctForItem(), `${evt.range}${evt.note ? ` · ${evt.note}` : ''}`);
      break;
    case 'cut-progress':
      state.cut.ratio = clamp(evt.ratio || 0, 0, 1);
      setProgress(`切割 ${state.cut.index + 1}/${state.cut.total}`, pctForItem(), evt.range || '');
      break;
    case 'verify':
      setProgress('自检中（比对源参数 + 解码校验）', 92, '');
      break;
    case 'done':
      setProgress('导出完成', 100, '');
      break;
    default:
      break;
  }
}

function pctForItem() {
  const { index, total, ratio } = state.cut;
  return 2 + ((index + ratio) / Math.max(1, total)) * 86;
}

function showChecks(results) {
  const ul = $('checks');
  ul.innerHTML = '';
  (results || []).forEach((r) => {
    const title = document.createElement('li');
    title.className = 'title';
    title.textContent = `${String(r.file).split(/[\\/]/).pop()} — ${r.ok ? '通过' : '未通过'}`;
    ul.appendChild(title);
    for (const c of r.checks || []) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'bad';
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = c.ok ? '✓' : '✕';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = c.detail || '';
      detail.title = c.detail || '';
      li.append(st, name, detail);
      ul.appendChild(li);
    }
  });
}

async function cancelExport() {
  if (!state.busy) return;
  await window.fc.exportCancel();
  setProgress('正在取消…', Number($('progressPct').textContent) || 0, '终止 ffmpeg 进程并清理半成品');
}

// ---------------------------------------------------------------- 快捷键面板

/**
 * 键位表。用户自定义存在主进程 settings.keymap（userData）里，
 * 这里只留"动作 → 组合键数组"，header 上那个 ⌨ 面板可以逐条改。
 */
const KEYS = {
  rippleBefore: ['q'], split: ['w'], rippleAfter: ['e'], deleteClip: ['backspace'],
  playPause: [' '], rewind: ['j'], slowRewind: ['shift+j'], pause: ['k'], faster: ['l'], slowFaster: ['shift+l'],
  prevFrame: [',', 'arrowleft'], nextFrame: ['.', 'arrowright'],
  prevKeyframe: ['shift+arrowleft'], nextKeyframe: ['shift+arrowright'],
  prevEdge: ['shift+arrowup'], nextEdge: ['shift+arrowdown'],
  undo: ['ctrl+z'], redo: ['ctrl+y', 'ctrl+shift+z'],
  zoomIn: ['+', '='], zoomOut: ['-', '_'], fit: ['ctrl+0'],
  toStart: ['home'], toEnd: ['end'], cancelExport: ['escape'],
  importFile: ['ctrl+o'], exportNow: ['ctrl+e'], keysPanel: ['shift+?'],
};

const KEY_LABELS = {
  rippleBefore: '删到上一个分割点', split: '在播放头处分割', rippleAfter: '删到下一个分割点',
  deleteClip: '删除整段素材', playPause: '播放 / 暂停', rewind: '倒带（越按越快）', slowRewind: '慢速倒带',
  pause: '暂停',
  faster: '快进（越按越快）', slowFaster: '慢放', prevFrame: '上一帧', nextFrame: '下一帧',
  prevKeyframe: '上一个关键帧', nextKeyframe: '下一个关键帧',
  prevEdge: '上一个分割点', nextEdge: '下一个分割点',
  undo: '撤销', redo: '重做', zoomIn: '放大时间轴', zoomOut: '缩小时间轴', fit: '整条适应',
  toStart: '跳到片头', toEnd: '跳到片尾', cancelExport: '取消导出',
  importFile: '导入', exportNow: '导出', keysPanel: '打开本面板',
};

const KEY_ORDER = ['rippleBefore', 'split', 'rippleAfter', 'deleteClip', 'rewind', 'slowRewind', 'pause', 'faster', 'slowFaster',
  'playPause', 'prevFrame', 'nextFrame', 'prevKeyframe', 'nextKeyframe', 'prevEdge', 'nextEdge',
  'undo', 'redo', 'zoomIn', 'zoomOut', 'fit', 'toStart', 'toEnd', 'cancelExport', 'importFile', 'exportNow'];

let customKeys = {};
let capturing = null;

function bindingFor(action) {
  const list = customKeys[action];
  return (list && list.length ? list : KEYS[action] || []).slice();
}

/** KeyboardEvent → 'ctrl+o' / 'shift+arrowleft' / 'backspace'。 */
function comboOf(e) {
  const key = String(e.key || '').toLowerCase();
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  // 符号键自身已经带出 shift 的意思（'+' 就是 shift+'='），不重复计入
  if (e.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) mods.push('shift');
  mods.push(key);
  return mods.join('+');
}

const KEY_PRETTY = {
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  backspace: 'Backspace', escape: 'Esc', ' ': 'Space', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt',
};

function prettyKey(combo) {
  return String(combo).split('+')
    .map((part) => KEY_PRETTY[part] || (part.length === 1 ? part.toUpperCase() : part))
    .join(' + ');
}

function actionForCombo(combo) {
  for (const action of KEY_ORDER.concat(['keysPanel'])) {
    if (bindingFor(action).includes(combo)) return action;
  }
  return null;
}

function persistKeys() {
  window.fc.setKeymap(customKeys);
}

async function loadKeys() {
  try {
    customKeys = (await window.fc.getKeymap()) || {};
  } catch (err) {
    customKeys = {};
  }
}

function openKeys() {
  let mask = document.querySelector('.modal-mask.keys');
  if (!mask) {
    mask = document.createElement('div');
    mask.className = 'modal-mask keys';
    const panel = document.createElement('div');
    panel.className = 'modal keys';
    const h = document.createElement('h3');
    h.textContent = '快捷键';
    const tip = document.createElement('div');
    tip.className = 'modal-tip';
    tip.textContent = '点按键位，再按新键即可改。';
    const grid = document.createElement('div');
    grid.className = 'keys-grid';
    const foot = document.createElement('div');
    foot.className = 'm-foot';
    const all = document.createElement('button');
    all.className = 'btn';
    all.textContent = '全部恢复默认';
    all.addEventListener('click', () => { customKeys = {}; persistKeys(); paint(); });
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '关闭';
    close.addEventListener('click', () => { capturing = null; mask.remove(); });
    const gap = document.createElement('span');
    gap.className = 'grow';
    foot.append(all, gap, close);
    panel.append(h, tip, grid, foot);
    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) { capturing = null; mask.remove(); } });
    document.body.appendChild(mask);
    document.addEventListener('keydown', captureKey, true);
  }
  const grid = mask.querySelector('.keys-grid');

  function paint() {
    grid.innerHTML = '';
    for (const action of KEY_ORDER) {
      const row = document.createElement('div');
      row.className = 'm-row';
      const label = document.createElement('div');
      label.className = 'm-label dim';
      label.textContent = KEY_LABELS[action] || action;
      const chips = document.createElement('span');
      chips.className = 'm-act';
      const chip = document.createElement('button');
      chip.className = 'm-chip act' + (capturing === action ? ' capture' : '');
      chip.textContent = capturing === action
        ? '按下新键…'
        : bindingFor(action).map(prettyKey).join(' / ') || '—';
      chip.addEventListener('click', () => {
        capturing = capturing === action ? null : action;
        paint();
      });
      const reset = document.createElement('button');
      reset.className = 'm-reset';
      reset.textContent = '↺';
      reset.title = '恢复这一项的默认键位';
      reset.addEventListener('click', () => { delete customKeys[action]; persistKeys(); paint(); });
      chips.append(chip, reset);
      row.append(label, chips);
      grid.append(row);
    }
  }
  paint();
}

function captureKey(e) {
  if (!capturing) return;
  const combo = comboOf(e);
  if (combo === 'shift' || combo === 'ctrl' || combo === 'alt' || combo === 'meta') return;
  e.preventDefault();
  e.stopPropagation();
  for (const action of Object.keys(KEYS)) {
    if (action === capturing) continue;
    const list = bindingFor(action);
    if (!list.includes(combo)) continue;
    const rest = list.filter((c) => c !== combo);
    if (rest.length) customKeys[action] = rest;
    else delete customKeys[action];
  }
  customKeys[capturing] = [combo];
  capturing = null;
  persistKeys();
  openKeys();
}

function runAction(action) {
  switch (action) {
    case 'rippleBefore': return rippleDeleteBefore();
    case 'rippleAfter': return rippleDeleteAfter();
    case 'split': return splitAtPlayhead();
    case 'deleteClip': return deleteClipAtPlayhead();
    case 'rewind': return stepRate(-1, false);
    case 'slowRewind': return stepRate(-1, true);
    case 'pause': return pausePlayback();
    case 'faster': return stepRate(1, false);
    case 'slowFaster': return stepRate(1, true);
    case 'playPause': return togglePlay();
    case 'prevFrame': return stepFrames(-1);
    case 'nextFrame': return stepFrames(1);
    case 'prevKeyframe': return stepKeyframe(-1);
    case 'nextKeyframe': return stepKeyframe(1);
    case 'prevEdge': return stepClip(-1);
    case 'nextEdge': return stepClip(1);
    case 'undo': return stepHistory(-1, '撤销');
    case 'redo': return stepHistory(1, '重做');
    case 'zoomIn': return tl.setZoomLevel(tl.zoomLevel() + 8);
    case 'zoomOut': return tl.setZoomLevel(tl.zoomLevel() - 8);
    case 'fit': return tl.fit();
    case 'toStart': return state.src && seekProgram(0);
    case 'toEnd': return state.src && seekProgram(programTotal());
    case 'importFile': return pickAndImport();
    case 'exportNow': popShow('exportMask', true); if (!$('btnExport').disabled) runExport(); return undefined;
    case 'cancelExport':
      if (state.busy) return cancelExport();
      // 没在导出时 Esc 什么也没做，就是键位表里这条一直没接上分支；现在拿它关弹层
      popShow('exportMask', false);
      popShow('importMask', false);
      return undefined;
    case 'keysPanel': return openKeys();
    default: return undefined;
  }
}
// ---------------------------------------------------------------- 事件绑定

function bindUi() {
  const p = $('player');
  p.addEventListener('loadedmetadata', () => { onTimeUpdate(); tl.render(); });
  p.addEventListener('timeupdate', () => { if (!rafId) onTimeUpdate(); });
  // 倒带的节奏驱动：一次 seek 落定就按拍点追下一帧（见 rewindStep 的注释）
  p.addEventListener('seeked', () => {
    if (state.rate >= 0 || rewindTimer) return;
    clearTimeout(rewindWatchdog); rewindWatchdog = 0;
    rewindTimer = setTimeout(rewindStep, Math.max(0, rewind.nextWall - performance.now()));
  });
  p.addEventListener('durationchange', onTimeUpdate);
  p.addEventListener('play', () => { $('btnPlay').textContent = '⏸'; if (!rafId) rafId = requestAnimationFrame(tick); });
  p.addEventListener('pause', () => {
    $('btnPlay').textContent = '▶';
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    // 倒带时播放器是**故意**停住的（applyRate 起倒带循环前先 pause），
    // 这里再复位一次速率就会把刚起的倒带当场掐掉——所以倒带态下不动速率。
    if (state.rate >= 0) applyRate(1);
    onTimeUpdate();
  });
  p.addEventListener('error', () => {
    if (!state.src) return;
    toast('预览器无法解码该视频（常见于 HEVC／AV1）。这只影响预览，导出不受影响：默认吸附模式下整段流拷贝；勾了「精确模式」则只重编码入点那一小段。', 'warn');
  });

  $('btnImportEmpty').addEventListener('click', pickAndImport);
  // 顶栏三个入口：☰ 是贴按钮的菜单，⤓ 导入 / ⤒ 导出是居中模态
  $('btnExportOpen').addEventListener('click', (e) => { e.stopPropagation(); popToggle('exportMask'); });
  $('btnImportOpen').addEventListener('click', (e) => { e.stopPropagation(); popToggle('importMask'); });
  $('btnImportPick').addEventListener('click', async () => {
    popShow('importMask', false);
    await pickAndImport();
  });
  $('btnMenu').addEventListener('click', (e) => { e.stopPropagation(); popToggle('menuPop'); });
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest ? e.target : null;
    // 模态里点任何一处（勾选项、输入框）都不算"点到外面"，否则一勾就关
    if (el && (el.closest('.pop-wrap') || el.closest('.modal-mask')
      || el.closest('#btnExportOpen') || el.closest('#btnImportOpen'))) return;
    popCloseAll();
  });
  for (const item of document.querySelectorAll('#menuPop .mi')) {
    item.addEventListener('click', () => {
      popCloseAll();
      onMenuAction(item.dataset.action);
    });
  }
  // 点模态的暗色底（面板本体之外）关闭它，与快捷键面板一致
  for (const id of ['exportMask', 'importMask']) {
    $(id).addEventListener('pointerdown', (e) => { if (e.target === $(id)) popShow(id, false); });
  }
  // 页脚的"关闭"按钮统一用 data-close 声明，省得每个面板各写一遍
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => popShow(btn.dataset.close, false));
  }

  // 自绘标题栏的窗口控制
  $('winMin').addEventListener('click', () => window.fc.winMin());
  $('winMax').addEventListener('click', () => window.fc.winMax());
  $('winClose').addEventListener('click', () => window.fc.winClose());
  window.fc.onWinState(({ maximized }) => {
    $('topbar').classList.toggle('maxed', !!maximized);
    $('winMax').title = maximized ? '还原' : '最大化';
  });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnStepBack').addEventListener('click', () => stepFrames(-1));
  $('btnStepFwd').addEventListener('click', () => stepFrames(1));
  $('btnPrevKf').addEventListener('click', () => stepKeyframe(-1));
  $('btnNextKf').addEventListener('click', () => stepKeyframe(1));
  $('btnUndo').addEventListener('click', () => stepHistory(-1, '撤销'));
  $('btnRedo').addEventListener('click', () => stepHistory(1, '重做'));
  $('btnReset').addEventListener('click', resetClips);
  $('btnSnapKf').addEventListener('click', toggleKeyframeSnap);
  $('btnFit').addEventListener('click', () => tl.fit());
  $('btnKeys').addEventListener('click', openKeys);

  $('btnChooseDir').addEventListener('click', async () => {
    const dir = await window.fc.chooseDir($('outDir').value);
    if (dir) { $('outDir').value = dir; updateExportEnabled(); }
  });
  $('outName').addEventListener('input', updateExportEnabled);

  $('optSplit').addEventListener('change', () => {
    syncTimeline(false);
    refreshPlan();
  });

  $('optPrecise').addEventListener('change', () => {
    // 勾选框行染警告黄（唯一"勾上就有代价"的选项），并按新模式重算计划与预估
    $('optPrecise').closest('.m-row').classList.toggle('on', $('optPrecise').checked);
    syncTimeline(false);
    refreshPlan();
  });

  $('outContainer').addEventListener('change', refreshPlan);   // 换容器会改后缀，也可能装不下字幕

  $('btnExport').addEventListener('click', runExport);
  $('btnCancelExport').addEventListener('click', cancelExport);
  $('btnReveal').addEventListener('click', () => state.outputs[0] && window.fc.reveal(state.outputs[0]));
  $('btnPlayOut').addEventListener('click', () => state.outputs[0] && window.fc.openFile(state.outputs[0]));

  /**
   * 从资源管理器拖视频进来。反馈层必须是覆盖整窗的独立一层：
   * 之前借用空状态的 #empty 描边，导入过一次之后它就 display:none 了，
   * 第二次拖入毫无提示，看起来像"不支持拖拽"。
   */
  let dragDepth = 0;
  const showVeil = (on) => $('dropVeil').classList.toggle('hidden', !on);
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth += 1;
    showVeil(true);
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showVeil(false);
  });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    showVeil(false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const path = window.fc.pathForFile(file);
    if (path) await importFile(path);
    else toast('无法读取拖入文件的路径，请用 文件 → 导入视频', 'warn');
  });

  document.addEventListener('keydown', onKeyDown);
  window.fc.onProgress(onProgress);
  window.fc.onScan(onScanResult);
  window.fc.onThumbs(applyThumbs);
  window.fc.onFilm(applyFilm);
  window.fc.onMenu((payload) => onMenuAction(payload.action, payload.file));
  updateToolButtons();
}

function onMenuAction(action, file) {
  const map = {
    import: pickAndImport,
    open: () => file && importFile(file),
    export: () => { popShow('exportMask', true); if (!$('btnExport').disabled) runExport(); },
    split: splitAtPlayhead,
    rippleBefore: rippleDeleteBefore,
    rippleAfter: rippleDeleteAfter,
    playSlower: () => stepRate(-1, false),
    playFaster: () => stepRate(1, false),
    pause: pausePlayback,
    undo: () => stepHistory(-1, '撤销'),
    redo: () => stepHistory(1, '重做'),
    togglePlay, stepBack: () => stepFrames(-1), stepForward: () => stepFrames(1),
    prevKeyframe: () => stepKeyframe(-1), nextKeyframe: () => stepKeyframe(1),
    deleteClip: deleteClipAtPlayhead,
    cancel: cancelExport,
    fit: () => tl.fit(),
    reset: resetClips,
    about: () => window.fc.appAbout(),
    quit: () => window.fc.appQuit(),
    shortcuts: openKeys,
  };
  const fn = map[action];
  if (fn) fn();
}

function onKeyDown(e) {
  if (capturing) return;                              // 面板正在等新键位，别抢
  const tag = String(e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  const combo = comboOf(e);
  const action = actionForCombo(combo);
  if (!action) return;
  if (action === 'cancelExport') {
    if (state.busy) { e.preventDefault(); cancelExport(); }
    else if (typing) e.target.blur();
    return;
  }
  if (typing) return;                                 // 输入框里保留原生行为
  e.preventDefault();
  runAction(action);
}

window.addEventListener('DOMContentLoaded', boot);

/** 端到端自检用的最小钩子：scripts/smoke.js 通过它驱动真实界面。 */
window.__smoke = {
  state,
  get tl() { return tl; },
  importFile,
  splitAtPlayhead,
  seekProgram,
  stepFrames,
  stepKeyframe,
  rippleDeleteBefore,
  rippleDeleteAfter,
  stepRate,
  pausePlayback,
  mergeBoundary,
  deleteClipAtPlayhead,
  reorderClip,
  bindingFor,
  openKeys,
  resetClips,
  undo: () => stepHistory(-1, '撤销'),
  redo: () => stepHistory(1, '重做'),
  programTotal,
  keptSeconds,
  runExport,
  setOption(id, on) {
    const el = $(id);
    el.checked = !!on;
    // 无论值是否变化都发 change：调用方（如 smoke）切回同一个值时同样需要重算计划
    el.dispatchEvent(new Event('change'));
  },
  setOut(dir, name) { $('outDir').value = dir; $('outName').value = name; updateExportEnabled(); },
  setContainer(id) { $('outContainer').value = id; $('outContainer').dispatchEvent(new Event('change')); },
  ready: () => !!window.fc && !!tl,
};
