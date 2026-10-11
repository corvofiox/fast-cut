'use strict';

/**
 * 多段裁剪 + 内容抽查：
 *   node core/demo-multi.js <源文件>
 * 在 10s 测试片上保留 [0.5,2.3)、[4.1,6.7)、[8.0,9.5) 三段，导出后逐段核对
 * "内容真的来自源的那一段"——入点不在关键帧上时会切成"重编码小段 + 拷贝段"两段，
 * 所以中间段在产物里的位置要从计划实算，不能写死。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { loadSource, exportSegments, planFor } = require('./pipeline');

const SEGS = [
  { start: 0.5, end: 2.3 },
  { start: 4.1, end: 6.7 },
  { start: 8.0, end: 9.5 },
];

function frameHash(file, from, to) {
  // 用 frame md5 比对内容：对指定时间窗内的所有帧算 md5（参数走 argv 数组，不拼 shell）
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', file,
    '-map', '0:v:0', '-f', 'framehash', '-hash', 'md5', '-',
  ]).toString();
  // framehash 先是 8 行 `#` 头，数据行形如
  //   0,          3,          3,        1,    86400, 9c9767a2d2...
  // 最后一列才是帧哈希；按逗号取第 6 列
  return out.split(/\r?\n/)
    .filter((l) => l && l[0] !== '#')
    .map((l) => l.split(',')[5])
    .join('|');
}

function probeDuration(file) {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).toString().trim());
}

(async () => {
  const file = process.argv[2] || 'tmp/test.mp4';
  const loaded = await loadSource(file);
  const ext = path.extname(file);
  const outPath = `${path.join(path.dirname(file), path.basename(file, ext))}-multi${ext}`;

  const { plan } = planFor(loaded, SEGS, {});
  console.log('切割计划：', plan.map((p) => `${p.kind}/${p.role}[${p.start.toFixed(3)}+${p.duration.toFixed(3)}]`).join(' '));

  const r = await exportSegments(loaded, SEGS, {
    outPath,
    onProgress: (p) => {
      if (p.phase === 'cut') console.log(`  切割 [${p.range}] ${p.kind} — ${p.note ?? ''}`);
    },
  });
  console.log(`  保留总时长 ${r.keepSecs}s；输出 ${r.outputs[0]}`);
  for (const w of r.warnings) console.log(`      ⚠ ${w}`);
  console.log(`  自检：${r.ok ? '通过' : '未通过'}`);
  for (const c of r.results[0].checks) if (!c.ok) console.log(`      ✗ ${c.name}：${c.detail}`);

  // 内容抽查：拿中间那条保留区间里**流拷贝**的那一段比——拷贝段的帧与源逐位相同，
  // 哈希必须一致；重编码的入点小段本来就该不一样，拿来比只会得到假警报。
  const idx = plan.findIndex((p) => p.keepIndex === 1 && p.kind === 'copy');
  if (idx < 0) {
    console.log('  内容抽查：中间段没有流拷贝段，跳过');
  } else {
    const progStart = plan.slice(0, idx).reduce((a, p) => a + p.duration, 0);
    const item = plan[idx];
    const secs = Math.min(0.5, item.duration);
    const srcHash = frameHash(file, item.start, item.start + secs);
    const outHash = frameHash(outPath, progStart, progStart + secs);
    const nSrc = srcHash.split('|').filter(Boolean).length;
    const nOut = outHash.split('|').filter(Boolean).length;
    console.log(`  内容抽查（源 ${item.start.toFixed(3)}s ↔ 产物 ${progStart.toFixed(3)}s，${secs}s）：`
      + `源 ${nSrc} 帧 / 产物 ${nOut} 帧 `
      + (nSrc > 0 && nSrc === nOut && srcHash === outHash
        ? '✓ 逐位一致'
        : `✗ 不一致（源 ${srcHash.slice(0, 24)} / 产物 ${outHash.slice(0, 24)}）`));
    const outLen = probeDuration(outPath);
    const planLen = plan.reduce((a, p) => a + p.duration, 0);
    console.log(`  长度核对：计划 ${planLen.toFixed(3)}s（用户选区 ${r.keepSecs}s）↔ 产物 ${outLen.toFixed(3)}s`);
    if (!(nSrc > 0 && nSrc === nOut && srcHash === outHash)) process.exit(1);
  }
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
