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
const { decodeErrors } = require('../core/verify');
const { byExt, unmuxableSubtitles } = require('../core/containers');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tmp', 'codecs');
const SEGS = [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8.0, end: 9.5 }];

const V = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10'];
const A = (freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=10`];

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
    note: '字幕轨必须留在 MKV 段里 → 不能归一封装、也不能用 MP4 段，'
      + '时间戳只能按 make_zero 归零，每个接缝多约 1 帧（帧数仍要精确，跨度允差放宽到 0.2s）',
    spanTol: 0.2,
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
];

const MODES = [
  { key: 'exact', label: '精确·拼接', opts: {}, avBudget: 0.3 },
  { key: 'split', label: '精确·每段一文件', opts: { split: true }, avBudget: 0.3 },
];

function sh(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function buildFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'tmp', 'sub.srt'))) {
    fs.writeFileSync(path.join(ROOT, 'tmp', 'sub.srt'), '1\n00:00:00,500 --> 00:00:02,000\nhello\n', 'utf8');
  }
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
    for (const mode of MODES) {
      for (const target of targets) {
        const label = `${fx.name} / ${mode.label}${target ? ` → ${target.toUpperCase()}` : ''}`;
        const { ext, container, dropSubtitles } = targetFor(fx, loaded, target);
        const stem = path.basename(fx.file, path.extname(fx.file));
        const outPath = path.join(DIR, `${stem}-${mode.key}${target ? `-${target}` : ''}${ext}`);
        let r;
        try {
          r = await exportSegments(loaded, SEGS, { ...mode.opts, outPath, container, dropSubtitles });
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
        const plan = planFor(loaded, SEGS, {}).plan;
        const fpsOf = loaded.media.video?.fps || 30;
        const framesOf = (p) => (Number.isFinite(p.frames) && p.frames > 0
          ? Math.round(p.frames) : Math.round(p.duration * fpsOf));
        const groups = groupByKeep(plan);
        const wantFrames = mode.opts.split
          ? groups.map((g) => g.reduce((a, n) => a + framesOf(plan[n]), 0))
          : [plan.reduce((a, p) => a + framesOf(p), 0)];
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
        const ok = r.ok && noise.length === 0 && badAv.length === 0 && badFrames.length === 0 && badSpans.length === 0;
        console.log(`${pad(label, 34)}${ok ? '✓' : '✗'}  ${
          r.ok
            ? (noise.length ? `自检漏判：${cut(noise[0], 40)}`
              : badAv.length ? `自检漏判：音视频时间线差 ${badAv.map((x) => x.toFixed(3)).join('/')}s（允差 ${mode.avBudget}s）`
              : badFrames.length ? `帧数不符：${cut(badFrames.join('；'), 48)}`
              : badSpans.length ? `时间线偏差大：${cut(badSpans.join('；'), 48)}`
              : `${r.outputs.length} 个文件 · ${counts.join('/')} 帧 · 跨度差 ${drift}s`)
            : cut(failed.map((c) => `${c.name}：${c.detail}`).join('、'), 62)
        }`);
        // 静默交差 = 自检说通过但独立复核发现问题，一律算事故
        if (r.ok && noise.length) problems.push(`${label}：产物解码有错但自检判为通过 —— ${noise[0]}`);
        if (r.ok && badAv.length) problems.push(`${label}：音视频时间线差 ${badAv.map((x) => x.toFixed(3)).join('/')}s 但自检判为通过`);
        if (r.ok && badFrames.length) problems.push(`${label}：帧数不符 —— ${badFrames.join('；')}`);
        if (r.ok && badSpans.length) problems.push(`${label}：时间线跨度偏差过大 —— ${badSpans.join('；')}`);
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
