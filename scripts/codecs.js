'use strict';

/**
 * 内核的"容器 × 编码 × 裁剪模式"矩阵自检（不依赖 Electron）：
 *   node scripts/codecs.js
 * 自己造素材 → 三种模式各导一遍 → 逐条核对自检结论是否可信。
 *
 * 判据不是"全部成功"，而是**不许静默交出差文件**：
 * 要么 ok=true，要么 ok=false 且能指出哪一项没过。做不到就退出码 1。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const { loadSource, exportSegments } = require('../core/pipeline');
const { decodeErrors } = require('../core/verify');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'tmp', 'codecs');
const SEGS = [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8.0, end: 9.5 }];

const FIXTURES = [
  { name: 'h264-mp4', file: 'h264.mp4', cmd: (f) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f] },
  { name: 'h264-mkv-多轨', file: 'h264.mkv', cmd: (f) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=10', '-i', path.join(ROOT, 'tmp', 'sub.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', f] },
  { name: 'hevc-mov', file: 'hevc.mov', cmd: (f) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f] },
  { name: 'vp9-webm', file: 'vp9.webm', cmd: (f) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-g', '60', '-c:a', 'libopus', '-shortest', f] },
  { name: 'av1-mkv', file: 'av1.mkv', cmd: (f) => ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-c:v', 'libaom-av1', '-crf', '50', '-b:v', '0', '-cpu-used', '8', '-g', '60', '-pix_fmt', 'yuv420p', f] },
];

const MODES = [
  { key: 'snap', label: '吸附·拼接', opts: {} },
  { key: 'split', label: '吸附·每段一文件', opts: { split: true } },
  { key: 'precise', label: '精确·拼接', opts: { precise: true } },
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
    if (fs.existsSync(target)) continue;
    process.stdout.write(`  造素材 ${fx.name}…`);
    const t0 = Date.now();
    sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...fx.cmd(target)]);
    console.log(` ${(Date.now() - t0) / 1000}s`);
  }
}

/** 独立于 verify.js 的第二双眼睛：自己再解一遍码，用同一套"什么算真错误"的判定。 */
function decodeNoise(file) {
  try {
    return decodeErrors(execSync(`ffmpeg -v error -xerror -i "${file}" -f null - 2>&1`, { encoding: 'utf8' }));
  } catch (e) {
    return [`退出码非 0：${decodeErrors(e.stderr || e.message)[0] || ''}`.trim()];
  }
}

async function runMatrix() {
  const problems = [];
  console.log('\n素材 / 模式            结果   说明');
  console.log('─'.repeat(78));

  for (const fx of FIXTURES) {
    const src = path.join(DIR, fx.file);
    let loaded;
    try {
      loaded = await loadSource(src);
    } catch (err) {
      problems.push(`${fx.name} 导入失败：${err.message}`);
      continue;
    }
    for (const mode of MODES) {
      const outPath = path.join(DIR, `${fx.file.replace(/\.[^.]+$/, '')}-${mode.key}${path.extname(src)}`);
      let r;
      try {
        r = await exportSegments(loaded, SEGS, { ...mode.opts, outPath });
      } catch (err) {
        console.log(`${pad(`${fx.name} / ${mode.label}`, 26)}✗ 异常  ${cut(err.message, 46)}`);
        problems.push(`${fx.name} / ${mode.label} 抛异常：${err.message}`);
        continue;
      }
      const failed = r.results.flatMap((x) => (x.checks || []).filter((c) => !c.ok));
      // 自检说通过 → 独立解码每个产物都必须干净；自检说失败 → 必须能指出原因
      const noise = r.ok ? r.outputs.flatMap(decodeNoise) : [];
      const ok = r.ok && noise.length === 0;
      console.log(`${pad(`${fx.name} / ${mode.label}`, 26)}${ok ? '✓' : '✗'}  ${
        r.ok ? (noise.length ? `自检漏判：${cut(noise[0], 34)}` : `${r.outputs.length} 个文件`) : cut(failed.map((c) => `${c.name}：${c.detail}`).join('、'), 60)
      }`);
      if (!r.ok && failed.length === 0) problems.push(`${fx.name} / ${mode.label}：ok=false 却说不出原因`);
      if (noise.length) problems.push(`${fx.name} / ${mode.label}：产物解码有错但自检判为通过 —— ${noise[0]}`);
    }
  }
  return problems;
}

function pad(s, n) { return s.length >= n ? `${s.slice(0, n - 1)}… ` : s + ' '.repeat(n - s.length); }
function cut(s, n) { return String(s).replace(/\s+/g, ' ').slice(0, n); }

(async () => {
  console.log('Fast Cut 内核矩阵自检：容器 × 编码 × 裁剪模式');
  buildFixtures();
  const problems = await runMatrix();
  console.log('─'.repeat(78));
  if (problems.length) {
    console.log(`\n✗ 需要处理 ${problems.length} 项：`);
    for (const p of problems) console.log(`  · ${p}`);
    process.exit(1);
  }
  console.log('\n✓ 矩阵通过：没有静默产出差文件的情况');
})().catch((err) => { console.error(err); process.exit(1); });
