'use strict';

/**
 * 「每段一个文件」的回归（2026-10-18，用户报的失效）：
 * 用户切了 13 段、勾上「每段一个文件」，产物却仍然只有一段完整视频。
 *
 * 根因两层，各自都能单独把分组吃光：
 *  1. `normalizeSegments` 把**首尾相接**的区间并成一条 —— 用户在播放头处连切几刀
 *     （还没删任何东西）时保留区间正是 [0,3] [3,6] [6,9]，一并就只剩一段。
 *  2. `dedupePlan` 按"时间上相邻"吸收同类型段，**不看 keepIndex** —— 即便规整阶段
 *     保住了两条区间，吸附模式把两段的拷贝段接在一起时又会被吸收成一段。
 *
 * 这个文件同时守住「多段合并导出」：分组（`group`）必须真的把几段拼进一个文件，
 * 而且不能反过来把没分组的段也并掉。
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildPlan } = require('./cuttings');
const { normalizeSegments } = require('./segments');

const KF = [0, 4, 8, 12];
const OPTS = { keyframes: KF, duration: 12, fps: 30 };

/** 每个输出分组各覆盖了多少秒（用来验证"合并"与"拆分"都没丢内容）。 */
function groupSecs(plan) {
  const map = new Map();
  for (const p of plan) {
    const k = p.outGroup != null ? p.outGroup : `k${p.keepIndex}`;
    map.set(k, (map.get(k) || 0) + p.duration);
  }
  return map;
}

test('规整：首尾相接的区间默认仍合并（拼接导出的老行为不变）', () => {
  const out = normalizeSegments([{ start: 0, end: 3 }, { start: 3, end: 6 }]);
  assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[0, 6]]);
});

test('规整：keepAdjacent 时相邻区间各自保留，「每段一个文件」才有分组', () => {
  const out = normalizeSegments([{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }],
    { keepAdjacent: true });
  assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[0, 3], [3, 6], [6, 9]]);
});

test('规整：keepAdjacent 下**真正重叠**的仍要合并（同一帧不许导出两遍）', () => {
  const out = normalizeSegments([{ start: 0, end: 5 }, { start: 3, end: 8 }], { keepAdjacent: true });
  assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[0, 8]]);
});

test('「每段一个文件」：splitOutput 时 dedupePlan 不跨输出分组合并', () => {
  // 两段都正好落在关键帧上、精确模式 → 各出一条纯拷贝段，时间上首尾相接。
  // 老 dedupe 会把它们吸收成一段 copy[0,8]（分组就只剩一组）。
  const keeps = [{ start: 0, end: 4 }, { start: 4, end: 8 }];
  const merged = buildPlan(keeps, { ...OPTS, precise: true });
  const split = buildPlan(keeps, { ...OPTS, precise: true, splitOutput: true });
  assert.strictEqual(merged.plan.length, 1,
    `不 split 时合并成一段是预期行为：${JSON.stringify(merged.plan.map((p) => [p.start, p.duration]))}`);
  assert.strictEqual(split.plan.length, 2,
    `split 时必须保留两段：${JSON.stringify(split.plan.map((p) => [p.start, p.duration]))}`);
  assert.strictEqual(new Set(split.plan.map((p) => p.outGroup)).size, 2,
    `split 时必须是两组：${JSON.stringify(split.plan.map((p) => p.outGroup))}`);
});

test('「每段一个文件」：相邻片段的内容一秒不少（吸附不许把起点钳到下一个关键帧）', () => {
  // 关键帧 [0,4,8] 上切 [0,3] [3,6]：两段的 lastKeyframeAtMost 都是 0。
  // 旧代码把第二段的吸附起点钳到 4 —— 用户要的 [3,4] 整段消失，
  // 而两段各自的时长/帧数自检都对，合起来少 1s 也查不出来。
  const keeps = [{ start: 0, end: 3 }, { start: 3, end: 6 }];
  const { plan } = buildPlan(keeps, { ...OPTS, precise: false, splitOutput: true });
  const covered = plan.reduce((a, p) => a + p.duration, 0);
  assert.ok(Math.abs(covered - 6) < 1e-6, `两段合计应覆盖 6s，实际 ${covered}：${JSON.stringify(plan.map((p) => [p.start, p.duration]))}`);
  for (const k of [0, 1]) {
    const segs = plan.filter((p) => p.keepIndex === k);
    const from = Math.min(...segs.map((p) => p.start));
    assert.ok(Math.abs(from - keeps[k].start) < 1e-6,
      `第 ${k} 段的源起点必须是用户选的 ${keeps[k].start}s，实际 ${from}s`);
  }
});

test('多段合并导出：同一个 group 的几段进同一个输出分组', () => {
  const keeps = [
    { start: 0, end: 2, group: 7 },
    { start: 3, end: 5, group: 7 },
    { start: 6, end: 8 },
  ];
  const { plan } = buildPlan(keeps, { ...OPTS, precise: true, splitOutput: true });
  const groups = new Set(plan.map((p) => p.outGroup));
  assert.strictEqual(groups.size, 2, `应出两个文件：${JSON.stringify([...groups])}`);
  const secs = groupSecs(plan);
  assert.ok(Math.abs((secs.get('g7') || 0) - 4) < 1e-6, `合并组应覆盖 0–2 与 3–5 共 4s：${JSON.stringify([...secs])}`);
  assert.ok(Math.abs((secs.get('k2') || 0) - 2) < 1e-6, `未分组的那段仍是 2s：${JSON.stringify([...secs])}`);
});

test('多段合并导出：没分组时一段一组（group 只影响分组，不影响切法）', () => {
  const keeps = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
  const { plan } = buildPlan(keeps, { ...OPTS, precise: true, splitOutput: true });
  const groups = new Set(plan.map((p) => p.outGroup));
  assert.strictEqual(groups.size, 3, JSON.stringify([...groups]));
  // 分组键是 `k<keepIndex>`：没分组时一条区间一个键
  assert.deepStrictEqual([...groups].sort(), ['k0', 'k1', 'k2']);
});

test('多段合并导出：合并组内部的相邻段仍被 dedupe 正常吸收（不多写中间段）', () => {
  // 同组内两段都落在关键帧上、精确模式 → 各一条纯拷贝段，时间上首尾相接，
  // dedupe 应把它们合成一段（这是优化，不是 bug：反正都要进同一个文件）。
  const keeps = [{ start: 0, end: 4, group: 1 }, { start: 4, end: 8, group: 1 }];
  const { plan } = buildPlan(keeps, { ...OPTS, precise: true, splitOutput: true });
  assert.strictEqual(plan.length, 1, `同组内应合成一段：${JSON.stringify(plan.map((p) => [p.start, p.duration]))}`);
  assert.strictEqual(plan[0].outGroup, 'g1');
  assert.ok(Math.abs(plan[0].duration - 8) < 1e-6, `合成后应覆盖 8s，实际 ${plan[0].duration}`);
});

test('规整：不同分组的区间永不合并（分组是用户意图，不许被规整抹掉）', () => {
  // 相邻的 [0,4]（组1）与 [4,8]（无组）：若并成 [0,8] 并只留前一段的 group，
  // 后一段就被静默拖进组1 —— 实测组1 把无关的段3 也吞了进去。
  const out = normalizeSegments([
    { start: 0, end: 4, group: 1 },
    { start: 4, end: 8 },
  ], { keepAdjacent: true });
  assert.deepStrictEqual(out.map((s) => [s.start, s.end, s.group == null ? null : s.group]),
    [[0, 4, 1], [4, 8, null]]);
  // 同组的相邻区间仍可合并（它们本来就要进同一个文件）
  const same = normalizeSegments([
    { start: 0, end: 4, group: 1 },
    { start: 4, end: 8, group: 1 },
  ], { keepAdjacent: true });
  assert.deepStrictEqual(same.map((s) => [s.start, s.end]), [[0, 8]]);
});

test('分组合并后 outGroup 是字符串键，用户分组号不会与 keepIndex 撞号', () => {
  // group: 0 与 keepIndex: 0 数值相同，若用数字做键就会错误合并
  const keeps = [{ start: 0, end: 2 }, { start: 3, end: 5, group: 0 }];
  const { plan } = buildPlan(keeps, { ...OPTS, precise: true, splitOutput: true });
  const groups = new Set(plan.map((p) => p.outGroup));
  assert.strictEqual(groups.size, 2, JSON.stringify([...groups]));
  assert.deepStrictEqual([...groups].sort(), ['g0', 'k0']);
});
