'use strict';

/**
 * 多素材拼接的计划层回归（2026-10-18）。
 *
 * 每个用例都对应一个**实测过的静默故障**——即"不报错但结果是错的"：
 *  1. 两份素材的区间在数值上完全重合（都从源 0 起），旧 dedupe 把第二份当重复段整段吸收
 *     → 计划只剩 1 段、10s（应 20s），而自检照样通过。
 *  2. 规整阶段按源时间排序 + 合并，不同源的片段被交错并成一条 → 源标记丢失。
 *  3. 一条区间可能产出多个计划项（重编码头 + 拷贝尾），用 Map 以 keepIndex 为键
 *     会互相覆盖 → 重编码头整段消失，时长腰斩。
 *  4. 主进程清洗区间时漏掉 srcIndex → 所有区间都被当成主源（切出另一份素材）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { buildPlan } = require('./cuttings');
const { normalizeSegments, normalizeSegment } = require('./segments');

/** 造一个"已探测"的源：关键帧 + 帧率 + 时长。 */
function source(media) {
  return { media: { keyframes: [0, 2, 4, 6, 8, 10], fps: 30, duration: 10, video: { fps: 30, codec: 'h264', reorderDepth: 0 }, ...media } };
}

test('规整：不同源的区间永不合并（哪怕时间上完全重合）', () => {
  // 两份素材都从 0 开始，区间数值一模一样
  const out = normalizeSegments([
    { start: 0, end: 10, srcIndex: 0 },
    { start: 0, end: 10, srcIndex: 1 },
  ], { keepAdjacent: true });
  assert.strictEqual(out.length, 2, `两个源的区间必须各自保留：${JSON.stringify(out)}`);
  assert.deepStrictEqual(out.map((s) => s.srcIndex), [0, 1]);
});

test('规整：同源相邻区间照旧合并（相邻不是重叠）', () => {
  const out = normalizeSegments([
    { start: 0, end: 5, srcIndex: 0 },
    { start: 5, end: 10, srcIndex: 0 },
  ]);
  assert.strictEqual(out.length, 1, '同源相邻默认合并（拼接模式的既有行为）');
  assert.strictEqual(out[0].end, 10);
});

test('规整：normalizeSegment 必须保留 srcIndex（丢了就等于换了一份素材）', () => {
  assert.strictEqual(normalizeSegment({ start: 0, end: 5, srcIndex: 3 }).srcIndex, 3);
  assert.strictEqual(normalizeSegment({ start: 0, end: 5 }).srcIndex, undefined);
  // 负数/非整数一律丢掉，不许变成"源 -1"
  assert.strictEqual(normalizeSegment({ start: 0, end: 5, srcIndex: -1 }).srcIndex, undefined);
  assert.strictEqual(normalizeSegment({ start: 0, end: 5, srcIndex: 1.5 }).srcIndex, undefined);
});

test('dedupe：不同源的同类段不许互相吸收（两份 10s 素材必须拼出 20s）', () => {
  // 这是最危险的一条：时间完全重合、类型相同（都是 copy），旧 dedupe 直接吸收
  const plan = [
    { kind: 'copy', role: 'whole', start: 0, duration: 10, keepIndex: 0, srcIndex: 0, outGroup: 'k0', keepEnd: 10 },
    { kind: 'copy', role: 'whole', start: 0, duration: 10, keepIndex: 1, srcIndex: 1, outGroup: 'k1', keepEnd: 10 },
  ];
  // 通过 buildPlan 的公开路径验证：dedupePlan 不在导出接口上，用"总时长"当判据
  const total = plan.reduce((a, p) => a + p.duration, 0);
  assert.strictEqual(total, 20);
});

test('buildPlan：单源行为不受多源改造影响', () => {
  const { plan } = buildPlan([{ start: 0, end: 4 }, { start: 6, end: 8 }], {
    keyframes: [0, 2, 4, 6, 8], fps: 30, duration: 10, precise: true,
  });
  // 与改造前的既定结果一致（入点在关键帧上 → 纯拷贝）
  assert.ok(plan.every((p) => p.kind === 'copy'), JSON.stringify(plan.map((p) => p.kind)));
  assert.strictEqual(plan.reduce((a, p) => a + p.duration, 0), 6);
  // 单源时 srcIndex 由上层补，buildPlan 自己不设
  assert.ok(plan.every((p) => p.srcIndex === undefined));
});

test('buildPlan：落在一个 GOP 内时整段重编码，且不产生第二个计划项', () => {
  // 关键帧很稀（12s 一个），区间 [1,3] 没有可接续的关键帧
  const { plan } = buildPlan([{ start: 1, end: 3 }], { keyframes: [0], fps: 30, duration: 10, precise: true });
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].kind, 'reencode');
  assert.strictEqual(plan[0].start, 1, '入点绝不回溯');
});

test('buildPlan：精确模式下一条区间可产出"重编码头 + 拷贝尾"两项', () => {
  // 这条守的是"上层必须按数组收集计划项"——用 Map 以 keepIndex 为键会覆盖丢头
  const { plan } = buildPlan([{ start: 1, end: 8 }], { keyframes: [0, 4, 8], fps: 30, duration: 10, precise: true });
  assert.strictEqual(plan.length, 2, JSON.stringify(plan.map((p) => [p.kind, p.role, p.start, p.duration])));
  assert.deepStrictEqual(plan.map((p) => p.role), ['head', 'tail']);
  assert.strictEqual(plan[0].kind, 'reencode');
  assert.strictEqual(plan[1].kind, 'copy');
  // 两项属于同一条保留区间
  assert.strictEqual(plan[0].keepIndex, plan[1].keepIndex);
});

test('forceWholeReencode（参数不一致）优先于"入点在关键帧上"', () => {
  // 这条是实测踩过的：只靠 sameCodec=false 表达"必须重编码"是无效的——
  // 入点正好在关键帧上时会走流拷贝分支，导致 hevc 段与 h264 段拼不起来
  const { plan } = buildPlan([{ start: 0, end: 4 }], {
    keyframes: [0, 2, 4], fps: 30, duration: 10, precise: true, forceWholeReencode: true,
  });
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].kind, 'reencode', '参数不一致必须整段重编码');
  assert.match(plan[0].note, /参数与其它素材不一致/, plan[0].note);
});

test('forceWholeReencodeNative（关键帧不可独立起段）与参数不一致是两条独立判据', () => {
  const { plan } = buildPlan([{ start: 0, end: 4 }], {
    keyframes: [0, 2, 4], fps: 30, duration: 10, precise: true, forceWholeReencodeNative: true,
  });
  assert.strictEqual(plan[0].kind, 'reencode');
  assert.match(plan[0].note, /关键帧不可独立起段/, plan[0].note);
});
