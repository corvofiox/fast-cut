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
  assert.ok(warnings.some((w) => /没有可用关键帧/.test(w)), warnings.join('、'));
});

/**
 * 回归（2026-10-17 定案，四轮实验）：RASL 记账**整个删除**。
 *
 * 旧记账按「段内关键帧数 × (深度+1)」扣拷贝段帧数预期（配合 filter_units 全局剥除）。
 * 实测推翻其前提：段内中间关键帧的 RASL 是**真画面**（PTS 在窗内、参考帧在同段内），
 * 保留时它们本来就占窗口的显示帧数——包预算就是普通的 W − B帧深度，无需任何折让；
 * 段起点那簇 RASL 显示时刻在入点之前，由解封装/muxer/解码器三层天然去处消化，
 * 也不占产物帧数。旧记账是在白扣真内容（用户实测被白丢 287 帧）。
 * 详见 cuttings.buildPlan 里被删记账的注释与 docs/exploration-as-rasl-fix.md。
 */
test('拷贝段帧数只扣 B 帧防吞深度，不再按段内关键帧扣 RASL', () => {
  const media = { keyframes: [0, 4, 8], fps: 30, duration: 12, reorderDepth: 2 };
  // 拷到源尾 [4,12)：按 -t 收口（frames=null），不再有 RASL 记账分支
  const { plan: pEnd } = buildPlan([{ start: 4, end: 12 }], media);
  assert.strictEqual(pEnd[0].kind, 'copy');
  assert.strictEqual(pEnd[0].frames, null, '源尾段按 -t 收口');
  // 拷到源中间 [4,10)：只扣防吞深度 2，段内有没有关键帧都一样
  const { plan: pMid } = buildPlan([{ start: 4, end: 10 }], media);
  assert.strictEqual(pMid[0].frames, Math.round(6 * 30) - 2);
  const { plan: pNone } = buildPlan([{ start: 4, end: 8 }], media);
  assert.strictEqual(pNone[0].frames, Math.round(4 * 30) - 2);
  // 不再出现任何 RASL 剥除警告
  const { warnings } = buildPlan([{ start: 2, end: 12 }], media);
  assert.ok(!warnings.some((w) => /RASL|剥/.test(w)), warnings.join('、'));
});

test('帧数记账与 B 帧深度外的因素无关（关键帧密度不影响预算）', () => {
  const { plan } = buildPlan([{ start: 4, end: 10 }], { keyframes: [0, 4, 8], fps: 30, duration: 12, reorderDepth: 2 });
  assert.strictEqual(plan[0].frames, Math.round(6 * 30) - 2, '只扣防吞深度');
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

// ---------------------------------------------------------------- 吸附模式（precise=false）

// 吸附是 2026-10-14 应库主要求还原的模式（默认导出走它）：入点前移到 ≤ 它的最近关键帧，
// 整段流拷贝、零损失、最快；防吞钳制（cc1ff73 的教训）必须原样保留——回溯绝不越过
// 上一条保留段的出点，跨不过去就自动降级为局部精确。
const SNAP = { ...OPTS, precise: false };

test('吸附：入点前移到最近关键帧，整段流拷贝，snapFrom 保留用户原始入点', () => {
  const { plan, warnings } = buildPlan([{ start: 3.4, end: 5.2 }], SNAP);
  assertPlan(plan, [['copy', 2, 3.2]]);
  assert.strictEqual(plan[0].snapFrom, 3.4, 'UI 显示"少掉多少"要用原始入点');
  assert.match(plan[0].note, /前移/);
  assert.ok(warnings.length === 0, `不该有警告：${warnings.join('、')}`);
});

test('吸附：入点正好在关键帧上 = 与精确模式同一条 copy 段', () => {
  const { plan } = buildPlan([{ start: 4, end: 6 }], SNAP);
  assertPlan(plan, [['copy', 4, 2]]);
});

test('吸附防吞钳制：回溯会吞已排段的内容时，该段整段重编码，绝不吞掉已删素材', () => {
  // 整片只有一个关键帧（12s GOP 的形状）：每条非首段的吸附都会回溯到 0，与已排拷贝段重叠。
  // 语义修正（2026-10-14）：这种情况只降级"局部精确"不够——精确路径的拷贝尾段仍与
  // 已排拷贝段重叠（copy[6,8] ⊂ copy[6,10] 实测），所以重叠侧必须整段重编码。
  const { plan, warnings } = buildPlan(
    [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8, end: 9.5 }],
    { keyframes: [0], duration: 10, fps: 30, precise: false },
  );
  assert.deepStrictEqual(plan.map((p) => p.kind), ['copy', 'reencode', 'reencode']);
  assert.strictEqual(plan[0].start, 0, '首段允许片头回溯（不会并掉别人的区间）');
  assert.strictEqual(plan[1].start, 4.1, '后两段的入点必须精确，绝不前移');
  assert.strictEqual(plan[2].start, 8);
  assert.ok(plan[1].autoPrecise && plan[2].autoPrecise);
  // 拷贝段两两不重叠（防吞+防重叠的合成不变式）
  const cp = plan.filter((p) => p.kind === 'copy');
  for (let i = 0; i < cp.length; i++) for (let j = i + 1; j < cp.length; j++) {
    const ov = Math.min(cp[i].start + cp[i].duration, cp[j].start + cp[j].duration) - Math.max(cp[i].start, cp[j].start);
    assert.ok(ov <= 1e-6, `拷贝段 ${i}/${j} 重叠 ${ov}s`);
  }
  assert.ok(warnings.some((w) => /整段重编码/.test(w) && /交叠/.test(w)), warnings.join('、'));
});

test('吸附防重叠：乱序下吸附拷贝段与已排拷贝段重叠时整段重编码，重叠归零', () => {
  // 旧版缺陷用例：拖乱顺序 + 吸附 → copy[6,10] 与 copy[2,8] 重复 2s（自检拦不住）
  const { plan, warnings } = buildPlan(
    [{ start: 9, end: 10 }, { start: 0, end: 2 }, { start: 5, end: 8 }],
    { keyframes: [0, 2, 6], duration: 10, fps: 30, precise: false, ordered: true },
  );
  const cp = plan.filter((p) => p.kind === 'copy');
  for (let i = 0; i < cp.length; i++) for (let j = i + 1; j < cp.length; j++) {
    const ov = Math.min(cp[i].start + cp[i].duration, cp[j].start + cp[j].duration) - Math.max(cp[i].start, cp[j].start);
    assert.ok(ov <= 1e-6, `拷贝段 ${i}/${j} 重叠 ${ov}s`);
  }
  assert.ok(plan.some((p) => p.keepIndex === 2 && p.kind === 'reencode'), '重叠段必须重编码');
  assert.ok(warnings.some((w) => /交叠/.test(w)), warnings.join('、'));
});

test('吸附防吞钳制（换编码源）：跨界时整段重编码，不混拼也不吞', () => {
  const { plan, warnings } = buildPlan(
    [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }],
    { keyframes: [0], duration: 10, fps: 30, precise: false, sameCodec: false },
  );
  const second = plan.filter((p) => p.keepIndex === 1);
  assert.strictEqual(second.length, 1, '换编码源跨界：整段单编码，绝不与拷贝段混拼');
  assert.strictEqual(second[0].kind, 'reencode');
  assert.strictEqual(second[0].start, 4.1, '入点仍是用户选的，绝不前移吞段');
  assert.ok(second[0].codecChange, '自检要按「编码为重编码所选」判定');
  assert.ok(warnings.some((w) => /带回已删|整段重编码/.test(w)), warnings.join('、'));
});

test('吸附：入点之前没有任何关键帧时从 0 开始，note 说明多带了开头', () => {
  const { plan, warnings } = buildPlan([{ start: 1.5, end: 3 }], { keyframes: [2, 4], duration: 10, precise: false });
  assertPlan(plan, [['copy', 0, 3]]);
  assert.match(plan[0].note, /从 0 开始/);
  assert.ok(plan[0].note.includes('1.500s'), 'note 里写明多带多少');
  assert.strictEqual(warnings.length, 0, '从 0 起是唯一可行解，不算吸附偏差（首段无 prevEnd 可跨）');
});

test('吸附：相邻区间各自吸附后由 dedupePlan 合成一段（同类型吸收）', () => {
  // [1.2,2] 吸附到 0（首段不跨界），[2.2,3] 吸附到 2（2 不小于前段出点 2，不跨界）
  // 两段首尾相接 → dedupe 同类型吸收为 copy[0,3]
  const { plan } = buildPlan([{ start: 1.2, end: 2 }, { start: 2.2, end: 3 }], SNAP);
  assertPlan(plan, [['copy', 0, 3]]);
  assert.strictEqual(plan[0].keepEnd, 3, '合并段的 keepEnd 取最大');
});
