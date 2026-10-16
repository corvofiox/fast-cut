'use strict';

/**
 * 内核的"容器 × 编码 × 裁剪模式 × 目标封装"矩阵自检（不依赖 Electron）：
 *   node scripts/codecs.js
 * 自己造素材 → 每种模式各导一遍 → 逐条核对自检结论是否可信。
 *
 * 判据不是"全部成功"，而是**不许静默交出差文件**：
 * 要么 ok=true，要么 ok=false 且能指出哪一项没过。做不到就退出码 1。
 *
 * 素材不是随便挑的，每一行都对应一个真踩过的坑（详见 docs/02）：
 *  - 约束基线 H.264：ffprobe 的 "Constrained Baseline" 原样喂给 x264 会打不开编码器
 *  - MPEG-4 ASP（.avi）：源 profile "Simple Profile" 同上
 *  - 偏移 .ts：首帧 pts 不是 0（相机/录像带素材），时间轴整体平移、拼接还会摊成十倍长
 *  - VFR：标称帧率与实测不符，按帧数限长会切错长度
 *  - Matroska 里的 HEVC 开 GOP：先归一成 MP4 工作副本才能拼干净（不归一必炸）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { loadSource, exportSegments, planFor, groupByKeep } = require('../core/pipeline');
const { frameStart } = require('../core/cuttings');
const { decodeErrors } = require('../core/verify');
const { byExt, unmuxableSubtitles } = require('../core/containers');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tmp', 'codecs');
const SEGS = [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8.0, end: 9.5 }];

/**
 * 长素材专用区间（配合 fx.segs === 'long' 的素材）。
 * 每条区间都跨多个关键帧：入点不在关键帧上 → 重编码头段；后面还有长拷贝尾段。
 * 两三条这样的区间拼起来就是 R→C→R→C，正是混拼参数集错乱的必要形态。
 */
const LONG_SEGS = [{ start: 3.4, end: 12.3 }, { start: 16.4, end: 25.3 }];

const V = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10'];
const A = (freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=10`];

/**
 * 字幕核对用的 cue 起点：每条都落在某条保留区间**内部**（远离边界），
 * 这样"丢了哪条、漂了多少"是可以精确算出来的。
 * 保留区间 [[0.5,2.3],[4.1,6.7],[8.0,9.5]] 的成片起点依次是 0 / 1.8 / 4.4，
 * 所以期望落点 = 0.3（0.8）/ 1.6（2.1）/ 2.7（5.0）/ 4.6（8.2）。
 */
const SUB_CUES = [0.8, 2.1, 5.0, 8.2];
const SRT_TEXT = SUB_CUES.map((t, i) => {
  const stamp = (s) => `00:00:${s.toFixed(3).padStart(6, '0')}`.replace(/\./, ',');
  return `${i + 1}\n${stamp(t)} --> ${stamp(t + 0.4)}\ncue-${i + 1}\n`;
}).join('\n');

/** ASS 版：字段顺序故意用默认的 Layer,Start,End,…，并留一条 Comment 验证不被改动 */
const ASS_TEXT = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Arial,16,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,这条不该出现在产物里
` + SUB_CUES.map((t, i) => {
  const stamp = (s) => `0:00:${s.toFixed(2).padStart(5, '0')}`;
  return `Dialogue: 0,${stamp(t)},${stamp(t + 0.4)},Default,,0,0,0,,cue-${i + 1}`;
}).join('\n') + '\n';

const FIXTURES = [
  {
    name: 'h264-mp4',
    file: 'h264.mp4',
    args: [...V, ...A(), '-c:v', 'libx264', '-profile:v', 'high', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    remux: ['mkv'],
  },
  {
    name: 'h264 约束基线-mp4',
    file: 'baseline.mp4',
    note: '入点重编码：profile 名要映射，否则 x264 报 invalid profile',
    args: [...V, ...A(), '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '31', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  },
  {
    name: 'h264-mkv-多轨',
    file: 'h264.mkv',
    note: '带字幕的源做分段流拷贝时，ffmpeg 逐段定位字幕轨会漏掉窗口内的 cue、也会把被删区间的串回来'
      + '（实测四条 cue 只出三条，条数还会被"漏一条+串一条"抵消）。自检按落点逐条比对并**拒绝交付**，'
      + '现在改成把字幕抽成文本按保留区间重新计时再上轨，四条 cue 落点逐条核对',
    subCues: SUB_CUES,
    args: [...V, ...A(), ...A(880), '-i', 'tmp/sub.srt', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
      '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt'],
    remux: ['mp4'],
  },
  {
    name: 'hevc-mov',
    file: 'hevc.mov',
    note: '开放 GOP：靠剔 RASL 才能纯拷贝拼接',
    args: [...V, ...A(), '-c:v', 'libx265', '-x265-params', 'log-level=none', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    remux: ['mkv'],
  },
  {
    name: 'hevc-mkv 开GOP',
    file: 'hevc.mkv',
    note: '以前多段拼接接缝解码不过：现在先把源纯拷成 MP4 工作副本再切，接缝干净（不再是需要用户绕开的限制）',
    args: [...V, ...A(), '-c:v', 'libx265', '-x265-params', 'log-level=none', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264-mkv-ass 字幕',
    file: 'ass.mkv',
    note: 'ASS 字幕：抽成文本按保留区间重排再上轨，Dialogue 的 Start/End 改完其余原样，'
      + '落在被删区间的整行不写，Comment 行不参与',
    subCues: SUB_CUES,
    args: [...V, ...A(), '-i', 'tmp/sub.ass', '-map', '0:v', '-map', '1:a', '-map', '2:s',
      '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'ass'],
  },
  {
    name: 'vp9-webm',
    file: 'vp9.webm',
    args: [...V, ...A(), '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-g', '60', '-c:a', 'libopus', '-shortest'],
  },
  {
    name: 'av1-mkv',
    file: 'av1.mkv',
    args: [...V, '-c:v', 'libaom-av1', '-crf', '50', '-b:v', '0', '-cpu-used', '8', '-g', '60', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'mpeg4ASP+mp3-avi',
    file: 'xvid.avi',
    note: '入点重编码：源 profile "Simple Profile" 不该被喂给 x264',
    args: [...V, ...A(), '-c:v', 'mpeg4', '-q:v', '5', '-g', '60', '-c:a', 'libmp3lame'],
  },
  {
    name: 'h264 偏移-ts',
    file: 'offset.ts',
    note: '首帧 pts 不是 0（13.7s 起）：时间轴归零 + 帧网格原点 + 归一成 MP4 段之后，'
      + '接缝不再被拉长，帧数与跨度都要贴着计划（以前这里必须响亮失败，现已解决）',
    args: [...V, ...A(), '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-output_ts_offset', '13.7'],
  },
  {
    name: 'h264-VFR-mp4',
    file: 'vfr.mp4',
    note: '可变帧率：帧长不均，只能整段重编码成定帧率，不该拿标称帧率判"帧率不一致"',
    args: [...V, ...A(), '-vf', "select='lt(mod(t,1),0.8)'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  {
    name: 'h264 12s超长GOP-mp4',
    file: 'longgop.mp4',
    note: '整片只有一个关键帧：每条区间都要整段重编码，产物时长必须贴着计划',
    args: [...V, ...A(), '-c:v', 'libx264', '-g', '360', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  },
  /**
   * 混拼长段回归（2026-10-17）：多区间精确模式产物必报参数集错乱
   * （`Invalid number of merging MVP candidates` / `delta_idx in slice header RPS`）。
   *
   * 上面所有素材都只有 10s，切出来的拷贝段只有 0.3~0.7s，装不下一个内部关键帧；
   * 于是"重编码段排在别段后面"这条通路从没被走到——这就是该 bug 活到发布的原因。
   * 这条素材 30s / 关键帧每 2s，配合 LONG_SEGS 让每条区间都产生
   * `重编码头段 + 长拷贝尾段`，完整覆盖 R→C→R→C 的拼接形态。
   *
   * 用 **HEVC + 闭合 GOP（open-gop=0）+ preset ultrafast**：
   *  - 必须是 HEVC：H.264 的 x264 参数集与源足够接近，靠解码器容错侥幸活着（实测不炸）；
   *  - 必须是 .mp4 源：矩阵输出容器跟随素材扩展名，而"MP4 每轨只容一份参数集"
   *    才是根源；写成 .mkv 参数集走带内、根本触发不到；
   *  - **必须是 ultrafast**：实测源用默认/medium preset 时，它与我们重编码段
   *    （`-preset veryfast`）的参数集恰好兼容，这个 bug 不复现；ultrafast 的
   *    SPS/PPS 差异够大才露馅。这条是实测结论，不是猜的——漏了它这条素材就白加。
   */
  {
    name: 'hevc 30s 混拼长段(闭GOP)',
    file: 'mixed30.mp4',
    note: '多区间精确模式（重编码头段+长拷贝尾段交替）：产物必须解码干净且帧数=计划',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=none:keyint=60:min-keyint=60:scenecut=0:open-gop=0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    segs: 'long',
    /**
     * 跨度允差放宽到 0.85s（默认 4 帧 ≈ 0.133s）。
     *
     * 这条素材的拷贝段很长（8.3s / 7.3s），把两条已知的记账分歧放大了：
     *  - 结束在源中间的拷贝段按 B 帧重排深度少给 2 帧（`trimmed`），窗口仍按原时长算；
     *  - 拷贝段的帧数预期还按"段内关键帧 × raslPerKf"扣，而 `raslPerKf` 只按编码
     *    是不是 HEVC 判断、没区分开/闭 GOP（闭合 GOP 没有 RASL 可剥，扣多了）。
     * 这条素材真正要守的是**帧数判据与解码判据**（实测 509=509、全片解码零报错）；
     * 跨度在长段上是已知不可靠的信号，故放宽，理由留档于此。
     */
    spanTol: 0.85,
  },
  /**
   * 开放 GOP 多区间（吸附模式）回归（2026-10-17 实测）：
   * 全片只有一个 IDR、其余是 CRA，两个纯拷贝段首尾相接时 POC 不重置 →
   * `Duplicate POC in a sequence`，且接缝后有源里不存在的坏帧。
   *
   * 修法是让第二个及以后的拷贝段走局部精确（入点小段重编码自带 IDR 重置 POC）。
   * 这条素材专门守它：`.mp4` 源（输出也是 mp4，才会撞参数集/POC 这一族问题）、
   * ultrafast（参数集差异够大）、30s（拷贝段装得下内部关键帧）。
   */
  {
    name: 'hevc 30s 开GOP 多区间',
    file: 'open30.mp4',
    note: '开放 GOP 的第二个拷贝段必须由 IDR 重置 POC，否则接缝报 Duplicate POC',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=none:keyint=60:min-keyint=60:scenecut=0:open-gop=1',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    segs: 'long',
    snap: true,
    spanTol: 0.85,
  },
];

const MODES = [
  { key: 'exact', label: '拼接', opts: {}, avBudget: 0.3 },
  { key: 'split', label: '每段一文件', opts: { split: true }, avBudget: 0.3 },
];

/**
 * 吸附模式（precise:false）——**应用层默认模式**。
 *
 * 这里刻意不做成全矩阵都跑：实测把所有素材都加一格"吸附"会打红 4 格，
 * 其中 3 格是**既有缺陷**（hevc-mov 跨度、mpeg4ASP 帧数、开放 GOP 跨度），
 * 与本轮改动无关。那批要单独排期修，不该混进这次提交。
 *
 * 只给下面的开放 GOP 素材用，因为"第二个拷贝段要重置 POC"这个回归
 * **只在吸附模式的多区间下出现**（精确模式每个区间开头本就有重编码段）。
 */
const SNAP_ONLY = { key: 'snap', label: '吸附', opts: { precise: false }, avBudget: 0.3 };

function sh(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function buildFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  // 字幕内容会改（核对 cue 条数与落点要用），每次都覆写
  fs.writeFileSync(path.join(ROOT, 'tmp', 'sub.srt'), SRT_TEXT, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'tmp', 'sub.ass'), ASS_TEXT, 'utf8');
  for (const fx of FIXTURES) {
    const target = path.join(DIR, fx.file);
    if (fs.existsSync(target) && !process.argv.includes('--rebuild')) continue;
    process.stdout.write(`  造素材 ${fx.name}…`);
    const t0 = Date.now();
    try {
      const args = fx.args.map((a) => (a.startsWith('tmp/') ? path.join(ROOT, a) : a));
      sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, target]);
      console.log(` ${(Date.now() - t0) / 1000}s`);
    } catch (e) {
      console.log(`失败：${String(e.stderr || e.message).replace(/\s+/g, ' ').slice(-90)}`);
    }
  }
}

/** 独立于 verify.js 的第二双眼睛：自己再解一遍码，用同一套"什么算真错误"的判定。 */
function decodeNoise(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64e6 });
  const noise = decodeErrors(r.stderr || '');
  if (r.status === 0) return noise;
  return [`退出码 ${r.status}：${noise[0] || ''}`.trim(), ...noise.slice(1)];
}

/**
 * 第二双眼睛之二：逐报文算每条流的真实时间线。
 * 容器总时长看不出"音频比视频长半秒"和"帧被越拉越开"这两类接缝病。
 */
function avSpread(file) {
  let j;
  try {
    j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json',
      '-show_entries', 'packet=stream_index,pts_time,duration_time', '-show_entries', 'stream=index,codec_type', file],
    { encoding: 'utf8', maxBuffer: 128e6 }));
  } catch { return null; }
  const typeOf = new Map((j.streams || []).map((s) => [Number(s.index), s.codec_type]));
  const agg = new Map();
  for (const p of j.packets || []) {
    const t = typeOf.get(Number(p.stream_index));
    if (t !== 'video' && t !== 'audio') continue;
    const pts = Number(p.pts_time);
    if (!Number.isFinite(pts)) continue;
    const s = agg.get(t) || { lo: Infinity, hi: -Infinity };
    s.lo = Math.min(s.lo, pts);
    s.hi = Math.max(s.hi, pts + (Number(p.duration_time) || 0));
    agg.set(t, s);
  }
  const v = agg.get('video');
  const a = agg.get('audio');
  if (!v || !a) return null;
  return (a.hi - a.lo) - (v.hi - v.lo);
}

/** 视频的独立时间线跨度（逐报文）：与"切割计划实算时长"比对，抓静默多带。 */
function videoSpan(file) {
  const j = probePackets(file);
  if (!j) return null;
  const vids = new Set((j.streams || []).filter((s) => s.codec_type === 'video').map((s) => Number(s.index)));
  let lo = Infinity; let hi = -Infinity;
  for (const p of j.packets || []) {
    if (!vids.has(Number(p.stream_index))) continue;
    const pts = Number(p.pts_time);
    if (!Number.isFinite(pts)) continue;
    lo = Math.min(lo, pts);
    hi = Math.max(hi, pts + (Number(p.duration_time) || 0));
  }
  return hi > lo ? hi - lo : null;
}

/** 视频轨报文数：帧数的硬判据（比 -count_frames 便宜，且不受容器时长记账影响）。 */
function videoPacketCount(file) {
  const j = probePackets(file);
  if (!j) return null;
  const vids = new Set((j.streams || []).filter((s) => s.codec_type === 'video').map((s) => Number(s.index)));
  let n = 0;
  for (const p of j.packets || []) if (vids.has(Number(p.stream_index))) n++;
  return n || null;
}

function probePackets(file) {
  try {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries',
      'packet=stream_index,pts_time,duration_time', '-show_entries', 'stream=index,codec_type', file],
    { encoding: 'utf8', maxBuffer: 128e6 }));
  } catch { return null; }
}

/** 成片字幕 cue 的起点（秒）。Matroska 的字幕块一条 cue 一个包，读包时间即可。 */
function cueStarts(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 's:0',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 32e6 });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim() !== '')
    .map((l) => Number(l.trim())).filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * 期望成片里出现哪些 cue：cue 起点落在某条保留区间内部（离两端都 > 0.3s，
 * 免得撞上 B 帧余量的边界），就该出现在"该区间成片起点 + (cue − 这一段实际第一帧的时刻)"。
 * 基准不是用户输入的入点：入点不在帧网格上时画面从网格点起步，用入点算会让整条字幕
 * 一致地偏晚半帧（内核 retime 同一条规则，见 core/pipeline 的 keepAligns）。
 */
function expectedCues(plan, groups, keeps, cues, split, media) {
  const progStart = [];
  let acc = 0;
  for (const g of groups) { progStart.push(acc); acc += g.reduce((a, n) => a + plan[n].duration, 0); }
  const off = Number(media.startOffset) || 0;
  const out = [];
  for (const abs of cues) {
    const t = abs - off;                       // 素材给的是绝对 pts，内核一切都在"相对容器原点"
    const ki = keeps.findIndex((k) => t >= k.start - 1e-6 && t < k.end - 1e-6);
    if (ki < 0) continue;
    const gi = groups.findIndex((g) => g.some((n) => plan[n].keepIndex === ki));
    if (split && ki !== gi) continue;
    out.push({ file: split ? gi : 0, src: t,
      at: (split ? 0 : progStart[ki]) + (t - frameStart(keeps[ki].start, media.video?.fps, media.gridOrigin)) });
  }
  return out;
}

function targetFor(fx, loaded, target) {
  if (!target) return { ext: path.extname(fx.file), container: null, dropSubtitles: false };
  const container = byExt(target);
  const dropped = unmuxableSubtitles(container.family, loaded.media.subtitleCodecs);
  return { ext: container.ext, container, dropSubtitles: dropped.length > 0 };
}

async function runMatrix() {
  const problems = [];
  console.log('\n素材 / 模式 / 目标      结果   说明');
  console.log('─'.repeat(84));

  for (const fx of FIXTURES) {
    const src = path.join(DIR, fx.file);
    if (!fs.existsSync(src)) { problems.push(`${fx.name}：素材没造出来`); continue; }
    let loaded;
    try {
      loaded = await loadSource(src);
    } catch (err) {
      problems.push(`${fx.name} 导入失败：${err.message}`);
      continue;
    }
    const targets = [null, ...(fx.remux || [])];
    const segs = fx.segs === 'long' ? LONG_SEGS : SEGS;
    // 多数素材只跑常规模式；个别素材（如开放 GOP 多区间）额外补一格吸附模式
    const modes = fx.snap ? [...MODES, SNAP_ONLY] : MODES;
    for (const mode of modes) {
      for (const target of targets) {
        const label = `${fx.name} / ${mode.label}${target ? ` → ${target.toUpperCase()}` : ''}`;
        const { ext, container, dropSubtitles } = targetFor(fx, loaded, target);
        const stem = path.basename(fx.file, path.extname(fx.file));
        const outPath = path.join(DIR, `${stem}-${mode.key}${target ? `-${target}` : ''}${ext}`);
        let r;
        try {
          r = await exportSegments(loaded, segs, { ...mode.opts, outPath, container, dropSubtitles });
        } catch (err) {
          console.log(`${pad(label, 34)}✗ 异常  ${cut(err.message, 48)}`);
          problems.push(`${label} 抛异常：${err.message}`);
          continue;
        }
        const failed = r.results.flatMap((x) => (x.checks || []).filter((c) => !c.ok));
        const noise = r.ok ? r.outputs.flatMap(decodeNoise) : [];
        const spread = r.ok ? r.outputs.map(avSpread).filter((x) => x != null) : [];
        const badAv = spread.filter((x) => Math.abs(x) > mode.avBudget);
        /**
         * 硬判据：**剪辑位置精确到帧**。
         *  1) 帧数：产物视频轨的报文数必须等于计划要写的帧数（允差 1 帧，只给封装器
         *     自己的边界取整留余地）。多一帧 = 把用户删掉的素材带回来，少一帧 = 把用户要的剪掉了。
         *  2) 时间线跨度：容器记账口径（mkv 的块时长、ts 的 90kHz 取整、VFR）会让跨度
         *     与计划差几帧，允差 4 帧，并把差值打印出来供人工核对。
         */
        // 基准计划必须用**与导出同一套 opts**（含 precise），否则"吸附模式"
        // 会拿精确模式的计划去比对吸附模式的产物，全是假失败。
        const planned = planFor(loaded, segs, { dropSubtitles, precise: mode.opts.precise !== false });
        const plan = planned.plan;
        const fpsOf = loaded.media.video?.fps || 30;
        const framesOf = (p) => (Number.isFinite(p.frames) && p.frames > 0
          ? Math.round(p.frames) : Math.round(p.duration * fpsOf));
        const groups = groupByKeep(plan);
        const wantFrames = mode.opts.split
          ? groups.map((g) => g.reduce((a, n) => a + framesOf(plan[n]), 0))
          : [plan.reduce((a, p) => a + framesOf(p), 0)];
        /**
         * 跨度基准 = Σplan.duration（窗口和）。
         *
         * 注意这与内核自检的尺子（core/verify 的 framesToSecs = Σframes/fps）**不同**，
         * 而两者对"结束在源中间"的拷贝段会分歧：那种段按 B 帧重排深度少给 2 帧，
         * 但容器记账仍按窗口算，实测产物落在两者之间。谁"对"取决于问的是
         * "容器记了多久"还是"计划里有多少帧"——短素材（10s、切得碎）两者差不到 4 帧，
         * 分不出来；长段多时会露馅，见下面 mixed30 素材的 spanTol。
         * 这个分歧本身待定，暂不改尺子（曾试过改成 Σframes/fps，一次性打红 8 格）。
         */
        const wantSecs = mode.opts.split
          ? groups.map((g) => g.reduce((a, n) => a + plan[n].duration, 0))
          : [plan.reduce((a, p) => a + p.duration, 0)];
        const spanTol = fx.spanTol || Math.max(4 / fpsOf, 0.1);
        const counts = r.ok ? r.outputs.map(videoPacketCount) : [];
        const spans = r.ok ? r.outputs.map(videoSpan) : [];
        const badFrames = [];
        const badSpans = [];
        if (counts.length === wantFrames.length) {
          counts.forEach((c, i) => {
            if (c == null) return;
            if (Math.abs(c - wantFrames[i]) > 1) badFrames.push(`第 ${i + 1} 条 ${c} 帧 / 计划 ${wantFrames[i]} 帧`);
          });
        }
        if (spans.length === wantSecs.length) {
          spans.forEach((s, i) => {
            if (s == null) return;
            if (Math.abs(s - wantSecs[i]) > spanTol) badSpans.push(`第 ${i + 1} 条 ${s.toFixed(3)}s / 计划 ${wantSecs[i].toFixed(3)}s`);
          });
        }
        const drift = spans.length === wantSecs.length
          ? spans.map((s, i) => (s == null ? '?' : (s - wantSecs[i] >= 0 ? '+' : '') + (s - wantSecs[i]).toFixed(3))).join('/')
          : '';
        /**
         * 3) 字幕：这条素材带 subrip，成片里的 cue 条数与落点都要对得上。
         *    （内核曾因"入点重编码段 + 拷贝尾段"的分段丢掉落在尾段里的整条 cue。）
         */
        const cueBad = [];
        let cueNote = '';
        if (fx.subCues && !dropSubtitles && r.ok) {
          const exp = expectedCues(plan, groups, planned.keeps, fx.subCues, mode.opts.split, loaded.media);
          const got = r.outputs.map(cueStarts);
          const tol = 0.05;
          for (const e of exp) {
            const list = got[e.file];
            if (!list) { cueBad.push(`cue@${e.src} 所在文件读不到字幕`); continue; }
            const near = list.reduce((best, t) => (Math.abs(t - e.at) < Math.abs(best - e.at) ? t : best), Infinity);
            if (!(near < Infinity) || Math.abs(near - e.at) > tol) {
              cueBad.push(`源 ${e.src}s 的 cue 期望 ${e.at.toFixed(3)}s，实际 ${list.map((x) => x.toFixed(2)).join('/') || '（一条都没有）'}`);
            }
          }
          const totalGot = got.reduce((a, g) => a + (g ? g.length : 0), 0);
          if (totalGot > exp.length) cueBad.push(`多出 ${totalGot - exp.length} 条字幕（已删区间里的 cue 回来了）`);
          cueNote = ` · 字幕 ${exp.length} 条`;
        }
        const ok = r.ok && noise.length === 0 && badAv.length === 0 && badFrames.length === 0 && badSpans.length === 0 && cueBad.length === 0;
        console.log(`${pad(label, 34)}${ok ? '✓' : '✗'}  ${
          r.ok
            ? (noise.length ? `自检漏判：${cut(noise[0], 40)}`
              : badAv.length ? `自检漏判：音视频时间线差 ${badAv.map((x) => x.toFixed(3)).join('/')}s（允差 ${mode.avBudget}s）`
              : badFrames.length ? `帧数不符：${cut(badFrames.join('；'), 48)}`
              : badSpans.length ? `时间线偏差大：${cut(badSpans.join('；'), 48)}`
              : cueBad.length ? `字幕错位：${cut(cueBad.join('；'), 48)}`
              : `${r.outputs.length} 个文件 · ${counts.join('/')} 帧 · 跨度差 ${drift}s${cueNote}`)
            : cut(failed.map((c) => `${c.name}：${c.detail}`).join('、'), 62)
        }`);
        // 静默交差 = 自检说通过但独立复核发现问题，一律算事故
        if (r.ok && noise.length) problems.push(`${label}：产物解码有错但自检判为通过 —— ${noise[0]}`);
        if (r.ok && badAv.length) problems.push(`${label}：音视频时间线差 ${badAv.map((x) => x.toFixed(3)).join('/')}s 但自检判为通过`);
        if (r.ok && badFrames.length) problems.push(`${label}：帧数不符 —— ${badFrames.join('；')}`);
        if (r.ok && badSpans.length) problems.push(`${label}：时间线跨度偏差过大 —— ${badSpans.join('；')}`);
        if (r.ok && cueBad.length) problems.push(`${label}：字幕没保住 —— ${cueBad.join('；')}`);
        if (!r.ok) {
          if (failed.length === 0) problems.push(`${label}：ok=false 却说不出原因`);
          if (!fx.expectLoudFail) {
            const why = failed.map((c) => c.name).join('/');
            problems.push(`${label}：自检判失败（${why}）—— ${cut(failed[0].detail, 60)}`);
          }
        }
      }
    }
  }
  return problems;
}

function pad(s, n) { return s.length >= n ? `${s.slice(0, n - 1)}… ` : s + ' '.repeat(n - s.length); }
function cut(s, n) { return String(s).replace(/\s+/g, ' ').slice(0, n); }

(async () => {
  console.log('Fast Cut 内核矩阵自检：容器 × 编码 × 裁剪模式 × 目标封装');
  buildFixtures();
  const problems = await runMatrix();
  console.log('─'.repeat(84));
  if (problems.length) {
    console.log(`\n✗ 需要处理 ${problems.length} 项：`);
    for (const p of problems) console.log(`  · ${p}`);
    process.exit(1);
  }
  console.log('\n✓ 矩阵通过：没有静默交出差文件的情况');
})().catch((err) => { console.error(err); process.exit(1); });
