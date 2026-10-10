'use strict';

/**
 * 裁剪流程编排：导入 → 探流 → 吸附 → 切割 → 拼接 → 自检。
 * 这是 UI 唯一需要调用的入口；它自己不碰 DOM、不碰 Electron。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { normalizeSegments, totalDuration, snap } = require('./segments');
const { buildPlan } = require('./cuttings');
const { probeMedia, probeKeyframes, run } = require('./probe');
const { argsForSegment, argsForConcat, concatListBody, listPathOf, fmtTime } = require('./buildArgs');
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
 * 导入：探流 + 扫关键帧。
 */
async function loadSource(file, opts = {}) {
  const ffprobe = opts.ffprobe || ffprobePath();
  const ffmpeg = opts.ffmpeg || ffmpegPath();
  if (!ffprobe || !ffmpeg) {
    throw new Error('未找到 ffmpeg/ffprobe，请在设置中指定 ffmpeg 目录，或安装后加入 PATH');
  }

  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('路径不是文件');

  const media = await probeMedia(ffprobe, file);
  if (!media.video) throw new Error('该文件没有视频轨，Fast Cut v0.1 仅支持含视频轨的文件');

  const keyframes = await probeKeyframes(ffprobe, file);
  media.keyframes = keyframes;
  media.lastKeyframe = keyframes.length ? snap(keyframes[keyframes.length - 1]) : null;
  media.duration = snap(Number(media.duration) || (media.lastKeyframe ?? 0));

  if (keyframes.length === 0) {
    throw new Error('未能扫描到关键帧（文件可能损坏或视频轨不可解码）');
  }

  return { file, media, bins: { ffmpeg, ffprobe } };
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
 * 执行导出。
 */
async function exportSegments(loaded, segments, opts) {
  const { file, media, bins } = loaded;
  const {
    outPath, precise = false, split = false, crf = 18,
    onProgress = () => {}, token = createToken(),
  } = opts;

  const keeps = normalizeSegments(segments);
  if (keeps.length === 0) throw new Error('没有有效的保留区间');

  const totalKeep = totalDuration(keeps);
  const space = await precheckSpace(outPath, media, totalKeep);
  if (!space.ok) throw new Error(space.message);
  onProgress({ phase: 'prepare', keepSecs: totalKeep, segments: keeps });

  const { plan, warnings } = buildPlan(keeps, {
    keyframes: media.keyframes,
    precise,
    fps: media.video?.fps,
    lastKeyframe: media.lastKeyframe,
    duration: media.duration,
  });

  await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-cut-'));
  const partFiles = [];

  try {
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const ext = path.extname(outPath) || '.mp4';
      const partFile = path.join(tmpDir, `seg${String(i).padStart(3, '0')}${ext}`);
      const args = argsForSegment(item, { ...media, file }, partFile, { crf, fps: media.video?.fps });
      onProgress({ phase: 'cut', index: i, total: plan.length, kind: item.kind, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}`, note: item.note });
      await runWithProgress(bins.ffmpeg, args, item, onProgress, token);
      partFiles.push(partFile);
    }

    let outputs = [];
    if (split) {
      outputs = partFiles.map((p, i) => numbered(outPath, i, path.extname(p)));
      await copyFiles(partFiles, outputs);
    } else {
      await concatInto(partFiles, outPath, media, bins);
      outputs = [outPath];
    }

    // 3) 自检
    //    - 拼接模式：只有一个文件，与"全部保留区间的总时长"比对
    //    - split 模式：每个文件对应一条保留区间，与该区间自己的时长比对
    //      （注意 plan 里一个 keep 可能被切成多段：精确模式的 reencode+copy，
    //        因此按 keep 序号取 keeps[i]，而不是按 part 序号）
    onProgress({ phase: 'verify' });
    const results = [];
    if (split) {
      const keepIndex = keeps.map((_, i) => i);
      for (let i = 0; i < outputs.length; i++) {
        const keep = keeps[keepIndex[i] ?? keepIndex.length - 1] ?? keeps[keeps.length - 1];
        const r = await verifyExport(bins.ffmpeg, bins.ffprobe, file, outputs[i], { duration: keep.end - keep.start });
        results.push({ file: outputs[i], ...r });
      }
    } else {
      const r = await verifyExport(bins.ffmpeg, bins.ffprobe, file, outputs[0], { duration: totalKeep });
      results.push({ file: outputs[0], ...r });
    }
    onProgress({ phase: 'done', outputs, warnings, results });

    return { outputs, warnings, results, keepSecs: totalKeep, ok: results.every((r) => r.ok) };
  } catch (err) {
    if (isCancelled(err)) {
      await safeRemove(outPath);
      throw err;
    }
    throw new Error(`导出失败：${err.message}`);
  } finally {
    await rmrf(tmpDir);
  }
}

function isCancelled(err) {
  return String(err.message || '').includes('已取消');
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

async function copyFiles(from, to) {
  for (let i = 0; i < from.length; i++) await fsp.copyFile(from[i], to[i]);
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

module.exports = { loadSource, exportSegments, createToken };
