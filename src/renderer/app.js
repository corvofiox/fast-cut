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
  src: null,            // 主源（第一份素材）——保留这个字段，几十处读它当"当前播放的源"
  /**
   * 全部素材（2026-10-18 追加导入）：
   * `[{ id, file, media }]`，`src` 恒等于 `sources[0]`。
   * 片段用 `srcIndex` 指向这里的某一项；播放/切割按片段所属源取文件与长度。
   */
  sources: [],
  clips: [],            // [{start,end,ps,pe,srcIndex?,group?}] 源时间 + 成片时间，顺序即时间顺序
  sel: -1,
  selSet: [],           // 多选（含 sel）：把几段"并成一次导出"时用
  groupSeq: 0,          // 分组号发号器（只增不减，撤销后复用也不会撞）
  rate: 1,              // 走带速率：正 = 正放，负 = 倒带（<video> 不接受负值，倒带走 seek 循环）
  plan: null,
  busy: false,
  scanning: false,
  snapKf: true,          // 播放头磁吸关键帧：开 = 拖刻度条时吸到最近关键帧（片段边界恒吸）
  thumbs: null,        // { dir, step, count } 时间轴胶片条
  cut: { index: 0, total: 1, ratio: 0 },
  outputs: [],
  /**
   * 确认框的接管点（自动化测试用）。null = 用原生 confirm。
   * 原生 confirm 是模态的，会把渲染进程卡住，自检脚本没法自己点"确定"。
   */
  confirmHook: null,
};

/**
 * 片段所属的源（多素材）：没有 srcIndex 时一律当主源。
 * 单素材时恒等于 `state.src`，行为与改造前完全一致。
 */
function srcOfClip(clip) {
  const i = Number(clip && clip.srcIndex);
  if (Number.isInteger(i) && i >= 0 && state.sources[i]) return state.sources[i];
  return state.src;
}

/** 成片时间 pt 处的源（播放器该播哪一份）。 */
function srcAtProgram(pt) {
  const list = state.sources || [];
  if (list.length <= 1) return state.src;
  const i = tl && tl.srcIndexAtProg ? tl.srcIndexAtProg(pt) : 0;
  return list[i] || state.src;
}

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
 * 片段序号 → 计划里的 keepIndex。
 *
 * 平时就是它自己；「多段合并导出」把同组相邻片段并成一条 keep 之后，
 * keeps 比 clips 短，必须用主进程给的 clipToKeep 映射，否则后面的片段全部错位
 * （实测第 3 段显示"待计划"：它去查 keepIndex=2，而计划里只有 0/1）。
 */
function keepIndexOf(clipIndex) {
  const map = state.plan && state.plan.clipToKeep;
  if (Array.isArray(map) && map.length > clipIndex && map[clipIndex] != null) return map[clipIndex];
  return clipIndex;
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
  // 时间轴按**片段序号**取这张表，所以把 keepIndex 换成片段序号。
  // 只映射"该 keep 的第一个片段"：多条片段并成一条 keep 时，只有第一条的起点是真正的
  // 导出起点；后面的片段若也拿到同一个起点，`start - 导出起点` 就是它们之间的整段长度，
  // 时间轴会画出一条假"多带"延伸块（实测精确模式下凭空多出 1 块 241px）。
  const out = {};
  const used = new Set();
  for (let i = 0; i < state.clips.length; i++) {
    const k = keepIndexOf(i);
    if (k == null || used.has(k) || map[k] == null) continue;
    used.add(k);
    out[i] = map[k];
  }
  return out;
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
  // 同上：界面按片段序号取，换过来
  const out = {};
  for (let i = 0; i < state.clips.length; i++) {
    const k = keepIndexOf(i);
    if (map[k] != null) out[i] = map[k];
  }
  return out;
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
      onSelect: (i, additive) => { selectClip(i, additive); },
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

/**
 * 需要用户点头的确认框。
 *
 * 抽成函数是为了让**自动化测试能接管**（`state.confirmHook`）：
 * 原生 `window.confirm` 是模态的，Electron 里会卡住整个渲染进程——
 * 自检脚本跑到"替换素材"那一步会永久停在这个对话框上（实测，
 * 表现为进程一直不退出、需要人工点确定）。测试把 hook 设成恒 true 即可。
 * 正常使用时 hook 为 null，行为与直接调用 `window.confirm` 完全一致。
 */
function askConfirm(message) {
  if (typeof state.confirmHook === 'function') return !!state.confirmHook(message);
  return window.confirm(message);
}

async function applySource(src) {
  const replacing = !!state.src && state.src.file !== src.file;
  if (replacing && state.clips.length > 1 &&
      !askConfirm('更换源文件会丢掉当前的分割与删除记录，继续？')) return;

  state.src = src;
  /**
   * 替换导入 = 从"只有这一份素材"重新开始（旧的多素材列表整个丢掉，上面的 confirm 已确认过）。
   *
   * **`state.sources[0]` 必须就是 `state.src` 这个对象本身**，不能另造一个。
   * `switchPlayerTo` 用对象身份判断"是否已经挂着这份素材"：如果这里是新造的
   * `{file, media}`，那么单素材时 `srcAtProgram()` 返回 `state.src`、`pc.src` 却是
   * `state.sources[0]`，两者永不相等 → 每次 seek 都重新加载 `<video>`，
   * 画面跟不上播放头（实测 smoke 报"<video> 停在 2.5s"、拖序也失效）。
   */
  state.sources = [src];
  src.id = '0';
  state.sel = 0;
  state.rate = 1;
  state.plan = null;
  state.outputs = [];
  state.scanning = !!src.scanning;
  state.thumbs = null;
  state.clips = [{ start: 0, end: round3(src.media.duration), ps: 0, pe: round3(src.media.duration), srcIndex: 0 }];
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
  syncSourcesToTimeline();
  /**
   * 绑定播放器文件时**必须同时更新 `pc.src` 账本**（2026-10-18）。
   * 直接写 `player.src` 而不记帐，会让 `switchPlayerTo` 以为"还挂在上一份素材"，
   * 于是下一次跨源时要么重复 reload、要么判定已经切过而实际没切——预览就错乱。
   */
  pc.src = state.sources[0];
  $('player').src = fileUrl(src.file);
  syncTimeline();
  pullThumbs(src.file);
  if (state.scanning) toast('已开始预览；正在后台扫描关键帧，长视频可能要等一会儿', 'warn');
}

/**
 * 把"全部素材"推进时间轴（2026-10-18）：关键帧合并表、最长时长、帧率。
 * 单素材时就等价于老的 `tl.setSource(media)`。
 */
function syncSourcesToTimeline() {
  const list = (state.sources || []).map((s, i) => ({
    srcIndex: i,
    duration: s.media?.duration || 0,
    fps: fpsOf(s.media || {}),
    keyframes: s.media?.keyframes || [],
  }));
  tl.setSources(list);
}

/**
 * 追加导入（2026-10-18）：把新素材接到现有轨道末尾，**不覆盖**已有片段。
 *
 * 做法：每份新素材在轨道末尾追加一条完整片段（源 0 → 源时长），
 * 片段带 `srcIndex` 指向新加的源。已有片段一律不动——这正是"追加"与"替换"的区别。
 * 若两份素材的参数不一致，导出时就必须选封装+编码（见 previewPlan 的 compat，
 * 界面会用红字拦），这里不提前拒绝：用户可能只是想先摆好顺序再决定参数。
 */
async function appendSources(files) {
  if (!files || !files.length) return;
  if (state.busy) { toast('导出进行中，请先等待或取消', 'warn'); return; }
  const results = await window.fc.appendFiles(files);
  const ok = results.filter((r) => !r.error);
  const bad = results.filter((r) => r.error);
  if (bad.length) {
    toast(`${bad.length} 份素材导入失败：${bad[0].error}`, 'warn', 6000);
  }
  if (!ok.length) return;

  /**
   * 第一份素材 + 已有片段 = 保持原样；后面每份追加一条片段。
   * 追加位置永远是"轨道末尾"（成片时间最后），符合"接着剪"的直觉。
   */
  for (const r of ok) {
    const media = r.media;
    if (!media || !media.video) continue;
    const localIndex = state.sources.length;
    state.sources.push({ id: String(localIndex), file: r.file, media });
    const dur = round3(media.duration);
    state.clips.push({ start: 0, end: dur, ps: 0, pe: dur, srcIndex: localIndex });
  }
  relayout();
  // 关键帧/时长/帧率要按"全部源"重建，否则磁吸与胶片条还停在第一份素材上
  syncSourcesToTimeline();
  state.plan = null;
  pushHistory();
  syncTimeline();
  const n = state.sources.length;
  toast(n > 1 ? `已追加 ${ok.length} 份素材（共 ${n} 份）` : `已追加 ${ok.length} 份素材`);
}

async function pickAndAppend() {
  const files = await window.fc.pickFile({ multiple: true });
  const list = Array.isArray(files) ? files : (files ? [files] : []);
  if (list.length) await appendSources(list);
}

/**
 * 认下这个源之后再主动要一次胶片条：主进程抽得早的话，推送会赶在
 * state.src 就位之前到达而被丢掉（换素材、走缓存的第二次导入尤其容易撞上）。
 */
function pullThumbs(file) {
  /**
   * 切源时**不要先清空**时间轴胶片（2026-10-18）。
   * 旧实现每次 `tl.setThumbs(null)`：跨源拖动时两边的胶片被反复清空再重铺，
   * 中间那几秒时间轴是空白/错位的——用户看到的就是"预览乱码"。
   * 现在优先用手头已缓存的那份直接铺上，没有才等新的。
   */
  const si = (state.sources || []).findIndex((s) => s.file === file);
  const cached = state.thumbsByFile && state.thumbsByFile[file];
  if (cached && si >= 0) {
    state.thumbs = cached;
    tl.setThumbs({ ...cached, srcIndex: si });
  }
  window.fc.getThumbs(file).then((payload) => applyThumbs(payload));
}

function applyThumbs(payload) {
  if (!payload) return;
  /**
   * 接受**任何已导入素材**的推送（多素材，2026-10-18）。
   *
   * 旧判据写死 `payload.file !== state.src.file`（`state.src` 永远是第一份素材），
   * 于是切到第二段之后，属于第二份素材的胶片推送被当成"过期数据"直接丢掉——
   * 时间轴胶片条一直停在前一份素材的画面上，看起来就是"预览错乱"。
   */
  const si = (state.sources || []).findIndex((s) => s.file === payload.file);
  if (si < 0) return;
  if (payload.error) { toast(`时间轴预览图生成失败：${payload.error}`, 'warn', 6000); return; }
  // 按文件记账：多素材时各有一份，切过去时立刻能铺上，不必重新抽
  state.thumbsByFile = state.thumbsByFile || {};
  state.thumbsByFile[payload.file] = payload;
  // 胶片按源区分：告诉时间轴"这套总览图属于第几个源"
  // （时间轴只给属于这个源的片段画它，绝不拿这份的图去画另一份素材的片段）
  tl.setThumbs({ ...payload, srcIndex: si });
  if (payload.file === activeFile()) state.thumbs = payload;
}

/**
 * 当前"正在看"的那份素材的文件路径（多素材）。
 *
 * 胶片条与动态抽帧都是**按源**推送的，校验基准不能写死第一份素材。
 */
function activeFile() {
  const s = (tl ? srcAtProgram(tl.currentProgramTime()) : null) || state.src;
  return s ? s.file : null;
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
    /**
     * 多素材（2026-10-18）：可见区域里可能同时有**多份素材**的片段，
     * 每份都要抽自己那一档的格子。旧实现只按 `state.src.file`（第一份）要帧，
     * 于是第二段的画面只能拿第一份素材的格子顶上——这就是"乱码"的直接来源。
     */
    const seen = new Set();
    for (const si of visibleSourceIndices()) {
      const s = state.sources[si];
      if (!s || seen.has(s.file)) continue;
      seen.add(s.file);
      window.fc.requestFilm({ file: s.file, ...want, srcIndex: si });
    }
  }, 160);
}

/** 视口里可见片段涉及哪些源（主源永远排在最前，保持既有行为）。 */
function visibleSourceIndices() {
  const out = [];
  const push = (i) => { if (!out.includes(i)) out.push(i); };
  push(0);
  try {
    const v = tl.view();
    for (const c of state.clips) {
      if (c.pe < v.t0 - 0.001 || c.ps > v.t1 + 0.001) continue;
      push(srcIndexOf(c));
    }
  } catch { /* 时间轴还没就绪，只抽主源 */ }
  return out;
}

function applyFilm(payload) {
  if (!payload) return;
  const si = Number.isInteger(payload.srcIndex)
    ? payload.srcIndex
    : (state.sources || []).findIndex((s) => s.file === payload.file);
  if (si < 0) return;
  if (payload.error) {
    // 同一份素材的抽帧失败只提示一次，避免跨源拖动时刷屏
    toast(`这一档预览图抽失败了：${payload.error}`, 'warn', 6000);
    return;
  }
  tl.setLevel({ ...payload, srcIndex: si });
}

/** 后台扫描回包：补上关键帧刻度，并放开导出。 */
function onScanResult(payload) {
  // 多素材：回包可能属于任一份素材，按文件找到它，而不是只认第一份
  const which = (state.sources || []).find((s) => s.file === payload.file);
  if (!which) return;
  /**
   * `state.scanning` 只反映"**主源**还没扫完"（2026-10-18）。
   *
   * 旧代码里它就是"当前这份素材是否在扫"。多素材改造时我一度改成"任一份缺关键帧
   * 就算在扫"，于是追加一份素材后即使主源已扫完也会被重新置为 true，
   * 导出按钮被一直禁用（实测 smoke 报"导入后即可导出且预估正确 ✗"）。
   * 追加源的扫描由 `appendSources` 自己按需处理（时长已知即可预览），不该挡住主源导出。
   */
  if (which === state.src) state.scanning = false;
  if (!payload.ok) {
    showError(`关键帧扫描失败：${payload.message}`);
    toast('关键帧扫描失败：无法判断哪些段能整段流拷贝，导出会把每段都重编码', 'warn');
    updateExportEnabled();
    return;
  }
  which.media.keyframes = payload.keyframes;
  which.media.lastKeyframe = payload.lastKeyframe;
  if (payload.duration) which.media.duration = payload.duration;
  // 关键帧刻度是"所有源合并"的，必须整体重建（只刷某一源会让别的源刻度消失）
  syncSourcesToTimeline();
  updateInfo();
  syncTimeline();
  const headN = countCost('head');
  toast(`关键帧扫描完成：${baseName(payload.file)} ${payload.keyframes.length} 个（其中 ${headN} 段需重编码入点）；用时 ${(payload.ms / 1000).toFixed(2)} 秒`);
  updateExportEnabled();
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
  /**
   * 多素材：播放头跨到另一份素材上时，必须先把 <video> 切到那个文件再 seek。
   *
   * **不能在这里直接写 `pc.src = want`**（2026-10-18 修）：`pc.src` 记录的是
   * "播放器实际挂着的文件"，只有 `switchPlayerTo` 真换了 `video.src` 才该更新它。
   * 之前那一行是手误——它把记录改成"已经是新源"，于是下一次切到同一源时
   * `switchPlayerTo` 判定"已经切过"直接返回，`video.src` 却还停在旧文件上：
   * 预览拿旧文件的时间基对着新源的时刻播，画面就糊成几秒乱码。
   */
  const want = srcAtProgram(clamped);
  const switched = switchPlayerTo(want);
  // 刚换过文件时 <video> 还没加载完，立刻写 currentTime 会被丢弃，
  // 所以等元数据就绪再定位（与 tick 里跨源处理同一套做法）。
  if (switched) {
    queueSeekAfterLoad(clamped, srcT, want);
  } else {
    $('player').currentTime = clamp(srcT, 0, (want?.media?.duration) || 0);
  }
  tl.setProgramTime(clamped);
  lastSnap = null;        // 键盘 / 按钮移动播放头，谈不上磁吸
  onTimeUpdate();
}

/**
 * 换过 `<video src>` 之后，等媒体元数据就绪再写 currentTime。
 *
 * 直接写会丢：浏览器要先解析新文件头，`readyState` 到 1 之前 `currentTime` 的赋值
 * 可能被忽略或立刻被重置到 0 —— 用户看到的就是"跳回片头"或"画面不动"。
 * 用 `loadedmetadata` 一次性回调；同时兜一个超时，避免文件异常时永远不等。
 */
function queueSeekAfterLoad(progT, srcT, src) {
  const p = $('player');
  const put = () => {
    try {
      p.currentTime = clamp(srcT, 0, (src?.media?.duration) || 0);
    } catch { /* 元数据还没到时忽略，下一次 seek 会补上 */ }
  };
  if (p.readyState >= 1) { put(); return; }
  p.addEventListener('loadedmetadata', put, { once: true });
  // 兜底：某些容器（或已被缓存的短片段）可能不触发 loadedmetadata
  clearTimeout(pc.seekTimer);
  pc.seekTimer = setTimeout(put, 1200);
}

/**
 * 播放器当前挂的是哪一份素材（多素材切换用）。
 *
 * `<video>` 一次只能播一个文件，而时间轴是"多份素材首尾相接"的成片时间轴。
 * 所以播放头跨源时必须换 `src` —— 换完要重新 seek 到该源内的时刻。
 * 单素材时 `pc.src === state.src` 恒成立，这段就完全不动作。
 *
 * **`pc.src` 只在真正改了 `video.src` 时才更新**。它是"播放器实际挂着什么"的账本，
 * 任何人绕过 `switchPlayerTo` 去写它，都会让下一次判断失真（切源失效 → 乱码）。
 */
const pc = { src: null, seekTimer: 0 };

/** 把播放器切到某个源（同一份就什么都不做，避免 reload 打断播放）。 */
function switchPlayerTo(src) {
  if (!src || pc.src === src) return false;
  const p = $('player');
  p.src = fileUrl(src.file);
  pc.src = src;
  // 胶片条也跟着当前源走（时间轴每段按自己的源抽帧）
  pullThumbs(src.file);
  return true;
}

function seekSource(srcT) {
  const pt = tl.srcToProg(srcT);
  seekProgram(pt == null ? 0 : pt);
}

function onScrub(srcT, progT, snap) {
  if (!state.src) return;
  // 手动拖播放头 = 接管：倒带循环还在跑的话会跟手指抢位置，先掐掉
  if (state.rate < 0) haltPlayback();
  // 拖到别的素材上时先换文件，再按该源内的时刻定位
  const want = srcAtProgram(progT);
  const switched = switchPlayerTo(want);
  if (switched) queueSeekAfterLoad(progT, srcT, want);
  else $('player').currentTime = clamp(srcT, 0, (want?.media?.duration) || 0);
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
  // 帧号按**播放头所在那份素材**的帧率折算：多素材可能帧率不同（30 与 24 混剪）
  const at = state.src ? (srcAtProgram(pt) || state.src) : null;
  const fps = at ? fpsOf(at.media) : 30;
  $('frameNo').textContent = at ? `帧 ${Math.round(srcT * fps)}` : '帧 --';
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
  // 帧率取**这一段所属源**的：多素材混剪时各源帧率可能不同（容差按谁算都行，但不能恒用主源）
  const fps = fpsOf((srcOfClip(c) || {}).media || state.src.media);
  const slack = (0.5 / fps) * Math.max(1, state.rate);     // 倍速下一帧跨度更大，容差跟着放大
  if (p.currentTime >= c.end - slack) {
    const next = state.clips[pb.index + 1];
    if (!next) { p.currentTime = c.end; p.pause(); onTimeUpdate(); return; }
    pb.index += 1;
    /**
     * 跨到下一段时，如果它属于**另一个源**，必须先换 <video> 的 src 再 seek。
     * 不做这一步，播放器会拿上一份素材的画面去对下一段的源时刻——跨素材拼接时
     * 那条时间轴完全对不上（实测会一直停在第一个源的画面）。
     */
    const want = srcOfClip(next);
    if (switchPlayerTo(want)) {
      // 换 src 是异步加载：等元数据就绪后再 seek，否则 currentTime 会被立刻忽略
      queueSeekAfterLoad(next.ps, next.start + 0.5 / fps, want);
      onTimeUpdate();
      if (!p.paused) rafId = requestAnimationFrame(tick);
      return;
    }
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

// ---------------------------------------------------------------- 选择与分组

/**
 * 点选/多选片段。
 *
 * - 普通单击：单选，清空多选
 * - Ctrl/⌘ 单击：加选/减选（把几段并成一次导出就靠它）
 * - Shift 单击：从当前段扩选到目标段（连续几段一次选完）
 */
function selectClip(i, additive) {
  if (i < 0 || i >= state.clips.length) return;
  if (!additive) {
    state.sel = i;
    state.selSet = [i];
  } else {
    const set = new Set(state.selSet.length ? state.selSet : (state.sel >= 0 ? [state.sel] : []));
    if (set.has(i)) {
      // 再点一次取消。至少留一段被选，否则界面会出现"没选中任何段"的空状态
      if (set.size > 1) set.delete(i);
    } else {
      set.add(i);
    }
    state.selSet = [...set].sort((a, b) => a - b);
    state.sel = i;
  }
  tl.setSelection(state.selSet, state.sel);
  renderClips();
}

/** 当前选中的片段序号（升序）。永远至少含 `state.sel`。 */
function selectedIndices() {
  const list = state.selSet.length ? state.selSet.slice() : (state.sel >= 0 ? [state.sel] : []);
  return list.filter((i) => i >= 0 && i < state.clips.length).sort((a, b) => a - b);
}

/**
 * 把选中的几段"并成一次导出"（或拆开）。
 *
 * 机制：给这些片段打同一个 `group` 号，导出时它们共享一个输出分组 ——
 * concat 之后只写一个文件，这就是用户要的"多段合并成一段导出"。
 * 拆开 = 清掉 group（回到"每段一个文件"）。
 */
function mergeSelected() {
  const idx = selectedIndices();
  if (idx.length < 2) { toast('先按住 Ctrl 点选至少两段，再合并成一段导出', 'warn'); return; }
  // 分组号取这些片段里已有的最大号 +1，避免和别的组撞号
  const gid = ++state.groupSeq;
  for (const i of idx) state.clips[i].group = gid;
  pushHistory();
  syncTimeline();
  toast(`已把 ${idx.length} 段并成一组：导出时会拼进同一个文件`);
}

/** 拆开选中片段所在的分组（清掉 group）。 */
function unmergeSelected() {
  const idx = selectedIndices();
  const groups = new Set(idx.map((i) => state.clips[i].group).filter((g) => g != null));
  if (!groups.size) { toast('选中的片段没有并入任何分组', 'warn'); return; }
  for (const c of state.clips) if (c.group != null && groups.has(c.group)) delete c.group;
  pushHistory();
  syncTimeline();
  toast('已拆开分组：这几段重新各出一个文件');
}

// ---------------------------------------------------------------- 撤销 / 重做

function snapshot() {
  // group / srcIndex 都要进快照：分组是用户的一次编辑动作，srcIndex 是多素材的来源标记
  // （丢了它，撤销后那几段会被当成主源素材，切出完全不相干的内容）
  return state.clips.map((c) => {
    const one = { start: c.start, end: c.end };
    if (c.group != null) one.group = c.group;
    if (Number.isInteger(c.srcIndex)) one.srcIndex = c.srcIndex;
    return one;
  });
}

/** 片段所属源的序号（缺省 0 = 主源）。界面各处取源信息都走它，避免到处 `?? 0`。 */
function srcIndexOf(clip) {
  const i = Number(clip && clip.srcIndex);
  return Number.isInteger(i) && i >= 0 && state.sources[i] ? i : 0;
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
  state.selSet = state.sel >= 0 ? [state.sel] : [];
  pb.index = state.sel;
  syncTimeline();
  toast(label === '撤销' ? '已撤销' : '已重做');
}

// ---------------------------------------------------------------- 面板

function syncTimeline(withPlan = true) {
  tl.setClips(state.clips, state.sel, snapMap());
  tl.setSelection(selectedIndices(), state.sel);
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

/**
 * 把片段转成主进程要的 segments（`srcIndex` 与 `group` 都必须带上）。
 * 少带 srcIndex 的后果不是报错，而是"按主源切出另一份素材"——必须统一从这里出。
 *
 * 没有 srcIndex 的片段按**主源（0）**补齐：早期版本创建的片段（或撤销回很旧的状态）
 * 不带这个字段，缺省成 0 与"它就是第一份素材"完全等价，但显式写出来能让
 * 主进程/计划层始终拿到完整信息，不必到处 `?? 0`。
 */
function segmentsPayload() {
  return state.clips.map((c) => {
    const one = { start: c.start, end: c.end };
    if (c.group != null) one.group = c.group;
    one.srcIndex = Number.isInteger(c.srcIndex) && state.sources[c.srcIndex] ? c.srcIndex : 0;
    return one;
  });
}

/** 全部素材的路径（主进程据此解析源数组；单素材时就是一项）。 */
function sourceFiles() {
  return (state.sources && state.sources.length ? state.sources : []).map((s) => s.file);
}

/**
 * 多素材参数不一致时，把"必须选封装与编码"这件事说清楚（2026-10-18）。
 *
 * 用户定的是：参数不一致 → 拒绝导出、在**对应项上标红字**，让他知道要选什么。
 * 所以这里既写面板上的提示条，也给两行加红框；选好编码后由 updateCodecHint 清掉。
 */
function showCodecRequired(compat) {
  const box = $('codecHint');
  if (!box) return;
  const diffs = (compat.diffs || []).map((d) => `${d.label} ${d.values.map((v) => v.value).join(' / ')}`).join('；');
  box.innerHTML = '';
  const line1 = document.createElement('div');
  line1.className = 'note-strong';
  line1.textContent = '这些素材的参数不一致，无法直接流拷贝拼接，请选择封装与编码格式';
  const line2 = document.createElement('div');
  line2.textContent = diffs;
  const line3 = document.createElement('div');
  const base = compat.baseline;
  line3.textContent = base
    ? `其余参数将统一到 ${base.width}×${base.height} @ ${base.fps}fps（基准取自参数最强的那份素材）`
    : '';
  box.append(line1, line2, line3);
  box.classList.remove('hidden');
  $('rowCodec')?.classList.add('need');
  $('rowContainer')?.classList.add('need');
}

/** 参数一致 / 已选编码时清掉红字与提示。 */
function updateCodecHint() {
  const box = $('codecHint');
  const compat = state.plan && state.plan.compat;
  const chosen = $('outCodec') ? $('outCodec').value : '';
  if (!box) return;
  if (!compat || compat.uniform) {
    // 参数一致：跟随源可用，这一行只是提示"可以零损失"
    if (compat && compat.uniform && state.sources.length > 1) {
      box.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'note-soft';
      d.textContent = `素材参数一致（${compat.baseline?.width}×${compat.baseline?.height} @ ${compat.baseline?.fps}fps）——「跟随源」可全程流拷贝，零损失`;
      box.appendChild(d);
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
    $('rowCodec')?.classList.remove('need');
    $('rowContainer')?.classList.remove('need');
    return;
  }
  if (!chosen) { showCodecRequired(compat); return; }
  // 已选编码：说明哪些段会被重编码（有损，必须让用户知道）
  const reN = (compat.perSource || []).filter((p) => p.reencode).length;
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'note-soft';
  const base = compat.baseline || {};
  d.textContent = reN
    ? `${reN} 份素材参数与其它不一致，导出时整段重编码为 ${chosen}（有损），统一到 ${base.width}×${base.height} @ ${base.fps}fps`
    : `将统一编码为 ${chosen}（所有素材都需重编码）`;
  box.appendChild(d);
  box.classList.remove('hidden');
  $('rowCodec')?.classList.remove('need');
  $('rowContainer')?.classList.remove('need');
}

let planSeq = 0;              // 计划请求代序：勾选切模式时防旧响应覆盖新计划（乱序完成时后者胜）
async function runPlan() {
  if (!state.src || !state.clips.length) return;
  const seq = ++planSeq;
  try {
    const plan = await window.fc.previewPlan({
      files: sourceFiles(),
      segments: segmentsPayload(),
      container: containerChoice(),
      // 多素材参数不一致时用户必须选编码；没选就发空，主进程会回 needsCodec=true
      codec: $('outCodec') ? $('outCodec').value || '' : '',
      precise: isPreciseMode(),
      split: $('optSplit').checked,
    });
    if (seq !== planSeq) return;   // 已有更新的请求在路上，这份过期了
    state.plan = plan;
  } catch (err) {
    showError(cleanErr(err));
    return;
  }
  // 新计划必须推进时间轴：snapMap 变了（吸附差/自动降级角标都随模式变），
  // 只刷列表 DOM 的话 tl 的 snapInfo 还是旧计划的——多带可视化与角标全踩旧数据。
  // **不清 lastSnap**（2026-10-17 修）：计划刷新是异步的（previewPlan IPC + 120ms
  // 防抖），它完成的时机可能落在用户拖放**之后**——把刚显示的"磁吸·分割点"抹掉，
  // HUD 凭空变空（smoke"磁吸关掉后片段边界仍然吸附"正是这么被打赢竞态的）。
  // HUD 语义是"最近一次拖放的磁吸结果"，与切割计划刷新无关，保住它。
  tl.setClips(state.clips, state.sel, snapMap());
  tl.setSelection(selectedIndices(), state.sel);
  // 输出的"第几个文件"必须来自真实计划（组号 ≠ 文件号，见 fileNoOfGroup）
  tl.setGroupFileNos(state.plan && state.plan.fileNoOfGroup);
  renderClips();
  // 多素材兼容性提示（参数不一致 → 红字要求选封装与编码）
  updateCodecHint();
  updateEstimate();
  updateExportEnabled();
  updateToolButtons();
  updateHud();
}

/** 导出模态的「精确模式」勾选：默认不勾 = 吸附关键帧整段流拷贝。 */
function isPreciseMode() {
  const box = $('optPrecise');
  return box ? box.checked : true;
}

function renderClips() {
  const ul = $('keepList');
  ul.innerHTML = '';
  const groupNo = groupNumbers();
  const selNow = selectedIndices();
  const multi = selNow.length > 1;
  state.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = (i === state.sel ? 'sel' : '') + (multi && selNow.includes(i) ? ' multi' : '');
    // 组别：用颜色 + 徽章两套编码（只靠文字在长列表里要一行行读，太慢）
    const gno = c.group == null ? null : groupNo.get(c.group);
    if (gno != null) {
      li.classList.add('grp');
      li.style.setProperty('--grp', window.groupColorOf(gno));
      li.style.setProperty('--grp-tint', window.groupTintOf(gno, 0.1));
      li.dataset.group = String(c.group);
    }
    // 组内第一行加个"顶部分隔"：两组相邻时，光看颜色若刚好相近就不够，再来一道结构分隔
    const prev = state.clips[i - 1];
    if (gno != null && (!prev || prev.group !== c.group)) li.classList.add('grp-start');
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    /**
     * 一行只放**起点**（2026-10-18 用户反馈"文本太多"，且代价标签被面板右缘裁掉）。
     *
     * 旧写法 `00:00.000 → 00:01.267  1.267s` 把起点、终点、时长全写出了，
     * 而"终点 = 起点 + 时长"是冗余信息——右栏本来就不宽，这三分之一宽度直接导致
     * 最右边的代价标签被裁。现在只留起点 + 时长，终点进悬停提示。
     */
    const time = document.createElement('span');
    time.className = 'tc';
    time.textContent = tcShort(c.ps);
    const len = document.createElement('span');
    len.className = 'len tc';
    len.textContent = `${(c.end - c.start).toFixed(3)}s`;
    const rowTitle = `第 ${i + 1} 段\n成片 ${tcShort(c.ps)} → ${tcShort(c.pe)}\n源 ${tcShort(c.start)} → ${tcShort(c.end)}（${(c.end - c.start).toFixed(3)}s）`;
    // 组徽章单独一列（不是塞进说明文字里）：扫一眼就能数清"这组几段、是第几个文件"
    const badge = document.createElement('span');
    badge.className = 'gchip';
    if (gno != null) {
      badge.textContent = `组${gno}`;
      badge.style.color = window.groupColorOf(gno);
      badge.style.borderColor = window.groupTintOf(gno, 0.55);
      const fn = fileNoOfGroup(c.group);
      badge.title = `这 ${groupSizes().get(c.group) || 1} 段会拼进第 ${fn} 个文件`;
    } else {
      badge.textContent = '';
      badge.classList.add('none');
    }
    li.append(idx, time, len, badge);
    const cost = costMap()[i];
    /**
     * 代价做成第一行末尾的一个小标签（2026-10-18 用户反馈"文本太多"）。
     *
     * 旧写法第二行整行写 `源 00:26:58.607–00:29:53.485 · 入点小段重编码`——第一行已经写了
     * 成片区间，第二行再把源区间抄一遍，11 段就是 22 行时间码，真正要一眼扫到的
     * "这段要不要重编码"反而被埋了。现在：源区间进悬停提示，代价压缩成一个短标签。
     * 颜色沿用既有语义（纯拷贝=绿、有损=橙），不新增要学的颜色。
     */
    const lossy = cost && cost !== 'copy';
    const chip = document.createElement('span');
    chip.className = 'cost' + (lossy ? ' lossy' : '') + (cost ? '' : ' pending');
    chip.textContent = { copy: '纯拷贝', head: '入点重编码', whole: '整段重编码', codec: '换编码' }[cost] || '待计划';
    const costFull = {
      copy: '整段流拷贝（不转码）',
      head: '入点那一小段有损重编码，其余仍流拷贝',
      whole: '这一整段在同一个 GOP 内：有损重编码',
      codec: '整段重编码并更换编码格式',
    }[cost] || '计划还没算出来';
    chip.title = `${rowTitle}\n源 ${tcShort(c.start)}–${tcShort(c.end)} · ${costFull}`;
    li.append(chip);
    li.title = chip.title;

    li.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) { selectClip(i, true); return; }
      state.sel = i;
      state.selSet = [i];
      tl.setSelected(i);
      tl.setSelection(state.selSet, i);
      seekProgram(c.ps);
      renderClips();
    });
    ul.appendChild(li);
  });
  $('keepCount').textContent = String(state.clips.length);
  $('keepTotal').textContent = `合计 ${keptSeconds().toFixed(3)} s`;
  // 分组工具条：多选时才能合并；有分组时才能拆开
  const nSel = selNow.length;
  const anyGroup = state.clips.some((c) => c.group != null);
  const btnMerge = $('btnMergeGroup');
  const btnUnmerge = $('btnUnmergeGroup');
  if (btnMerge) {
    btnMerge.disabled = nSel < 2;
    btnMerge.title = nSel < 2
      ? '按住 Ctrl 点选至少两段，就能把这几段并成一次导出'
      : `把选中的 ${nSel} 段并成一次导出（拼进同一个文件）`;
  }
  if (btnUnmerge) {
    btnUnmerge.disabled = !anyGroup;
    btnUnmerge.title = anyGroup ? '拆开选中片段所在的分组' : '当前没有合并的分组';
  }
  const hints = $('planHints');
  hints.innerHTML = '';
  const planWarns = (state.plan && state.plan.warnings) || [];
  if (planWarns.length) {
    // 与导出完成后的警告框同一套渲染：条目多时可折叠，别让 8 条同因长句铺成一面墙
    const box = document.createElement('div');
    box.className = 'hint-warns';
    showWarnings(box, planWarns);
    hints.appendChild(box);
  }
  // 有分组时把"哪几段拼进同一个文件"直接写出来：分组是用户自己做的编辑，
  // 但导出前必须能一眼核对（分组跨了很远的两段时尤其容易记错）。
  // 每一组带自己的颜色小方块，和上面的徽章、时间轴的描边对得上。
  if (groupNo.size) {
    const wrap = document.createElement('div');
    wrap.className = 'hint-group';
    const sizes = groupSizes();
    for (const [gid, no] of groupNo) {
      const idx = state.clips.map((c, i) => (c.group === gid ? i + 1 : 0)).filter(Boolean);
      const row = document.createElement('div');
      row.className = 'hint-grow';
      const dot = document.createElement('i');
      dot.className = 'gdot';
      dot.style.background = window.groupColorOf(no);
      const txt = document.createElement('span');
      txt.textContent = `组${no} · 第 ${fileNoOfGroup(gid)} 个文件 ← 第 ${idx.join('、')} 段（${sizes.get(gid) || 1} 段）`;
      row.append(dot, txt);
      wrap.appendChild(row);
    }
    hints.appendChild(wrap);
  }
}

/** 分组 id → 显示序号（1 起，按首次出现顺序），与时间轴上的"组N"一致。 */
function groupNumbers() {
  const map = new Map();
  let n = 0;
  for (const c of state.clips) {
    if (c.group == null || map.has(c.group)) continue;
    map.set(c.group, ++n);
  }
  return map;
}

/** 分组 id → 段数（右侧徽章与提示里要写"这组几段"）。 */
function groupSizes() {
  const map = new Map();
  for (const c of state.clips) {
    if (c.group == null) continue;
    map.set(c.group, (map.get(c.group) || 0) + 1);
  }
  return map;
}

/**
 * 分组 id → 它落在**第几个输出文件**。
 *
 * 必须用计划里算出来的真实序号，不能用组号：组号只是"第几次合并"，
 * 实测 6 段、1+2 一组、4+5 一组时，实际文件是
 * `文件1←组1 / 文件2←第3段 / 文件3←组2 / 文件4←第6段`——组2 是第 **3** 个文件。
 * 写"组2 · 第 2 个文件"会让用户按提示去找一个不存在的文件。
 * 计划还没回来时（无映射）退回组号，至少不会显示成空。
 */
function fileNoOfGroup(gid) {
  const map = state.plan && state.plan.fileNoOfGroup;
  if (map && map[gid] != null) return map[gid];
  const own = groupNumbers().get(gid);
  return own == null ? '?' : own;
}

/** 预估行是 innerHTML 拼的，凡是来自文件元数据/主进程的字样都先过这一道。 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/** 「每段一个文件」会写出几个文件 = 分组数（计划还没回来时按片段自身的 group 数）。 */
function outputFileCount() {
  if (state.plan && Number.isInteger(state.plan.groups)) return state.plan.groups;
  const seen = new Set();
  let n = 0;
  state.clips.forEach((c, i) => {
    // 未分组的段各占一个文件，键必须带序号，否则两段会被当成同一个
    const key = c.group == null ? `k${i}` : `g${c.group}`;
    if (seen.has(key)) return;
    seen.add(key);
    n++;
  });
  return n;
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
    `<b>${split ? outputFileCount() : 1} 个文件</b> · 成片 <b>${tc(estSecs)}</b> · <b>${fmtBytes(bytes)}</b>`,
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
  const segments = segmentsPayload();
  if (!segments.length) return;

  /**
   * 导出前的最后一道拦截（2026-10-18）。
   *
   * 多素材参数不一致却没选编码 → 直接拒绝，不把注定失败的导出送进主进程。
   * 主进程里还有一层同样的检查（防脚本调用绕过界面），这里是为了给用户
   * 一个**当场可见**的红字，而不是等到点完导出才弹错误。
   */
  const compat = state.plan && state.plan.compat;
  if (compat && !compat.uniform && !$('outCodec').value) {
    showCodecRequired(compat);
    $('outCodec').focus();
    return;
  }

  const payload = {
    files: sourceFiles(),
    segments,
    codec: $('outCodec') ? $('outCodec').value || '' : '',
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
      showWarnings($('warnings'), warnList);
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

/**
 * 警告的渲染（2026-10-18 改）：不再是一坨文字，改为**可折叠的条目**。
 *
 * 起因：用户切 11 段，其中 8 段同因，旧写法把 8 条近乎相同的长句直接铺开，读起来是一堵墙。
 * 内核已把同因聚合成一条（见 cuttings.warnOnce），这里再补两件事：
 *  1. 条目多了才折叠（>3 条），默认只露一行，点一下展开全文——想细看时不挡路；
 *  2. 每条带一个"⚠"标记并各自成行，段号 `（第 3、5、7 段）` 自然落在同一行。
 * 警告本来就不多时（≤3 条）不折叠：免得为看一句话还要点两下。
 */
function showWarnings(box, list) {
  box.innerHTML = '';
  const collapse = list.length > 3;
  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'wrow' + (collapse ? ' clipped' : '');
    const mark = document.createElement('span');
    mark.className = 'wmark';
    mark.textContent = '⚠';
    const txt = document.createElement('span');
    txt.className = 'wtxt';
    txt.textContent = w;
    row.append(mark, txt);
    if (collapse) {
      row.title = '点击展开/收起全文';
      row.addEventListener('click', () => row.classList.toggle('clipped'));
    }
    box.appendChild(row);
  }
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
  importFile: ['ctrl+o'], appendFiles: ['ctrl+shift+o'], exportNow: ['ctrl+e'], keysPanel: ['shift+?'],
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
  importFile: '导入', appendFiles: '追加导入', exportNow: '导出', keysPanel: '打开本面板',
};

const KEY_ORDER = ['rippleBefore', 'split', 'rippleAfter', 'deleteClip', 'rewind', 'slowRewind', 'pause', 'faster', 'slowFaster',
  'playPause', 'prevFrame', 'nextFrame', 'prevKeyframe', 'nextKeyframe', 'prevEdge', 'nextEdge',
  'undo', 'redo', 'zoomIn', 'zoomOut', 'fit', 'toStart', 'toEnd', 'cancelExport', 'importFile', 'appendFiles', 'exportNow'];

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
    case 'appendFiles': return pickAndAppend();
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
  // 追加导入：不动现有片段，把新素材接到轨道末尾（2026-10-18）
  $('btnImportAppend')?.addEventListener('click', async () => {
    popShow('importMask', false);
    await pickAndAppend();
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
  $('btnMergeGroup').addEventListener('click', mergeSelected);
  $('btnUnmergeGroup').addEventListener('click', unmergeSelected);
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
  // 换编码会改变"哪些源需要重编码"，必须重算计划（代价标签、估时、红字都跟着变）
  $('outCodec')?.addEventListener('change', () => { refreshPlan(); });

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
  // 多素材（追加导入）：smoke 与联调脚本用它把第二份素材并进轨道
  appendSources,
  pickAndAppend,
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
  // 分组（多段合并导出）与重排：smoke 用它把几段并成一组再验导出文件数
  relayout,
  syncTimeline,
  selectClip,
  mergeSelected,
  unmergeSelected,
  selectedIndices,
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
