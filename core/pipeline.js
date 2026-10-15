'use strict';

/**
 * 裁剪流程编排：导入 → 探流 → 切割 → 拼接 → 自检。
 * 这是 UI 唯一需要调用的入口；它自己不碰 DOM、不碰 Electron。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { normalizeSegment, normalizeSegments, totalDuration, snap } = require('./segments');
const { buildPlan, frameStart } = require('./cuttings');
const { probeMedia, probeKeyframes, run, sourceSubtitleCues } = require('./probe');
const { familyOfFormat, familyOfExt } = require('./containers');
const { parseSrt, parseAss, applyRetime, retime, isTextSubtitle } = require('./subtitles');
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
 * UI 要在导出前显示真实的入点/代价、主进程要查重名，都走这里，保证和真正导出同一套算法。
 */
function planFor(loaded, segments, opts = {}) {
  const keeps = opts.ordered ? orderPreserving(segments) : normalizeSegments(segments);
  const { plan, warnings } = buildPlan(keeps, {
    keyframes: loaded.media.keyframes,
    // media.video.fps 是 avg_frame_rate（实测帧数/时长），VFR 源也得用它折帧数：
    // 实测 VFR 源改用 -t 限长时长根本收不住（要 2.27s 给出 4.83s，把删掉的内容又带回来）
    fps: loaded.media.video?.fps,
    gridOrigin: loaded.media.gridOrigin,
    reorderDepth: loaded.media.video?.reorderDepth,
    duration: loaded.media.duration,
    ordered: !!opts.ordered,
    sameCodec: keepsSourceCodec(loaded.media),
    // VFR 源帧长不均匀，按帧数切出来的时长与音频对不上：只能整段重编码成定帧率
    forceReencode: !!loaded.media.video?.vfr,
    // HEVC 开放 GOP：剥 RASL 时每个段内关键帧剥 (深度+1) 帧（x265 实测），
    // 拷贝段的帧数预期要同步扣，见 cuttings.buildPlan 末尾的记账
    raslPerKf: loaded.media.video?.codec === 'hevc' && loaded.media.video?.reorderDepth >= 0
      ? loaded.media.video.reorderDepth + 1
      : 0,
    // precise=false → 吸附模式：入点前移到关键帧整段流拷贝（防吞钳制在 buildPlan 里）
    precise: opts.precise !== false,
  });
  const keepSecs = opts.ordered
    ? snap(keeps.reduce((acc, k) => acc + (k.end - k.start), 0))
    : totalDuration(keeps);
  /**
   * 每条保留区间**实际第一帧**的源时刻：入点不在帧网格上时画面从网格点起步。
   * 字幕按文本重新计时要拿它做减法，否则每条 cue 都比口型晚半帧（见 cuttings.frameStart）。
   */
  const keepAligns = keeps.map((k) => frameStart(k.start, loaded.media.video?.fps, loaded.media.gridOrigin));
  return { keeps, plan, warnings, keepSecs, keepAligns };
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
    outPath, split = false, crf = 18, ordered = false,
    precise = true, dropSubtitles = false, container = null,
    onProgress = () => {}, token = createToken(),
  } = opts;

  const { keeps, plan, warnings, keepSecs: totalKeep, keepAligns } = planFor(loaded, segments, { ordered, precise, dropSubtitles });
  if (keeps.length === 0) throw new Error('没有有效的保留区间');
  if (plan.length === 0) throw new Error(`所有保留区间都落在源尾之后或不足一帧：${warnings.join('；') || '无计划段'}`);

  // 整片换了编码（源编码没有对应的同编码重编码器）时，自检要拿"所选编码"
  // 比对，而不是拿源比对——否则这条明说的重编码会被判成故障。
  const allReencode = plan.every((p) => p.kind === 'reencode');
  const intendedCodec = allReencode && !keepsSourceCodec(media)
    ? (CODEC_OF_ENCODER[pickVideoCodec(media)] || null)
    : null;
  const cutFps = media.video?.fps;

  await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-cut-'));
  const partFiles = [];
  const ext = path.extname(outPath) || '.mp4';
  // 输出文件名在切割前就确定，取消时才能把半成品全部清掉。
  const groups = groupByKeep(plan);
  const outNames = split ? groups.map((_, i) => numbered(outPath, i, ext)) : [outPath];

  /**
   * 字幕先摘出来：ffmpeg 逐段定位字幕轨会漏包/串包（实测），所以能按文本重新计时时，
   * 段里一律不带字幕，等拼接那一步再把重排好的 sidecar 一次上轨。
   */
  let subDocs = null;
  if (!dropSubtitles && (media.subtitleCodecs || []).length) {
    subDocs = await extractSubtitleDocs(bins, file, media, tmpDir);
    if (!subDocs) {
      warnings.push('源含字幕轨，但它不是可重排的文本字幕（只支持 SRT/ASS）：仍按分段流拷贝处理，'
        + '自检会逐条比对字幕落点，对不上就拒绝交付');
    }
  }
  const stripSubs = !!subDocs;
  const carrySubsInParts = !dropSubtitles && !stripSubs && (media.subtitleCodecs || []).length > 0;

  // 归一化：多段拼接时先把源整片纯拷进 MP4 工作副本（原因见 willNormalize 注释）
  const normalize = willNormalize(media, plan.length, stripSubs);
  const space = await precheckSpace(outPath, media, totalKeep + (normalize ? (media.duration || 0) : 0));
  if (!space.ok) throw new Error(space.message);
  onProgress({ phase: 'prepare', keepSecs: totalKeep, segments: keeps });

  try {
    let src = { file, media };
    if (normalize) {
      onProgress({ phase: 'normalize', note: '先把源封装归一成 MP4（纯拷贝，不重编码）' });
      try {
        src = await makeWorkingCopy(bins, file, media, tmpDir, token);
        warnings.push('源不是 MP4 封装：多段拼接前已把它纯拷成 MP4 工作副本，否则按段归零时间戳会丢报文时间戳（实测 MKV 源直接切出的段 pts 为空，拼不了）');
      } catch (err) {
        if (isCancelled(err)) throw err;
        warnings.push(`封装归一失败（${String(err.message || err).split('\n')[0].slice(0, 90)}），改用源文件直接切割`);
      }
    }
    // 中间段优先写 MP4（原因见 partsAsMp4）；只有必须把字幕带在段里时才沿用目标容器。
    const partExt = partsAsMp4(media, ext, carrySubsInParts) ? '.mp4' : ext;
    // 「读 mov 族 且 写 mov 族」才敢让拷贝段的时间戳不归零：
    // 不归零才不会每个接缝多一帧（见 buildArgs），但读 MKV/TS 或写 MKV 时会丢报文时间戳。
    const zeroFree = familyOfFormat(src.media.format) === 'mov' && familyOfExt(partExt) === 'mov';
    const copyTs = zeroFree ? 'disabled' : 'make_zero';
    if (!zeroFree && plan.some((p) => p.kind === 'copy')) {
      warnings.push('这次导出无法让拷贝段的时间戳严格按帧对齐（源或目标容器不允许），'
        + '接缝处可能多带 1~2 帧画面——产物内容仍是按你选的区间切的');
    }

    // 混拼（重编码段与流拷贝段并存）时，拷贝段要把源参数集内嵌进关键帧包：
    // MP4 每轨只存一份参数集，拼接产物取第一段的；若第一段是重编码段，它那套
    // 参数集与源的不一致，拷贝段就会解不开（HEVC 必炸，H.264 靠解码器容错侥幸活着）。
    // 全拷贝（参数集同源）或全重编码（只有一套）都不需要。见 buildArgs.MIXED_PARAM_BSF。
    const mixedCodecs = plan.some((p) => p.kind === 'copy') && plan.some((p) => p.kind === 'reencode');

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const partFile = path.join(tmpDir, `seg${String(i).padStart(3, '0')}${partExt}`);
      const args = argsForSegment(item, { ...src.media, file: src.file }, partFile, {
        crf, fps: cutFps, dropSubtitles: dropSubtitles || stripSubs, copyTs,
        dumpParams: mixedCodecs,
      });
      onProgress({ phase: 'cut', index: i, total: plan.length, kind: item.kind, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}`, note: item.note });
      await runWithProgress(bins.ffmpeg, args, item, onProgress, token);
      partFiles.push(partFile);
    }
    const cutMedia = src.media;
    let outputs = [];
    const expectSecs = [];
    const expectFrames = [];
    const userSecs = [];
    const wantCues = [];
    const subTracks = [];
    /** 每个输出内部的拼接接缝（成片时刻）：解码自检拿它决定哪些时刻非解到不可。 */
    const seamsOf = (idxList) => {
      const out = [];
      let acc = 0;
      for (const n of idxList.slice(0, -1)) { acc += plan[n].duration; out.push(acc); }
      return out;
    };
    const seamsList = [];
    /** 计划要写多少帧：拷贝段按 plan 给的包数（已扣双向预测余量），其余按时长折算。 */
    const framesOf = (p) => (Number.isFinite(p.frames) && p.frames > 0
      ? Math.round(p.frames)
      : (cutFps ? Math.round(p.duration * cutFps) : null));
    const framesSum = (idxList) => {
      const ns = idxList.map((n) => framesOf(plan[n]));
      return ns.some((x) => x == null) ? null : ns.reduce((a, b) => a + b, 0);
    };
    /** 计划里被 B 帧余量裁掉的帧占多少：帧率自检拿它当允差，免得把"故意留的余量"判成改了帧率。 */
    const rateSlackOf = (idxList) => {
      const frames = framesSum(idxList);
      if (!frames) return 0;
      const trimmed = idxList.reduce((a, n) => a + (plan[n].trimmed || 0), 0);
      return trimmed / frames;
    };
    const expectSlack = [];
    // 每条保留区间在成片里的起点（拼接模式按全部区间累加）
    const progOfKeep = {};
    let cursor = 0;
    for (const g of groups) {
      const k = plan[g[0]].keepIndex;
      if (k != null && progOfKeep[k] === undefined) progOfKeep[k] = cursor;
      cursor += g.reduce((a, n) => a + plan[n].duration, 0);
    }
    const keepsOf = (idxList) => [...new Set(idxList.map((n) => plan[n].keepIndex).filter((k) => k != null))];
    /** 重排字幕 sidecar：split 时每片只装自己那条区间的字幕，起点归零。 */
    async function sidecarsFor(idxList, tag) {
      if (!subDocs) return { files: [], cues: null };
      const ks = keepsOf(idxList);
      const files = [];
      const cues = [];
      for (const entry of subDocs) {
        const one = split
          ? await writeRetimeSidecar(entry, ks.map((k) => keeps[k]), ks.map(() => 0), ks.map((k) => keepAligns[k]), tmpDir, tag)
          : await writeRetimeSidecar(entry, keeps, keeps.map((_, i) => progOfKeep[i] || 0), keepAligns, tmpDir, tag);
        if (one) { files.push(one.file); cues.push(one.cues); }
      }
      return { files, cues };
    }

    if (split) {
      // 需求文档 §4.3：「每段一个文件」= 每条保留区间一个文件。
      // 入点不在关键帧上时一条区间会被切成"重编码小段 + 流拷贝段"，这里再把它们拼回同一个文件。
      for (let i = 0; i < groups.length; i++) {
        const files = groups[i].map((n) => partFiles[n]);
        const target = outNames[i];
        const subs = await sidecarsFor(groups[i], `k${i}`);
        if (files.length === 1 && !subs.files.length && path.extname(files[0]).toLowerCase() === path.extname(target).toLowerCase()) {
          await fsp.copyFile(files[0], target);
        } else {
          await concatInto(files, target, cutMedia, bins, { subs: subs.files });
        }
        outputs.push(target);
        expectSecs.push(snap(groups[i].reduce((acc, n) => acc + plan[n].duration, 0)));
        expectFrames.push(framesSum(groups[i]));
        expectSlack.push(rateSlackOf(groups[i]));
        wantCues.push(subs.cues);
        if (subs.cues) subTracks.push(subs.cues.length);
        seamsList.push(seamsOf(groups[i]));
        const ki = plan[groups[i][0]].keepIndex;
        userSecs.push(ki != null && keeps[ki] ? snap(keeps[ki].end - keeps[ki].start) : undefined);
      }
    } else {
      const subs = await sidecarsFor(plan.map((_, n) => n), 'all');
      await concatInto(partFiles, outPath, cutMedia, bins, { subs: subs.files });
      outputs = [outPath];
      // 基准按计划实算：段时长是整帧时刻，与用户选区最多差一帧。
      // 拿源长百分比当允差会宽到"吞掉剪辑"都查不出来（实测 98 分钟片删 1.9s 判通过）。
      expectSecs.push(snap(plan.reduce((acc, p) => acc + p.duration, 0)));
      expectFrames.push(framesSum(plan.map((_, n) => n)));
      expectSlack.push(rateSlackOf(plan.map((_, n) => n)));
      wantCues.push(subs.cues);
      if (subs.cues) subTracks.push(subs.cues.length);
      seamsList.push(seamsOf(plan.map((_, n) => n)));
      userSecs.push(totalKeep);
    }

    // 自检：每个输出文件与"它自己那组切割计划的时长"比对，不和总时长比。
    // 字幕基准：能重排时用重排后的时刻（我们自己算的，最准）；不能重排时去数源的 cue，
    // 那条路就是"分段流拷贝会不会把字幕弄坏"的检验。
    onProgress({ phase: 'verify' });
    for (let i = 0; i < outputs.length; i++) {
      if (!wantCues[i] && !dropSubtitles && (media.subtitleCodecs || []).length) {
        wantCues[i] = await expectedCuesFromSource(bins, file, media, keeps, plan, groups, progOfKeep, split, i, keepAligns);
      }
    }
    const results = [];
    for (let i = 0; i < outputs.length; i++) {
      const r = await verifyExport(bins.ffmpeg, bins.ffprobe, file, outputs[i],
        {
          duration: expectSecs[i], userSecs: userSecs[i], frames: expectFrames[i],
          rateSlack: expectSlack[i], container, wantCues: wantCues[i],
          subTracks: subTracks[i],
          dropSubtitles, codec: intendedCodec, vfr: !!media.video?.vfr, parts: plan.length,
          seams: seamsList[i],
          sourceFormat: media.format,
        });
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
      const segLen = Math.max(0.001, item.duration);
      const ratio = Math.min(1, Math.max(0, p.seconds / segLen));
      onProgress({ phase: 'cut-progress', ratio, time: p.seconds, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}` });
    },
  });
}

/**
 * 多段拼接前要不要先把源归一成 MP4 工作副本。
 *
 * 起因（实测）：拷贝段的时间戳"不归零"才能对齐接缝（归零会把段内视频推后约一帧，
 * 每个接缝多一帧，四段拼出来多 0.067s）。但 `-avoid_negative_ts disabled` 配
 * **Matroska 源**会让段里所有报文丢掉时间戳（ffprobe 读出来 pts=N/A），
 * 拼接直接报 "Can't write packet with unknown timestamp"。
 * 把源纯拷成 MP4 之后再切，段的时间戳正常、接缝也不漂，MKV/TS 源的拼接就干净了
 * （实测 hevc.mkv 归一 → 切 5 段 → 拼 mkv/mpv 两个目标都解码无错）。
 *
 * 不做的情况：
 *  - 只有一段（没有拼接就没有漂移）；
 *  - 源本来就是 mov 族（多拷一份纯浪费磁盘和时间）；
 *  - 源带字幕（MP4 装不下 subrip/ass 的流拷贝，归一等于悄悄丢字幕）。
 */
function willNormalize(media, partCount, stripSubtitles) {
  if (partCount < 2) return false;
  if (familyOfFormat(media.format) === 'mov') return false;
  // 字幕留在段里时不能归一（MP4 装不下 subrip/ass 的流拷贝）；能重新计时就已经把字幕摘出去了
  return stripSubtitles || !(media.subtitleCodecs || []).length;
}

/**
 * 中间的切割段写成什么容器。
 *
 * 用 MP4 写段（哪怕最终产物是 MKV）有两个实测依据：
 *  - `-avoid_negative_ts disabled` 只有写 mov 族才安全；写 Matroska 会让段里
 *    所有报文丢掉时间戳（实测 pts=N/A，拼接报 unknown timestamp）；
 *  - MKV 段的块时长记账会把接缝后的时间轴拉长（实测 hevc.mov 切成 mkv 段再拼，
 *    52 帧的视频占了 1.952s，而按 mp4 段拼同样的计划是 1.800s 整）。
 * 段是临时产物，只有最终产物留给用户，所以中间步骤统一走最准的那条路。
 *
 * 不能这么做的情况：段里必须带上字幕轨（MP4 装不下 subrip/ass 的流拷贝，
 * 见 containers.js），这时只能沿用目标容器并承担 mkv 段的记账偏差。
 */
function partsAsMp4(media, ext, carrySubsInParts) {
  if (familyOfExt(ext) === 'mov') return false;                 // 本来就是 mov 族，无需改
  if (carrySubsInParts) return false;                            // 段必须带字幕时 MP4 装不下
  return true;
}

/**
 * 抽文本字幕并留好原始解析结果。
 *
 * 只支持 srt / ass 这类文本字幕：位图字幕（PGS/DVD）重排需要 OCR，明确不做，
 * 返回 null 让调用方退回旧路径（段里带字幕 + 自检按落点拦下）。
 * 抽取或解析任何一步出错也返回 null —— 宁可不优化，也不能吐一份对不上的字幕。
 */
async function extractSubtitleDocs(bins, file, media, tmpDir) {
  const codecs = media.subtitleCodecs || [];
  if (!codecs.length || !codecs.every(isTextSubtitle)) return null;
  const docs = [];
  for (let k = 0; k < codecs.length; k++) {
    const isAss = /ass|ssa/i.test(codecs[k]);
    const raw = path.join(tmpDir, `sub${k}.src${isAss ? '.ass' : '.srt'}`);
    try {
      await run(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
        '-map', `0:s:${k}`, '-c:s', isAss ? 'ass' : 'srt', raw]);
      docs.push({ track: k, isAss, doc: isAss ? parseAss(await fsp.readFile(raw, 'utf8')) : parseSrt(await fsp.readFile(raw, 'utf8')) });
    } catch (err) {
      await safeRemove(raw);
      return null;
    }
    await safeRemove(raw);
  }
  return docs;
}

/**
 * 把某条输出的字幕重排成 sidecar 文件。
 * @returns {{file:string, cues:number[]}|null} 一条都没有时返回 null（该轨就不写进产物）
 */
async function writeRetimeSidecar(entry, keeps, progStarts, aligns, tmpDir, tag) {
  const moved = retime(entry.doc.cues, keeps, progStarts, aligns);
  if (!moved.length) return null;
  const out = path.join(tmpDir, `sub${entry.track}-${tag}${entry.isAss ? '.ass' : '.srt'}`);
  try {
    await fsp.writeFile(out, applyRetime(entry.doc, moved), 'utf8');
  } catch { return null; }
  return { file: out, cues: moved.map((c) => c.start) };
}

/**
 * 不能重排字幕时（位图字幕等）的基准：去源里数各保留区间内的 cue 时刻，
 * 换算成成片时刻。自检拿它逐条比对成片字幕，就能把"漏一条 + 串一条"那种
 * 条数刚好相等的情况也抓出来。
 */
async function expectedCuesFromSource(bins, file, media, keeps, plan, groups, progOfKeep, split, outIndex, aligns) {
  try {
    const cueLists = await sourceSubtitleCues(bins.ffprobe, file,
      keeps.map((k) => [k.start, k.end]), media.startOffset, media.duration);
    const ks = split
      ? [...new Set(groups[outIndex].map((n) => plan[n].keepIndex).filter((k) => k != null))]
      : keeps.map((_, k) => k);
    return cueLists.map((list) => {
      const out = [];
      for (const t of list) {
        const k = ks.find((ki) => t >= keeps[ki].start - 0.001 && t < keeps[ki].end);
        if (k === undefined) continue;
        const align = (aligns && Number.isFinite(aligns[k])) ? aligns[k] : keeps[k].start;
        out.push(split ? t - align : (progOfKeep[k] || 0) + (t - align));
      }
      return out.sort((a, b) => a - b);
    });
  } catch {
    return null;
  }
}

/** 纯拷贝把工作副本写成 MP4；关键帧表沿用源的（流拷贝不动报文）。 */
async function makeWorkingCopy(bins, file, media, tmpDir, token) {
  const working = path.join(tmpDir, 'normalized.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-c', 'copy', '-map', '0:v', '-map', '0:a', '-dn', working];
  await run(bins.ffmpeg, args, { signal: token.signal });
  const wm = await probeMedia(bins.ffprobe, working);
  wm.keyframes = media.keyframes;
  wm.lastKeyframe = media.lastKeyframe;
  return { file: working, media: wm };
}

async function concatInto(parts, outPath, media, bins, opts = {}) {
  if (parts.length === 1) {
    const args = argsForConcat(parts, outPath, media, undefined, opts);
    await run(bins.ffmpeg, args);
    return;
  }
  const listFile = listPathOf(outPath);
  await fsp.writeFile(listFile, concatListBody(parts), 'utf8');
  const args = argsForConcat(parts, outPath, media, undefined, opts);
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
