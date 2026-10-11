'use strict';

/**
 * 裁剪流程编排：导入 → 探流 → 吸附 → 切割 → 拼接 → 自检。
 * 这是 UI 唯一需要调用的入口；它自己不碰 DOM、不碰 Electron。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { normalizeSegment, normalizeSegments, totalDuration, snap } = require('./segments');
const { buildPlan } = require('./cuttings');
const { probeMedia, probeKeyframes, run } = require('./probe');
const { argsForSegment, argsForConcat, concatListBody, listPathOf, fmtTime, keepsSourceCodec, pickVideoCodec, CODEC_OF_ENCODER } = require('./buildArgs');
const { verifyExport } = require('./verify');
const { ffmpegPath, ffprobePath } = require('./ffmpegPath');

/** 可取消令牌 */
function createToken() {
  const c = new AbortController();
  return {
    signal: c.signal,
    cancel: (why = '已取消') => c.abort(new Error(why)),
  };
}

/**
 * 导入第一步：探流。耗时与文件长度无关（只读容器头），界面可以立刻开始预览。
 */
async function probeSource(file, opts = {}) {
  const ffprobe = opts.ffprobe || ffprobePath();
  const ffmpeg = opts.ffmpeg || ffmpegPath();
  if (!ffprobe || !ffmpeg) {
    throw new Error('未找到 ffmpeg/ffprobe，请在设置中指定 ffmpeg 目录，或安装后加入 PATH');
  }

  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('路径不是文件');

  const media = await probeMedia(ffprobe, file);
  if (!media.video) throw new Error('该文件没有视频轨，Fast Cut v0.1 仅支持含视频轨的文件');

  media.keyframes = [];
  media.lastKeyframe = null;
  media.duration = snap(Number(media.duration) || 0);

  return { file, media, bins: { ffmpeg, ffprobe }, stat: st };
}

/**
 * 导入第二步：扫全片关键帧。耗时随文件线性增长，长视频要放到后台跑，
 * 不能挡着"导入即播"。
 */
async function scanKeyframes(loaded) {
  const keyframes = await probeKeyframes(loaded.bins.ffprobe, loaded.file, loaded.media.startOffset || 0);
  if (keyframes.length === 0) {
    throw new Error('未能扫描到关键帧（文件可能损坏或视频轨不可解码）');
  }
  loaded.media.keyframes = keyframes;
  loaded.media.lastKeyframe = snap(keyframes[keyframes.length - 1]);
  // 少数容器不写时长，用最后一个关键帧兜底
  if (!loaded.media.duration) loaded.media.duration = loaded.media.lastKeyframe;
  return keyframes;
}

/** 导入 = 探流 + 扫关键帧（命令行/自检用的同步语义版本）。 */
async function loadSource(file, opts = {}) {
  const loaded = await probeSource(file, opts);
  await scanKeyframes(loaded);
  return loaded;
}

/** 预检磁盘空间。 */
async function precheckSpace(outPath, media, keepSecs) {
  const bytesNeeded = Math.ceil((media.bitRate || 8_000_000) / 8 * keepSecs * 1.05);
  let free = null;
  try {
    const s = await fsp.statfs(path.dirname(path.resolve(outPath)));
    free = s.bavail * s.bsize;
  } catch {
    return { ok: true, bytesNeeded, free: null };
  }
  if (free !== null && free < bytesNeeded) {
    return {
      ok: false,
      bytesNeeded,
      free,
      message: `磁盘空间不足：需要约 ${fmtBytes(bytesNeeded)}，可用 ${fmtBytes(free)}`,
    };
  }
  return { ok: true, bytesNeeded, free };
}

/**
 * 只做区间规整 + 切割计划推导，不跑 ffmpeg。
 * UI 要在导出前显示真实吸附结果、主进程要查重名，都走这里，保证和真正导出同一套算法。
 */
function planFor(loaded, segments, opts = {}) {
  const keeps = opts.ordered ? orderPreserving(segments) : normalizeSegments(segments);
  const { plan, warnings } = buildPlan(keeps, {
    keyframes: loaded.media.keyframes,
    precise: !!opts.precise,
    // media.video.fps 是 avg_frame_rate（实测帧数/时长），VFR 源也得用它折帧数：
    // 实测 VFR 源改用 -t 限长时长根本收不住（要 2.27s 给出 4.83s，把删掉的内容又带回来）
    fps: loaded.media.video?.fps,
    lastKeyframe: loaded.media.lastKeyframe,
    duration: loaded.media.duration,
    ordered: !!opts.ordered,
    sameCodec: keepsSourceCodec(loaded.media),
  });
  const keepSecs = opts.ordered
    ? snap(keeps.reduce((acc, k) => acc + (k.end - k.start), 0))
    : totalDuration(keeps);
  return { keeps, plan, warnings, keepSecs };
}

/**
 * 用户拖动改过顺序时，数组顺序就是导出顺序：只能逐条规整，
 * 绝不能走 normalizeSegments —— 它会排序并合并首尾相接的区间，把"乱序"抹平成原片。
 */
function orderPreserving(segments) {
  const out = [];
  for (const raw of segments) {
    const seg = normalizeSegment(raw);
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * 执行导出。
 */
async function exportSegments(loaded, segments, opts) {
  const { file, media, bins } = loaded;
  const {
    outPath, precise = false, split = false, crf = 18, ordered = false,
    dropSubtitles = false, container = null,
    onProgress = () => {}, token = createToken(),
  } = opts;

  const { keeps, plan, warnings, keepSecs: totalKeep } = planFor(loaded, segments, { precise, ordered });
  if (keeps.length === 0) throw new Error('没有有效的保留区间');
  if (plan.length === 0) throw new Error(`所有区间对齐关键帧后都为空：${warnings.join('；') || '无计划段'}`);

  // 精确模式整段换了编码（源编码没有对应的同编码重编码器）时，自检要拿"所选编码"
  // 比对，而不是拿源比对——否则这条明说的重编码会被判成故障。
  const allReencode = plan.every((p) => p.kind === 'reencode');
  const intendedCodec = allReencode && !keepsSourceCodec(media)
    ? (CODEC_OF_ENCODER[pickVideoCodec(media)] || null)
    : null;
  const cutFps = media.video?.fps;

  const space = await precheckSpace(outPath, media, totalKeep);
  if (!space.ok) throw new Error(space.message);
  onProgress({ phase: 'prepare', keepSecs: totalKeep, segments: keeps });

  await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-cut-'));
  const partFiles = [];
  const ext = path.extname(outPath) || '.mp4';
  // 输出文件名在切割前就确定，取消时才能把半成品全部清掉。
  const groups = groupByKeep(plan);
  const outNames = split ? groups.map((_, i) => numbered(outPath, i, ext)) : [outPath];

  try {
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const partFile = path.join(tmpDir, `seg${String(i).padStart(3, '0')}${ext}`);
      const args = argsForSegment(item, { ...media, file }, partFile, { crf, fps: cutFps, dropSubtitles });
      onProgress({ phase: 'cut', index: i, total: plan.length, kind: item.kind, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}`, note: item.note });
      await runWithProgress(bins.ffmpeg, args, item, onProgress, token);
      partFiles.push(partFile);
    }

    let outputs = [];
    const expectSecs = [];
    if (split) {
      // 需求文档 §4.3：「每段一个文件」= 每条保留区间一个文件。
      // 精确模式下一条区间会被切成"重编码小段 + 流拷贝段"，这里再把它们拼回同一个文件。
      for (let i = 0; i < groups.length; i++) {
        const files = groups[i].map((n) => partFiles[n]);
        const target = outNames[i];
        if (files.length === 1) await fsp.copyFile(files[0], target);
        else await concatInto(files, target, media, bins);
        outputs.push(target);
        expectSecs.push(snap(groups[i].reduce((acc, n) => acc + plan[n].duration, 0)));
      }
    } else {
      await concatInto(partFiles, outPath, media, bins);
      outputs = [outPath];
      expectSecs.push(totalKeep);
    }

    // 自检：每个输出文件与"它自己那组切割计划的时长"比对，不和总时长比。
    onProgress({ phase: 'verify' });
    const results = [];
    for (let i = 0; i < outputs.length; i++) {
      const r = await verifyExport(bins.ffmpeg, bins.ffprobe, file, outputs[i],
        { duration: expectSecs[i], container, dropSubtitles, codec: intendedCodec, vfr: !!media.video?.vfr, parts: plan.length, sourceFormat: media.format });
      results.push({ file: outputs[i], ...r });
    }
    onProgress({ phase: 'done', outputs, warnings, results });

    return { outputs, warnings, results, keepSecs: totalKeep, ok: results.every((r) => r.ok) };
  } catch (err) {
    if (isCancelled(err)) {
      for (const p of [...new Set([outPath, ...outNames])]) await safeRemove(p);
      throw err;
    }
    throw new Error(`导出失败：${muxHint(err.message)}`);
  } finally {
    await rmrf(tmpDir);
  }
}

/** 按保留区间给切割计划分组：plan 项的 keepIndex 由 cuttings.buildPlan 打标。 */
function groupByKeep(plan) {
  const groups = [];
  for (let i = 0; i < plan.length; i++) {
    const key = plan[i].keepIndex == null ? groups.length : plan[i].keepIndex;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(i);
  }
  return groups.map((g) => g.items);
}

function isCancelled(err) {
  return String(err.message || '').includes('已取消');
}

/**
 * 换封装时最常撞的一堵墙：目标 muxer 没有这个编码的 tag
 * （实测 ProRes → MP4 报 "Could not find tag for codec prores"，
 * 抛出来只有一长串 ffmpeg 退出码，用户看不出跟自己选的容器有关）。
 */
function muxHint(message) {
  const m = String(message || '');
  const tag = /Could not find tag for codec ([a-zA-Z0-9_]+)/.exec(m);
  if (tag) {
    return `${m.trim()}——目标容器装不下 ${tag[1]}，换 MKV 试试（字幕装不下时界面已经提示，视频/音频装不下只有封装器知道）`;
  }
  return m;
}

/** 带进度回调地跑 ffmpeg：ffmpeg 只在 stderr 打进度，持续读取并换算百分比。 */
async function runWithProgress(ffmpeg, args, item, onProgress, token) {
  return run(ffmpeg, args, {
    signal: token.signal,
    onProgress: (p) => {
      const segLen = Math.max(0.001, item.end - item.start);
      const ratio = Math.min(1, Math.max(0, p.seconds / segLen));
      onProgress({ phase: 'cut-progress', ratio, time: p.seconds, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}` });
    },
  });
}

async function concatInto(parts, outPath, media, bins) {
  if (parts.length === 1) {
    const args = argsForConcat(parts, outPath, media);
    await run(bins.ffmpeg, args);
    return;
  }
  const listFile = listPathOf(outPath);
  await fsp.writeFile(listFile, concatListBody(parts), 'utf8');
  const args = argsForConcat(parts, outPath, media);
  try {
    await run(bins.ffmpeg, args);
  } finally {
    await safeRemove(listFile);
  }
}

function numbered(outPath, i, ext) {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath, ext);
  return path.join(dir, `${base}-${String(i + 1).padStart(2, '0')}${ext}`);
}

async function safeRemove(p) { try { await fsp.rm(p, { force: true }); } catch { /* ignore */ } }
async function rmrf(p) { try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '未知';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

module.exports = {
  loadSource, probeSource, scanKeyframes, exportSegments, createToken, planFor, numbered, groupByKeep,
};
