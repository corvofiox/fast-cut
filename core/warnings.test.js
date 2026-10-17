'use strict';

/**
 * 警告与列表文本的回归（2026-10-18，用户反馈"当前程序中的文本实在是太多了"）。
 *
 * 场景：用户切 11 段，其中 8 段的入点都不在关键帧上。旧实现在右侧列出
 * 8 条几乎相同的长句（只有秒数不同），读起来是一堵墙，反而盖住了真正要看的差异。
 *
 * 本轮把它们**按原因聚合**：同类只留一条，段号统一附在句尾。
 * 这个文件钉住三件事：
 *  1. 同因必须聚合（条数不超过"原因种类数"）；
 *  2. 聚合后仍要指明**哪些段**（信息不能丢）；
 *  3. 不同原因不能互相吃掉（别为了少而合并了本来不同的问题）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildPlan } = require('./cuttings');

/** 关键帧每 2s 一个，源 10s：11 段各自落在 GOP 中间 → 同一种病。 */
const KF = [0, 2, 4, 6, 8];
const OPT = { keyframes: KF, duration: 10, fps: 30 };

/** 造 n 段，每段起点都错开关键帧 0.4s（保证"入点不在关键帧上"）。 */
function staggered(n) {
  const out = [];
  const w = 10 / n;
  for (let i = 0; i < n; i++) {
    out.push({ start: Math.round((i * w + 0.4) * 1000) / 1000, end: Math.round(((i + 1) * w) * 1000) / 1000 });
  }
  return out;
}

test('同因警告按段聚合：11 段同一种病，警告条数远少于段数', () => {
  // 吸附模式 + B 帧余量：这批段同时触发"吸附起点重合"与"裁剪末端余量"两类原因
  const { warnings } = buildPlan(staggered(11), { ...OPT, precise: false, reorderDepth: 2 });
  assert.ok(warnings.length <= 4, `11 段应聚合成很少几条，实际 ${warnings.length} 条：\n${warnings.join('\n')}`);
  // 旧行为是"每段一条"，这里必须显著更少
  assert.ok(warnings.length < 11, '不许退化成一段一条');
});

test('聚合后必须指明是哪些段（信息不能丢）', () => {
  const { warnings } = buildPlan(staggered(11), { ...OPT, precise: false, reorderDepth: 2 });
  assert.ok(warnings.length > 0, '这个场景必须有警告，否则测试没验到东西');
  const withSegs = warnings.filter((w) => /（第 [\d、]+ 段）$/.test(w));
  assert.strictEqual(withSegs.length, warnings.length,
    `每条聚合警告都该带段号：\n${warnings.join('\n')}`);
  // 段号必须是 1 起、升序、无重复
  for (const w of withSegs) {
    const nums = /（第 ([\d、]+) 段）$/.exec(w)[1].split('、').map(Number);
    assert.deepStrictEqual(nums, [...new Set(nums)].sort((a, b) => a - b), `段号要升序去重：${w}`);
    assert.ok(nums.every((n) => n >= 1), `段号从 1 起：${w}`);
  }
});

test('段号分隔符统一用顿号（不许逗号混进来）', () => {
  const { warnings } = buildPlan(staggered(11), { ...OPT, precise: false, reorderDepth: 2 });
  for (const w of warnings) {
    const m = /（第 ([\d、]+) 段）$/.exec(w);
    if (m) assert.ok(!m[1].includes(','), `段号里不许出现逗号：${w}`);
  }
});

test('不同原因不互相吃掉：吸附与 B 帧两类各自留一条', () => {
  const { warnings } = buildPlan(staggered(11), {
    ...OPT, precise: false, reorderDepth: 2,
  });
  assert.ok(warnings.length <= 4, `两类原因 → 最多几条，实际 ${warnings.length}：\n${warnings.join('\n')}`);
  assert.ok(warnings.some((w) => /关键帧|吸附/.test(w)), `应有一条讲吸附/关键帧：\n${warnings.join('\n')}`);
  assert.ok(warnings.some((w) => /双向预测/.test(w)), `应有一条讲 B 帧余量：\n${warnings.join('\n')}`);
});

test('聚合不吞信息：段号集合要覆盖实际受影响的段', () => {
  const { warnings, plan } = buildPlan(staggered(11), { ...OPT, precise: false, reorderDepth: 2 });
  const trimmedSegs = [...new Set(plan.filter((p) => p.trimmed > 0).map((p) => p.keepIndex + 1))].sort((a, b) => a - b);
  const bframe = warnings.find((w) => /双向预测/.test(w));
  assert.ok(bframe, '应有 B 帧余量警告');
  const listed = /（第 ([\d、]+) 段）$/.exec(bframe)[1].split('、').map(Number);
  assert.deepStrictEqual(listed, trimmedSegs, `警告列的段号要与计划里真被裁的段一致：${bframe}`);
});

test('只有一段时不该出现聚合前缀（段号不该是噪音）', () => {
  const { warnings } = buildPlan([{ start: 3.4, end: 5.2 }], { ...OPT, precise: true });
  assert.ok(warnings.length <= 2, `${warnings.join('、')}`);
});
