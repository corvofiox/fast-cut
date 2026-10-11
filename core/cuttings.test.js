'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildPlan } = require('./cuttings');

// 关键帧语义（已实测，见 docs/02 技术方案 §3）：
//  - 入点会吸附到 ≤ start 的关键帧（可能多带内容）
//  - 出点不需要吸附，-t 精确到时；流拷贝会多带约一帧，时长可精确控制
const KEYFRAMES = [0, 2, 4, 6, 8, 10];
const OPTS = { keyframes: KEYFRAMES, precise: false, duration: 10 };
const OPTS_PRECISE = { ...OPTS, precise: true };
const OPTS_PRECISE_30 = { ...OPTS_PRECISE, fps: 30 };

/** 浮点安全的 [start, duration] 断言。 */
function assertPlan(plan, expected) {
  assert.strictEqual(plan.length, expected.length);
  plan.forEach((p, i) => {
    assert.strictEqual(p.kind, expected[i][0]);
    assert.ok(Math.abs(p.start - expected[i][1]) < 1e-6, `第 ${i} 段起点 ${p.start} != ${expected[i][1]}`);
    assert.ok(Math.abs(p.duration - expected[i][2]) < 1e-6, `第 ${i} 段时长 ${p.duration} != ${expected[i][2]}`);
  });
}

test('吸附模式：入点前移到关键帧，出点用时长精确控制', () => {
  const { plan } = buildPlan([{ start: 3.4, end: 5.2 }], OPTS);
  assert.strictEqual(plan.length, 1);
  assertPlan(plan, [['copy', 2, 3.2]]); // 5.2 - 2.0
  assert.match(plan[0].note, /前移至关键帧 2\.000s（多 1\.400s 内容）/);
});

test('吸附模式：入点正好在关键帧上时提示无偏差', () => {
  const { plan } = buildPlan([{ start: 4, end: 6 }], OPTS);
  assert.strictEqual(plan[0].kind, 'copy');
  assert.strictEqual(plan[0].note, '入点正好落在关键帧上');
  assertPlan(plan, [['copy', 4, 2]]);
});

test('吸附模式：多段生成多段切割计划', () => {
  const { plan } = buildPlan([
    { start: 0.5, end: 1.5 },
    { start: 5, end: 9 },
  ], OPTS);
  assertPlan(plan, [['copy', 0, 1.5], ['copy', 4, 5]]);
});

test('吸附模式：出点超出源尾时裁剪到源时长', () => {
  const { plan } = buildPlan([{ start: 9, end: 20 }], OPTS);
  assertPlan(plan, [['copy', 8, 2]]); // 10 - 8，不超出源
});

test('入点早于第一个关键帧时从 0 开始并警告', () => {
  // 关键帧从 1.0 起（源以 non-keyframe 开头）：入点 0.5 之前无关键帧
  const { plan, warnings } = buildPlan([{ start: 0.5, end: 2.6 }], {
    keyframes: [1, 3, 5], precise: false, duration: 10,
  });
  assert.ok(warnings.some((w) => /之前没有关键帧，已从 0 开始/.test(w)), JSON.stringify(warnings));
  assert.strictEqual(plan[0].note, '入点之前没有关键帧，从 0 开始');
  assertPlan(plan, [['copy', 0, 2.6]]);
});

test('对齐后为空的区间被忽略并警告', () => {
  const { plan, warnings } = buildPlan([{ start: 2, end: 2 }], OPTS);
  assert.strictEqual(plan.length, 0);
  assert.strictEqual(warnings.length, 1);
});

test('精确模式：入点不是关键帧时切成 重编码+拷贝 两段', () => {
  const { plan } = buildPlan([{ start: 3.4, end: 7 }], OPTS_PRECISE);
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 3]]); // 7 - 4
});

test('精确模式：入点就是关键帧时退化为纯拷贝', () => {
  const { plan } = buildPlan([{ start: 4, end: 7 }], OPTS_PRECISE);
  assertPlan(plan, [['copy', 4, 3]]);
});

test('精确模式：区间落在一个 GOP 内时整段重编码', () => {
  const { plan } = buildPlan([{ start: 3.4, end: 3.9 }], OPTS_PRECISE);
  assertPlan(plan, [['reencode', 3.4, 0.5]]);
  assert.match(plan[0].note, /整段有损重编码/);
});

test('精确模式：源编码换掉时整段重编码，绝不与流拷贝段混拼', () => {
  // 实测 mpeg2video 源用"重编码接缝 + 拷贝其余"混拼，5.9s 选区拼出 35.8s、
  // avg_frame_rate 60/1 的怪文件；换编码时只能整条区间一种编码
  const { plan } = buildPlan([{ start: 3.4, end: 7 }], { ...OPTS_PRECISE, sameCodec: false });
  assertPlan(plan, [['reencode', 3.4, 3.6]]);
  assert.match(plan[0].note, /不混拼/);
  assert.ok(!plan.some((p) => p.kind === 'copy'));
});

test('精确模式相邻区间被去重：不重复导出同一段', () => {
  const { plan } = buildPlan([
    { start: 3.4, end: 4.4 },
    { start: 4.4, end: 5.4 },
  ], OPTS_PRECISE);
  // 3.4~4 重编码，4~4.4 拷贝，4.4~5.4 整段重编码：三段首尾严格相接，无重复内容
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 0.4], ['reencode', 4.4, 1]]);
});

test('精确模式相邻且吸附后重叠的区间会被吸收，不重复导出', () => {
  const { plan } = buildPlan([
    { start: 3.4, end: 5.4 },
    { start: 4.4, end: 5.4 },
  ], OPTS_PRECISE);
  // 第二区间 4.4~5.4 的入点被吸附到 4，与已拷贝区间重叠 → 吸收为 4~5.4
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 1.4]]);
});

test('精确模式相邻区间首尾无空洞、无重叠', () => {
  const { plan } = buildPlan([
    { start: 3.4, end: 4.4 },
    { start: 4.4, end: 4.9 },
  ], OPTS_PRECISE);
  for (let i = 1; i < plan.length; i++) {
    const prevEnd = plan[i - 1].start + plan[i - 1].duration;
    assert.ok(Math.abs(prevEnd - plan[i].start) < 1e-6, `第 ${i} 段与前段不连续：${prevEnd} vs ${plan[i].start}`);
  }
  assert.ok(plan.every((p) => p.duration > 0));
});

test('精确模式相邻但分离的区间各自成段，不跨越空隙', () => {
  const { plan } = buildPlan([
    { start: 3.4, end: 4.4 },
    { start: 6.2, end: 7.5 },
  ], OPTS_PRECISE);
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 0.4], ['reencode', 6.2, 1.3]]);
});

test('精确模式：出点后到关键帧之间的内容会被丢弃并警告', () => {
  const { warnings } = buildPlan([{ start: 3.4, end: 5.5 }], OPTS_PRECISE);
  assert.ok(warnings.some((w) => /精确模式：出点 5\.500s 到下一个关键帧 6\.000s/.test(w)), JSON.stringify(warnings));
});

test('帧取整：段时长必须是整帧时刻，避免 concat 时 PTS 落半格', () => {
  // 3.4 → 4.0 是 0.6s @30fps = 18 帧，整帧
  const { plan } = buildPlan([{ start: 3.4, end: 7 }], OPTS_PRECISE_30);
  const frames = Math.round(plan[0].duration * 30);
  assert.ok(Math.abs(plan[0].duration - frames / 30) < 1e-9,
    `重编码段时长 ${plan[0].duration}s 不是 30fps 的整帧时刻（最接近 ${frames} 帧）`);
});

test('帧取整：0.6s @30fps 恰好是 18 帧，不应被改动', () => {
  const { plan } = buildPlan([{ start: 3.4, end: 7 }], OPTS_PRECISE_30);
  assert.ok(Math.abs(plan[0].duration - 0.6) < 1e-9, `预期 0.6s，实际 ${plan[0].duration}s`);
});

test('帧取整：非整帧时长被就近取整到整帧', () => {
  // 0.71s @30fps → 21.3 帧 → 取整为 21 帧 = 0.7s
  const { plan } = buildPlan([{ start: 2.3, end: 3.01 }], OPTS_PRECISE_30);
  const dur = plan[0].duration;
  assert.ok(Math.abs(dur - Math.round(dur * 30) / 30) < 1e-9, `${dur}s 不是整帧时刻`);
});

test('乱序：用户改过顺序时绝不合并相邻段（否则后一段会被前一段吞掉）', () => {
  // [5-10, 0-5] 顺序倒置且首尾相接；默认的 dedupePlan 会把它们并成一段，
  // 导出就少了一半内容，所以 ordered 必须绕开那套"时间递增"假设。
  const keeps = [{ start: 5, end: 10 }, { start: 0, end: 5 }];
  const merged = buildPlan(keeps, OPTS);
  const ordered = buildPlan(keeps, { ...OPTS, ordered: true });
  assert.strictEqual(merged.plan.length, 1, '默认路径按时间合并（输入已排好序时才是这个语义）');
  assert.strictEqual(ordered.plan.length, 2, `乱序应保留两段，实际 ${ordered.plan.length} 段`);
  assert.deepStrictEqual(ordered.plan.map((p) => [p.start, p.duration]), [[4, 6], [0, 5]],
    '两段都要按各自的关键帧入点导出，且顺序不变');
});
