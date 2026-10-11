'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  snap, normalizeSegment, normalizeSegments, unionSegments, invertSegments,
  totalDuration,
} = require('./segments');

test('snap 抹平浮点误差', () => {
  assert.strictEqual(snap(2.9999999), 3);
  assert.strictEqual(snap(0.0333333333), 0.033);
  assert.strictEqual(snap(-0), 0);
  assert.strictEqual(snap(1e9), 1e9);
});

test('normalizeSegment 交换首尾并丢弃空区间', () => {
  assert.deepStrictEqual(normalizeSegment({ start: 5, end: 2 }), { start: 2, end: 5 });
  assert.strictEqual(normalizeSegment({ start: 3, end: 3 }), null);
  assert.strictEqual(normalizeSegment({ start: 3, end: 2.999 }), null);
  assert.deepStrictEqual(normalizeSegment({ start: -4, end: 1 }), { start: 0, end: 1 });
  assert.strictEqual(normalizeSegment({ start: NaN, end: 1 }), null);
});

test('normalizeSegments 按起点排序并合并重叠/相邻', () => {
  const out = normalizeSegments([
    { start: 8, end: 10 },
    { start: 0, end: 2 },
    { start: 3, end: 5 },
    { start: 4.5, end: 6 },
    { start: 2, end: 2 },
  ]);
  assert.deepStrictEqual(out, [
    { start: 0, end: 2, merged: false },
    { start: 3, end: 6, merged: true },
    { start: 8, end: 10, merged: false },
  ]);
});

test('乱序输入必须被排序，否则会错误地并进第一段', () => {
  const out = normalizeSegments([{ start: 5, end: 6 }, { start: 0, end: 1 }]);
  assert.deepStrictEqual(out.map((s) => [s.start, s.end]), [[0, 1], [5, 6]]);
});

test('首尾相接（含浮点误差）的区间会被合并，避免零长拼接段', () => {
  const out = normalizeSegments([{ start: 0, end: 2 }, { start: 2.0000001, end: 4 }]);
  assert.deepStrictEqual(out, [{ start: 0, end: 4, merged: true }]);
});

test('真正有空档的区间保持独立', () => {
  const out = normalizeSegments([{ start: 0, end: 2 }, { start: 2.5, end: 4 }]);
  assert.deepStrictEqual(out, [
    { start: 0, end: 2, merged: false },
    { start: 2.5, end: 4, merged: false },
  ]);
});

test('invertSegments 反相为删除区间', () => {
  const del = invertSegments([{ start: 2, end: 5 }, { start: 8, end: 10 }], 12);
  assert.deepStrictEqual(del, [
    { start: 0, end: 2 },
    { start: 5, end: 8 },
    { start: 10, end: 12 },
  ]);
});

test('totalDuration 累加的是并集时长', () => {
  assert.strictEqual(totalDuration([{ start: 0, end: 2 }, { start: 1, end: 4 }]), 4);
  assert.strictEqual(totalDuration([]), 0);
});
