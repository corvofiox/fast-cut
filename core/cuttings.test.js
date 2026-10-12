'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildPlan, frameStart } = require('./cuttings');

// 剪辑位置是硬性要求（v0.1 起，见 docs/02 技术方案 §3）：
//  - 入点**绝不**吸附关键帧；不在关键帧上就重编码入点那一小段，其余仍流拷贝
//  - 出点按整帧取长，且最后一帧必须严格早于用户出点
//  - 换编码时整条区间只允许一种编码，绝不与流拷贝段混拼
const KEYFRAMES = [0, 2, 4, 6, 8, 10];
const OPTS = { keyframes: KEYFRAMES, duration: 10 };
const OPTS_30 = { ...OPTS, fps: 30 };

/** 浮点安全的 [kind, start, duration] 断言。 */
function assertPlan(plan, expected) {
  assert.strictEqual(plan.length, expected.length, `计划段数 ${plan.length} != ${expected.length}：`
    + JSON.stringify(plan.map((p) => [p.kind, p.start, p.duration])));
  plan.forEach((p, i) => {
    assert.strictEqual(p.kind, expected[i][0], `第 ${i} 段 kind`);
    assert.ok(Math.abs(p.start - expected[i][1]) < 1e-6, `第 ${i} 段起点 ${p.start} != ${expected[i][1]}`);
    assert.ok(Math.abs(p.duration - expected[i][2]) < 1e-6, `第 ${i} 段时长 ${p.duration} != ${expected[i][2]}`);
  });
}

test('入点不在关键帧上：切成 重编码入点段 + 流拷贝其余，入点一秒都不动', () => {
  const { plan, warnings } = buildPlan([{ start: 3.4, end: 5.2 }], OPTS);
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 1.2]]);
  assert.strictEqual(plan[0].role, 'head');
  assert.strictEqual(plan[1].role, 'tail');
  assert.ok(!warnings.some((w) => /前移|吸附|回溯/.test(w)), `不该再出现吸附类警告：${warnings.join('、')}`);
});

test('入点正好落在关键帧上：整段流拷贝，一秒都不多编', () => {
  const { plan } = buildPlan([{ start: 4, end: 6 }], OPTS);
  assertPlan(plan, [['copy', 4, 2]]);
  assert.match(plan[0].note, /整段流拷贝/);
});

test('多条保留区间各自成计划', () => {
  const { plan } = buildPlan([
    { start: 0.5, end: 1.5 },   // 后面没有可接续的关键帧（2 已超出出点）→ 整段重编码
    { start: 5, end: 9 },       // 5 不是关键帧 → 入点重编码 + 6 起拷贝
  ], OPTS);
  assertPlan(plan, [['reencode', 0.5, 1], ['reencode', 5, 1], ['copy', 6, 3]]);
  assert.deepStrictEqual(plan.map((p) => p.keepIndex), [0, 1, 1], '每条区间的分段都要标记归属，"每段一个文件"按它分组');
});

test('出点超出源尾时裁剪到源时长，且不回溯关键帧', () => {
  // 9 不是关键帧，能接续的关键帧正好是源尾 10 → 拷贝段无意义，整段重编码
  const { plan } = buildPlan([{ start: 9, end: 20 }], OPTS);
  assertPlan(plan, [['reencode', 9, 1]]);
});

test('入点早于第一个关键帧：重编码到那个关键帧，绝不从 0 开始', () => {
  const { plan, warnings } = buildPlan([{ start: 0.5, end: 2.6 }], {
    keyframes: [1, 3, 5], duration: 10, fps: 30,
  });
  assertPlan(plan, [['reencode', 0.5, span30(0.5, 1)], ['copy', 1, span30(1, 2.6)]]);
  assert.ok(!warnings.some((w) => /从 0 开始/.test(w)), warnings.join('、'));
});

function span30(from, to) {
  const idx = (t) => Math.ceil(t * 30 - 1e-9);
  return (idx(to) - idx(from)) / 30;
}

test('空区间被忽略并警告', () => {
  const { plan, warnings } = buildPlan([{ start: 2, end: 2 }], OPTS);
  assert.strictEqual(plan.length, 0);
  assert.strictEqual(warnings.length, 1);
});

test('关键帧比剪辑粒度粗时也绝不把已删的间隙吞回来', () => {
  // 整片只有一个关键帧：以前入点回溯会跨过上一条区间的出点，三段被 dedupePlan 并成
  // "从 0 拷到片尾"一整段——删了等于没删，而自检按"源长 5%"允差照样判通过
  // （实测 98 分钟 .mkv 就翻在这条）。现在只能整段重编码。
  const { plan } = buildPlan(
    [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8, end: 9.5 }],
    { keyframes: [0], fps: 30, duration: 10 },
  );
  assert.deepStrictEqual(plan.map((p) => p.kind), ['reencode', 'reencode', 'reencode']);
  assert.deepStrictEqual(plan.map((p) => p.start), [0.5, 4.1, 8], '入点必须就是用户选的那一秒');
  assert.ok(!plan.some((p) => p.start < 0.5), '不允许出现回溯到关键帧的段');
});

test('入点不在关键帧上时，重编码段至少两帧：往后多取一个关键帧也不切窄段', () => {
  // 关键帧 2.0 距入点 1.97 只有 1 帧，按旧办法会切出 1 帧的窄段（实测音频包配不上，
  // concat 偏移炸掉）。现在跳过它、用下一个关键帧 4.0，代价是多编 2 秒而不是切坏文件。
  const { plan } = buildPlan([{ start: 1.97, end: 8 }], { keyframes: [0, 2, 4, 6, 8], fps: 30, duration: 10 });
  assert.strictEqual(plan[0].kind, 'reencode');
  assert.strictEqual(plan[0].start, 1.97);
  assert.strictEqual(plan[1].kind, 'copy');
  assert.strictEqual(plan[1].start, 4, '拷贝段必须从"离入点至少两帧"的那个关键帧起');
  assert.ok(Math.abs(plan[0].duration - 60 / 30) < 1e-9,
    `入点段要编满 1.97→4.0 之间的 60 帧，实际 ${plan[0].duration}s`);
  assert.ok(plan[0].start + plan[0].duration - 1 / 30 < plan[1].start, '入点段末帧必须早于关键帧');
});

test('源编码没有同编码重编码器时整段重编码，绝不与流拷贝段混拼', () => {
  // 实测 mpeg2video 源用"重编码接缝 + 拷贝其余"混拼，5.9s 选区拼出 35.8s、
  // avg_frame_rate 60/1 的怪文件；换编码时只能整条区间一种编码
  const { plan, warnings } = buildPlan([{ start: 3.4, end: 7 }], { ...OPTS, sameCodec: false });
  assertPlan(plan, [['reencode', 3.4, 3.6]]);
  assert.strictEqual(plan[0].codecChange, true);
  assert.ok(!plan.some((p) => p.kind === 'copy'));
  assert.ok(warnings.some((w) => /编码会与源不同/.test(w)), warnings.join('、'));
});

test('没有关键帧索引时整段重编码并警告，而不是从 0 拷贝', () => {
  const { plan, warnings } = buildPlan([{ start: 3.4, end: 7 }], { keyframes: [], duration: 10 });
  assertPlan(plan, [['reencode', 3.4, 3.6]]);
  assert.ok(warnings.some((w) => /没有关键帧索引/.test(w)), warnings.join('、'));
});

test('相邻区间首尾严格相接：不重复导出，也不留空洞', () => {
  const { plan } = buildPlan([
    { start: 3.4, end: 4.4 },
    { start: 4.4, end: 5.4 },
  ], OPTS);
  // 3.4~4 重编码，4~4.4 拷贝，4.4~5.4 整段重编码（5.4 之前没有可接续的关键帧）
  assertPlan(plan, [['reencode', 3.4, 0.6], ['copy', 4, 0.4], ['reencode', 4.4, 1]]);
  for (let i = 1; i < plan.length; i++) {
    const prevEnd = plan[i - 1].start + plan[i - 1].duration;
    assert.ok(Math.abs(prevEnd - plan[i].start) < 1e-6, `第 ${i} 段与前段不连续：${prevEnd} vs ${plan[i].start}`);
  }
});

test('重叠区间：拷贝段的起点钉在关键帧上，dedupe 只截前一段', () => {
  // 用户拖动改过顺序时保留区间可以任意重叠（normalizeSegments 被绕开）。
  // 旧 dedupePlan 会把后一段的起点推到前段末尾——那一秒不是关键帧，ffmpeg 流拷贝
  // 直接跳到下一个关键帧，中间整段 GOP 全空而总时长被 -t 补回来，自检看不出来。
  const { plan } = buildPlan([
    { start: 3.4, end: 3.9 },   // 落在一个 GOP 内 → 整段重编码
    { start: 3.5, end: 6 },     // 3.5 不是关键帧 → 重编码到 4，再从 4 拷贝
  ], { ...OPTS, ordered: true });
  const copy = plan.filter((p) => p.kind === 'copy');
  assert.ok(copy.length >= 1, JSON.stringify(plan.map((p) => [p.kind, p.start])));
  assert.deepStrictEqual(copy.map((p) => p.start), [4], '拷贝段起点必须还是关键帧 4');
});

test('帧取整：段时长必须是整帧时刻，避免 concat 时 PTS 落半格', () => {
  const { plan } = buildPlan([{ start: 3.4, end: 7 }], OPTS_30);
  for (const p of plan) {
    const frames = Math.round(p.duration * 30);
    assert.ok(Math.abs(p.duration - frames / 30) < 1e-9,
      `段时长 ${p.duration}s 不是 30fps 的整帧时刻（最接近 ${frames} 帧）`);
  }
});

test('出点：最后一帧严格早于用户出点，一秒已删的素材都不许多带', () => {
  // 4 是关键帧 → 整段拷贝；5.21 落在第 157 帧之前，所以最多导到第 156 帧（5.2s）
  const { plan } = buildPlan([{ start: 4, end: 5.21 }], OPTS_30);
  const last = plan[0].start + plan[0].duration - 1 / 30;
  assert.ok(last < 5.21, `末帧 ${last}s 越过了用户出点 5.21s`);
  assert.ok(Math.abs(plan[0].duration - 37 / 30) < 1e-9, `应为 37 帧，实际 ${plan[0].duration}`);
});

test('入点：重编码段末帧严格早于接续的关键帧，接缝不会把同一帧导出两遍', () => {
  // 入点 1.9 与关键帧 2.0 之间只有 3 帧；若把时长四舍五入到 0.1s=3 帧没问题，
  // 但换成 3.4→4.0 这种 18 帧以外的场合就可能越过。逐条核对末帧时刻。
  const cases = [[1.9, 2.0], [3.4, 4.0], [0.5, 2.0], [7.33, 8.0]];
  for (const [start] of cases) {
    const { plan } = buildPlan([{ start, end: 9.5 }], { keyframes: [0, 2, 4, 6, 8], fps: 30, duration: 10 });
    const head = plan.find((p) => p.kind === 'reencode');
    const tail = plan.find((p) => p.kind === 'copy');
    assert.ok(head && tail, `入点 ${start} 该切成两段：${JSON.stringify(plan.map((p) => [p.kind, p.start]))}`);
    const lastHead = head.start + head.duration - 1 / 30;
    assert.ok(lastHead < tail.start, `入点 ${start}：末帧 ${lastHead} 越过了拷贝段起点 ${tail.start}`);
    assert.ok(Math.abs(head.start + head.duration - tail.start) < 1 / 30 + 1e-6,
      `入点 ${start}：接缝留了空洞 ${tail.start - (head.start + head.duration)}s`);
  }
});

test('帧网格原点不在 0（实测 HEVC 首帧 pts=0.023）：按网格折算，接缝不互相蚕食', () => {
  const { plan } = buildPlan([{ start: 0.5, end: 2.3 }], {
    keyframes: [0.023, 2.023, 4.023, 6.023], fps: 30, duration: 10, gridOrigin: 0.023,
  });
  assert.strictEqual(plan[0].kind, 'reencode');
  assert.strictEqual(plan[0].duration, 1.5, `入点段应是整 45 帧，实际 ${plan[0].duration}`);
  assert.strictEqual(plan[1].start, 2.023);
  assert.ok(plan[0].start + plan[0].duration <= plan[1].start + 1e-6,
    '重编码段名义终点不得越过拷贝段起点，否则 dedupe 会把两段互相截短');
  assert.ok(Math.abs(plan.reduce((a, p) => a + p.duration, 0) - 1.8) < 1e-6,
    `计划总长要等于用户选区 1.8s：${plan.map((p) => p.duration)}`);
});

test('可变帧率源：整段重编码，不做按帧数的流拷贝', () => {
  const { plan, warnings } = buildPlan([{ start: 0.5, end: 2.3 }], {
    keyframes: KEYFRAMES, fps: 25.1, duration: 10, forceReencode: true,
  });
  assertPlan(plan, [['reencode', 0.5, spanAt(25.1, 0.5, 2.3)]]);
  assert.ok(warnings.some((w) => /可变帧率/.test(w)), warnings.join('、'));
});

function spanAt(fps, from, to) {
  const idx = (t) => Math.ceil(t * fps - 1e-9);
  return (idx(to) - idx(from)) / fps;
}

test('含双向预测（B 帧）的源：拷贝段按解码序留余量，时长仍按用户窗口占位', () => {
  // 出点用 -frames:v 数包，B 帧源会漏掉窗口尾几帧、又多带窗口外几帧。
  // 计划里 frames 减掉重排深度（绝不带已删的素材），duration 保持窗口长度（占位不变，
  // 总时长仍然精确等于用户选区）。
  const { plan, warnings } = buildPlan([{ start: 4, end: 9.5 }], {
    keyframes: KEYFRAMES, fps: 30, duration: 10, reorderDepth: 2,
  });
  assert.strictEqual(plan[0].kind, 'copy');
  assert.ok(Math.abs(plan[0].duration - 5.5) < 1e-6, `占位时长应为窗口 5.5s，实际 ${plan[0].duration}`);
  assert.strictEqual(plan[0].frames, Math.round(5.5 * 30) - 2);
  assert.strictEqual(plan[0].trimmed, 2);
  assert.ok(warnings.some((w) => /双向预测/.test(w)), warnings.join('、'));
});

test('接到源尾的区间不用留 B 帧余量（后面本来没有帧）', () => {
  const { plan } = buildPlan([{ start: 4, end: 10 }], {
    keyframes: KEYFRAMES, fps: 30, duration: 10, reorderDepth: 2,
  });
  assert.strictEqual(plan[0].frames, null);
  assert.strictEqual(plan[0].trimmed, 0);
});

test('区间短于 B 帧重排窗口时改整段重编码，不交出空拷贝段', () => {
  const { plan } = buildPlan([{ start: 4, end: 4.05 }], {
    keyframes: KEYFRAMES, fps: 30, duration: 10, reorderDepth: 2,
  });
  assert.strictEqual(plan[0].kind, 'reencode');
});

test('乱序：用户改过顺序时绝不合并相邻段（否则后一段会被前一段吞掉）', () => {
  // [5-10, 0-5] 顺序倒置且首尾相接；默认的 dedupePlan 会把它们并成一段，
  // 导出就少了一半内容，所以 ordered 必须绕开那套"时间递增"假设。
  const keeps = [{ start: 5, end: 10 }, { start: 0, end: 5 }];
  const merged = buildPlan(keeps, OPTS);
  const ordered = buildPlan(keeps, { ...OPTS, ordered: true });
  assert.ok(merged.plan.length < ordered.plan.length,
    `乱序不该被合并：merged ${merged.plan.length} 段 / ordered ${ordered.plan.length} 段`);
  assert.deepStrictEqual(ordered.plan.map((p) => [p.kind, p.start, p.duration]),
    [['reencode', 5, 1], ['copy', 6, 4], ['copy', 0, 5]], '顺序按用户排的，段内容各自精确');
});

// 帧网格原点：入点不在格子上时，画面从"不早于它的那一格"起步。字幕重计时拿这个时刻做基准，
// 否则每条 cue 都比口型一致地晚半帧（实测 30fps、origin 0.023 的 mkv 源差 0.023s）。
test('frameStart：入点向上落到帧网格，原点与无帧率两种情况都不越界', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(frameStart(0.5, 30, 0.023), 0.523), '0.5 → 第 15 帧 0.523');
  assert.ok(near(frameStart(4.1, 30, 0.023), 4.123), '4.1 → 4.123');
  assert.ok(near(frameStart(0.023, 30, 0.023), 0.023), '正好在格子上就不动');
  assert.ok(near(frameStart(0, 30, 0.023), 0.023), '早于首帧的入点落到首帧');
  assert.ok(near(frameStart(0.5, 30, 0), 0.5), '原点 0 时按整帧刻度对齐');
  assert.strictEqual(frameStart(1.234, null, 0.023), 1.234, '没有帧率就原样返回，不编造网格');
});
