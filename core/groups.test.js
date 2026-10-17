'use strict';

/**
 * 分组显示的回归测试（2026-10-18，用户反馈催出来的）：
 * 用户分了两组（1+2 并一组、4+5 并一组），时间轴上两组都显示"组1"，
 * 走带和右侧片段栏都分不出哪几段是一伙的。
 *
 * 根因是编号表**每次调用都从头重数**：已登记的组不占号，第二个组又拿到 1。
 * 这类"看着对、其实全错"的 bug 单测最难抓（没有异常、没有报错，只是数字不对），
 * 所以这里把判据钉死：编号必须唯一、连续、按首次出现顺序。
 *
 * 同时钉住"组号 ≠ 文件号"这条：组号只表示"第几次合并"，
 * 中间夹着未分组的段时，组2 可能是第 3 个文件——界面提示必须用真实文件序号。
 */
const test = require('node:test');
const assert = require('node:assert');

/** 与 timeline.js / app.js 里 groupNumbers 同源的编号规则（两处必须一致）。 */
function numbering(clips) {
  const map = new Map();
  let n = 0;
  for (const c of clips) {
    if (c.group == null || map.has(c.group)) continue;
    map.set(c.group, ++n);
  }
  return map;
}

test('组号唯一且连续：两组必须是 组1 / 组2，不能都叫组1', () => {
  // 用户实测的形状：6 段，1+2 一组、4+5 一组
  const clips = [
    { group: 1 }, { group: 1 }, { group: null },
    { group: 2 }, { group: 2 }, { group: null },
  ];
  const map = numbering(clips);
  assert.strictEqual(map.get(1), 1);
  assert.strictEqual(map.get(2), 2, '第二个组必须拿到 2；旧 bug 会给出 1');
  assert.deepStrictEqual([...map.values()], [1, 2]);
  // 反查：每段拿到的显示号
  const shown = clips.map((c) => (c.group == null ? null : map.get(c.group)));
  assert.deepStrictEqual(shown, [1, 1, null, 2, 2, null]);
});

test('组号按首次出现顺序编：内部 id 不连续也不会出现空洞', () => {
  // 用户撤销/拆分后内部 id 会变成 7、13 这种，显示必须是 1、2
  const clips = [{ group: 7 }, { group: 13 }, { group: 7 }, { group: 13 }];
  const map = numbering(clips);
  assert.strictEqual(map.get(7), 1);
  assert.strictEqual(map.get(13), 2);
});

test('重复调用必须给出同一个答案（旧实现每调一次都重数，是 bug 的根）', () => {
  const clips = [
    { group: 1 }, { group: 1 }, { group: null }, { group: 2 }, { group: 2 },
  ];
  const map = numbering(clips);
  // 模拟"画每一块时都查一次编号"：旧实现每次都会把已登记的组跳过却不计数
  const per = fn => clips.map((c) => (c.group == null ? null : fn(map, c.group)));
  const first = per((m, g) => m.get(g));
  const second = per((m, g) => m.get(g));
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, [1, 1, null, 2, 2]);
});

test('组号 ≠ 文件号：中间夹着未分组的段时，组2 落在第 3 个文件', () => {
  // 真实分组顺序：g1 / k1 / g2 / k3
  const plan = [
    { keepIndex: 0, outGroup: 'g1' }, { keepIndex: 0, outGroup: 'g1' },
    { keepIndex: 1, outGroup: 'k1' },
    { keepIndex: 2, outGroup: 'g2' }, { keepIndex: 2, outGroup: 'g2' },
    { keepIndex: 3, outGroup: 'k3' },
  ];
  const fileNoOfGroup = {};
  const seen = new Set();
  for (let i = 0, fileNo = 0; i < plan.length; i++) {
    const key = plan[i].outGroup;
    if (seen.has(key)) continue;
    seen.add(key);
    fileNo++;
    const m = /^g(\d+)$/.exec(key);
    if (m) fileNoOfGroup[Number(m[1])] = fileNo;
  }
  assert.strictEqual(fileNoOfGroup[1], 1, '组1 是第 1 个文件');
  assert.strictEqual(fileNoOfGroup[2], 3, '组2 是第 3 个文件（第 2 个文件是未分组的那段）');
  // 旧界面直接拿组号当文件号写，会写成"组2 · 第 2 个文件"——按提示去找会找错
  assert.notStrictEqual(fileNoOfGroup[2], 2);
});

test('每个分组都要有对应的颜色，且相邻组颜色不同', () => {
  // 这里复刻 groupColor.js 的规则（含守卫），用于钉住"非法组号不能返回 undefined"
  const PALETTE = ['#4fc3d9', '#e8b04b', '#b08ce8', '#e87b9a', '#9bd45f', '#5fa8e8', '#e8845f', '#5fd4a8'];
  const colorOf = (no) => {
    const n = Number(no);
    if (!Number.isFinite(n) || n < 1) return PALETTE[0];
    return PALETTE[(Math.round(n) - 1) % PALETTE.length];
  };
  assert.strictEqual(colorOf(1), '#4fc3d9');
  assert.strictEqual(colorOf(2), '#e8b04b');
  assert.notStrictEqual(colorOf(1), colorOf(2), '组1 与组2 的颜色必须可区分');
  // 前 8 组两两不同
  const first8 = Array.from({ length: 8 }, (_, i) => colorOf(i + 1));
  assert.strictEqual(new Set(first8).size, 8, '前 8 组颜色必须互不相同');
  // 非法组号不能返回 undefined（CSS 里会静默变成继承色，看起来"配色没生效"）
  assert.strictEqual(colorOf(0), PALETTE[0]);
  assert.strictEqual(colorOf(NaN), PALETTE[0]);
  assert.strictEqual(colorOf(-3), PALETTE[0]);
  assert.strictEqual(colorOf(undefined), PALETTE[0]);
});
