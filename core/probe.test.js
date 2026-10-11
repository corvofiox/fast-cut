'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeProbe } = require('./probe');

const VIDEO = { index: 0, codec_type: 'video', codec_name: 'h264', r_frame_rate: '30/1', avg_frame_rate: '30/1', pix_fmt: 'yuv420p' };

test('时间原点归零：mkv 的 format.duration 含偏移，要减掉', () => {
  const m = normalizeProbe({
    format: { format_name: 'matroska,webm', start_time: '12.322000', duration: '22.368000' },
    streams: [VIDEO],
  }, 'x.mkv');
  assert.strictEqual(m.startOffset, 12.322);
  assert.strictEqual(m.duration, 10.046);
});

test('时间原点归零：mpegts 的 duration 不含偏移，不能减', () => {
  const m = normalizeProbe({
    format: { format_name: 'mpegts', start_time: '15.076778', duration: '10.023222' },
    streams: [VIDEO],
  }, 'x.ts');
  assert.strictEqual(m.startOffset, 15.077);
  assert.strictEqual(m.duration, 10.023);
});

test('普通素材 startOffset 为 0，时长原样', () => {
  const m = normalizeProbe({ format: { format_name: 'mov,mp4,m4a', duration: '10' }, streams: [VIDEO] }, 'x.mp4');
  assert.strictEqual(m.startOffset, 0);
  assert.strictEqual(m.duration, 10);
});

test('帧网格原点 = 视频流自己的 start_time（实测 HEVC 的 mp4/mkv 首帧 pts 0.023）', () => {
  const m = normalizeProbe({
    format: { format_name: 'mov,mp4,m4a', start_time: '0.000000', duration: '10.031' },
    streams: [{ ...VIDEO, start_time: '0.023000' }],
  }, 'x.mp4');
  assert.strictEqual(m.startOffset, 0);
  assert.strictEqual(m.gridOrigin, 0.023);
});

test('容器与流的原点合一时网格原点归 0，不重复扣', () => {
  const m = normalizeProbe({
    format: { format_name: 'mpegts', start_time: '15.076778', duration: '10.023222' },
    streams: [{ ...VIDEO, start_time: '15.076778' }],
  }, 'x.ts');
  assert.strictEqual(m.gridOrigin, 0);
});

test('可变帧率判定：标称与实测差 1% 以上算 VFR', () => {
  const vfr = normalizeProbe({
    format: { format_name: 'mov,mp4', duration: '10' },
    streams: [{ ...VIDEO, r_frame_rate: '30/1', avg_frame_rate: '251/10' }],
  }, 'v.mp4');
  assert.strictEqual(vfr.video.vfr, true);
  const cfr = normalizeProbe({
    format: { format_name: 'mov,mp4', duration: '10' },
    streams: [{ ...VIDEO, r_frame_rate: '30/1', avg_frame_rate: '30/1' }],
  }, 'c.mp4');
  assert.strictEqual(cfr.video.vfr, false);
});
