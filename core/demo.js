'use strict';

/**
 * 端到端演示 / 手测入口：
 *   node core/demo.js <源文件> <入点秒> <出点秒> [输出路径] [--precise]
 *
 * 跑通 导入 → 探流 → 吸附 → 切割 → 拼接 → 自检 全流程，并打印每一步的实际结果。
 */

const path = require('path');
const { loadSource, exportSegments } = require('./pipeline');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 3) {
    console.error('用法: node core/demo.js <源文件> <入点秒> <出点秒> [输出路径] [--precise]');
    process.exit(2);
  }
  const [srcFile, startRaw, endRaw, outArg, preciseFlag] = argv;
  const start = Number(startRaw);
  const end = Number(endRaw);
  const precise = preciseFlag === '--precise';
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    console.error('入点/出点必须是数字（秒）');
    process.exit(2);
  }
  const outPath = outArg || path.join(path.dirname(path.resolve(srcFile)), `fast-cut-demo.${path.extname(srcFile) || '.mp4'}`);

  const t0 = Date.now();
  console.log(`\n[1/4] 导入并探流：${srcFile}`);
  const loaded = await loadSource(srcFile);
  const m = loaded.media;
  console.log(`      容器=${m.format} 时长=${m.duration}s 视频=${m.video.codec}/${m.video.profile} ${m.video.width}x${m.video.height}@${m.video.fps} fps 音频轨=${m.audioTracks.length}`);
  console.log(`      关键帧 ${m.keyframes.length} 个，GOP≈${m.keyframes.length > 1 ? (m.keyframes[1] - m.keyframes[0]).toFixed(3) : '?'}s，码率=${Math.round(m.bitRate / 1000)} kbps`);
  console.log(`      耗时 ${Date.now() - t0}ms`);

  console.log(`\n[2/4] 生成切割计划：保留 ${start}s → ${end}s（精确模式=${precise ? '开' : '关'}）`);
  const t1 = Date.now();
  const result = await exportSegments(loaded, [{ start, end }], {
    outPath,
    precise,
    onProgress: (p) => {
      if (p.phase === 'cut') console.log(`      切割 [${p.range}] kind=${p.kind} ${p.note ?? ''}`);
      if (p.phase === 'cut-progress' && p.ratio >= 1) console.log(`      切割进度 ${(p.ratio * 100).toFixed(0)}%`);
      if (p.phase === 'verify') console.log('      自检中…');
    },
  });
  console.log(`      导出耗时 ${Date.now() - t1}ms（全程 ${Date.now() - t0}ms）`);
  console.log(`      保留总时长 ${result.keepSecs}s（用户所选 ${end - start}s）`);

  for (const w of result.warnings) console.log(`      ⚠ ${w}`);

  console.log(`\n[3/4] 输出：${result.outputs.join(', ')}`);

  console.log(`\n[4/4] 自检结果：${result.ok ? '通过' : '未通过'}`);
  for (const r of result.results) {
    for (const c of r.checks) console.log(`      ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
  }
  console.log('');
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  process.exit(1);
});
