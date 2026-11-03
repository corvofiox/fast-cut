'use strict';

/**
 * 接缝修补的回归：把切点上的 CRA 改写成 BLA。
 *
 * 这条逻辑动的是码流字节，写错一个位就是坏文件，所以把边界情形都钉住：
 *   - 只改类型位，layer_id / temporal_id 必须原样；
 *   - 包里前面还有 AUD/SEI/参数集时，必须能走到后面的 CRA；
 *   - 已经是 IDR/BLA 的段一个字都不许动（闭合 GOP 的源就走这条路）；
 *   - 长度字段不可信时宁可什么都不做（返回 changed:false），绝不瞎写。
 */
const test = require('node:test');
const assert = require('node:assert');

const { patchPacket, rewriteNalType, nalType, CRA_NUT, BLA_W_LP } = require('./hevcSplice');

/** 造一个 length-prefixed 的 NAL：type 写在头 6 位，layer/tid 可指定。 */
function nal(type, payloadLen = 8, layerId = 0, tidPlus1 = 1) {
  const b = Buffer.alloc(4 + 2 + payloadLen, 0xab);
  b.writeUInt32BE(2 + payloadLen, 0);
  const b0 = ((type & 0x3f) << 1) | ((layerId >> 5) & 0x01);
  const b1 = ((layerId & 0x1f) << 3) | (tidPlus1 & 0x07);
  b[4] = b0; b[5] = b1;
  return b;
}

test('NAL 头：类型位与 layer/tid 的位布局', () => {
  const b = nal(CRA_NUT, 4, 0, 1);
  assert.strictEqual(nalType(b[4]), CRA_NUT);
  // CRA=21 → byte0 = 21<<1 = 42 = 0x2a
  assert.strictEqual(b[4], 0x2a);
  assert.strictEqual(b[5], 0x01);
});

test('改写只动类型位，layer_id 与 temporal_id 原样保留', () => {
  const b = nal(CRA_NUT, 4, 5, 3);      // layerId=5, tid+1=3
  const before = { b0: b[4], b1: b[5] };
  const from = rewriteNalType(b, 4, BLA_W_LP);
  assert.strictEqual(from, CRA_NUT);
  assert.strictEqual(nalType(b[4]), BLA_W_LP);
  assert.strictEqual(b[5], before.b1, '第二字节（layer 低位 + tid）必须一个字都不变');
  assert.strictEqual((b[4] & 0x81), (before.b0 & 0x81), 'forbidden_zero 与 layer 高位必须保留');
});

test('包里先有 AUD/SEI 时，仍能找到并改写后面的 CRA', () => {
  const parts = [nal(35, 2), nal(39, 4), nal(CRA_NUT, 10)];
  const buf = Buffer.concat(parts);
  const r = patchPacket(buf, 0, buf.length);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(nalType(buf[parts[0].length + parts[1].length + 4]), BLA_W_LP);
});

test('已经是 IDR 的段：一个字都不动（闭合 GOP 的源）', () => {
  const buf = nal(19, 10);              // IDR_W_RADL
  const before = Buffer.from(buf);
  const r = patchPacket(buf, 0, buf.length);
  assert.strictEqual(r.changed, false);
  assert.match(r.reason, /接入点/);
  assert.deepStrictEqual(buf, before);
});

test('长度字段不可信时宁可不动，也不瞎写', () => {
  const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x2a, 0x01, 0, 0, 0, 0]);
  const before = Buffer.from(buf);
  const r = patchPacket(buf, 0, buf.length);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(buf, before);
});

test('越界的包位置直接拒绝', () => {
  const buf = nal(CRA_NUT, 8);
  assert.strictEqual(patchPacket(buf, 0, buf.length + 100).changed, false);
  assert.strictEqual(patchPacket(buf, -1, 10).changed, false);
});

test('包里没有 CRA 时不改（例如纯 P 帧包）', () => {
  const buf = Buffer.concat([nal(35, 2), nal(1, 6)]);
  const before = Buffer.from(buf);
  assert.strictEqual(patchPacket(buf, 0, buf.length).changed, false);
  assert.deepStrictEqual(buf, before);
});
