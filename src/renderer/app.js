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
  rate: 1,              // J/K/L 变速播放
  plan: null,
  busy: false,
  scanning: false,
  thumbs: null,        // { dir, step, count } 时间轴胶片条
  cut: { index: 0, total: 1, ratio: 0 },
  outputs: [],
};

const history = { stack: [], i: -1 };
const pb = { index: 0 };      // 播放头当前落在第几个片段
let lastSnap = null;          // 最近一次拖放的磁吸结果，给 #hud 用
let tl = null;
let rafId = 0;

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
  await refreshEnv();
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
    showError(`GOP 边界扫描失败：${payload.message}`);
    toast('GOP 边界扫描失败：无法判断哪些段能整段流拷贝，导出会把每段都重编码', 'warn');
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
  toast(`GOP 边界扫描完成：${payload.keyframes.length} 个（其中 ${headN} 段需重编码入点）；用时 ${(payload.ms / 1000).toFixed(2)} 秒`);
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
  rows.push(['GOP 边界', state.scanning ? '扫描中…' : `${kfCount} 个${gap ? ` · 间隔约 ${gap}` : ''}`, state.scanning ? 'warn' : '']);

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
  $('player').currentTime = clamp(srcT, 0, state.src.media.duration);
  const i = tl.clipIndexAtProg(progT);
  if (i >= 0) pb.index = i;
  lastSnap = snap || null;
  updateHud();
  onTimeUpdate();
}

function onTimeUpdate() {
  const p = $('player');
  const pt = playheadProgram();
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
  if (!state.src) { hud.textContent = ''; return; }
  const parts = [];
  if (lastSnap) parts.push(lastSnap.kind === 'keyframe' ? '磁吸·GOP 边界' : '磁吸·分割点');
  const pt = tl.currentProgramTime();
  const srcT = tl.progToSrc(pt);
  if (Math.abs(srcT - pt) > 0.001) parts.push(`源 ${tcShort(srcT)}`);
  hud.textContent = parts.join(' · ');
}

/** J/K/L 的档位表：L 往右走一档，J 往左走一档。 */
const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];

function applyRate(r) {
  state.rate = r;
  $('player').playbackRate = r;
  $('rateTag').textContent = r === 1 ? '' : `${r}×`;
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
  if (state.src) $('player').pause();
}

/** dir > 0 = L（加速），dir < 0 = J（减速）。暂停时按下会从 1× / 0.5× 起播。 */
function stepRate(dir) {
  if (!state.src) return;
  const p = $('player');
  if (p.paused) { applyRate(dir > 0 ? 1 : 0.5); resumePlay(); return; }
  const i = RATES.findIndex((r) => r >= state.rate - 1e-6);
  const j = clamp((i < 0 ? RATES.indexOf(1) : i) + dir, 0, RATES.length - 1);
  if (j === i) { toast(dir > 0 ? '已经是最快的 8×' : '已经是最慢的 0.25×', 'warn'); return; }
  applyRate(RATES[j]);
}

/** 播放循环：跨过片段接缝时把 <video> 跳到下一段的源起点，到片尾就停。 */
function tick() {
  rafId = 0;
  if (!state.src) return;
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

function stepFrames(dir, count) {
  if (!state.src) return;
  $('player').pause();
  const fps = fpsOf(state.src.media);
  seekProgram(tl.currentProgramTime() + dir * (count || 1) / fps);
}

/** 跳到源时间轴上最近的上/下一个关键帧（还在成片上的才算）。 */
function stepKeyframe(dir) {
  if (!state.src) return;
  $('player').pause();
  const srcT = tl.progToSrc(tl.currentProgramTime());
  const kfs = (state.src.media.keyframes || []).filter((k) => tl.srcToProg(k) != null);
  const target = dir > 0 ? kfs.find((k) => k > srcT + 1 / 120) : kfs.slice().reverse().find((k) => k < srcT - 1 / 120);
  if (target == null) { toast('这一侧没有更近的关键帧了', 'warn'); return; }
  seekProgram(tl.srcToProg(target));
}

function stepClip(dir) {
  if (!state.src) return;
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


/** Backspace：删掉播放头所在的整段，后面自动并拢。 */
function deleteClipAtPlayhead() {
  if (!state.src) return;
  const i = tl.clipIndexAtProg(tl.currentProgramTime());
  if (i < 0) return;
  if (state.clips.length === 1) { toast('只剩一段，删掉就没东西可导出了', 'warn'); return; }
  const c = state.clips[i];
  state.clips.splice(i, 1);
  relayout();
  state.sel = clamp(i - 1, 0, state.clips.length - 1);
  pb.index = state.sel;
  pushHistory();
  syncTimeline();
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
    if (extra > 0.05) lines.push(`⚠ 吸附关键帧：会多带开头共 ${extra.toFixed(3)}s（切点对准 GOP 边界可避免，或勾「精确模式」）`);
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
    lines.push(`⚠ 源含 ${subTracks} 条字幕轨但不是可重排的文本字幕（只支持 SRT/ASS）：分段流拷贝会漏掉/串动字幕，导出会被自检拒绝。出路：让每个入点都落在 GOP 边界上（实测整段流拷贝的那一刀字幕一条不缺），或改选会省略这条字幕轨的容器、把字幕当外挂文件另行处理`);
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
}

function updateExportEnabled() {
  const secs = keptSeconds();
  const why = !state.src ? '先导入视频'
    : !(state.env && state.env.ok) ? '未找到可用的 ffmpeg'
      : state.scanning ? '正在 GOP 边界扫描，扫完才能确定哪些段能整段流拷贝'
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
  playPause: [' '], slower: ['j'], pause: ['k'], faster: ['l'],
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
  deleteClip: '删除整段素材', playPause: '播放 / 暂停', slower: '减速播放', pause: '暂停',
  faster: '加速播放', prevFrame: '上一帧', nextFrame: '下一帧',
  prevKeyframe: '上一个关键帧', nextKeyframe: '下一个关键帧',
  prevEdge: '上一个分割点', nextEdge: '下一个分割点',
  undo: '撤销', redo: '重做', zoomIn: '放大时间轴', zoomOut: '缩小时间轴', fit: '整条适应',
  toStart: '跳到片头', toEnd: '跳到片尾', cancelExport: '取消导出',
  importFile: '导入', exportNow: '导出', keysPanel: '打开本面板',
};

const KEY_ORDER = ['rippleBefore', 'split', 'rippleAfter', 'deleteClip', 'slower', 'pause', 'faster',
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
    case 'slower': return stepRate(-1);
    case 'pause': return pausePlayback();
    case 'faster': return stepRate(1);
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
  p.addEventListener('durationchange', onTimeUpdate);
  p.addEventListener('play', () => { $('btnPlay').textContent = '⏸'; if (!rafId) rafId = requestAnimationFrame(tick); });
  p.addEventListener('pause', () => {
    $('btnPlay').textContent = '▶';
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    applyRate(1);
    onTimeUpdate();
  });
  p.addEventListener('error', () => {
    if (!state.src) return;
    toast('预览器无法解码该视频（常见于 HEVC／AV1）。这只影响预览，导出不受影响：该拷的照拷，拷不动的只重编码入点那一小段。', 'warn');
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
    playSlower: () => stepRate(-1),
    playFaster: () => stepRate(1),
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
