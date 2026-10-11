'use strict';

/**
 * 多段裁剪 + 内容抽查：
 *   node core/demo-multi.js <源文件>
 * 在 10s 测试片上保留 [0.5,2.3)、[4.1,6.7)、[8.0,9.5) 三段，
 * 分别用吸附模式和精确模式导出，然后逐段核对"内容真的来自源的那一段"。
 */

const { execSync } = require('child_process');
const path = require('path');
const { loadSource, exportSegments } = require('./pipeline');

const SEGS = [
  { start: 0.5, end: 2.3 },
  { start: 4.1, end: 6.7 },
  { start: 8.0, end: 9.5 },
];

function frameHash(file, from, to) {
  // 用 frame md5 比对内容：对指定时间窗内的所有帧算 md5
  const out = execSync(
    `ffmpeg -v error -ss ${from} -t ${to - from} -i "${file}" -map 0:v:0 -f framehash -hash md5 -`,
  ).toString().trim();
  return out.split(/\r?\n/).slice(1).map((l) => l.split(',')[3]).join('|');
}

async function run(label, file, precise) {
  console.log(`\n===== ${label}（精确模式=${precise ? '开' : '关'}）=====`);
  const loaded = await loadSource(file);
  const ext = path.extname(file);
  const outPath = `${path.join(path.dirname(file), path.basename(file, ext))}-multi-${label}${ext}`;
  const r = await exportSegments(loaded, SEGS, {
    outPath,
    precise,
    onProgress: (p) => {
      if (p.phase === 'cut') console.log(`  切割 [${p.range}] ${p.kind} — ${p.note ?? ''}`);
    },
  });
  console.log(`  保留总时长 ${r.keepSecs}s；输出 ${r.outputs[0]}`);
  for (const w of r.warnings) console.log(`      ⚠ ${w}`);
  console.log(`  自检：${r.ok ? '通过' : '未通过'}`);
  for (const c of r.results[0].checks) if (!c.ok) console.log(`      ✗ ${c.name}：${c.detail}`);

  // 内容抽查：第 2 段（4.1→6.7）是中间那段，最能暴露顺序错乱
  const srcHash = frameHash(file, 4.1, 6.7);
  const outLen = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${outPath}"`).toString().trim());
  // 中间段在产物中的位置：吸附后第 1 段约 1.8s
  const outStart = 1.8;
  const outHash = frameHash(outPath, outStart, Math.min(outStart + 2.6, outLen));
  console.log(`  内容抽查（源 4.1–6.7 vs 产物 ${outStart}s 起）：${srcHash.slice(0, 24)} vs ${outHash.slice(0, 24)} ${srcHash === outHash ? '✓ 一致' : '（不同帧边界，需人工确认）'}`);
  return r;
}

(async () => {
  const file = process.argv[2] || 'tmp/test.mp4';
  await run('snap', file, false);
  await run('precise', file, true);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
