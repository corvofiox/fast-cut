'use strict';

/**
 * 时间轴组件：**节目（成片）时间**。
 *
 * 片段（clip）首尾相接铺在车道上，删掉一段后面自动并拢，刻度显示的是成片时间而不是源时间。
 * 因此所有指针位置都要在"成片时间 ↔ 源时间"之间换算，映射表由上层传进来（clips 带 ps/pe）。
 *
 * 交互（刻意不做任何"拖一下就删除"）：
 *  - 顶部刻度条（0–22px）= 唯一能移动播放头的地方，整条都能按下拖，带磁吸（片段边界、关键帧）
 *  - 胶片上按下拖动 = 改这段素材的顺序；单击只选中，都不动播放头
 *  - 拖片段之间的分割线 = 调整切点；双击分割线 = 合并
 *  - 平移视图 = 滚轮 或 底部滑块（刻度条已经让给播放头，不再兼作平移）
 */

(function () {
'use strict';

const RULER_H = 22;               // 顶部一条：时间刻度与播放头手柄同槽（效仿剪映）
const LANE_TOP = RULER_H + 2;
const LANE_H = 48;
const RULER_GAP = 14;             // 两个刻度标签之间最少留这么多像素
const KNOB_HALF = 6.5;            // 胶囊半宽：正好是 13px 的一半，中心才压得在线上
const PAD = 8;                    // 绘图区两端各收这么多像素，见下面 tToX 的注释
const SNAP_PX = 8;
const DRAG_MIN = 4;               // 超过这个位移才算"拖"，否则算单击选中
const FILM_CELL = 85;             // 胶片一格的理想宽度：48px 车道按 16:9 铺满正好这么多
const FILM_ROWS = 4;              // 最多同时记住几个缩放层级，来回拉缩放也不至于攒爆内存
const EPS = 1e-6;

function createTimeline(options) {
  const { root, canvas, lane, playheadEl, callbacks } = options;
  const scrollEl = options.scrollEl;      // 底部滚动条轨道
  const thumbEl = options.thumbEl;        // 滚动条滑块
  const bubbleEl = playheadEl ? playheadEl.querySelector('.ph-bubble') : null;
  const knobEl = playheadEl ? playheadEl.querySelector('.knob') : null;
  const cb = callbacks || {};
  const ctx = canvas.getContext('2d');

  const view = { t0: 0, t1: 1 };
  let srcDuration = 1;
  let total = 1;                  // 成片总时长
  let keyframes = [];             // 源时间
  let clips = [];                 // [{start,end,ps,pe}]
  let selected = -1;
  let selSet = [];                 // 多选集合（含 selected）：把几段并成一次导出时用
  let programTime = 0;
  let drag = null;
  let pointer = { x: 0 };
  let minSpan = 0.5;
  let snapInfo = null;
  let fitted = false;              // 内容第一次进来时把视口对齐到成片总长
  let thumbs = null;               // 导入时整片抽的那一遍：{ dir, step, count, height }
  let thumbImgs = [];              // 与 thumbs.count 同序的 Image，加载完才画
  let fps = 30;                    // 抽帧间隔不能细于一帧
  let snapKeyframes = true;        // 关键帧磁吸开关：false = 只吸片段边界（播放头自由走）
  let levels = new Map();          // step -> { step, dir, imgs: Map<格号, Image> }，按缩放动态抽的层级
  let filmSig = '';                // 上一次向主进程要的是哪一档，避免自问自答
  let filmDrawn = 0;               // 最近一次 render 实际画了几格，给自检用
  let snapExtraInfo = { count: 0, px: 0 };   // 最近一次画的多带延伸块：块数与总宽，给自检用
  let renderSeq = 0;               // render 计数：自检等"新计划已渲染"用
  let filmStats = { step: null, cells: 0, minCell: 0, maxCell: 0, maxScale: 0 };
  let rulerInfo = { step: 0, labels: [] };   // 最近一次刻度尺画了什么，给自检用
  let reorder = null;              // { from, to } 正在拖哪一段、要插到哪
  let groupOrder = new Map();      // 分组 id → 显示序号（1 起，按首次出现编）

  // ---------- 时间换算 ----------
  const width = () => root.clientWidth || 1;
  /**
   * 绘图区两端各收 PAD 像素，胶片、刻度、片段块、播放头一起往里挪。
   * 目的是让胶囊在手柄还没走到片头片尾时就先顶到边缘：以前手柄被 overflow 裁掉一半，
   * 只能把胶囊夹回来而线留在原位，于是贴边那一下线和手柄分家，看着像坏了。
   */
  const plotW = () => Math.max(1, width() - PAD * 2);
  const tToX = (t) => PAD + (t - view.t0) / (view.t1 - view.t0) * plotW();
  const xToT = (x) => view.t0 + ((x - PAD) / plotW()) * (view.t1 - view.t0);
  const ms = (t) => Math.round(Math.min(1e9, Math.max(0, t)) * 1000) / 1000;

  const pxPerSec = () => plotW() / Math.max(EPS, view.t1 - view.t0);

  /**
   * 当前缩放下"一格大约 FILM_CELL 宽"对应的抽帧间隔。
   * 沿 2 的幂**就近**取档（不是往下取整）：格子宽度因此落在 60–120px 之间，
   * 既不会细到互相压格，也不会粗到把 160px 的小图拉成几百像素的糊图。
   */
  function levelStep() {
    const raw = FILM_CELL / Math.max(1e-6, pxPerSec());
    const min = 1 / Math.max(1, fps);
    const snapped = Math.pow(2, Math.round(Math.log2(Math.max(min, raw))));
    return Math.max(min, Math.min(srcDuration / 4, snapped));
  }

  /** 该向主进程要哪一档、哪一段。窗口按整格对齐，小幅平移不会反复重抽。 */
  function filmWant() {
    if (!clips.length || !srcDuration) return null;
    const step = levelStep();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of clips) {
      const a = Math.max(c.ps, view.t0);
      const b = Math.min(c.pe, view.t1);
      if (b <= a) continue;
      lo = Math.min(lo, c.start + (a - c.ps));
      hi = Math.max(hi, c.start + (b - c.ps));
    }
    if (!(hi > lo)) return null;
    const pad = (hi - lo) * 0.5;      // 左右各多要半屏，往回拖时不必马上再抽一批
    return {
      step,
      from: Math.max(0, Math.floor((lo - pad) / step) * step),
      to: Math.min(srcDuration, Math.ceil((hi + pad) / step) * step),
    };
  }

  /** 取手头最接近当前缩放的那一档；差太远就不如不画。 */
  function pickLevel() {
    if (!levels.size) return null;
    const want = levelStep();
    let best = null;
    let bestD = Infinity;
    for (const lv of levels.values()) {
      const d = Math.abs(Math.log(lv.step / want));
      if (d < bestD) { bestD = d; best = lv; }
    }
    return best && best.imgs.size ? best : null;
  }

  /** 成片时间 → 源时间 */
  function progToSrc(pt) {
    for (const c of clips) {
      if (pt >= c.ps - EPS && pt <= c.pe + EPS) return ms(c.start + (pt - c.ps));
    }
    if (!clips.length) return 0;
    return pt < clips[0].ps ? clips[0].start : clips[clips.length - 1].end;
  }

  /** 源时间 → 成片时间；落在被删掉的素材上时返回最近的可显示位置 */
  function srcToProg(st) {
    for (const c of clips) {
      if (st >= c.start - EPS && st <= c.end + EPS) return ms(c.ps + (st - c.start));
    }
    return null;
  }

  /**
   * 拖边界（片段端点）的锚点。
   *
   * 不能用 progToSrc(指针) 当新的切点：指针一旦落进右段，那条函数给的是**右段的源坐标**，
   * 而右段的源起点比这条边界的成片位置晚了"此前删掉的素材总长"——第一次 move 就把端点
   * 弹开那么远，之后按这个固定偏差跟着鼠标走（实测切一刀再拖右段左端点，端点瞬间跳 2s+）。
   * 所以按住的那一刻记下边界自己的源值 src0 与成片位置 prog0，拖动只喂**位移量**，
   * grab 再把"按在端点哪一侧"的初始偏差也抵掉，端点就不会先跳一下。
   */
  function boundaryAnchor(index, x) {
    const left = clips[index];
    if (!left) return { src0: 0, prog0: 0, grab: 0 };
    const prog0 = left.pe;
    return { src0: left.end, prog0, grab: xToT(x) - prog0 };
  }

  function boundaryValue(drag, x) {
    return ms(drag.src0 + (xToT(x) - drag.prog0) - drag.grab);
  }

  function clipIndexAtProg(pt) {
    for (let i = 0; i < clips.length; i++) {
      if (pt >= clips[i].ps - EPS && pt <= clips[i].pe + EPS) return i;
    }
    return -1;
  }

  /**
   * 磁吸：优先吸片段边界，其次吸关键帧（只有还在成片上的关键帧才算）。
   *
   * 两级吸附，可由上层按用户开关取舍：
   *  - `edges`（片段边界）恒开 —— 吸到边界只是定位到某一刀上，不会改变剪辑结构
   *  - `keyframes` 可关（磁吸关=只吸边界）—— 关键帧只在流拷贝导出时才是合法切割位置
   */
  function snapCandidate(x, opts) {
    const t = xToT(x);
    let best = null;
    const consider = (progT, kind, srcT) => {
      if (progT == null || progT < 0 || progT > total) return;
      const dx = Math.abs(tToX(progT) - x);
      if (dx <= SNAP_PX && (!best || dx < best.dx)) best = { t: ms(progT), kind, srcT, dx };
    };
    consider(0, 'edge', clips.length ? clips[0].start : 0);
    consider(total, 'edge', clips.length ? clips[clips.length - 1].end : 0);
    for (let i = 0; i < clips.length; i++) {
      consider(clips[i].ps, 'edge', clips[i].start);
      consider(clips[i].pe, 'edge', clips[i].end);
    }
    if (!opts || opts.keyframes !== false) {
      for (const kf of keyframes) {
        const prog = srcToProg(kf);
        if (prog != null) consider(prog, 'keyframe', kf);
      }
    }
    return best;
  }

  // ---------- 渲染 ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w };
  }

  function render() {
    const { w } = resize();
    renderSeq++;
    ctx.clearRect(0, 0, w, root.clientHeight);
    drawRuler();
    drawFilm();
    drawKeyframeTicks();      // tick 现在画在胶片底边上，必须压在胶片之上
    drawSnapExtra();          // 吸附多带的区间：半透明延伸块，压在胶片上、片段块之下
    drawBlocks();
    drawGroupBrackets();      // 分组连线：画在块之上，表达"这几段进同一个文件"
    drawCaret();
    drawPlayhead();
    drawScrollbar();
    askFilm();
  }

  /**
   * 吸附模式的多带可视化：每条片段若被吸附前移（snapInfo[i] < 片段源起点），
   * 在它的左侧画一个半透明块，宽度 = 多带的秒数在成片时间轴上的长度。
   * 数据全部来自真实切割计划（snapInfo ← snapMap ← planFor），不前端另算。
   * 精确模式（无吸附差）下这块自然消失。
   */
  function drawSnapExtra() {
    snapExtraInfo = { count: 0, px: 0 };
    if (!snapInfo || !clips.length) return;
    const x0 = Math.max(0, tToX(view.t0));
    const x1 = Math.min(width(), tToX(view.t1));
    for (let i = 0; i < clips.length; i++) {
      const s = snapInfo[i];
      if (!s) continue;
      const c = clips[i];
      const extra = c.start - s;
      if (extra <= 0.001) continue;
      const px = extra * pxPerSec();
      const right = tToX(c.ps);
      const left = right - px;
      if (right < x0 || left > x1) continue;   // 视口外不画
      ctx.fillStyle = 'rgba(127, 211, 163, 0.28)';
      ctx.fillRect(left, LANE_TOP, px, LANE_H);
      ctx.fillStyle = 'rgba(127, 211, 163, 0.85)';
      // 左缘一条 1px 竖线标出"真正的导出起点"
      ctx.fillRect(Math.round(left) + 0.5, LANE_TOP, 1, LANE_H);
      snapExtraInfo.count++;
      snapExtraInfo.px += px;
    }
  }

  /** 缩放/平移换了档位就通知上层去要那一档的格子；签名不变时什么都不做。 */
  function askFilm() {
    if (!cb.onFilmWant) return;
    const want = filmWant();
    const sig = want ? `${want.step}|${want.from}|${want.to}` : '';
    if (sig === filmSig) return;
    filmSig = sig;
    if (want) cb.onFilmWant(want);
  }

  /**
   * 刻度尺搬到顶部那条：数字在上、刻度线贴底，播放头手柄就骑在同一条上。
   *
   * 间隔不能只按"每 90px 一格"选——标签宽度差得远（"0.5s" 与 "1:06:40.000"），
   * 一小时的素材按固定密度画出来就是满行互相压字。所以先量一遍视口内最长的标签，
   * 再沿 1/2/5 阶梯把间隔抬到"格宽 >= 标签宽 + 间隙"为止。
   */
  function drawRuler() {
    const span = view.t1 - view.t0;
    const pxPerSec = plotW() / span;
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    const labelPx = ctx.measureText(fmtClock(total)).width;
    let step = niceStep(span / Math.max(1, plotW() / 90));
    for (let guard = 0; guard < 16 && step * pxPerSec < labelPx + RULER_GAP && step < span; guard++) step = nextNice(step);
    const fmt = step >= 1 ? fmtShort : fmtClock;      // 亚秒级刻度才需要显示到毫秒
    rulerInfo = { step, labels: [] };
    ctx.strokeStyle = '#2c313a';
    ctx.fillStyle = '#626d7d';
    ctx.lineWidth = 1;
    // 只画视口内的刻度：上界写 total 的话，放大到 92 级会为一整条 6 小时素材
    // 画十多万次刻度（x 跑到千万像素），每次 render 都卡一遍。
    const last = Math.min(total, view.t1) + step;
    for (let t = Math.ceil(view.t0 / step) * step; t <= last; t += step) {
      const x = Math.round(tToX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 7);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      const label = fmt(t);
      rulerInfo.labels.push({ t, x, label });
      ctx.fillText(label, x + 3, 1);
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(x, LANE_TOP);
      ctx.lineTo(x, LANE_TOP + LANE_H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#2c313a';
    ctx.fillRect(0, RULER_H, width(), 1);
  }

  /**
   * 关键帧 tick：只压在胶片底边留一个小勾，只画还在成片上的那些，落在被删素材里的自然消失。
   * 以前还把这条线一路画穿整个车道，缩放到 GOP 只剩十几像素时，满条的竖线会把画面切成栅格。
   */
  function drawKeyframeTicks() {
    ctx.fillStyle = '#8f9aa8';
    const pxSec = pxPerSec();
    const stride = pxSec < 14 ? Math.max(1, Math.round(1 / (pxSec * 0.15))) : 1;
    for (let i = 0; i < keyframes.length; i += stride) {
      const prog = srcToProg(keyframes[i]);
      if (prog == null) continue;
      const x = tToX(prog);
      if (x < -2 || x > width() + 2) continue;
      ctx.fillRect(Math.round(x), LANE_TOP + LANE_H - 5, 1, 5);
    }
  }

  function drawBlocks() {
    if (lane.childElementCount !== clips.length) {
      lane.innerHTML = '';
      for (let i = 0; i < clips.length; i++) lane.appendChild(makeBlock());
    }
    for (let i = 0; i < clips.length; i++) {
      const el = lane.children[i];
      const c = clips[i];
      const x0 = tToX(c.ps);
      const x1 = tToX(c.pe);
      el.dataset.index = String(i);
      el.style.left = `${x0}px`;
      el.style.width = `${Math.max(3, x1 - x0)}px`;
      el.classList.toggle('sel', i === selected);
      el.classList.toggle('multi', selSet.length > 1 && selSet.includes(i));
      el.classList.toggle('last', i === clips.length - 1);
      // 分组（「并成一次导出」）：块上带个角标，同一组的块由下方括号连起来
      const g = c.group == null ? null : groupNo(c.group);
      el.classList.toggle('grp', g != null);
      el.querySelector('.idx').textContent = String(i + 1);
      const badge = el.querySelector('.grp-badge');
      badge.textContent = g == null ? '' : `组${g}`;
      el.querySelector('.drop').textContent = snapDelta(i) > 0.001 ? `+${snapDelta(i).toFixed(3)}s` : '';
      el.classList.toggle('moving', !!(reorder && reorder.from === i));
      el.title = `成片 ${fmtClock(c.ps)} → ${fmtClock(c.pe)}\n源 ${fmtClock(c.start)} → ${fmtClock(c.end)}`
        + (g != null ? `\n并入导出第 ${g} 个文件` : '');
    }
  }

  /**
   * 分组号 → 显示序号（1 起，按首次出现的顺序编）。
   * 分组号本身是内部 id（用户撤销/拆分后可能不连续），显示要连续，否则会出现"组3、组7"。
   */
  function groupNo(id) {
    let n = 0;
    for (const c of clips) {
      if (c.group == null) continue;
      if (!groupOrder.has(c.group)) groupOrder.set(c.group, ++n);
      if (c.group === id) return groupOrder.get(id);
    }
    return groupOrder.get(id) || null;
  }

  /**
   * 分组括号：同一组连续的几块下面画一条连线 + 一个"组N"，直观表达
   * "这几段会拼进同一个文件"。组的成员被拖散成两截时，两截各画一次、标同一个号
   * ——那正好说明它们仍然进同一个文件。
   */
  function drawGroupBrackets() {
    const y = LANE_TOP + LANE_H - 2;
    let i = 0;
    while (i < clips.length) {
      const gid = clips[i].group;
      if (gid == null) { i++; continue; }
      let j = i;
      while (j + 1 < clips.length && clips[j + 1].group === gid) j++;
      const x0 = tToX(clips[i].ps);
      const x1 = tToX(clips[j].pe);
      ctx.fillStyle = 'rgba(127, 211, 163, 0.9)';
      ctx.fillRect(Math.round(x0), y, Math.max(2, Math.round(x1 - x0)), 2);
      i = j + 1;
    }
  }

  function snapDelta(i) {
    const s = snapInfo && snapInfo[i];
    return s ? Math.max(0, clips[i].start - s) : 0;
  }

  function makeBlock() {
    const el = document.createElement('div');
    el.className = 'seg';
    el.innerHTML = '<div class="handle l"></div><div class="label"><span class="idx"></span></div>' +
      '<div class="grp-badge"></div><div class="drop"></div><div class="handle r"></div>';
    return el;
  }

  function drawPlayhead() {
    playheadEl.classList.toggle('hidden', !clips.length);
    const x = tToX(Math.min(total, Math.max(0, programTime)));
    // 强制取整到设备像素：消除跨设备的子像素抖动（dpr≠1 时）
    const intX = Math.round(x * window.devicePixelRatio) / window.devicePixelRatio;
    playheadEl.style.left = `${intX}px`;
    if (knobEl) knobEl.style.left = `${-KNOB_HALF}px`;   // 胶囊永远正中线：绘图区已经收出 PAD 的余量
    if (bubbleEl) bubbleEl.textContent = fmtClock(programTime);
  }

  /**
   * 胶片条：先铺导入时整片抽的那一遍当背景，再盖上按当前缩放现抽的一层。
   *
   * 每格**只在自己的矩形里画**，并且把源图裁成这一格的比例 —— 之前按"cover 铺满"
   * 放大时一格能溢出盖掉左右十几格，缩略图全糊在一起；改成裁切填充后既不越界也
   * 不放大，配合按缩放抽帧，任何倍率下都是清晰且互不重叠的一排画面。
   */
  function drawFilm() {
    filmDrawn = 0;
    filmStats = { step: null, cells: 0, minCell: 0, maxCell: 0, maxScale: 0 };
    const pxSec = pxPerSec();
    // 总览那一遍的格子一旦拉到几百像素就没意义了（会糊成一大片），那种缩放交给动态层级
    if (thumbs && thumbs.step * pxSec <= FILM_CELL * 4) drawRow(thumbs.step, (i) => thumbImgs[i]);
    const lv = pickLevel();
    if (!lv) return;
    // 统计只记最上面那一层 —— 那才是用户真正看到的画面
    filmStats = { step: lv.step, cells: 0, minCell: 0, maxCell: 0, maxScale: 0 };
    drawRow(lv.step, (i) => lv.imgs.get(i));
  }

  function drawRow(step, imgAt) {
    forEachTile(step, (i, dx, dw) => {
      const img = imgAt(i);
      if (!img || !img.complete || !img.naturalWidth) return;
      paintCell(img, dx, dw);
      filmDrawn++;
      const scale = Math.max(dw / img.naturalWidth, LANE_H / (img.naturalHeight || 1));
      filmStats.cells++;
      filmStats.minCell = filmStats.minCell ? Math.min(filmStats.minCell, dw) : dw;
      filmStats.maxCell = Math.max(filmStats.maxCell, dw);
      filmStats.maxScale = Math.max(filmStats.maxScale, scale);
    });
  }

  /**
   * 只遍历视口内的格子：(格号, 左边界 px, 宽 px)。
   * 必须按视口夹一遍 —— 放大到一屏不到一秒时，一个长片段自身就有几十万个格子，
   * 从片段头遍历到片段尾会把每一次 render 都拖成一次灾难。
   */
  function forEachTile(step, fn) {
    if (!step) return;
    for (const c of clips) {
      const pa = Math.max(c.ps, view.t0);
      const pb = Math.min(c.pe, view.t1);
      if (pb <= pa) continue;
      const sa = c.start + (pa - c.ps);
      const sb = c.start + (pb - c.ps);
      const iFrom = Math.max(0, Math.floor(sa / step));
      const iTo = Math.floor((sb - EPS) / step);
      for (let i = iFrom; i <= iTo; i++) {
        const s0 = Math.max(sa, i * step);
        const s1 = Math.min(sb, (i + 1) * step);
        const dx0 = tToX(c.ps + (s0 - c.start));
        const dx1 = tToX(c.ps + (s1 - c.start));
        if (dx1 - dx0 < 0.5) continue;
        fn(i, dx0, dx1 - dx0);
      }
    }
  }

  /** 源图按格子的宽高比居中裁一块，正好填满这一格：不越界、不变形、不放大。 */
  function paintCell(img, dx, dw) {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight || 1;
    const scale = Math.max(dw / natW, LANE_H / natH);
    const sw = dw / scale;
    const sh = LANE_H / scale;
    ctx.drawImage(img, (natW - sw) / 2, (natH - sh) / 2, sw, sh, dx, LANE_TOP, dw, LANE_H);
  }

  /** 拖动改顺序时的插入位置指示线。 */
  function drawCaret() {
    if (!reorder) return;
    const at = reorder.to == null ? null : (clips[reorder.to] || clips[clips.length - 1]);
    if (!at) return;
    const x = Math.round(tToX(reorder.to > reorder.from ? at.pe : at.ps)) + 0.5;
    ctx.strokeStyle = '#8ee0af';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, LANE_TOP - 2);
    ctx.lineTo(x, LANE_TOP + LANE_H + 2);
    ctx.stroke();
  }

  /** 底部滚动条：滑块宽度 = 视口 / 总长，位置 = 视口左端在剩余区间里的占比。 */
  function drawScrollbar() {
    if (!scrollEl || !thumbEl) return;
    const span = view.t1 - view.t0;
    const track = scrollEl.clientWidth || 1;
    if (span >= total - 1e-6) {
      scrollEl.classList.add('full');
      thumbEl.style.width = '100%';
      thumbEl.style.left = '0px';
      return;
    }
    scrollEl.classList.remove('full');
    const w = Math.max(38, track * span / total);
    const room = Math.max(0, track - w);
    thumbEl.style.width = `${w}px`;
    thumbEl.style.left = `${(view.t0 / Math.max(EPS, total - span)) * room}px`;
  }

  /** 缩放级别 0–100：0 = 整条适配，100 = 一屏只剩约 24 帧。对数刻度，手感才均匀。 */
  function spanToLevel(span) {
    const hi = total;
    const lo = Math.min(total, minSpan);
    if (hi <= lo) return 100;
    return clampNum(Math.log(hi / span) / Math.log(hi / lo) * 100, 0, 100);
  }
  function levelToSpan(v) {
    const hi = total;
    const lo = Math.min(total, minSpan);
    if (hi <= lo) return hi;
    return hi * Math.pow(lo / hi, clampNum(v, 0, 100) / 100);
  }
  function syncZoomSlider() { /* 缩放滑杆已按需求移除，保留空钩子给视图同步 */ }
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** 以 anchorX（默认视口中心）为锚，把缩放滑杆的 0–100 变成实际视口。 */
  function setZoomLevel(level, anchorX) {
    const span = levelToSpan(level);
    const anchorT = anchorX == null ? (view.t0 + view.t1) / 2 : xToT(anchorX);
    const ratio = span > 0 ? clampNum((anchorT - view.t0) / Math.max(EPS, view.t1 - view.t0), 0, 1) : 0.5;
    view.t0 = anchorT - ratio * span;
    view.t1 = view.t0 + span;
    panTo(view.t0, view.t1);
    render();
  }

  /** 把视口左端平移到 t（滚动条用）。 */
  function setViewStart(t) {
    const span = view.t1 - view.t0;
    panTo(t, t + span);
    render();
  }

  // ---------- 播放头定位 ----------
  function selectClip(i, additive) {
    if (i < 0) return;
    if (additive) {
      // Ctrl/⌘ 单击 = 加选/减选（用来把几段并成一次导出）；Shift 单击 = 从当前段扩选到目标段
      if (cb.onSelect) cb.onSelect(i, additive);
      return;
    }
    if (i === selected) return;
    selected = i;
    if (cb.onSelect) cb.onSelect(i, false);
  }

  /** 把成片时间落到一个可编辑的位置（含磁吸），并回调上层。 */
  function moveTo(x, { allowSnap = true, select = true } = {}) {
    const raw = Math.min(total, Math.max(0, xToT(x)));
    const snap = allowSnap ? snapCandidate(x, { keyframes: snapKeyframes }) : null;
    const pt = snap ? snap.t : ms(raw);
    programTime = pt;
    if (select) selectClip(clipIndexAtProg(pt));
    if (cb.onScrub) cb.onScrub(progToSrc(pt), pt, snap);
    render();
    return snap;
  }

  // ---------- 交互 ----------
  function localX(e) {
    const rect = root.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  root.addEventListener('pointerdown', (e) => {
    if (!clips.length) return;
    const x = localX(e);
    const y = e.clientY - root.getBoundingClientRect().top;
    const segEl = e.target.closest ? e.target.closest('.seg') : null;
    const index = segEl ? Number(segEl.dataset.index) : -1;
    // 每段左右各有一个 .handle，两边都是同一个边界：左柄 = 本段与前段的边界（index-1），
    // 右柄 = 本段与后段的边界（index）。以前只判断"按到了手柄"就一律当左柄，
    // 于是第二段及以后**拖右端其实在拖自己的左端**（只有第一段的右端碰巧对）。
    const side = segEl && e.target.classList && e.target.classList.contains('handle')
      ? (e.target.classList.contains('r') ? 'r' : 'l')
      : null;

    if (y < LANE_TOP) {
      // 顶部刻度条整条都是"手柄道"：按下去就拖播放头，不必去瞄准 12px 宽的手柄
      drag = { mode: 'scrub', x0: x, moved: 0 };
      playheadEl.classList.add('dragging');
      moveTo(x, { allowSnap: false, select: true });
    } else if (side === 'l' && index > 0) {
      drag = Object.assign({ mode: 'boundary', index: index - 1, moved: 0 }, boundaryAnchor(index - 1, x));
    } else if (side === 'r' && index < clips.length - 1) {
      drag = Object.assign({ mode: 'boundary', index, moved: 0 }, boundaryAnchor(index, x));
    } else if (side) {
      // 第一段左柄 / 最后一段右柄：那头没有边界，什么都不做。
      // 不能让它落到"拖动改顺序"，否则抓片段边缘那一下会把整段拎起来。
    } else if (index >= 0) {
      // 胶片本身：按下就是抓住这段素材，拖动改顺序；单击只选中，绝不动播放头
      // Ctrl/⌘ 或 Shift 按下 = 多选（把几段并成一次导出），此时不进入拖动改顺序
      const multi = e.ctrlKey || e.metaKey || e.shiftKey;
      if (multi) {
        selectClip(index, true);
      } else {
        drag = { mode: 'reorder', from: index, x0: x, moved: 0 };
        reorder = { from: index, to: index };
        selectClip(index);
      }
    }
    try { root.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    e.preventDefault();
    render();
  });

  root.addEventListener('dblclick', (e) => {
    if (!clips.length || !cb.onMergeBoundary) return;
    const x = localX(e);
    const y = e.clientY - root.getBoundingClientRect().top;
    if (y < LANE_TOP) return;      // 刻度条上双击不改切点
    for (let i = 0; i < clips.length - 1; i++) {
      if (Math.abs(tToX(clips[i].pe) - x) < 6) { cb.onMergeBoundary(i); return; }
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!clips.length) return;
    const x = localX(e);
    pointer = { x };
    if (!drag) return;
    drag.moved = Math.max(drag.moved || 0, Math.abs(x - (drag.x0 != null ? drag.x0 : x)));
    if (drag.mode === 'scrub') {
      moveTo(x, { allowSnap: true, select: false });
    } else if (drag.mode === 'boundary' && cb.onBoundary) {
      cb.onBoundary(drag.index, boundaryValue(drag, x));
    } else if (drag.mode === 'reorder') {
      const t = xToT(x);
      let to = clips.findIndex((c) => t >= c.ps && t < c.pe);
      if (to < 0) to = t < (clips[0]?.ps ?? 0) ? 0 : clips.length;
      reorder = { from: drag.from, to };
      render();
    }
  });

  root.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const x = localX(e);
    const d = drag;
    drag = null;
    playheadEl.classList.remove('dragging');
    try { root.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    if (d.mode === 'scrub') moveTo(x, { allowSnap: true, select: true });
    else if (d.mode === 'boundary' && cb.onBoundaryCommit) cb.onBoundaryCommit(d.index);
    else if (d.mode === 'reorder') {
      const to = reorder ? reorder.to : d.from;
      reorder = null;
      if (d.moved >= DRAG_MIN && cb.onReorder) cb.onReorder(d.from, to);
    }
    render();
  });

  root.addEventListener('pointercancel', () => { drag = null; reorder = null; render(); });

  /** 顶部手柄：拖它 = 精确落位（与在手柄道上按下拖动等效）。 */
  const knob = playheadEl.querySelector('.knob');
  if (knob) {
    knob.addEventListener('pointerdown', (e) => {
      if (!clips.length) return;
      drag = { mode: 'scrub', moved: 0, x0: localX(e) };
      try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // 滚轮 = 左右滚动时间轴；Alt + 滚轮 = 以光标为锚缩放（触控板横滚同样走滚动）
  root.addEventListener('wheel', (e) => {
    if (!total) return;
    e.preventDefault();
    if (e.altKey) {
      zoomAt(Math.exp(e.deltaY * 0.0022), localX(e));
      render();
      return;
    }
    const dy = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const span = view.t1 - view.t0;
    panTo(view.t0 + dy * 0.0022 * span, view.t1 + dy * 0.0022 * span);
    render();
  }, { passive: false });

  // 滚动条：拖滑块 = 平移，点轨道 = 把视口中心移过去
  if (thumbEl && scrollEl) {
    let slide = null;
    thumbEl.addEventListener('pointerdown', (e) => {
      slide = { x0: e.clientX, t0: view.t0, moved: false };
      thumbEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    thumbEl.addEventListener('pointermove', (e) => {
      if (!slide) return;
      const span = view.t1 - view.t0;
      const room = Math.max(1, (scrollEl.clientWidth || 1) - (thumbEl.clientWidth || 1));
      const dt = (e.clientX - slide.x0) / room * Math.max(EPS, total - span);
      if (Math.abs(e.clientX - slide.x0) > 2) slide.moved = true;
      setViewStart(slide.t0 + dt);
    });
    const endSlide = (e) => {
      if (!slide) return;
      try { thumbEl.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      slide = null;
    };
    thumbEl.addEventListener('pointerup', endSlide);
    thumbEl.addEventListener('pointercancel', endSlide);
    scrollEl.addEventListener('pointerdown', (e) => {
      if (e.target === thumbEl) return;
      const rect = scrollEl.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / Math.max(1, rect.width);
      setViewStart(frac * total - (view.t1 - view.t0) / 2);
    });
  }

  // ---------- 视图控制 ----------
  function panTo(t0, t1) {
    const span = t1 - t0;
    if (span >= total) { view.t0 = 0; view.t1 = total; return; }
    if (t0 < 0) { t0 = 0; t1 = span; }
    if (t1 > total) { t1 = total; t0 = total - span; }
    view.t0 = t0; view.t1 = t1;
  }

  function zoomAt(factor, anchorX) {
    const span = view.t1 - view.t0;
    const newSpan = Math.min(total, Math.max(minSpan, span * factor));
    if (Math.abs(newSpan - span) < 1e-6) return;
    const anchorT = xToT(anchorX == null ? width() / 2 : anchorX);
    const ratio = span > 0 ? (anchorT - view.t0) / span : 0.5;
    view.t0 = anchorT - ratio * newSpan;
    view.t1 = view.t0 + newSpan;
    panTo(view.t0, view.t1);
  }

  function fit() { view.t0 = 0; view.t1 = total; render(); }

  /** 播放 / 落位时把视口跟过去：出右沿就把它放到靠左 1/3，出左沿放到靠右 1/5。 */
  function ensureVisible(t) {
    const span = view.t1 - view.t0;
    if (span >= total) return;
    if (t > view.t1 - span * 0.04) {
      panTo(t - span * 0.34, t - span * 0.34 + span);
      render();
    } else if (t < view.t0 + span * 0.04) {
      panTo(t - span * 0.2, t - span * 0.2 + span);
      render();
    }
  }

  // ---------- 格式化 ----------
  function fmtClock(t) {
    const s = Math.max(0, t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const msPart = Math.round((s - Math.floor(s)) * 1000);
    const body = `${pad(m)}:${pad(sec)}.${String(msPart).padStart(3, '0')}`;
    return h > 0 ? `${h}:${body}` : body;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  /**
   * 分钟 / 小时都要保留到"分:秒"，否则一小时内的每个刻度全印成同一个 "2h"。
   * 是否带小时前缀由整条尺子统一决定（看 total），不由单个 t 决定，
   * 免得出 "0.00s 3:20 6:40" 这种一格一样式的尺子。
   */
  function fmtShort(t) {
    if (total >= 3600) return `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(Math.floor(t % 60))}`;
    if (total >= 60) return `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}`;
    return t.toFixed(t < 10 ? 2 : 1);
  }
  function niceStep(target) {
    const t = Math.max(0.05, target || 1);
    const pow = Math.pow(10, Math.floor(Math.log10(t)));
    const n = t / pow;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  }
  /** 沿 1 → 2 → 5 → 10 阶梯往上抬一档。 */
  function nextNice(step) {
    const pow = Math.pow(10, Math.floor(Math.log10(step)));
    const n = step / pow;
    return (n < 2 ? 2 : n < 5 ? 5 : 10) * pow;
  }

  /**
   * 胶片图的文件地址：目录里可能有空格、中文，甚至 # 和 ?（encodeURI 不转这两个，
   * 一旦命中整条胶片就全 404）。所以逐段 encodeURIComponent，只放过 Windows 盘符。
   */
  function thumbUrl(dir, name) {
    const segs = String(dir).replace(/\\/g, '/').split('/')
      .map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s)));
    return `file:///${segs.join('/')}/${name}`;
  }

  /**
   * 图片陆续到达就重画。这里刻意不用 requestAnimationFrame 合帧：
   * 窗口被最小化 / 遮挡时 rAF 根本不触发，胶片会一直空白到用户下次操作。
   */
  function scheduleFilmRender() {
    render();
  }

  new ResizeObserver(() => render()).observe(root);

  return {
    render,
    fit,
    zoomBy: (f) => { zoomAt(f, null); render(); },
    setZoomLevel,
    zoomLevel: () => Math.round(spanToLevel(view.t1 - view.t0)),
    /** 播放头移动到成片时间 pt（不经过磁吸），供键盘逐帧/跳转使用。 */
    setProgramTime(pt) { programTime = ms(Math.min(total, Math.max(0, pt))); drawPlayhead(); ensureVisible(programTime); },
    moveToX: (x) => moveTo(x, { allowSnap: true, select: true }),
    /** 关键帧磁吸开关（片段边界磁吸不受它影响，恒开）。 */
    setKeyframeSnap(on) { snapKeyframes = on !== false; },
    currentProgramTime: () => programTime,
    setSource(media) {
      srcDuration = Math.max(0.001, Number(media.duration) || 0.001);
      keyframes = (media.keyframes || []).slice();
      fps = Number(media.video && (media.video.fps || media.video.nominalFps)) || 30;
      minSpan = Math.min(srcDuration, 24 / fps);
      fitted = false;
      render();
    },
    setClips(next, sel, snapMap) {
      clips = next.map((c) => ({ ...c }));
      total = Math.max(0.001, clips.length ? clips[clips.length - 1].pe : 0.001);
      selected = sel == null ? selected : sel;
      snapInfo = snapMap || null;
      // 分组显示序号按"当前出现顺序"重排：删掉一段后组号不该留空洞
      groupOrder = new Map();
      // 内容变了就把视口收进 [0, total]；用户自己放大过（span < total）则保留缩放
      if (!fitted || view.t1 > total || view.t1 - view.t0 >= total) { view.t0 = 0; view.t1 = total; }
      fitted = true;
      render();
    },
    setSelected(i) { selected = i; render(); },
    /** 多选集合：`[2,3,4]`。传空数组或省略 = 单选（只有 selected 高亮）。 */
    setSelection(list, primary) {
      selSet = Array.isArray(list) ? list.slice() : [];
      if (primary != null) selected = primary;
      render();
    },
    /**
     * 换素材、或主进程边抽边推进度时调用。同目录下张数只会增长，
     * 所以只补新增的那几张，别把已经加载好的图重建一遍。
     */
    setThumbs(next) {
      const prev = thumbs;
      thumbs = next && next.count ? { ...next } : null;
      if (!thumbs) {
        thumbImgs = [];
        filmDrawn = 0;
        for (const lv of levels.values()) for (const img of lv.imgs.values()) img.src = '';
        levels.clear();
        filmSig = '';
        render();
        return;
      }
      if (!prev || prev.dir !== thumbs.dir) thumbImgs = [];
      if (thumbImgs.length > thumbs.count) thumbImgs.length = thumbs.count;
      for (let i = 0; i < thumbs.count; i++) {
        const old = thumbImgs[i];
        // 进度是按"已写出几张"报的，抽帧并发时可能先报后写：
        // 加载失败的那格下次进度推送时重建一次 Image，不然就是一个永久空洞。
        if (old && !(old.complete && !old.naturalWidth)) continue;
        const img = new Image();
        img.onload = scheduleFilmRender;
        img.onerror = scheduleFilmRender;
        img.src = thumbUrl(thumbs.dir, `f${String(i + 1).padStart(5, '0')}.jpg`);
        thumbImgs[i] = img;
      }
      render();
    },
    /**
     * 动态层级的一批格子到货：`{ step, dir, have: [格号…] }`，格号就是 `floor(源时间/step)`。
     * 同一档会分好几次推（边抽边推），所以这里是往 Map 里补，不是替换。
     */
    setLevel(next) {
      if (!next || !next.step || !Array.isArray(next.have)) return;
      let lv = levels.get(next.step);
      if (!lv) {
        lv = { step: next.step, dir: next.dir, imgs: new Map() };
        levels.set(next.step, lv);
        while (levels.size > FILM_ROWS) {
          const oldest = levels.keys().next().value;
          if (oldest === next.step) break;
          for (const img of levels.get(oldest).imgs.values()) img.src = '';
          levels.delete(oldest);
        }
      }
      let added = 0;
      for (const i of next.have) {
        if (lv.imgs.has(i)) continue;
        const img = new Image();
        img.onload = scheduleFilmRender;
        img.onerror = scheduleFilmRender;
        img.src = thumbUrl(lv.dir, `t${String(i).padStart(7, '0')}.jpg`);
        lv.imgs.set(i, img);
        added++;
      }
      if (added) render();
    },
    /** 当前这一档在视口里是否已经画满：给自检等位用，避免量到"正在长出来"的中间态。 */
    filmReady() {
      const step = levelStep();
      const lv = levels.get(step);
      if (!lv) return false;
      let need = 0;
      let got = 0;
      forEachTile(step, (i) => {
        const img = lv.imgs.get(i);
        need++;
        if (img && img.complete && img.naturalWidth) got++;
      });
      return need > 0 && got === need;
    },
    film: () => ({ ...filmStats, drawn: filmDrawn, want: filmWant() }),
    setDragging(on) { playheadEl.classList.toggle('dragging', !!on); },
    view: () => ({ ...view, total, srcDuration }),
    progToSrc,
    srcToProg,
    clipIndexAtProg,
    timeToX: tToX,
    edgePad: () => PAD,
    /** 磁吸候选点（给 HUD 显示"吸附到哪个关键帧"用）。 */
    snapAtProgram: (pt) => {
      const x = tToX(pt);
      const hit = snapCandidate(x, { keyframes: snapKeyframes });
      return hit && Math.abs(hit.t - pt) < 1e-6 ? hit : null;
    },
    get clips() { return clips.map((c) => ({ ...c })); },
    get filmDraws() { return filmDrawn; },
    get snapExtras() { return { ...snapExtraInfo }; },
    get renderSeq() { return renderSeq; },
    get ruler() { return { ...rulerInfo, labels: rulerInfo.labels.slice() }; },
    get total() { return total; },
  };
}

window.createTimeline = createTimeline;
})();

