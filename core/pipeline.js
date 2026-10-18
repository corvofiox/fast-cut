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
const { probeMedia, probeKeyframes, run, sourceSubtitleCues, probeHasRasl } = require('./probe');
const { familyOfFormat, familyOfExt, byId, byExt } = require('./containers');
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
  /**
   * 顺带探一次"源里有没有 RASL"（HEVC NAL 8/9）。只在 HEVC 上做，实测 35ms/0.1MB。
   * 结果决定拷贝段要不要剥 RASL、帧数预期要不要扣——闭合 GOP 硬扣会白丢真实内容
   * （实测 1.03s），开放 GOP 不扣会把已删素材带回来。两者都是硬伤，必须实测。
   */
  if (loaded.media.video?.codec === 'hevc') {
    loaded.media.hasRasl = await probeHasRasl(
      loaded.bins.ffmpeg, loaded.file, loaded.media.keyframes, loaded.media.duration,
    );
  }
  /**
   * 通用探针：这份源的多段纯拷贝拼接能不能解码干净。
   * 一次实测约 0.2s（切 3 段 + 拼一次 + 解一遍），导入时跑一次；
   * 结果决定吸附模式下要不要给非首个片段做接缝缓解（片段开头重编码）。
   * 与编码无关——H.264 开放 GOP、HEVC 开放 GOP，以及将来任何未知格式一并覆盖。
   */
  if (keyframes.length >= 3) {
    const seam = await probePureCopySeams(loaded);
    loaded.media.seamSafe = seam.safe;
    // 单段就解不开 → 只能整段重编码（接缝缓解救不了）；段干净、拼起来才坏 → 接缝重置即可
    loaded.media.segmentsOk = seam.segmentsOk;
    loaded.media.seamProbe = { detail: seam.detail, ms: seam.ms, segs: seam.segs, segmentsOk: seam.segmentsOk };
  }
  return keyframes;
}

/** 导入 = 探流 + 扫关键帧（命令行/自检用的同步语义版本）。 */
async function loadSource(file, opts = {}) {
  const loaded = await probeSource(file, opts);
  await scanKeyframes(loaded);
  return loaded;
}

/** 某个目录所在卷的可用字节数；取不到就返回 null（放行，别把"查不到"误判成"不够"）。 */
async function freeBytesAt(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * 预检磁盘空间：把**每个真要落盘的目录**分别按峰值算清楚。
 *
 * 峰值构成（这些文件在同一时刻都还在盘上）：
 *  · 工作副本——源是 mkv/ts 时要先整片纯拷成 mp4，**大小 ≈ 整份源**；
 *  · 全部中间段（≈ 保留总时长）；
 *  · 最终产物（≈ 保留总时长）。
 * 所以中间文件目录要 workBytes + outBytes，产物目录要 outBytes；两者同卷就是
 * workBytes + 2 × outBytes。
 *
 * 老实现有两个洞，2026-10-17 由一次真实失败暴露（4 小时 27GB 素材、输出盘剩 230GB，
 * 却在导出时报 `No space left on device`）：
 *  1. 只按"产物一个文件"估，漏了工作副本（那份 27GB）；
 *  2. 只查产物目录所在卷，而中间文件当时写在系统临时盘——爆的是没人检查的那个盘。
 */
async function precheckSpace(outPath, media, opts = {}) {
  const bps = ((media.bitRate || 8_000_000) / 8) * 1.05;
  const outBytes = Math.ceil(bps * Math.max(0, opts.keepSecs || 0));
  const workBytes = Math.ceil(bps * Math.max(0, opts.workSecs || 0));

  const outDir = path.dirname(path.resolve(outPath));
  const tmpBase = opts.tmpBase ? path.resolve(opts.tmpBase) : outDir;
  const needByDir = new Map();
  const add = (dir, bytes) => needByDir.set(dir, (needByDir.get(dir) || 0) + bytes);
  add(outDir, outBytes);                 // 最终产物
  add(tmpBase, workBytes + outBytes);    // 工作副本 + 全部中间段

  for (const [dir, need] of needByDir) {
    const free = await freeBytesAt(dir);
    if (free !== null && free < need) {
      return {
        ok: false,
        bytesNeeded: need,
        free,
        dir,
        message: `磁盘空间不足：${dir} 需要约 ${fmtBytes(need)}`
          + `（中间文件＋产物要同时落在这块盘上），当前可用 ${fmtBytes(free)}。`
          + '请换一个空间更大的输出目录，或先清理该磁盘后重试。',
      };
    }
  }
  // 全部目录都够（或查不到可用量）：把总量带回去给上层做展示
  return { ok: true, bytesNeeded: [...needByDir.values()].reduce((a, b) => a + b, 0), free: null };
}

/**
 * 中间文件目录：**放在输出文件同一卷**（2026-10-17 修）。
 *
 * 以前用 `os.tmpdir()`——Windows 上是 `C:\Users\<用户>\AppData\Local\Temp`。
 * 于是"输出盘还有 230GB"完全不起作用：归一工作副本（**整份源大小**，实测用户那单
 * 是 27GB）加全部中间段都写系统盘，系统盘一满 ffmpeg 就报 `No space left on device`
 * （退出码 -28），而预检只看输出盘，等于放行了一个注定失败的导出。
 *
 * 放同卷还有两个好处：最终拼接不再跨卷复制；预检查的就是真正要写的那块盘。
 * 输出目录不可写时（权限/只读/网络盘）退回系统临时目录——那时 precheckSpace
 * 会按 tmpBase 单独把那个卷也查一遍。
 */
async function makeTempDir(anchorPath, prefix = '.fast-cut-tmp-') {
  const base = path.dirname(path.resolve(anchorPath));
  try {
    await fsp.mkdir(base, { recursive: true });
    return await fsp.mkdtemp(path.join(base, prefix));
  } catch {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'fast-cut-'));
  }
}

/**
 * 只做区间规整 + 切割计划推导，不跑 ffmpeg。
 * UI 要在导出前显示真实的入点/代价、主进程要查重名，都走这里，保证和真正导出同一套算法。
 */
/**
 * 把"单源 loaded"与"多源 sources 数组"归一成统一的源列表。
 *
 * 单源（旧调用）→ `[{ id, file, media, bins, ...loaded }]`，行为与以前逐字节相同；
 * 多源 → 原样返回。所有下游只认这个数组，不再直接摸 `loaded.file`。
 */
function asSourceList(loadedOrSources) {
  if (!loadedOrSources) return [];
  if (Array.isArray(loadedOrSources)) {
    return loadedOrSources.map((s, i) => ({ ...s, id: s.id != null ? s.id : String(i) }));
  }
  return [{ ...loadedOrSources, id: loadedOrSources.id != null ? loadedOrSources.id : '0' }];
}

function planFor(loadedOrSources, segments, opts = {}) {
  const sources = asSourceList(loadedOrSources);
  if (!sources.length) throw new Error('没有可用的源');
  const splitOutput = !!opts.split;
  const keeps = opts.ordered
    ? orderPreserving(segments)
    // split（「每段一个文件」）必须保留首尾相接的边界：相邻两段各是用户切出来的一份素材，
    // 并成一段分组就没了（产物变成"一段包含所有片段的完整视频"，用户实测报的失效）
    : normalizeSegments(segments, { keepAdjacent: splitOutput });

  /**
   * 一条保留区间属于哪个源：`seg.srcIndex`。
   *
   * **计划必须按源分别推导**（2026-10-18 多源改造）：关键帧表、帧率、网格原点、
   * 重排深度、接缝探针结论全都绑定在各自的源上。混在一起算会把 A 源的关键帧
   * 当成 B 源的，切点与帧数预算全错。所以这里按源分组调 buildPlan，再按全局
   * keepIndex 合并回来——分组、字幕重排、界面映射仍然一一对应。
   */
  const srcOfKeep = (k) => {
    const i = Number(k && k.srcIndex);
    return Number.isInteger(i) && i >= 0 && i < sources.length ? i : 0;
  };
  const allWarnings = [];
  const planByGi = new Map();
  const warnsSeen = new Set();
  // 跨源统一参数时，参数不一致的源要**整段重编码**（流拷贝拼不了，实测会静默丢帧）。
  // 用函数传入，让每个源各自决定；单源导出恒为 false。
  const forceFor = typeof opts.forceReencodeFor === 'function' ? opts.forceReencodeFor : () => false;

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    const items = [];
    keeps.forEach((k, gi) => { if (srcOfKeep(k) === si) items.push({ keep: k, gi }); });
    if (!items.length) continue;
    const forceThis = !!forceFor(si, src);
    const { plan: subPlan, warnings: subWarn } = buildPlan(items.map((x) => x.keep), {
      keyframes: src.media.keyframes,
      // media.video.fps 是 avg_frame_rate（实测帧数/时长），VFR 源也得用它折帧数：
      // 实测 VFR 源改用 -t 限长时长根本收不住（要 2.27s 给出 4.83s，把删掉的内容又带回来）
      fps: src.media.video?.fps,
      gridOrigin: src.media.gridOrigin,
      reorderDepth: src.media.video?.reorderDepth,
      duration: src.media.duration,
      ordered: !!opts.ordered,
      sameCodec: forceThis ? false : keepsSourceCodec(src.media),
      /**
       * 开放 GOP 的源每个段内关键帧后跟 (深度+1) 个 RASL 画面（x265 实测）。
       * RASL 剥除已整体移除（2026-10-17 定案，四轮实验，见 buildArgs 顶部定案注释与
       * docs/exploration-as-rasl-fix.md）——段内 RASL 是真画面，保留；但它们按解码序
       * 占 `-frames:v` 的包位，所以预算要**加回**它们的包数（cuttings.raslKfsIn）。
       * 闭合 GOP（hasRasl=false）没有 RASL，传 0。
       */
      raslPerKf: src.media.video?.codec === 'hevc' && src.media.video?.reorderDepth >= 0
        && src.media.hasRasl === true
        ? src.media.video.reorderDepth + 1
        : 0,
      /**
       * 多段纯拷贝拼接是否需要"接缝缓解"（非首个片段开头重编码，自带 IDR 重置 POC）。
       * 判据：`hasRasl === true`（HEVC 开放 GOP）或 `seamSafe === false`（通用探针实测拼不了）。
       */
      seamNeedsIdr: src.media.hasRasl === true || src.media.seamSafe === false,
      /**
       * 更严重的一层：探针发现**单个拷贝段自己就解不开**（x264 开放 GOP 的 K 帧不是 IDR）。
       * 此时"开头重编码一小段"救不了，只能整段重编码。
       */
      forceWholeReencodeNative: src.media.segmentsOk === false,
      /**
       * 跨素材统一参数：这个源与基准不一致 → 每段都整段重编码并归一化。
       * 这是"必须"而不是"可选"：实测流拷贝拼参数不同的素材会**静默丢帧**
       * （273/300 帧、帧间隔塌到 0.0001s，解码却不报错）。
       */
      forceWholeReencode: forceThis,
      // precise=false → 吸附模式：入点前移到关键帧整段流拷贝（防吞钳制在 buildPlan 里）
      precise: opts.precise !== false,
      // 「每段一个文件」：dedupePlan 不得跨保留区间合并，否则两条相邻片段会被并成一组
      splitOutput,
    });
    // 组内 keepIndex → 全局 keepIndex；同时打上 srcIndex，导出时据此选对源文件。
    // **一条区间可能产出多个计划项**（精确模式 = 重编码头 + 拷贝尾），必须按数组收集，
    // 不能用 Map 以 keepIndex 为键——那样后一项会把前一项覆盖掉（实测重编码头整段丢失，
    // 3 条区间 10s 变成 4s，只剩拷贝尾段）。
    /**
     * `outGroup` 必须在**这里**按全局序号重打（2026-10-18 多素材）。
     *
     * `buildPlan` 是按源分别调用的，每个源只看到自己的 keeps，于是两个源的首条区间
     * 都会被打成 `k0`——「每段一个文件」于是把两份素材并成同一个文件
     * （实测两段素材只产出 1 个文件、内容还是混的）。合并之后按全局 keepIndex 重算，
     * 分组边界才与用户在时间轴上看到的片段一一对应。
     */
    const anyGroup = keeps.some((k) => k && k.group != null);
    for (const p of subPlan) {
      const gi = items[p.keepIndex] ? items[p.keepIndex].gi : p.keepIndex;
      const k = keeps[gi];
      const arr = planByGi.get(gi);
      const one = {
        ...p,
        keepIndex: gi,
        srcIndex: si,
        sourceId: src.id,
        outGroup: (!anyGroup || !k || k.group == null) ? `k${gi}` : `g${k.group}`,
      };
      if (arr) arr.push(one);
      else planByGi.set(gi, [one]);
    }
    for (const w of subWarn) {
      if (warnsSeen.has(w)) continue;
      warnsSeen.add(w);
      allWarnings.push(w);
    }
  }

  // 按全局顺序摊平（乱序时 keeps 的顺序就是导出顺序，plan 项必须跟着走）。
  // 同一 keep 的多项（重编码头 + 拷贝尾）按原顺序全部保留。
  const plan = [];
  for (let gi = 0; gi < keeps.length; gi++) {
    const arr = planByGi.get(gi);
    if (arr) plan.push(...arr);
  }

  const keepSecs = opts.ordered
    ? snap(keeps.reduce((acc, k) => acc + (k.end - k.start), 0))
    : totalDuration(keeps);
  /**
   * 每条保留区间**实际第一帧**的源时刻：入点不在帧网格上时画面从网格点起步。
   * 字幕按文本重新计时要拿它做减法，否则每条 cue 都比口型晚半帧（见 cuttings.frameStart）。
   * 多源时按各自源的帧率与网格原点算。
   */
  const keepAligns = keeps.map((k) => {
    const src = sources[srcOfKeep(k)] || sources[0];
    return frameStart(k.start, src.media.video?.fps, src.media.gridOrigin);
  });
  /**
   * 片段 → 保留区间的对应表（界面按**片段序号**取代价与吸附差，计划按 keepIndex 打标）。
   *
   * 平时两者一一对应（clips[i] ↔ keeps[i]），但「多段合并导出」会把同组的相邻片段
   * 在规整阶段并成一条 keep，keeps 就比 clips 短了；这时仍按序号硬对会让后面的片段
   * 全部错位（实测第 3 段显示"待计划"，因为它去查 keepIndex=2 而计划里只有 0/1）。
   * 所以这里按源区间把每个片段映射回它实际落进的那条 keep。
   */
  const clipToKeep = mapClipsToKeeps(segments, keeps, { ordered: !!opts.ordered });
  return { keeps, plan, warnings: allWarnings, keepSecs, keepAligns, clipToKeep };
}

/**
 * 片段 → keepIndex 的映射。
 *
 * 判据是"片段的源起点落在哪条 keep 里"（同组相邻片段被并成一条 keep 时，
 * 组内每段都指向那一条）。找不到（片段被源尾裁剪掉等）就给 null，界面显示"待计划"。
 *
 * `ordered`（用户拖过顺序）时不能按源时刻找：keeps 的顺序就是数组顺序、内容可能任意重叠，
 * 只能按序号一一对应——规整阶段是逐条保序的（orderPreserving），所以序号恒定可靠。
 */
function mapClipsToKeeps(segments, keeps, opts = {}) {
  const list = segments || [];
  if (opts.ordered) return list.map((_, i) => (i < keeps.length ? i : null));
  return list.map((raw) => {
    const start = Number(raw && raw.start);
    if (!Number.isFinite(start)) return null;
    let best = null;
    for (let i = 0; i < keeps.length; i++) {
      const k = keeps[i];
      if (start >= k.start - 1e-3 && start < k.end - 1e-6) return i;
      // 起点正好等于某条 keep 的终点（相邻边界）：归后一条
      if (Math.abs(start - k.start) <= 1e-3) return i;
      if (start < k.start) break;
      best = i;
    }
    return best;
  });
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
 *
 * 第一个参数既可以是单个 `loaded`（旧调用），也可以是**源数组**
 * （多素材追加导入后为此形状）。第三个参数里的 `normalize` 决定跨源参数如何统一。
 */
async function exportSegments(loadedOrSources, segments, opts) {
  const sources = asSourceList(loadedOrSources);
  if (!sources.length) throw new Error('没有可用的源');
  // 单源语义全部沿用"第一个源"：file/media/bins 在多源下只代表"主源"，
  // 逐段的源由 plan 项的 srcIndex 决定（见下方切割循环）。
  const primary = sources[0];
  const { file, media, bins } = primary;
  const {
    outPath, split = false, crf = 18, ordered = false,
    precise = true, dropSubtitles = false, container = null,
    onProgress = () => {}, token = createToken(),
    /** 跨源统一参数：`{ width, height, fps, sar, codec, audio }`。单源导出不传。 */
    normalizeTo = null,
    /** 哪些源需要整段重编码（参数与基准不一致）。单源导出不传。 */
    reencodeSources = null,
  } = opts;

  // 自检用的容器家族：调用方传容器 id（'mp4'）或扩展名（'.mp4'）都行，转成
  // containers 的家族对象（{family,label,ext}）；不传则 verify 退回"与源一致"判。
  const containerFamily = (typeof container === 'string' ? byId(container) || byExt(container) : container);

  /**
   * 多源时，被判定"参数不一致、必须统一"的源要整段重编码（流拷贝拼不了）。
   * forceReencodeAll 只作用于这些源：同源导出、或参数一致的源之间，绝不因此多编一帧。
   */
  const forceAll = new Set(Array.isArray(reencodeSources) ? reencodeSources : []);
  const needsForce = (srcIndex) => forceAll.has(sources[srcIndex]?.id) || forceAll.has(srcIndex);

  const { keeps, plan, warnings, keepSecs: totalKeep, keepAligns } = planFor(sources, segments, {
    ordered, precise, dropSubtitles, split,
    // 按源决定是否强制整段重编码：planFor 内部逐源调 buildPlan，这里按源号判断
    forceReencodeFor: (si, src) => needsForce(si) || needsForce(src.id),
  });
  if (keeps.length === 0) throw new Error('没有有效的保留区间');
  if (plan.length === 0) throw new Error(`所有保留区间都落在源尾之后或不足一帧：${warnings.join('；') || '无计划段'}`);

  // 整片换了编码（源编码没有对应的同编码重编码器）时，自检要拿"所选编码"
  // 比对，而不是拿源比对——否则这条明说的重编码会被判成故障。
  const allReencode = plan.every((p) => p.kind === 'reencode');
  const intendedCodec = allReencode && !keepsSourceCodec(media)
    ? (CODEC_OF_ENCODER[pickVideoCodec(media)] || null)
    : null;
  /**
   * 切割用的帧率与"输出主体参数"。
   *
   * 跨源统一参数时必须用**基准参数**（normalizeTo），而不是第一个源的：
   * 基准源可能不是第一个（实测基准是第二个源 640x360@24，产物却按下第一个源的
   * 30fps/320x180 出，结果是"分辨率一致"自检失败、音画差 0.9s）。
   */
  const cutFps = normalizeTo?.fps || media.video?.fps;

  // 中间文件落在**输出盘**（见 makeTempDir 注释：以前写系统临时盘，大素材必爆）
  const tmpDir = await makeTempDir(outPath);
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
  const space = await precheckSpace(outPath, media, {
    keepSecs: totalKeep,
    workSecs: normalize ? (media.duration || 0) : 0,
    tmpBase: tmpDir,
  });
  if (!space.ok) throw new Error(space.message);
  onProgress({ phase: 'prepare', keepSecs: totalKeep, segments: keeps });

  try {
    /**
     * 多源（2026-10-18）：每个源各自准备一份"切片用的源"。
     *
     * 单源时这就是以前那个 `src`，行为逐字节不变。多源时每个源独立判断要不要归一封装，
     * 结果放进 srcPool[srcIndex]，切割循环按 `item.srcIndex` 取对应那份——拿错文件
     * 会切出完全不相干的内容，而且自检只看时长/帧数，很可能照样"通过"。
     */
    const srcPool = await Promise.all(sources.map(async (s) => {
      let one = { file: s.file, media: s.media };
      if (!willNormalize(s.media, plan.filter((p) => p.srcIndex === sources.indexOf(s)).length, stripSubs)) {
        return one;
      }
      try {
        const w = await makeWorkingCopy(bins, s.file, s.media, tmpDir, token);
        if (sources.length > 1) {
          warnings.push(`${path.basename(s.file)} 不是 MP4 封装：已把它纯拷成 MP4 工作副本再切（否则按段归零时间戳会丢报文时间戳，实测 MKV 源直接切出的段 pts 为空，拼不了）`);
        } else {
          warnings.push('源不是 MP4 封装：多段拼接前已把它纯拷成 MP4 工作副本，否则按段归零时间戳会丢报文时间戳（实测 MKV 源直接切出的段 pts 为空，拼不了）');
        }
        return w;
      } catch (err) {
        if (isCancelled(err)) throw err;
        const detail = String(err.message || err).split('\n')[0].slice(0, 90);
        if (sources.length > 1) warnings.push(`${path.basename(s.file)} 封装归一失败（${detail}），改用源文件直接切割`);
        else warnings.push(`封装归一失败（${detail}），改用源文件直接切割`);
        return one;
      }
    }));
    if (sources.length === 1) onProgress({ phase: 'normalize', note: '先把源封装归一成 MP4（纯拷贝，不重编码）' });
    const src = srcPool[0];
    // 中间段优先写 MP4（原因见 partsAsMp4）；只有必须把字幕带在段里时才沿用目标容器。
    const partExt = partsAsMp4(media, ext, carrySubsInParts) ? '.mp4' : ext;
    // 「读 mov 族 且 写 mov 族」才敢让拷贝段的时间戳不归零：
    // 不归零才不会每个接缝多一帧（见 buildArgs），但读 MKV/TS 或写 MKV 时会丢报文时间戳。
    // **VFR 源除外**（2026-10-17 实测）：VFR 输入侧 -ss 后音频包天然带大负偏移
    // （实测首包 pts=-44885 样本 ≈ -1.02s），`disabled` 让这个负偏移原样进段文件；
    // concat 拼接按"最大流偏移"补齐时把它整段推后——2.68s 的视频配出 3.04s 音频
    // （多 0.36s 静音，自检"音画一致"必挂）。`make_zero` 把音频也拉回 0，
    // 拼接后逐包贴合（2.6279 vs 2.6800）。VFR 段本来就全部重编码，不用顾虑
    // disabled 那点"接缝多一帧"的小账。
    const zeroFree = familyOfFormat(src.media.format) === 'mov' && familyOfExt(partExt) === 'mov'
      && !media.video?.vfr;
    const copyTs = zeroFree ? 'disabled' : 'make_zero';
    if (!zeroFree && plan.some((p) => p.kind === 'copy')) {
      warnings.push('这次导出无法让拷贝段的时间戳严格按帧对齐（源或目标容器不允许）'
        + (media.video?.vfr ? '，或源是可变帧率' : '')
        + '——接缝处可能多带 1~2 帧画面：产物内容仍是按你选的区间切的');
    }

    // 混拼（重编码段与流拷贝段并存）时，拷贝段要把源参数集内嵌进关键帧包：
    // MP4 每轨只存一份参数集，拼接产物取第一段的；若第一段是重编码段，它那套
    // 参数集与源的不一致，拷贝段就会解不开（HEVC 必炸，H.264 靠解码器容错侥幸活着）。
    // 全拷贝（参数集同源）或全重编码（只有一套）都不需要。见 buildArgs.MIXED_PARAM_BSF。
    const mixedCodecs = plan.some((p) => p.kind === 'copy') && plan.some((p) => p.kind === 'reencode');

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const partFile = path.join(tmpDir, `seg${String(i).padStart(3, '0')}${partExt}`);
      /**
       * 按 `srcIndex` 取该段自己的源（2026-10-18 多源）。
       * 单源时恒为 srcPool[0]，与改造前完全一致。
       * 拿错源的后果不是报错，而是"切出另一份素材却照样能通过自检"——必须按段严格对齐。
       */
      const srcOfItem = srcPool[item.srcIndex] || srcPool[0];
      /**
       * 跨源参数归一：这段的源参数与基准不一致时，重编码段必须显式把尺寸/帧率/SAR 统一过去。
       * 被判为"要重编码"的段一定带有 forceReencode，所以这里只在不等于基准时才给 filter。
       */
      const needNorm = normalizeTo && needsForce(item.srcIndex) ? normalizeTo : null;
      const args = argsForSegment(item, { ...srcOfItem.media, file: srcOfItem.file }, partFile, {
        crf, fps: cutFps, dropSubtitles: dropSubtitles || stripSubs, copyTs,
        dumpParams: mixedCodecs,
        normalize: needNorm,
        // 归一化时编码器必须由目标编码决定（否则 hevc 源会重编码成 hevc，与 h264 段拼不起来）
        targetCodec: needNorm ? normalizeTo.codec : null,
      });
      onProgress({ phase: 'cut', index: i, total: plan.length, kind: item.kind, range: `${fmtTime(item.start)}→${fmtTime(item.start + item.duration)}`, note: item.note });
      await runWithProgress(bins.ffmpeg, args, item, onProgress, token);
      partFiles.push(partFile);
    }
    /**
     * 拼接与自检用的"产物主体参数"。
     *
     * 单源：就是那个源。
     * 多源统一参数：必须用**基准参数**重建一份——否则拼接仍按第一个源的时基/分辨率
     * 去推，产物会是"第一个源的参数"（实测基准是第二个源时，产物出成 320x180@30，
     * 而所有段其实都统一到了 640x360@24，于是时长 4.917 而不是 4.000）。
     */
    const cutMedia = normalizeTo
      ? {
        ...media,
        video: {
          ...media.video,
          width: normalizeTo.width,
          height: normalizeTo.height,
          fps: normalizeTo.fps,
          pixFmt: normalizeTo.pixFmt || media.video?.pixFmt,
          sar: normalizeTo.sar || media.video?.sar,
          codec: normalizeTo.codec || media.video?.codec,
        },
        audioTracks: normalizeTo.audio
          ? [{ ...(media.audioTracks?.[0] || {}), ...normalizeTo.audio }]
          : media.audioTracks,
      }
      : src.media;
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
    /**
     * 时长自检的基准：**Σframes/fps**。
     *
     * RASL 剥除已整体移除（2026-10-17），不再有"帧被剥掉但 PTS 空洞还在"的成分
     * ——保留的 RASL 的显示时刻本就在窗口内，既占 frames 也占时长，两边自洽。
     * B 帧收尾（trimmed）会让产物比窗口短，那段是真删掉的帧，属正常折让。
     * fps 缺失（折不出帧数）时回退窗口和，允差交给 verify 的 -1.0s 下界兜底。
     */
    const framesToSecs = (idxList) => {
      const f = framesSum(idxList);
      return f != null && cutFps ? f / cutFps : idxList.reduce((a, n) => a + plan[n].duration, 0);
    };
    const expectSlack = [];
    /**
     * 每条保留区间在**成片**里的起点（拼接模式按全部区间累加）。
     *
     * 必须逐**计划项**累加、给每个出现的 keepIndex 都记一次，不能按输出分组记
     * （2026-10-18 修）：分组以前恒等于"一条区间"，按组记没错；但「多段合并导出」
     * 让一个组里装了好几条区间，按组记就只给每组第一条记了位置，
     * 后面几条的 progOfKeep 是 undefined → 字幕重排全挤到 0（非 split 路径会用到它）。
     */
    const progOfKeep = {};
    {
      let cursor = 0;
      for (const p of plan) {
        if (p.keepIndex != null && progOfKeep[p.keepIndex] === undefined) progOfKeep[p.keepIndex] = cursor;
        cursor += p.duration;
      }
    }
    const keepsOf = (idxList) => [...new Set(idxList.map((n) => plan[n].keepIndex).filter((k) => k != null))];
    /**
     * 某一组计划项里，每条保留区间在该组**自己那个文件**里的起点（成片时间，从 0 起）。
     * 一条区间一组时就是 0；「多段合并导出」时后几段要接在前几段之后，
     * 字幕重排与自检基准都靠这张表。
     */
    function groupKeepStarts(idxList) {
      const ks = keepsOf(idxList);
      const start = {};
      let acc = 0;
      for (const n of idxList) {
        const k = plan[n].keepIndex;
        if (k == null) { acc += plan[n].duration; continue; }
        if (start[k] === undefined) start[k] = acc;
        acc += plan[n].duration;
      }
      return { ks, start };
    }
    /** 重排字幕 sidecar：split 时每片只装自己那组区间的字幕，起点按组内位置。 */
    async function sidecarsFor(idxList, tag) {
      if (!subDocs) return { files: [], cues: null };
      const files = [];
      const cues = [];
      const { ks, start } = groupKeepStarts(idxList);
      for (const entry of subDocs) {
        const one = split
          ? await writeRetimeSidecar(entry, ks.map((k) => keeps[k]), ks.map((k) => start[k] || 0),
            ks.map((k) => keepAligns[k]), tmpDir, tag)
          : await writeRetimeSidecar(entry, keeps, keeps.map((_, i) => progOfKeep[i] || 0), keepAligns, tmpDir, tag);
        if (one) { files.push(one.file); cues.push(one.cues); }
      }
      return { files, cues };
    }

    if (split) {
      // 需求文档 §4.3：「每段一个文件」= 一个导出分组一个文件。
      // 默认一条保留区间一组；用户在时间轴上把几段并成一组时，那几段拼进同一个文件。
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
        expectSecs.push(snap(framesToSecs(groups[i])));
        expectFrames.push(framesSum(groups[i]));
        expectSlack.push(rateSlackOf(groups[i]));
        wantCues.push(subs.cues);
        if (subs.cues) subTracks.push(subs.cues.length);
        seamsList.push(seamsOf(groups[i]));
        // 该组的用户选区总长：合并组要把组内每条区间都算上
        const ks = keepsOf(groups[i]);
        userSecs.push(ks.length ? snap(ks.reduce((a, k) => a + (keeps[k] ? keeps[k].end - keeps[k].start : 0), 0)) : undefined);
      }
    } else {
      const subs = await sidecarsFor(plan.map((_, n) => n), 'all');
      await concatInto(partFiles, outPath, cutMedia, bins, { subs: subs.files });
      outputs = [outPath];
      // 基准按计划实算：段时长是整帧时刻，与用户选区最多差一帧。
      // 拿源长百分比当允差会宽到"吞掉剪辑"都查不出来（实测 98 分钟片删 1.9s 判通过）。
      expectSecs.push(snap(framesToSecs(plan.map((_, n) => n))));
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
          rateSlack: expectSlack[i], container: containerFamily, wantCues: wantCues[i],
          subTracks: subTracks[i],
          dropSubtitles, codec: intendedCodec, vfr: !!media.video?.vfr, parts: plan.length,
          seams: seamsList[i],
          sourceFormat: media.format,
          /**
           * 多段素材统一参数时，产物应当长成"基准参数"的样子——不是第一个源的样子。
           * 不传这个，自检会拿第一个源去比，把正确的产物判成故障（实测）。
           */
          target: normalizeTo
            ? { ...normalizeTo, codec: normalizeTo.codec || cutMedia.video?.codec }
            : null,
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

/**
 * 按**导出分组**给切割计划分组。
 *
 * 以前按 `keepIndex` 分组（一条保留区间一个文件）。现在计划项带 `outGroup`
 * （cuttings.tagOutputGroups）：默认仍是"一条区间一组"，用户在时间轴上把几段
 * 并成一组时，那几段共享同一个 outGroup —— 于是它们 concat 成一个文件，
 * 这就是「多段合并导出」的实现方式（不新增拼接逻辑，只换分组键）。
 *
 * 兼容旧计划项（没有 outGroup）：退回 keepIndex。
 */
function groupByKeep(plan) {
  const groups = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const key = p.outGroup != null ? p.outGroup
      : (p.keepIndex == null ? groups.length : p.keepIndex);
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
    /**
     * 每条区间在该文件里的起点。split 下以前恒为 0（一条区间一个文件），
     * 「多段合并导出」后一个文件里有好几条区间，必须按组内位置依次累加，
     * 否则后几段的 cue 会全部挤到 0 附近、自检必然误报。
     */
    const baseOf = {};
    if (split) {
      let acc = 0;
      for (const n of groups[outIndex]) {
        const k = plan[n].keepIndex;
        if (k == null) { acc += plan[n].duration; continue; }
        if (baseOf[k] === undefined) baseOf[k] = acc;
        acc += plan[n].duration;
      }
    }
    return cueLists.map((list) => {
      const out = [];
      for (const t of list) {
        const k = ks.find((ki) => t >= keeps[ki].start - 0.001 && t < keeps[ki].end);
        if (k === undefined) continue;
        const align = (aligns && Number.isFinite(aligns[k])) ? aligns[k] : keeps[k].start;
        out.push(split ? (baseOf[k] || 0) + (t - align) : (progOfKeep[k] || 0) + (t - align));
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
  // 纯拷贝不改码流，RASL 的有无跟着源走（planFor 用的是源 media，这里只为一致）
  wm.hasRasl = media.hasRasl;
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

/**
 * 通用探针：这份源的**纯拷贝多段拼接**能不能解码干净？并区分坏在哪一层。
 *
 * 为什么要有它（2026-10-17）：视频格式太多（h264/hevc/vp9/av1/mpeg2/mpeg4…），
 * 每种的随机接入语义都不同。逐个写规则要么漏（H.264 的开放 GOP 就没有对应代码），
 * 要么互相打架。实测可以**完全不看编码**：拿生产自己的切段/拼接参数在源上做一次
 * 微缩试跑，看产物解码有没有错。
 *
 * 三个实测得出的设计要点（每一条都是踩过坑才定下来的）：
 *  1. 必须测**多段拼接**，不能测"单段能不能解"：HEVC 开放 GOP 单段全干净，
 *     两段拼起来才报 `Duplicate POC`（前导帧引用了段外画面）。单段探针会漏判。
 *  2. 必须用**生产函数**（planFor + argsForSegment）而不是手写 ffmpeg 参数：
 *     手写时漏一个 `frames` 字段（该用 `-frames:v` 却用了 `-t`），切出的段就与生产
 *     不同，实测会把 HEVC 开放 GOP 误判成安全。
 *  3. 段要**够长（6s）**：2s 的段装不下足够的段内关键帧，被剥的 RASL 太少，
 *     POC 冲突在解码器那里还没累积到报错的程度，会漏判。
 *
 * **必须看 stderr，不能只看退出码**：`Duplicate POC` / `mmco: unref short failure`
 * 这类问题 ffmpeg 照样退出 0，只看退出码会把坏产物判成安全（实测漏判过）。
 *
 * 返回分两层，因为两类源的修法不同（实测）：
 *  - `segmentsOk=false`：连**单个拷贝段**都解不开 → 该源的关键帧不是自包含接入点
 *    （实测 x264 开放 GOP 的 K 帧 NAL type 是 1 不是 5，根本不是 IDR）；
 *    只能整段重编码，接缝缓解救不了。
 *  - `segmentsOk=true && concatOk=false`：段都干净、拼起来才炸（HEVC 开放 GOP）
 *    → 用"非首个片段开头重编码"重置 POC 即可，代价只有一小段。
 *
 * @returns {Promise<{safe:boolean, segmentsOk:boolean, concatOk:boolean, detail:string, ms:number, segs:number}>}
 */
async function probePureCopySeams(loaded, opts = {}) {
  const { segSec = 6.0, picks = 3 } = opts;
  const { file, media, bins } = loaded;
  const kfs = media?.keyframes || [];
  const fps = Number(media?.video?.fps) > 0 ? Number(media.video.fps) : 30;
  const dur = Number(media?.duration) || 0;
  const none = { safe: true, segmentsOk: true, concatOk: true, detail: '', ms: 0, segs: 0 };
  if (kfs.length < 3 || dur <= 0) return { ...none, detail: '关键帧/时长不足，跳过' };
  /**
   * 带字幕轨的源不能这么探：探针固定写 MP4 中间段，而 MP4 装不下 subrip/ass 的流拷贝
   * （实测 `Could not find tag for codec subrip`）——探针会自己失败，把好源误判成坏源。
   * 字幕在导出路径里另有处理（抽出来重排），与接缝问题无关，直接跳过探测。
   */
  if ((media.subtitleCodecs || []).length) return { ...none, detail: '源带字幕轨，跳过探测（不影响接缝判断）' };

  const t0 = Date.now();
  const usable = kfs.slice(0, Math.max(1, kfs.length - 1));
  const step = Math.max(1, Math.floor(usable.length / (picks + 1)));
  const starts = [];
  for (let i = 1; i <= picks; i++) {
    const k = usable[Math.min(usable.length - 1, i * step)];
    if (Number.isFinite(k) && k + 0.4 < dur) starts.push(snap(k));
  }
  const uniq = [...new Set(starts)];
  if (uniq.length < 2) return { ...none, detail: '可采样点不足 2 个，跳过' };

  let tmpDir;
  try {
    tmpDir = await makeTempDir(file, '.fast-cut-probe-');
  } catch (err) {
    /* 建不出临时目录（两个卷都写不了）：保守要求接缝缓解，别因为探针跑不了就交出坏产物 */
    return {
      safe: false, segmentsOk: true, concatOk: false, segs: 0, ms: 0,
      detail: `探针无法建临时目录：${String(err.message).split('\n')[0].slice(0, 80)}`,
    };
  }
  try {
    const parts = [];
    let segBad = '';
    let cutFail = '';
    for (let i = 0; i < uniq.length; i++) {
      // 单条区间走吸附模式 → 拿到真实的纯拷贝计划项（含 frames），再只取拷贝段
      const { plan } = planFor(loaded, [{ start: uniq[i] + 0.4, end: Math.min(uniq[i] + 0.4 + segSec, dur - 0.05) }],
        { precise: false });
      const copy = plan.find((p) => p.kind === 'copy');
      if (!copy || !(copy.duration > 0.3)) continue;
      const out = path.join(tmpDir, `s${i}.mp4`);
      try {
        await run(bins.ffmpeg, argsForSegment(copy, media, out, { fps, copyTs: 'make_zero', dumpParams: false }));
      } catch (err) {
        cutFail = String(err.message).split('\n')[0].slice(0, 100);
        break;
      }
      // 单段自解：这一层决定"接缝缓解够不够"
      if (!segBad) {
        const e = await decodeNoise(bins.ffmpeg, out);
        if (e) segBad = e;
      }
      parts.push(out);
    }
    /**
     * 样段**切不出来**（磁盘满 / 权限 / 编码器异常）与"这份源没有可测的多段拷贝形态"
     * 必须分开对待：前者是**未知**，只能保守要求接缝缓解（代价是接缝处一小段重编码），
     * 绝不能返回"安全"——那会静默跳过缓解、交出可能解不开的产物（2026-10-17 记）。
     */
    if (cutFail) {
      return {
        safe: false, segmentsOk: true, concatOk: false, segs: parts.length, ms: Date.now() - t0,
        detail: `试切样段失败，无法判定接缝：${cutFail}`,
      };
    }
    if (parts.length < 2) return { ...none, detail: `只切出 ${parts.length} 段，跳过`, segs: parts.length };
    if (segBad) {
      return { safe: false, segmentsOk: false, concatOk: false, detail: segBad, ms: Date.now() - t0, segs: parts.length };
    }

    const joined = path.join(tmpDir, 'j.mp4');
    await fsp.writeFile(listPathOf(joined), concatListBody(parts), 'utf8');
    try {
      await run(bins.ffmpeg, argsForConcat(parts, joined, media, 'concat_demuxer', {}));
    } catch (err) {
      return { safe: false, segmentsOk: true, concatOk: false, detail: `试拼失败：${String(err.message).split('\n')[0].slice(0, 100)}`, ms: Date.now() - t0, segs: parts.length };
    }
    const e = await decodeNoise(bins.ffmpeg, joined);
    return {
      safe: !e, segmentsOk: true, concatOk: !e,
      detail: e, ms: Date.now() - t0, segs: parts.length,
    };
  } finally {
    await rmrf(tmpDir);
  }
}

/** 解一遍产物，返回第一条真正的错误（没有错误返回空串）。封装修辞按 verify 同一口径滤掉。 */
async function decodeNoise(ffmpegPath, file) {
  const BENIGN = /non monotonically increasing dts to muxer|Last message repeated \d+ times/i;
  let stderr = '';
  try {
    const r = await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
    stderr = r.stderr || '';
  } catch (err) {
    stderr = err.stderr || err.message || '';
  }
  const n = String(stderr).split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !BENIGN.test(l)).map((l) => l.replace(/^\[[^\]]+\]\s*/, ''));
  return n[0] || '';
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
  probePureCopySeams,
  // 下面两个导出只为单测（空间预检与中间目录选址都是"错了就丢一晚导出"的地方）
  precheckSpace, makeTempDir,
};
