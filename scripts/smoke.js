'use strict';

/**
 * 端到端 UI 自检：真实窗口 + 真实 ffmpeg，跑一遍"导入 → 拖播放头落位 → Q/W/E 剪辑
 * → J/K/L 变速 → 三种导出"。用法：npm run smoke [源文件]
 * 顺带把窗口截图写到 tmp/smoke-ui*.png，供界面改动做视觉回归。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const { registerIpc } = require('../src/main/api');
const { resolveBin } = require('../core/ffmpegPath');

// J/K/L 要真的播起来才有速率可查
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOT = path.join(__dirname, '..');
const SRC = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/t10.mp4'));
const OUT_DIR = path.join(ROOT, 'tmp', 'smoke');

const failures = [];
const steps = [];

function check(name, ok, detail) {
  steps.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(code, win, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await win.webContents.executeJavaScript(`!!(${code})`)) return true;
    if (Date.now() > until) return false;
    await wait(120);
  }
}

const js = (win, code) => win.webContents.executeJavaScript(code);

/** 页面里用的指针/滚轮模拟器。合成事件要打在光标下的元素上才会冒泡到时间轴。 */
const HELPERS = `
  window.__t = {
    HANDLE_Y: 10,   // 手柄道：只有这一条能拖播放头
    LANE_Y: 44,     // 胶片车道：按下拖动 = 改顺序
    /** 导出完成后模态会自动展开，它是全屏遮罩、会盖住时间轴；驱动指针前先收掉 */
    closeMasks: () => {
      for (const id of ['exportMask', 'importMask', 'menuPop']) {
        document.getElementById(id).classList.add('hidden');
      }
    },
    /** 在手柄道上拖到某个成片时间 */
    dragTo: async (pt, y) => {
      const box = document.getElementById('timeline');
      const rect = box.getBoundingClientRect();
      const yy = y == null ? window.__t.HANDLE_Y : y;
      const x = __smoke.tl.timeToX(pt);
      const at = (px) => rect.left + px;
      const fire = (type, px) => (document.elementFromPoint(at(px), rect.top + yy) || box)
        .dispatchEvent(new PointerEvent(type, {
          pointerId: 21, clientX: at(px), clientY: rect.top + yy, bubbles: true, isPrimary: true,
        }));
      fire('pointerdown', Math.max(2, x - 40));
      fire('pointermove', Math.max(3, x - 20));
      fire('pointermove', x);
      fire('pointerup', x);
      await new Promise((r) => setTimeout(r, 220));
      return { pt: __smoke.tl.currentProgramTime(), src: __smoke.tl.progToSrc(__smoke.tl.currentProgramTime()) };
    },
    /** 在胶片上按下-拖动-抬起，返回播放头有没有被挪动 */
    dragFilm: async (fromPt, toPt) => {
      window.__t.closeMasks();
      const box = document.getElementById('timeline');
      const rect = box.getBoundingClientRect();
      const yy = window.__t.LANE_Y;
      const before = __smoke.tl.currentProgramTime();
      const fire = (type, pt) => {
        const px = Math.max(2, __smoke.tl.timeToX(pt));
        (document.elementFromPoint(rect.left + px, rect.top + yy) || box)
          .dispatchEvent(new PointerEvent(type, {
            pointerId: 23, clientX: rect.left + px, clientY: rect.top + yy, bubbles: true, isPrimary: true,
          }));
      };
      fire('pointerdown', fromPt);
      fire('pointermove', (fromPt + toPt) / 2);
      fire('pointermove', toPt);
      fire('pointerup', toPt);
      await new Promise((r) => setTimeout(r, 240));
      return { before, after: __smoke.tl.currentProgramTime(), clips: __smoke.state.clips.length };
    },
    /** 在胶片上单击一下（按下即抬起，不移动） */
    clickFilm: async (pt) => {
      window.__t.closeMasks();
      const box = document.getElementById('timeline');
      const rect = box.getBoundingClientRect();
      const px = Math.max(2, __smoke.tl.timeToX(pt));
      const fire = (type) => (document.elementFromPoint(rect.left + px, rect.top + window.__t.LANE_Y) || box)
        .dispatchEvent(new PointerEvent(type, {
          pointerId: 24, clientX: rect.left + px, clientY: rect.top + window.__t.LANE_Y, bubbles: true, isPrimary: true,
        }));
      const before = __smoke.tl.currentProgramTime();
      fire('pointerdown');
      fire('pointerup');
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: __smoke.tl.currentProgramTime(), sel: __smoke.state.sel };
    },
    /**
     * 按住某个片段的某个端点手柄拖动，全程回报"手柄中心离指针多远"。
     * 边界拖动只能这样验：端点先弹开一下、再按固定偏差跟随鼠标，读最终数值看不出问题。
     * 另一端的切点必须一动不动 —— 只量被拖的那端会漏掉"拖右端其实在拖左端"这类错。
     */
    dragHandle: async (index, toPx, side) => {
      window.__t.closeMasks();
      side = side || 'l';
      const box = document.getElementById('timeline');
      const rect = box.getBoundingClientRect();
      const yy = window.__t.LANE_Y;
      const selOf = (s) => '#tlLane .seg[data-index="' + index + '"] .handle.' + s;
      const center = (s) => {
        const el = document.querySelector(selOf(s));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 - rect.left;
      };
      const fire = (type, px) => (document.elementFromPoint(rect.left + px, rect.top + yy) || box)
        .dispatchEvent(new PointerEvent(type, {
          pointerId: 27, clientX: rect.left + px, clientY: rect.top + yy, bubbles: true, isPrimary: true,
        }));
      const other = side === 'l' ? 'r' : 'l';
      __smoke.tl.fit();          // 目标可能在放大后的视口外，先整条收进来再量
      await new Promise((r) => setTimeout(r, 60));
      const el = document.querySelector(selOf(side));
      if (!el) return { error: '找不到手柄元素' };
      if (getComputedStyle(el).display === 'none') return { error: '这一端没有边界（头段左/尾段右），手柄是隐藏的' };
      const x0 = center(side);
      if (x0 == null) return { error: '手柄量不到位置' };
      if (x0 < 0 || x0 > rect.width) return { error: '手柄不在视口内（x=' + Math.round(x0) + ' / 宽 ' + Math.round(rect.width) + '）' };
      const other0 = center(other);
      const clips0 = __smoke.state.clips.map((c) => [c.start, c.end]);
      fire('pointerdown', x0);
      const trail = [];
      for (const px of [x0 + toPx * 0.4, x0 + toPx]) {
        fire('pointermove', px);
        await new Promise((r) => setTimeout(r, 70));
        const got = center(side);
        trail.push({ want: Math.round(px), got: got == null ? -999 : Math.round(got) });
      }
      fire('pointerup', x0 + toPx);
      await new Promise((r) => setTimeout(r, 200));
      return {
        x0: Math.round(x0), trail, clips: __smoke.state.clips.map((c) => [c.start, c.end]), clips0,
        otherDrift: Math.round(Math.abs((center(other) == null ? -999 : center(other)) - other0)),
      };
    },
    wheel: async (opts) => {
      const box = document.getElementById('timeline');
      const r = box.getBoundingClientRect();
      box.dispatchEvent(new WheelEvent('wheel', Object.assign({
        deltaY: -240, clientX: r.left + 300, clientY: r.top + 44, bubbles: true, cancelable: true,
      }, opts)));
      await new Promise((x) => setTimeout(x, 140));
      return { span: __smoke.tl.view().t1 - __smoke.tl.view().t0, t0: __smoke.tl.view().t0 };
    },
  };
  'ok'
`;

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1320, height: 860, show: true, frame: false,   // 与正式版一致：自绘标题栏
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  registerIpc(() => win);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  await waitFor('document.readyState === "complete"', win);
  await waitFor('__smoke.ready()', win);

  const env = await js(win, 'window.fc.env()');
  check('检测到 ffmpeg', !!env.ok, env.version);
  if (!env.ok) return finish(win);
  await js(win, HELPERS);

  // 1) 导入即预览：探流返回就能播，全片关键帧在后台扫
  const tImport = Date.now();
  await js(win, `__smoke.importFile(${JSON.stringify(SRC)}); 'ok'`);
  const importMs = Date.now() - tImport;
  await waitFor('__smoke.state.src', win);
  check('导入不必等全片扫描', importMs < 1500, `${importMs} ms 返回`);
  await waitFor('__smoke.state.scanning === false', win);
  const media = JSON.parse(await js(win,
    'JSON.stringify({kf: __smoke.state.src.media.keyframes.length, dur: __smoke.state.src.media.duration, fps: __smoke.state.src.media.video.fps})'));
  check('关键帧扫描已回填', media.kf > 0, `关键帧 ${media.kf} 个 · 时长 ${media.dur}s · ${media.fps}fps`);

  await waitFor('document.getElementById("player").readyState >= 1', win, 8000);
  const parsed = JSON.parse(await js(win,
    'JSON.stringify({d: document.getElementById("player").duration, err: document.getElementById("player").error && document.getElementById("player").error.code})'));
  check('预览加载源文件', Number.isFinite(parsed.d) && parsed.d > 0 && !parsed.err, `video.duration=${parsed.d} error=${parsed.err}`);

  const est0 = await js(win, 'document.getElementById("estimate").textContent');
  check('导入后即可导出且预估正确',
    await js(win, '!document.getElementById("btnExport").disabled') && /成片 00:00:10[.]000/.test(est0),
    est0.replace(/\s+/g, ' ').slice(0, 72));
  check('剪辑按钮与冗余文案已移除', await js(win,
    '["btnMarkIn","btnMarkOut","btnDeleteMarked","btnSplit","btnRemove","btnGotoIn","zoomRange"].every((id) => !document.getElementById(id))'
    + ' && !document.querySelector("#tlTools .hint") && !document.querySelector("#tlFoot .hint")'));

  // 1b) 版面：刻度尺与手柄同槽、底部 HUD 行已并入走带行、滚动条紧贴胶片下方
  await js(win, '__smoke.seekProgram(2.5); "ok"');
  await wait(200);
  const layout = JSON.parse(await js(win, `JSON.stringify((() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const tl = r("timeline");
    const knob = document.querySelector("#tlPlayhead .knob").getBoundingClientRect();
    const lane = r("tlLane");
    return {
      inTransport: !!document.querySelector("#transport #btnUndo") && !!document.querySelector("#transport #btnStepFwd"),
      hudInTransport: !!document.querySelector("#transport #hud"),
      viewRangeGone: !document.getElementById("viewRange"),
      /** 左栏里"肉眼可见、自带文字出现时间码"的元素只能有一个（#timecode）。
       *  拖动时才浮现的时间气泡 opacity=0，不算常驻读数。 */
      timeReadouts: [...document.querySelectorAll("#left *")]
        .filter((el) => {
          if (!el.getClientRects().length) return false;
          if (getComputedStyle(el).opacity === "0") return false;
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
          // 注意：这段跑在模板字符串里，\d 的反斜杠会被模板吃掉，必须用 [0-9]
          return /[0-9]{1,2}:[0-9]{2}[:.][0-9]{2,3}/.test(own);
        })
        .map((el) => el.id || el.className),
      toolsRow: !!document.getElementById("tlTools"),
      hudRow: !!document.getElementById("tlHud"),
      footTop: r("tlFoot").top - tl.bottom,
      knobClearsLane: knob.bottom <= lane.top + 0.5,
      knobInLane: knob.top >= tl.top - 0.5 && knob.bottom <= lane.top + 0.5,
      laneTop: lane.top - tl.top,
      tlHeight: tl.height,
    };
  })())`));
  check('撤销/重做与走带同排', layout.inTransport && !layout.toolsRow,
    '#transport 里有 ↶ ↷ ↺，独立的一行已删除');
  check('底部 HUD 行并入走带行', layout.hudInTransport && !layout.hudRow && layout.viewRangeGone,
    '落位提示进走带行、视口范围删除，独立的一行已删除');
  check('左栏只保留一个时间读数', layout.timeReadouts.length === 1 && layout.timeReadouts[0] === 'timecode',
    `显示时间码的元素：${layout.timeReadouts.join('、') || '（无）'}`);
  check('刻度尺与手柄同槽且不与胶片重叠',
    layout.knobInLane && layout.knobClearsLane && layout.laneTop >= 20 && layout.laneTop <= 28,
    `车道从 ${layout.laneTop}px 起，手柄整条都在它上面`);
  check('时间轴更紧凑', layout.tlHeight <= 80 && layout.footTop >= -0.5,
    `画布高 ${layout.tlHeight.toFixed(0)}px（原 104），滚动条紧贴其下 ${layout.footTop.toFixed(1)}px`);

  // 1b2) 手柄贴到片头 / 片尾：既不溢出，胶囊中心也必须始终压在那条线上
  const clamp = JSON.parse(await js(win, `(() => {
    const box = document.getElementById('timeline').getBoundingClientRect();
    const probe = () => {
      const r = document.querySelector('#tlPlayhead .knob').getBoundingClientRect();
      const p = document.getElementById('tlPlayhead').getBoundingClientRect();
      return {
        left: +(r.left - box.left).toFixed(1),
        over: +(r.right - box.right).toFixed(1),
        off: +((r.left + r.width / 2) - p.left).toFixed(1),
      };
    };
    __smoke.seekProgram(0); const at0 = probe();
    __smoke.seekProgram(__smoke.tl.total); const atEnd = probe();
    __smoke.seekProgram(5); const mid = probe();
    return JSON.stringify({ at0, atEnd, mid });
  })()`));
  check('播放头贴边时手柄不被裁',
    clamp.at0.left >= 0.5 && clamp.atEnd.over <= -0.5 && clamp.mid.left > 100,
    `片头手柄留白 ${clamp.at0.left}px · 片尾留白 ${(-clamp.atEnd.over).toFixed(1)}px · 中间时 ${clamp.mid.left}px`);
  check('手柄与播放头线不分家',
    [clamp.at0, clamp.atEnd, clamp.mid].every((c) => Math.abs(c.off) <= 1),
    `胶囊中心相对线的偏移：片头 ${clamp.at0.off} / 片尾 ${clamp.atEnd.off} / 中间 ${clamp.mid.off}px`);

  // 1c) 顶栏：⌨ ⤓ ⤒ 三个图标按钮；导入 / 导出都是居中模态（与快捷键同款交互）
  const pop = JSON.parse(await js(win, `JSON.stringify((() => {
    const ids = ["optSplit", "outDir", "outName", "estimate", "btnExport", "checks", "error"];
    const order = [...document.querySelectorAll("#topbar > button, #topbar .pop-wrap > button")]
      .map((b) => b.id).filter((id) => id === "btnKeys" || id === "btnImportOpen" || id === "btnExportOpen");
    const mask = document.getElementById("exportMask");
    const box = mask.querySelector(".modal");
    document.getElementById("btnExportOpen").click();
    const expOpen = !mask.classList.contains("hidden");
    const geo = box.getBoundingClientRect();
    const centered = Math.abs(geo.left + geo.width / 2 - innerWidth / 2) < 24
      && Math.abs(geo.top + geo.height / 2 - innerHeight / 2) < 60;
    const backdrop = getComputedStyle(mask).backgroundColor;
    document.getElementById("btnExportOpen").click();
    document.getElementById("btnImportOpen").click();
    const impOpen = !document.getElementById("importMask").classList.contains("hidden");
    document.getElementById("btnImportOpen").click();
    return {
      order,
      legacyBtn: !!document.getElementById("btnImport"),
      badge: !!document.getElementById("engineBadge"),
      cards: document.querySelectorAll("#right > .card h2").length,
      titles: [...document.querySelectorAll("#right > .card h2")].map((h) => h.textContent.trim()),
      allInside: ids.every((id) => box.contains(document.getElementById(id))),
      expOpen, expClosed: mask.classList.contains("hidden"), centered,
      impOpen, impClosed: document.getElementById("importMask").classList.contains("hidden"),
      hasPick: !!document.getElementById("btnImportPick"),
      dimmed: backdrop !== "rgba(0, 0, 0, 0)" && backdrop !== "transparent",
      glyphs: document.getElementById("btnImportOpen").textContent + "/" + document.getElementById("btnExportOpen").textContent,
    };
  })())`));
  check('顶栏顺序：快捷键 → 导入 → 导出',
    pop.order.join(',') === 'btnKeys,btnImportOpen,btnExportOpen' && !pop.legacyBtn && !pop.badge,
    `${pop.order.join(' → ')} · 图标 ${pop.glyphs}`);
  check('导出整栏改成居中模态', pop.allInside && pop.expOpen && pop.expClosed && pop.centered && pop.dimmed,
    `开合 ${pop.expOpen}→${pop.expClosed}，居中 ${pop.centered}，有暗色底 ${pop.dimmed}`);
  check('导入模态开合正常', pop.impOpen && pop.impClosed && pop.hasPick,
    `开合 ${pop.impOpen}→${pop.impClosed}，"选择文件…"按钮 ${pop.hasPick}`);
  check('主页面只剩源信息与片段',
    pop.cards === 2 && pop.titles[0] === '源信息' && /^片段/.test(pop.titles[1] || ''),
    pop.titles.join(' / '));

  // 1d) 自绘标题栏：没有原生菜单，窗口控制与下拉菜单都在 DOM 里
  const tbar = JSON.parse(await js(win, `JSON.stringify((() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    document.getElementById('btnMenu').click();
    const opened = !document.getElementById('menuPop').classList.contains('hidden');
    const items = document.querySelectorAll('#menuPop .mi').length;
    const box = document.getElementById('menuPop').getBoundingClientRect();
    const btn = r('btnMenu');
    document.getElementById('btnMenu').click();
    return {
      ctl: ['winMin', 'winMax', 'winClose'].every((id) => !!document.getElementById(id)),
      drag: getComputedStyle(document.getElementById('topbar')).webkitAppRegion,
      noDrag: getComputedStyle(document.getElementById('winClose')).webkitAppRegion,
      opened, closed: document.getElementById('menuPop').classList.contains('hidden'),
      items, underBtn: box.top >= btn.bottom - 2,
      exportGlyph: document.getElementById('btnExportOpen').textContent,
      /** 两块面板都必须是不透明底：菜单曾经只写了 .popover 没带背景，成了透明玻璃 */
      /** 菜单与导出面板都必须是不透明底：菜单曾只写了 .popover 没带背景，成了透明玻璃 */
      opaque: [document.getElementById('menuPop'), document.querySelector('#exportMask .modal')]
        .every((el) => {
          const bg = getComputedStyle(el).backgroundColor;
          return bg !== 'transparent' && !/rgba\(.+,\s*0\)$/.test(bg);
        }),
    };
  })())`));
  const tbarOk = tbar.ctl && tbar.drag === 'drag' && tbar.noDrag === 'no-drag'
    && tbar.opened && tbar.closed && tbar.items >= 9 && tbar.underBtn && tbar.opaque;
  check('标题栏自绘：窗口控制 + 下拉菜单', tbarOk,
    `ctl=${tbar.ctl} drag=${tbar.drag} noDrag=${tbar.noDrag} 开合=${tbar.opened}/${tbar.closed} 项=${tbar.items} 在按钮下=${tbar.underBtn} 面板不透明=${tbar.opaque}`);
  check('导出图标朝外', tbar.exportGlyph === '⤒', `当前是 ${tbar.exportGlyph}`);

  // 2) 拖手柄道 = 只移动播放头，绝不删除
  const scrub = JSON.parse(await js(win, '__t.dragTo(4.0).then((r) => JSON.stringify(r))'));
  const clipsAfterScrub = await js(win, '__smoke.state.clips.length');
  check('拖手柄道只移动播放头', clipsAfterScrub === 1 && Math.abs(scrub.pt - 4) < 0.02 && Math.abs(scrub.src - 4) < 0.02,
    `片段 ${clipsAfterScrub} 段 · 成片 ${scrub.pt}s ↔ 源 ${scrub.src}s`);
  const videoAt = await js(win, 'Math.round(document.getElementById("player").currentTime * 1000) / 1000');
  check('画面跟随播放头落位', Math.abs(videoAt - 4) < 0.05, `<video> 停在 ${videoAt}s`);

  // 3) 磁吸：靠近关键帧吸上去，离得远不吸
  const near = JSON.parse(await js(win, '__t.dragTo(4.06).then((r) => JSON.stringify(r))'));
  const far = JSON.parse(await js(win, '__t.dragTo(5.0).then((r) => JSON.stringify(r))'));
  check('靠近关键帧自动磁吸', Math.abs(near.src - 4) < 0.001, `拖到 4.06 → 落在源 ${near.src}s`);
  check('离关键帧远则不吸附', Math.abs(far.src - 5) < 0.02, `拖到 5.0 → 源 ${far.src}s`);
  await js(win, '__t.dragTo(4.06); "ok"');
  const hudSnapped = await js(win, 'document.getElementById("hud").textContent');
  await js(win, '__t.dragTo(5.0); "ok"');
  const hudPlain = await js(win, 'document.getElementById("hud").textContent');
  check('HUD 只报磁吸状态不重复报时间',
    /磁吸·关键帧/.test(hudSnapped) && !/\d{1,2}:\d{2}/.test(hudSnapped) && !/磁吸/.test(hudPlain),
    `吸上时 "${hudSnapped}" · 没吸时 "${hudPlain || '（空）'}"`);

  // 3b) 磁吸开关：关掉后同一个 4.06 不再被吸到关键帧，按钮态与 HUD 同步
  await js(win, 'document.getElementById("btnSnapKf").click(); "ok"');
  await wait(150);
  const snapOff = JSON.parse(await js(win, '__t.dragTo(4.06).then((r) => JSON.stringify(r))'));
  const offState = JSON.parse(await js(win, 'JSON.stringify({ on: document.getElementById("btnSnapKf").classList.contains("on"), pressed: document.getElementById("btnSnapKf").getAttribute("aria-pressed"), title: document.getElementById("btnSnapKf").title, hud: document.getElementById("hud").textContent })'));
  check('关掉关键帧磁吸后：拖动落点不再被吸到关键帧',
    Math.abs(snapOff.src - 4.06) < 0.02,
    `拖到 4.06 → 源 ${snapOff.src}s（开时应为 4）`);
  check('磁吸开关的按钮态与提示同步',
    offState.on === false && offState.pressed === 'false' && /自由拖动/.test(offState.title),
    `on=${offState.on} · aria-pressed=${offState.pressed} · title="${offState.title}"`);
  check('关掉磁吸后 HUD 不再报磁吸·关键帧', !/磁吸/.test(offState.hud), `HUD="${offState.hud || '（空）'}"`);

  // 片段边界磁吸不受开关影响：先在源 2s 处切一刀，拖到那个切点附近照样吸得住
  await js(win, '__smoke.seekProgram(2); __smoke.splitAtPlayhead(); "ok"');
  await wait(150);
  // splitAtPlayhead 会走 syncTimeline，把 lastSnap 清掉；所以先分割再拖，落点与 HUD 都以这次拖动为准
  const edgeOn = JSON.parse(await js(win, '__t.dragTo(2.04).then((r) => JSON.stringify(r))'));
  const edgeOff = JSON.parse(await js(win, 'JSON.stringify({ src: __smoke.tl.progToSrc(__smoke.tl.currentProgramTime()), hud: document.getElementById("hud").textContent })'));
  check('磁吸关掉后片段边界仍然吸附',
    Math.abs(edgeOn.src - 2.04) > 0.02 && Math.abs(edgeOff.src - 2) < 0.02 && /磁吸·分割点/.test(edgeOff.hud),
    `拖到 2.04 → 源 ${edgeOff.src}s · HUD="${edgeOff.hud}"`);

  await js(win, 'document.getElementById("btnSnapKf").click(); "ok"');
  await wait(120);
  const backOn = JSON.parse(await js(win, '__t.dragTo(4.06).then((r) => JSON.stringify(r))'));
  check('重新打开磁吸后恢复吸附', Math.abs(backOn.src - 4) < 0.001, `拖到 4.06 → 源 ${backOn.src}s`);

  // 磁吸开关这一段动了片段结构（切了一刀），后面几项都从"整条素材"起算，
  // 所以这里先复位，别把状态漏给 7) 之后的分割/删除断言
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(300);

  // 4) 滚轮 = 滚动，Alt + 滚轮 = 缩放，底部滚动条 = 平移
  await js(win, '__smoke.tl.setZoomLevel(70); "ok"');
  await wait(200);
  const zoomed = JSON.parse(await js(win,
    'JSON.stringify({ level: __smoke.tl.zoomLevel(), span: __smoke.tl.view().t1 - __smoke.tl.view().t0, t0: __smoke.tl.view().t0, total: __smoke.tl.view().total, thumb: document.getElementById("tlThumb").style.width })'));
  check('缩放后视口变小、滚动条变窄',
    zoomed.level > 60 && zoomed.span < zoomed.total * 0.5 && parseFloat(zoomed.thumb) > 0,
    `${zoomed.level} 级 · 视口 ${zoomed.span.toFixed(2)}s / 共 ${zoomed.total}s · thumb ${zoomed.thumb}`);

  const pan = JSON.parse(await js(win, '__t.wheel({}).then((r) => JSON.stringify(r))'));
  const alt = JSON.parse(await js(win, '__t.wheel({ altKey: true }).then((r) => JSON.stringify(r))'));
  check('滚轮只滚动不缩放', Math.abs(pan.span - zoomed.span) < 1e-6 && Math.abs(pan.t0 - zoomed.t0) > 1e-6,
    `跨度不变 ${pan.span.toFixed(2)}s，视口左端 ${zoomed.t0.toFixed(2)}s → ${pan.t0.toFixed(2)}s`);
  check('Alt + 滚轮以光标为锚缩放', alt.span < pan.span * 0.9, `跨度 ${pan.span.toFixed(2)}s → ${alt.span.toFixed(2)}s`);

  const slid = JSON.parse(await js(win, `(async () => {
    const thumb = document.getElementById('tlThumb');
    const r = thumb.getBoundingClientRect();
    const before = __smoke.tl.view().t0;
    const spanBefore = __smoke.tl.view().t1 - __smoke.tl.view().t0;
    const fire = (type, x) => thumb.dispatchEvent(new PointerEvent(type, { pointerId: 41, clientX: x, clientY: r.top + 4, bubbles: true }));
    fire('pointerdown', r.left + 6);
    fire('pointermove', r.left + 120);
    fire('pointerup', r.left + 120);
    await new Promise((res) => setTimeout(res, 150));
    return JSON.stringify({ before, after: __smoke.tl.view().t0, span: __smoke.tl.view().t1 - __smoke.tl.view().t0, spanBefore });
  })()`));
  check('拖滚动条平移时间轴',
    slid.after > slid.before + 0.2 && Math.abs(slid.span - slid.spanBefore) < 0.01,
    `视口左端 ${slid.before.toFixed(2)}s → ${slid.after.toFixed(2)}s（跨度不变 ${slid.span.toFixed(2)}s）`);

  // 5) 播放头出界时视口跟随
  await js(win, `(() => { __smoke.tl.setZoomLevel(55); __smoke.seekProgram(0); return 'ok'; })()`);
  await wait(200);
  const follow = JSON.parse(await js(win, `(async () => {
    const before = __smoke.tl.view().t0;
    __smoke.seekProgram(6);
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({ before, after: __smoke.tl.view().t0, pt: __smoke.tl.currentProgramTime() });
  })()`));
  check('播放头出界视口跟过去', follow.after > follow.before + 0.5 && follow.pt > 0,
    `视口左端 ${follow.before.toFixed(2)}s → ${follow.after.toFixed(2)}s`);
  await js(win, '__smoke.tl.fit(); "ok"');
  await wait(150);

  // 6) 逐帧与跳关键帧
  await js(win, '__smoke.seekProgram(0); "ok"');
  await wait(120);
  await js(win, '__smoke.stepFrames(1); "ok"');
  await wait(120);
  const oneFrame = await js(win, '__smoke.tl.progToSrc(__smoke.tl.currentProgramTime())');
  check('逐帧微调', Math.abs(oneFrame - 1 / media.fps) < 0.002, `一帧 = ${oneFrame.toFixed(4)}s`);
  await js(win, '__smoke.stepKeyframe(1); "ok"');
  await wait(120);
  const atKf = await js(win, '__smoke.tl.progToSrc(__smoke.tl.currentProgramTime())');
  check('跳到下一个关键帧', Math.abs(atKf - 2) < 0.001, `落在源 ${atKf}s`);

  // 7) W 分割：段数 +1，成片总长不变
  await js(win, '__smoke.seekProgram(3); __smoke.splitAtPlayhead(); "ok"');
  await wait(300);
  const splitState = JSON.parse(await js(win, 'JSON.stringify({clips: __smoke.state.clips, total: __smoke.programTotal()})'));
  check('W 在播放头处分割', splitState.clips.length === 2 && splitState.total === 10 && splitState.clips[1].ps === 3,
    JSON.stringify(splitState.clips.map((c) => `源${c.start}-${c.end}@${c.ps}`)));

  // 8) Q / E：删到上一个分割点、删到下一个分割点，剩下的自动并拢
  await js(win, '__smoke.seekProgram(5); __smoke.rippleDeleteBefore(); "ok"');
  await wait(350);
  const afterQ = JSON.parse(await js(win, 'JSON.stringify({clips: __smoke.state.clips, total: __smoke.programTotal()})'));
  check('Q 删到上一个分割点', afterQ.clips.length === 2 && afterQ.clips[1].start === 5 && afterQ.total === 8,
    JSON.stringify(afterQ.clips.map((c) => `源${c.start}-${c.end}@${c.ps}`)) + ` · 成片 ${afterQ.total}s`);
  check('时间轴按成片时间重排',
    (await js(win, 'document.querySelectorAll("#tlLane .seg").length')) === afterQ.clips.length);

  await js(win, '__smoke.seekProgram(6); __smoke.rippleDeleteAfter(); "ok"');
  await wait(350);
  const afterE = JSON.parse(await js(win, 'JSON.stringify({clips: __smoke.state.clips, total: __smoke.programTotal()})'));
  check('E 删到下一个分割点', afterE.clips.length === 2 && afterE.clips[1].end === 8 && afterE.total === 6,
    JSON.stringify(afterE.clips.map((c) => `源${c.start}-${c.end}@${c.ps}`)) + ` · 成片 ${afterE.total}s`);

  await js(win, '__smoke.undo(); __smoke.undo(); "ok"');
  await wait(350);
  check('撤销回到分割后的状态',
    (await js(win, '__smoke.state.clips.length')) === 2 && (await js(win, '__smoke.programTotal()')) === 10);
  await js(win, '__smoke.redo(); "ok"');
  await wait(300);
  check('重做再次执行 Q 的删除', (await js(win, '__smoke.programTotal()')) === 8);
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(300);

  // 8a) 拖"右段左端点"伸缩：手柄必须一直压在指针底下。
  //     旧实现拿 progToSrc(指针) 当新切点，指针一旦落进右段就取到右段的**源**坐标，
  //     端点先弹开"此前删掉的素材长度"（这里 3→5，即 2 秒 ≈ 100px），再按这个固定偏差跟鼠标。
  await js(win, '__smoke.seekProgram(3); __smoke.splitAtPlayhead(); __smoke.seekProgram(5); __smoke.rippleDeleteBefore(); "ok"');
  await wait(350);
  const handleState = JSON.parse(await js(win, 'JSON.stringify(__smoke.state.clips)'));
  const handle = JSON.parse(await js(win, '__t.dragHandle(1, 45).then((r) => JSON.stringify(r))'));
  const back = JSON.parse(await js(win, '__t.dragHandle(1, -30).then((r) => JSON.stringify(r))'));
  const dev = handle.trail.concat(back.trail).map((p) => Math.abs(p.got - p.want));
  check('拖右段左端点伸缩：手柄不弹开，两个方向都跟住指针',
    !handle.error && handleState.length === 2 && Math.max(...dev) <= 4,
    handle.error
      || `右拖 指针 ${handle.trail.map((p) => p.want).join('/')}px / 手柄 ${handle.trail.map((p) => p.got).join('/')}px · `
      + `左拖 指针 ${back.trail.map((p) => p.want).join('/')}px / 手柄 ${back.trail.map((p) => p.got).join('/')}px · `
      + `最大偏差 ${Math.max(...dev).toFixed(0)}px · 源区间 ${JSON.stringify(back.clips)}`);
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(250);

  // 8c) 切三段后逐段拖**右**端：只有右边那个切点能动。
  //     旧实现的命中判断不区分左右柄，第二段及以后拖右端其实在拖自己的左端。
  await js(win, '__smoke.seekProgram(3); __smoke.splitAtPlayhead(); __smoke.seekProgram(6); __smoke.splitAtPlayhead(); "ok"');
  await wait(350);
  for (const idx of [0, 1]) {
    const r = JSON.parse(await js(win, `__t.dragHandle(${idx}, 40, 'r').then((x) => JSON.stringify(x))`));
    if (r.error) { check(`第 ${idx + 1} 段拖右端：动的是右端的切点，左端纹丝不动`, false, r.error); continue; }
    const d = r.trail.map((p) => Math.abs(p.got - p.want));
    const moved = r.clips.map((c, i) => [c[0] - r.clips0[i][0], c[1] - r.clips0[i][1]]);
    const cut = moved[idx][1];
    // 右端那个切点是"本段末 = 下段起"同一个值，必须一起动；
    // 真正要盯住不动的是本段的左端和上一段的右端 —— 拖错边就动的是它们。
    const together = Math.abs(moved[idx + 1][0] - cut) < 0.02;
    const leftIntact = Math.abs(moved[idx][0]) < 0.02 && (idx === 0 || Math.abs(moved[idx - 1][1]) < 0.02);
    check(`第 ${idx + 1} 段拖右端：动的是右端的切点，左端纹丝不动`,
      Math.max(...d) <= 4 && r.otherDrift <= 4 && Math.abs(cut) > 0.15 && together && leftIntact,
      `偏差 ${d.map((x) => x.toFixed(0)).join('/')}px · 对侧漂移 ${r.otherDrift}px · `
      + `切点增量 ${moved.map((m) => m.map((v) => v.toFixed(2)).join('~')).join(' | ')} · 源区间 ${JSON.stringify(r.clips)}`);
    await js(win, '__smoke.undo(); "ok"');
    await wait(250);
  }
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(250);

  // 8b) J/K/L 走带：L 正放逐档加快，J 倒带逐档加快，Shift+L 慢放，Shift+J 慢倒，K 停并复位
  await js(win, '__smoke.seekProgram(0); __smoke.stepRate(1, false); "ok"');
  await wait(450);
  const r1 = JSON.parse(await js(win,
    'JSON.stringify({ rate: __smoke.state.rate, paused: document.getElementById("player").paused, tag: document.getElementById("rateTag").textContent })'));
  await js(win, '__smoke.stepRate(1, false); __smoke.stepRate(1, false); "ok"');
  await wait(300);
  const rUp = JSON.parse(await js(win, 'JSON.stringify({ rate: __smoke.state.rate, tag: document.getElementById("rateTag").textContent })'));
  check('L 正放并逐档加快', r1.rate === 1 && !r1.paused && rUp.rate === 4 && rUp.tag === '4×',
    `1× → 2× → ${rUp.rate}×，速率标记 "${rUp.tag}"`);

  // 快进到 16× 封顶，再按要报"已经是最快"
  await js(win, '__smoke.stepRate(1, false); __smoke.stepRate(1, false); __smoke.stepRate(1, false); "ok"');
  await wait(200);
  const rMax = await js(win, '__smoke.state.rate');
  check('快进封顶 16×', rMax === 16, `顶到 ${rMax}×`);

  // 反向切档：正在 16× 正放时按 J，必须从 -1× 起倒，而不是一下跳到 -16×
  await js(win, `(() => {
    window.__evlog = [];
    const p = document.getElementById('player');
    ['pause','play','seeked'].forEach((ev) => p.addEventListener(ev, () => window.__evlog.push([performance.now().toFixed(0), ev, 'rate=' + __smoke.state.rate, 'ct=' + p.currentTime.toFixed(2)]), true));
    return 'ok';
  })()`);
  await js(win, '__smoke.seekProgram(6); __smoke.stepRate(-1, false); "ok"');
  await wait(80);
  const mid = JSON.parse(await js(win, `JSON.stringify({
    rate: __smoke.state.rate, pt: __smoke.tl.currentProgramTime(), ct: document.getElementById('player').currentTime })`));
  await wait(170);
  const rRev1 = JSON.parse(await js(win,
    'JSON.stringify({ rate: __smoke.state.rate, paused: document.getElementById("player").paused, tag: document.getElementById("rateTag").textContent, pt: __smoke.tl.currentProgramTime() })'));
  check('J 从正放切到倒带时从 -1× 起步', rRev1.rate === -1 && rRev1.paused && rRev1.tag === '-1×',
    `16× 正放 → 按 J → ${rRev1.rate}×（80ms 时 pt=${mid.pt}）`);

  // 倒带真的在往回走：等一会儿，播放头必须比刚才更靠前（时间更小）
  const revBefore = await js(win, '__smoke.tl.currentProgramTime()');
  await wait(700);
  const revAfter = await js(win, '__smoke.tl.currentProgramTime()');
  const evlog = await js(win, '(window.__evlog || []).slice(0, 14).map((r) => r.join(" ")).join(" | ")');
  check('倒带时播放头真的往回走', revAfter < revBefore - 0.05,
    `rate=${rRev1.rate} ${revBefore.toFixed(3)}s → ${revAfter.toFixed(3)}s（退了 ${(revBefore - revAfter).toFixed(3)}s）`
    + ` · 事件: ${evlog}`);

  // 画面泵连续追帧：视频的 currentTime 在倒带期间必须持续更新（= 多次 seek 落定），
  // 旧版 rAF 抢跑把 seek 全打断，currentTime 一次都不动、画面冻结
  const vidA = await js(win, 'document.getElementById("player").currentTime');
  await wait(600);
  const vidB = await js(win, 'document.getElementById("player").currentTime');
  check('倒带时画面在连续追帧（currentTime 持续更新）', vidB < vidA - 0.05,
    `${vidA.toFixed(3)}s → ${vidB.toFixed(3)}s`);
  check('倒带时画面与播放头不脱节', Math.abs(vidB - revAfter) < 1.5,
    `画面 ${vidB.toFixed(3)}s · 播放头 ${revAfter.toFixed(3)}s`);

  await js(win, '__smoke.stepRate(-1, false); __smoke.stepRate(-1, false); "ok"');
  await wait(200);
  const rRevUp = await js(win, '__smoke.state.rate');
  check('J 逐档加快倒带', rRevUp === -4, `-1× → -2× → ${rRevUp}×`);

  // Shift+J 慢速倒带：从快档进来落在 -1×，再按逐档变慢
  await js(win, '__smoke.stepRate(-1, true); "ok"');
  await wait(200);
  const rSlowRev1 = await js(win, '__smoke.state.rate');
  await js(win, '__smoke.stepRate(-1, true); "ok"');
  await wait(200);
  const rSlowRev2 = await js(win, '__smoke.state.rate');
  check('Shift+J 慢速倒带逐档变慢', rSlowRev1 === -1 && rSlowRev2 === -0.75,
    `-4× 快档 → Shift+J 进 ${rSlowRev1}× → ${rSlowRev2}×`);

  await js(win, '__smoke.pausePlayback(); "ok"');
  await wait(300);
  const rStop = JSON.parse(await js(win,
    'JSON.stringify({ paused: document.getElementById("player").paused, rate: __smoke.state.rate, tag: document.getElementById("rateTag").textContent })'));
  check('K 暂停并复位速率', rStop.paused && rStop.rate === 1 && rStop.tag === '', `rate=${rStop.rate} 标记 "${rStop.tag}"`);

  // 停住之后播放头不许再自己动（倒带循环必须真的被掐掉）
  const haltA = await js(win, '__smoke.tl.currentProgramTime()');
  await wait(500);
  const haltB = await js(win, '__smoke.tl.currentProgramTime()');
  check('K 之后倒带循环彻底停下', Math.abs(haltB - haltA) < 1e-6, `${haltA.toFixed(3)}s → ${haltB.toFixed(3)}s`);

  // Shift+L 慢放：正放档位里没有 1.5× 了，细档是 1 → 0.75 → 0.5 → 0.25
  await js(win, '__smoke.seekProgram(3); __smoke.stepRate(1, true); "ok"');
  await wait(250);
  const rSlow1 = await js(win, '__smoke.state.rate');
  await js(win, '__smoke.stepRate(1, true); "ok"');
  await wait(200);
  const rSlow2 = await js(win, '__smoke.state.rate');
  await js(win, '__smoke.pausePlayback(); "ok"');
  await wait(200);
  check('Shift+L 慢放逐档变慢', rSlow1 === 1 && rSlow2 === 0.75, `1× → ${rSlow2}×`);

  // 8c) Backspace：删掉**鼠标选中的高亮段**（不是播放头停靠段——两者可以停在不同段上）
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(300);
  await js(win, '__smoke.seekProgram(3); __smoke.splitAtPlayhead(); __smoke.seekProgram(7); __smoke.splitAtPlayhead(); "ok"');
  await wait(400);
  const beforeBs = JSON.parse(await js(win, 'JSON.stringify({ n: __smoke.state.clips.length, total: __smoke.programTotal() })'));
  // 播放头停在第 1 段（seek 3），鼠标点选第 3 段（源 7-10）→ Backspace 删的必须是第 3 段
  await js(win, '__smoke.seekProgram(5); __t.clickFilm(8); "ok"');
  await wait(300);
  await js(win, '__smoke.deleteClipAtPlayhead(); "ok"');
  await wait(400);
  const afterBs = JSON.parse(await js(win, 'JSON.stringify({ n: __smoke.state.clips.length, total: __smoke.programTotal(), clips: __smoke.state.clips })'));
  check('Backspace 删掉选中的高亮段',
    beforeBs.n === 3 && afterBs.n === 2 && afterBs.total === 7 && afterBs.clips[1].start === 3,
    `${beforeBs.n} 段 ${beforeBs.total}s → ${afterBs.n} 段 ${afterBs.total}s（删的是源 7-10 那段）`);
  await js(win, '__smoke.undo(); "ok"');
  await wait(300);
  check('撤销恢复被删的整段', (await js(win, '__smoke.state.clips.length')) === 3);

  // 8d) 键位面板：默认表 + 面板渲染 + 真按一次 Backspace
  const binds = JSON.parse(await js(win, 'JSON.stringify({ del: __smoke.bindingFor("deleteClip"), rb: __smoke.bindingFor("rippleBefore") })'));
  check('退格已绑到删除整段', binds.del.includes('backspace') && binds.rb.includes('q'),
    `删除整段 = ${binds.del.join('/')}, Q = ${binds.rb.join('/')}`);
  await js(win, '__smoke.openKeys(); "ok"');
  await wait(200);
  const panel = JSON.parse(await js(win,
    'JSON.stringify({ rows: document.querySelectorAll(".modal.keys .m-chip").length, plain: document.querySelectorAll(".modal.keys .m-row").length, title: (document.querySelector(".modal.keys h3") || {}).textContent })'));
  check('header 快捷键面板可打开', panel.rows >= 20 && panel.plain === panel.rows && /快捷键/.test(panel.title || ''),
    `${panel.rows} 行动作，全部走 .m-row 行语言`);
  // 8d-1) 快捷键 / 导入 / 导出三个模态必须共用同一套行语言，样式只能来自一份 CSS
  const lang = JSON.parse(await js(win, `JSON.stringify((() => {
    document.getElementById('btnImportOpen').click();
    document.getElementById('btnExportOpen').click();
    const cs = (sel, props) => {
      const s = getComputedStyle(document.querySelector(sel));
      const o = {};
      for (const p of props) o[p] = s[p];
      return o;
    };
    const chip = ['.modal.keys .m-chip', '#importMask .m-chip']
      .map((sel) => cs(sel, ['fontFamily', 'fontSize', 'backgroundColor', 'borderRadius', 'borderBottomWidth', 'padding']));
    const foot = ['.modal.keys .m-foot', '#importMask .m-foot', '#exportMask .m-foot']
      .map((sel) => cs(sel, ['borderTopWidth', 'borderTopColor', 'gap', 'paddingTop']));
    const panel = ['.modal.keys', '#importMask .modal', '#exportMask .modal']
      .map((sel) => cs(sel, ['backgroundColor', 'borderRadius', 'paddingTop', 'paddingLeft']));
    const same = (a) => a.every((x) => JSON.stringify(x) === JSON.stringify(a[0]));
    const rows = ['#importMask', '#exportMask'].map((sel) => document.querySelectorAll(sel + ' .m-row').length);
    __t.closeMasks();
    return {
      chipSame: same(chip), footSame: same(foot), panelSame: same(panel), rows,
      legacy: document.querySelectorAll('.modal .opt, .modal .field, .modal .estimate, .modal .k-chip, .modal .keys-foot').length,
    };
  })())`));
  check('三个模态同一套设计语言',
    lang.chipSame && lang.footSame && lang.panelSame && lang.rows.every((n) => n >= 1) && lang.legacy === 0,
    `键帽 ${lang.chipSame} · 页脚 ${lang.footSame} · 面板 ${lang.panelSame} · 行 ${lang.rows.join('/')} · 旧样式残留 ${lang.legacy}`);
  await js(win, 'document.querySelector(".modal-mask.keys").remove(); "ok"');
  const nBeforeKey = await js(win, '__smoke.state.clips.length');
  await js(win, `(() => { __smoke.seekProgram(4); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })); return 'ok'; })()`);
  await wait(400);
  check('按真实 Backspace 键真的删了', (await js(win, '__smoke.state.clips.length')) === nBeforeKey - 1,
    `${nBeforeKey} → ${await js(win, '__smoke.state.clips.length')} 段`);
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(300);

  // 8e) 缩略胶片：主进程抽帧成小图并落到缓存目录
  const thumbInfo = JSON.parse(await js(win, 'JSON.stringify(__smoke.state.thumbs || {})'));
  const thumbFiles = thumbInfo.dir && fs.existsSync(thumbInfo.dir)
    ? fs.readdirSync(thumbInfo.dir).filter((n) => n.endsWith('.jpg')).length : 0;
  await wait(600);
  const filmDraws = await js(win, '__smoke.tl.filmDraws');
  check('时间轴胶片条已生成并画上画布',
    thumbInfo.count > 0 && thumbInfo.final && thumbFiles >= thumbInfo.count && filmDraws >= thumbInfo.count,
    `${thumbFiles} 张在盘上 / 一帧里画了 ${filmDraws} 格${thumbInfo.final ? '' : '（没收到完成信号）'}`);

  // 8f) 缓存全命中时主进程会在渲染层认源之前就把胶片推出来，必须还能画上去
  await js(win, `__smoke.importFile(${JSON.stringify(SRC)}); 'ok'`);
  await waitFor('__smoke.state.src && __smoke.state.scanning === false', win);
  // 定长 sleep 会漂（画胶片排在 rAF 之后），改成轮询到画完为止
  await waitFor('__smoke.tl.filmDraws >= ((__smoke.state.thumbs || {}).count || 0)', win, 15000);
  const warm = JSON.parse(await js(win, 'JSON.stringify({ thumbs: (__smoke.state.thumbs || {}).count || 0, draws: __smoke.tl.filmDraws })'));
  check('第二次导入（全走缓存）胶片条还在', warm.thumbs > 0 && warm.draws >= warm.thumbs,
    `胶片 ${warm.thumbs} 张 / 一帧里画了 ${warm.draws} 格`);

  // 8g) 任何倍率下胶片都必须：换到对应档位、铺满、且不靠放大来铺
  const filmAt = async (level) => {
    await js(win, `__smoke.tl.setZoomLevel(${level}); "ok"`);
    const settled = await waitFor('__smoke.tl.filmReady()', win, 30000);
    await wait(150);
    const stat = JSON.parse(await js(win, `(() => {
      const c = document.getElementById('tlCanvas');
      const dpr = window.devicePixelRatio || 1;
      const pad = Math.round(__smoke.tl.edgePad() * dpr);
      const w = c.width - pad * 2;
      const row = c.getContext('2d').getImageData(pad, Math.round((24 + 24) * dpr), w, 1).data;
      let gap = 0;
      for (let x = 0; x < w; x++) if (row[x * 4 + 3] === 0) gap++;
      const f = __smoke.tl.film();
      return JSON.stringify({ gap: gap / w, step: f.step, cells: f.cells, wantStep: f.want && f.want.step,
                              minCell: Math.round(f.minCell), maxCell: Math.round(f.maxCell), maxScale: +f.maxScale.toFixed(2) });
    })()`));
    return { settled, ...stat };
  };
  const f0 = await filmAt(0);
  const f55 = await filmAt(55);
  const f92 = await filmAt(92);
  await js(win, '__smoke.tl.fit(); "ok"');
  await wait(150);
  const films = [f0, f55, f92];
  check('放大到任何倍率胶片都铺满', films.every((f) => f.gap < 0.02),
    `车道中线空隙：适应 ${(f0.gap * 100).toFixed(1)}% · 55 级 ${(f55.gap * 100).toFixed(1)}% · 92 级 ${(f92.gap * 100).toFixed(1)}%`);
  check('胶片按缩放换档，不重叠也不放大',
    films.every((f) => f.settled && f.step === f.wantStep && f.cells >= 6 && f.maxScale <= 1.02)
      && f92.step < f0.step && films.every((f) => f.minCell >= 24 && f.maxCell <= 170),
    `间隔 ${f0.step}s→${f92.step}s · 格宽 ${f0.minCell}-${f0.maxCell} / ${f92.minCell}-${f92.maxCell}px · `
    + `最大放大倍率 ${Math.max(...films.map((f) => f.maxScale))} · 每屏 ${films.map((f) => f.cells).join('/')} 格 · `
    + `等位 ${films.map((f) => f.settled).join('/')}`);

  // 8h) 刻度尺：标签既不能互相压字，也不能整行重复同一个字符串（小时素材曾全印成 "2h"）
  const ruler = JSON.parse(await js(win, `(() => {
    const ctx = document.getElementById('tlCanvas').getContext('2d');
    ctx.font = '10px Consolas, monospace';
    const probe = () => {
      const r = __smoke.tl.ruler;
      const bad = [];
      for (let i = 0; i + 1 < r.labels.length; i++) {
        const w = ctx.measureText(r.labels[i].label).width;
        if (r.labels[i + 1].x - (r.labels[i].x + 3 + w) < 6) bad.push(r.labels[i].label);
      }
      return { step: r.step, n: r.labels.length, uniq: new Set(r.labels.map((l) => l.label)).size,
               bad: bad.slice(0, 2), sample: r.labels.slice(0, 3).map((l) => l.label).join(' ') };
    };
    const out = {};
    for (const lv of [0, 40, 55, 92]) { __smoke.tl.setZoomLevel(lv); out['z' + lv] = probe(); }
    __smoke.tl.fit();
    return JSON.stringify(out);
  })()`));
  const rulerBad = Object.entries(ruler).filter(([, v]) => v.bad.length || v.uniq !== v.n);
  check('刻度标签不重叠且互不重复', rulerBad.length === 0,
    rulerBad.length ? rulerBad.map(([k, v]) => `${k}:${v.bad.join('|') || v.n + '格重名'}`).join(' ')
      : `四档共 ${Object.values(ruler).map((v) => v.n).join('/')} 格，间隔 ${ruler.z0.step}s，如 "${ruler.z0.sample}"`);

  // 9) 三种导出模式（先留两段，「每段一个文件」才有意义）
  await js(win, `(() => {
    __smoke.seekProgram(3); __smoke.splitAtPlayhead();
    __smoke.seekProgram(7); __smoke.splitAtPlayhead();
    __smoke.seekProgram(5); __smoke.rippleDeleteBefore();
    return 'ok';
  })()`);
  await wait(300);
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'exact'); 'ok'`);
  await wait(250);
  // 界面先给个说法：导出前那行"成片 …"说的秒数，必须和真导出来的时长对得上。
  // （98 分钟的 .mkv 就翻在这里：界面按选区报 8 秒，产物却是整部片，自检还判通过。）
  const promised = await js(win, `(() => {
    const m = document.getElementById('estimate').textContent.match(/成片\\s+(\\d+):(\\d\\d):(\\d\\d)/);
    if (!m) return -1;
    const plan = (__smoke.state.plan.plan || []).reduce((a, p) => a + p.duration, 0);
    return JSON.stringify({ shown: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), plan });
  })()`);
  const promise = promised === -1 ? null : JSON.parse(promised);
  // 剪辑语义随模式分叉：精确模式（勾选）每段起点必须就是用户入点、一秒不许前移；
  // 吸附模式（默认）每段起点必须落在关键帧上、且**绝不越过上一段出点**（防吞钳制，98 分钟 .mkv 的教训）
  const modeCheck = JSON.parse(await js(win, `(() => {
    const precise = document.getElementById('optPrecise') ? document.getElementById('optPrecise').checked : true;
    const keeps = __smoke.state.plan.keeps, parts = __smoke.state.plan.plan || [];
    let bad;
    if (precise) {
      bad = keeps.map((k, i) => [i, k, parts.filter((p) => p.keepIndex === i)[0]])
        .filter(([, k, p]) => p && p.start > k.start + 0.001)
        .map(([i]) => i);
    } else {
      // 吸附：每段起点必须是关键帧（或 0），且 ≥ 上一条保留段的出点（防吞）——
      // 上一段出点恰好是关键帧时允许相等（首尾相接不吞内容）
      bad = keeps.map((k, i) => {
        const p = parts.filter((q) => q.keepIndex === i)[0];
        if (!p) return i;
        if (k.start > 0.001 && p.start > k.start + 0.001) return i;          // 段起点晚于入点 = 跳过了内容
        if (i > 0 && p.start < keeps[i - 1].end - 0.001) return i;           // 越过上一段出点 = 吞了间隙
        return null;
      }).filter((v) => v !== null);
    }
    return JSON.stringify({ bad, n: parts.length, precise });
  })()`));
  check(modeCheck.precise
    ? '计划不回溯关键帧：每段起点就是用户选的入点'
    : '吸附模式：每段起点落在关键帧上，且绝不越过上一段出点（防吞）',
    modeCheck.bad.length === 0,
    JSON.stringify(modeCheck.bad) + `（共 ${modeCheck.n} 个切割段，precise=${modeCheck.precise}）`);
  let res = await runExport(win);
  check('拼接导出通过自检', res.ok && res.outputs.length === 1, res.detail);
  if (res.ok && promise) {
    const real = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
      path.join(OUT_DIR, 'exact.mp4')], { encoding: 'utf8' }).trim());
    check('界面预估的成片时长 = 实际产物，且不吞掉已删素材',
      Math.abs(promise.shown - real) <= 0.25 && Math.abs(promise.plan - real) <= 0.25,
      `预估 ${promise.shown}s · 计划 ${promise.plan.toFixed(3)}s · 实际 ${real.toFixed(3)}s（允差 0.25s）`);
    const names = JSON.parse(await js(win, `JSON.stringify([...document.querySelectorAll('#checks li')].map((li) => li.textContent))`));
    check('自检里有「帧数符合切割计划」这条硬判据',
      names.some((t) => t.includes('帧数符合切割计划')), names.join('、').slice(0, 200));
  }

  const groups = await js(win, 'new Set(__smoke.state.plan.plan.map((p) => p.keepIndex)).size');
  await js(win, `__smoke.setOption('optSplit', true); __smoke.setOut(${JSON.stringify(OUT_DIR)}, 'split'); 'ok'`);
  await wait(250);
  res = await runExport(win);
  check('每段一个文件通过自检', res.ok && res.outputs.length === groups, `${res.detail}（计划 ${groups} 组）`);
  await js(win, `__smoke.setOption('optSplit', false); 'ok'`);
  await wait(250);

  // 9-snap) 勾「精确模式」：计划回到"入点一秒不动"，导出仍通过自检 —— 两种模式都验到
  await js(win, `__smoke.setOption('optPrecise', true); __smoke.setOut(${JSON.stringify(OUT_DIR)}, 'precise'); 'ok'`);
  await wait(300);
  const precisePlan = JSON.parse(await js(win, `(() => {
    const keeps = __smoke.state.plan.keeps, parts = __smoke.state.plan.plan || [];
    const bad = keeps.map((k, i) => [i, parts.filter((p) => p.keepIndex === i)[0]])
      .filter(([, k, p]) => p && p.start > k.start + 0.001).map(([i]) => i);
    return JSON.stringify({ bad, reencodes: parts.filter((p) => p.kind === 'reencode').length });
  })()`));
  check('精确模式勾选后：计划回到入点不回溯，且有重编码段',
    precisePlan.bad.length === 0 && precisePlan.reencodes > 0,
    `坏段 ${JSON.stringify(precisePlan.bad)} · 重编码段 ${precisePlan.reencodes}`);
  res = await runExport(win);
  check('精确模式导出通过自检', res.ok && res.outputs.length === 1, res.detail);
  await js(win, `__smoke.setOption('optPrecise', false); 'ok'`);
  await wait(250);

  // 9-snap-viz) 吸附多带可视化：吸附模式下时间轴画出半透明延伸块，精确模式下消失。
  // 直接断言 timeline 暴露的绘制统计（比读像素稳：胶片缩略图本身含绿色内容）。
  // refreshPlan 是异步的（120ms debounce + IPC 往返），必须等"新计划已到且已重渲染"
  // 再读 snapExtras，否则读到的是上一模式的渲染（renderSeq 不变 = 还没重画）。
  const waitPlanMode = async (precise) => {
    const seq0 = await js(win, '__smoke.tl.renderSeq');
    const ok = await waitFor(
      `__smoke.state.plan && __smoke.state.plan.precise === ${precise} && __smoke.tl.renderSeq > ${seq0}`, win, 8000);
    if (!ok) {
      const diag = await js(win, `JSON.stringify({ planP: __smoke.state.plan && __smoke.state.plan.precise, box: document.getElementById('optPrecise').checked, seq: __smoke.tl.renderSeq, seq0: ${seq0} })`);
      throw new Error(`等待计划切到 precise=${precise} 超时 · 现场 ${diag}`);
    }
  };

  await js(win, `__smoke.setOption('optPrecise', false); 'ok'`);
  await waitPlanMode(false);
  const viz = JSON.parse(await js(win, 'JSON.stringify(__smoke.tl.snapExtras)'));
  check('吸附模式：时间轴画出"多带"延伸块', viz.count > 0 && viz.px > 4,
    `${viz.count} 块 · 总宽 ${viz.px.toFixed(0)}px`);
  await js(win, `__smoke.setOption('optPrecise', true); 'ok'`);
  await waitPlanMode(true);
  const viz2 = JSON.parse(await js(win, 'JSON.stringify(__smoke.tl.snapExtras)'));
  check('精确模式：延伸块消失', viz2.count === 0 && viz2.px === 0,
    `${viz2.count} 块 · 总宽 ${viz2.px.toFixed(0)}px`);

  // 9a) 用真实指针拖胶片：改顺序，且绝不移动播放头
  const orderBefore = JSON.parse(await js(win, 'JSON.stringify(__smoke.state.clips.map((c) => c.start + "-" + c.end))'));
  const filmDrag = JSON.parse(await js(win, '__t.dragFilm(1, 7).then((r) => JSON.stringify(r))'));
  const orderAfter = JSON.parse(await js(win, 'JSON.stringify(__smoke.state.clips.map((c) => c.start + "-" + c.end))'));
  check('拖胶片改顺序且播放头纹丝不动',
    orderBefore.join(',') !== orderAfter.join(',') && filmDrag.before === filmDrag.after,
    `${orderBefore.join(' ')} → ${orderAfter.join(' ')} · 播放头停在 ${filmDrag.after}s`);
  await js(win, '__smoke.undo(); "ok"');
  await wait(350);
  const clicked = JSON.parse(await js(win, '__t.clickFilm(6).then((r) => JSON.stringify(r))'));
  check('单击胶片只选中不跳时间戳', clicked.before === clicked.after && clicked.sel >= 0,
    `播放头 ${clicked.after}s · 选中第 ${clicked.sel + 1} 段`);

  // 9b) 拖动改顺序：数组顺序 ≠ 源顺序时，内核必须按用户顺序逐段导出
  await js(win, '__smoke.reorderClip(2, 0); "ok"');
  // 计划是异步刷的（previewPlan 走 IPC），胶片那边正忙着抽格子时 400ms 不够，必须等它落地
  await waitFor('__smoke.state.plan && __smoke.state.plan.ordered', win);
  const moved = JSON.parse(await js(win, 'JSON.stringify({ clips: __smoke.state.clips, total: __smoke.programTotal(), ordered: !!(__smoke.state.plan && __smoke.state.plan.ordered) })'));
  check('拖动改变片段顺序', moved.clips[0].start === 7 && moved.total === 8,
    JSON.stringify(moved.clips.map((c) => `源${c.start}-${c.end}@${c.ps}`)));
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'reordered'); 'ok'`);
  await wait(250);
  res = await runExport(win);
  check('乱序拼接导出通过自检', res.ok && res.outputs.length === 1 && moved.ordered, res.detail);
  await js(win, '__smoke.undo(); __smoke.undo(); "ok"');
  await wait(350);

  // 10) 截图：正常态 / 放大且正在拖手柄 / 导出结果面板
  await js(win, '__smoke.seekProgram(2.5); "ok"');
  await wait(300);
  // 导出成功后面板会自动展开，基线图得先把它收起来，否则右栏一直被挡着
  await js(win, `(() => {
    document.getElementById('exportMask').classList.add('hidden');
    document.getElementById('menuPop').classList.add('hidden');
    return 'ok';
  })()`);
  await wait(200);
  win.show();
  win.focus();
  await wait(700);
  await shoot(win, 'smoke-ui.png');
  await js(win, `(() => {
    __smoke.tl.setZoomLevel(62);
    __smoke.seekProgram(2.4);
    document.getElementById('tlPlayhead').classList.add('dragging');
    return 'ok';
  })()`);
  await wait(300);
  await shoot(win, 'smoke-ui-zoom.png');
  await js(win, `(() => {
    document.getElementById('tlPlayhead').classList.remove('dragging');
    __smoke.tl.fit();
    document.getElementById('exportMask').classList.remove('hidden');
    return 'ok';
  })()`);
  await wait(300);
  await shoot(win, 'smoke-ui-export.png');
  await js(win, `(() => {
    document.getElementById('exportMask').classList.add('hidden');
    return 'ok';
  })()`);
  // 三个模态各拍一张：并排看才知道设计语言到底统一了没有
  for (const [name, code] of [
    ['smoke-ui-keys.png', '__smoke.openKeys(); \'ok\''],
    ['smoke-ui-import.png', 'document.getElementById("importMask").classList.remove("hidden"); \'ok\''],
  ]) {
    await js(win, `(() => { ${code} })()`);
    await wait(300);
    await shoot(win, name);
    await js(win, `(() => {
      const k = document.querySelector('.modal-mask.keys');
      if (k) k.remove();
      document.getElementById('importMask').classList.add('hidden');
      return 'ok';
    })()`);
  }

  // 11) 目标重名必须拒绝，绝不覆盖（用本轮真正导出过的名字 'exact'）
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'exact'); 'ok'`);
  await wait(250);
  const refused = await js(win, '__smoke.runExport().then(() => document.getElementById("error").textContent)');
  check('重名时拒绝覆盖', /已存在/.test(String(refused)), String(refused).slice(0, 60));

  // 12) 一直按 Q 也不许把素材删空
  await js(win, '__smoke.resetClips(); "ok"');
  await wait(300);
  await js(win, `(() => {
    for (let i = 0; i < 12; i++) {
      __smoke.seekProgram(__smoke.programTotal());
      __smoke.rippleDeleteBefore();
    }
    return 'ok';
  })()`);
  await wait(600);
  const left = JSON.parse(await js(win, 'JSON.stringify({ n: __smoke.state.clips.length, total: __smoke.programTotal() })'));
  check('不许把素材删空', left.n >= 1 && left.total > 0, `还剩 ${left.n} 段 / ${left.total}s`);
  check('删到只剩一段仍可导出', await js(win, '!document.getElementById("btnExport").disabled'));

  const outs = fs.readdirSync(OUT_DIR);
  check('产物落在指定目录', outs.length > 0, outs.join(', '));

  // 13) remux 换封装：mp4 源出 mkv，自检必须认"所选容器"，不能再拿"与源一致"当判据
  await js(win, '__smoke.setContainer("mkv"); "ok"');
  await waitFor('document.getElementById("outExt").textContent === ".mkv"', win);
  const extShown = await js(win, 'document.getElementById("outExt").textContent');
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'remux'); 'ok'`);
  await wait(200);
  res = await runExport(win);
  const remuxChecks = await js(win,
    `[...document.querySelectorAll('#checks li')].map((li) => (li.classList.contains('bad') ? '✗' : '✓') + li.textContent).join(' | ')`);
  check('remux 成 MKV 通过自检',
    res.ok && extShown === '.mkv' && /容器为所选封装/.test(remuxChecks) && !/容器一致/.test(remuxChecks),
    `后缀 ${extShown} · ${String(remuxChecks).replace(/\s+/g, ' ').slice(0, 100)}`);

  // 14) 目标装不下的字幕轨：导出前就要在预估里说清楚，导出后整条省略而不是让 ffmpeg 崩
  const subMkv = ensureSubtitleSource();
  await js(win, `__smoke.importFile(${JSON.stringify(subMkv)}); 'ok'`);
  await waitFor(`__smoke.state.src && __smoke.state.src.file === ${JSON.stringify(subMkv)}`, win);
  await js(win, '__smoke.setContainer("mp4"); "ok"');
  const warned = await waitFor('document.getElementById("estimate").textContent.includes("装不下字幕轨")', win);
  const warnLine = await js(win, 'document.getElementById("estimate").textContent.split("\\n").find((l) => l.includes("字幕")) || ""');
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'remux-sub'); 'ok'`);
  await wait(200);
  res = await runExport(win);
  const subChecks = await js(win,
    `[...document.querySelectorAll('#checks li')].map((li) => (li.classList.contains('bad') ? '✗' : '✓') + li.textContent).join(' | ')`);
  check('字幕装不下时整条省略且仍通过自检',
    warned && res.ok && /容器为所选封装/.test(subChecks) && /✓字幕轨已按所选容器省略/.test(subChecks)
      && /音轨数量一致/.test(subChecks) && !/字幕轨数量一致/.test(subChecks),
    `预估「${String(warnLine).trim().slice(0, 46)}」· ${String(subChecks).replace(/\s+/g, ' ').slice(0, 90)}`);
  await js(win, '__smoke.setContainer("source"); "ok"');

  // 15) HEVC 精确模式：入点在 GOP 中间 + 拷贝到源尾（旧版必报"帧数符合切割计划"失败）
  //     根因是两层：①混拼参数集不一致（修复：拷贝段内嵌源参数集）；
  //     ②RASL 剥除帧数没从预期里扣（修复：计划侧记账）。这里用真实 HEVC 素材各验一遍。
  const hevcSrc = ensureHevcSource();
  await js(win, `__smoke.importFile(${JSON.stringify(hevcSrc)}); 'ok'`);
  await waitFor(`__smoke.state.src && __smoke.state.src.file === ${JSON.stringify(hevcSrc)}`, win);
  await waitFor('__smoke.state.scanning === false', win, 20000);
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'hevc-precise'); __smoke.setOption("optPrecise", true); __smoke.setContainer("source"); 'ok'`);
  await js(win, '__smoke.seekProgram(2); __smoke.splitAtPlayhead(); __smoke.seekProgram(0); __smoke.rippleDeleteAfter(); "ok"');
  await wait(500);
  await js(win, `__smoke.setOut(${JSON.stringify(OUT_DIR)}, 'hevc-precise'); 'ok'`);
  await wait(300);
  res = await runExport(win);
  check('HEVC 精确模式（入点在 GOP 中间、拷到源尾）通过自检', res.ok, res.detail);

  await longFileCheck(win);
  finish(win);
}

/**
 * 精确模式 HEVC 用例的素材：x265 open-gop、关键帧每 4s 一个（GOP 120）、12 秒。
 * 入点切在 2s（GOP 中间）→ 计划 = 重编码 [2,4) + 流拷贝 [4,12)；
 * 拷贝段里有关键帧 8s（RASL 记账）+ 两段参数集不同（hvcC 单份），两条坑都踩得到。
 */
function ensureHevcSource() {
  const out = path.join(ROOT, 'tmp', 'smoke-hevc-gop4.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 10000) return out;
  const ffmpeg = resolveBin('ffmpeg', [path.join(ROOT, 'vendor', 'ffmpeg')]);
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-g', '120', '-keyint_min', '120',
    '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out,
  ], { stdio: 'ignore' });
  return out;
}

/**
 * remux 字幕用例的素材：H.264 + 两条 AAC + 一条 subrip。
 * 只有 mkv 装得下 subrip（实测 mp4 muxer 直接 "Could not find tag for codec subrip"），
 * 所以它同时是"跟随源"和"换封装省略字幕"两条路的样本。
 */
function ensureSubtitleSource() {
  const out = path.join(ROOT, 'tmp', 'smoke-subtitles.mkv');
  if (fs.existsSync(out) && fs.statSync(out).size > 10000) return out;
  const ffmpeg = resolveBin('ffmpeg', [path.join(ROOT, 'vendor', 'ffmpeg')]);
  const srt = path.join(ROOT, 'tmp', 'smoke-subtitles.srt');
  fs.writeFileSync(srt, '1\n00:00:00.500 --> 00:00:02.000\n第一条字幕\n\n2\n00:00:04.000 --> 00:00:06.000\n第二条字幕\n');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-g', '60', '-keyint_min', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-c:s', 'srt', out,
  ], { stdio: 'ignore' });
  return out;
}

async function runExport(win) {
  await js(win, '__smoke.runExport()');
  const state = JSON.parse(await js(win, `JSON.stringify({
    outputs: __smoke.state.outputs,
    error: document.getElementById("error").classList.contains("hidden") ? '' : document.getElementById("error").textContent,
    badChecks: [...document.querySelectorAll('#checks li.bad')].map((li) => li.textContent),
    pct: document.getElementById("progressPct").textContent,
  })`));
  return {
    ok: !state.error && state.badChecks.length === 0 && state.outputs.length > 0,
    outputs: state.outputs,
    detail: state.error ? state.error.slice(0, 160)
      : (state.badChecks.length ? state.badChecks.join(' / ').slice(0, 160) : `${state.outputs.length} 个文件 ${state.pct}`),
  };
}

/** 抓一帧窗口图；Windows 上窗口未被合成器绘制时会拿到空图，重试一次。 */
async function shoot(win, name) {
  let img = await win.webContents.capturePage();
  if (img.toPNG().length === 0) {
    win.hide();
    win.show();
    await wait(1200);
    img = await win.webContents.capturePage();
  }
  const buf = img.toPNG();
  fs.writeFileSync(path.join(ROOT, 'tmp', name), buf);
  check(`截图 ${name}`, buf.length > 0, `${img.getSize().width}x${img.getSize().height}`);
}

/**
 * 长视频专项：有 tmp/long30.mp4（30 min / 1.24 GB）时量一遍
 * "导入返回 / 可预览 / 后台扫描完成"和"第二次导入走缓存"。
 */
async function longFileCheck(win) {
  const longFile = path.join(ROOT, 'tmp', 'long30.mp4');
  if (!fs.existsSync(longFile)) {
    steps.push('· 跳过长视频计时（缺 tmp/long30.mp4）');
    return;
  }
  fs.rmSync(path.join(app.getPath('userData'), 'keyframe-cache'), { recursive: true, force: true });
  fs.rmSync(path.join(app.getPath('userData'), 'thumb-cache'), { recursive: true, force: true });

  const t0 = Date.now();
  await js(win, `__smoke.importFile(${JSON.stringify(longFile)}); 'ok'`);
  const returned = Date.now() - t0;
  await waitFor('__smoke.state.src && __smoke.state.src.file === ' + JSON.stringify(longFile), win);
  const previewOk = await waitFor('document.getElementById("player").readyState >= 1', win, 60000);
  const previewMs = Date.now() - t0;
  const scanned = await waitFor('__smoke.state.scanning === false', win, 180000);
  const scanMs = Date.now() - t0;
  check('长视频先出画面再等扫描', previewOk && returned < 2000,
    `返回 ${returned} ms · 可预览 ${previewMs} ms · 扫描完成 ${scanMs} ms${scanned ? '' : '（超时）'}`);

  // 超过 SEEK_AFTER 的素材走逐点 seek：胶片条必须能画满，且不能一格空洞
  const filmWait = Date.now();
  const filmOk = await waitFor(
    '__smoke.state.thumbs && __smoke.state.thumbs.final && __smoke.tl.filmDraws >= __smoke.state.thumbs.count', win, 240000);
  const film = JSON.parse(await js(win, 'JSON.stringify({ count: (__smoke.state.thumbs || {}).count || 0, draws: __smoke.tl.filmDraws })'));
  check('长视频走 seek 也能画满胶片', filmOk && film.count >= 60 && film.draws >= film.count,
    `${film.draws}/${film.count} 格 · 从导入起 ${((Date.now() - t0) / 1000).toFixed(0)}s（本项等待 ${((Date.now() - filmWait) / 1000).toFixed(0)}s）`);

  // 半小时素材整条适应时最容易暴露刻度压字 / 重复
  const longRuler = JSON.parse(await js(win, `(() => {
    const ctx = document.getElementById('tlCanvas').getContext('2d');
    ctx.font = '10px Consolas, monospace';
    __smoke.tl.fit();
    const r = __smoke.tl.ruler;
    let bad = 0;
    for (let i = 0; i + 1 < r.labels.length; i++) {
      const w = ctx.measureText(r.labels[i].label).width;
      if (r.labels[i + 1].x - (r.labels[i].x + 3 + w) < 6) bad++;
    }
    return JSON.stringify({ step: r.step, n: r.labels.length,
      uniq: new Set(r.labels.map((l) => l.label)).size, bad,
      sample: r.labels.slice(0, 4).map((l) => l.label).join(' ') });
  })()`));
  check('长视频刻度尺不压字不重名',
    longRuler.bad === 0 && longRuler.uniq === longRuler.n && longRuler.n >= 3,
    `间隔 ${longRuler.step}s · ${longRuler.n} 格 · 前几格 "${longRuler.sample}"`);

  const t1 = Date.now();
  const cached = JSON.parse(await js(win,
    `window.fc.load(${JSON.stringify(longFile)}).then((r) => JSON.stringify({ scanning: r.scanning, kf: r.media.keyframes.length }))`));
  check('第二次导入走关键帧缓存', cached.scanning === false && cached.kf > 0,
    `${Date.now() - t1} ms · ${cached.kf} 个关键帧直接可用`);
}

function finish(win) {
  console.log(steps.join('\n'));
  console.log(failures.length ? `\n✗ 失败 ${failures.length} 项：${failures.join('、')}` : '\n✓ 端到端全部通过');
  try { if (win) win.close(); } catch { /* 已关闭 */ }
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(() => {
  main().catch((err) => {
    steps.push(`✗ 异常：${err && err.stack}`);
    failures.push('脚本异常');           // 异常必须算失败，否则退出码会骗人
    finish(null);
  });
});
