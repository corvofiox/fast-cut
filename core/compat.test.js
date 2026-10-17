'use strict';

/**
 * 多素材拼接的回归（2026-10-18）。
 *
 * 这一层的每个判据都是实验中"静默出错"催出来的：
 *  - 参数不一致却纯流拷贝 → 帧数少了、帧挤在同一时刻，**解码却不报错**
 *  - 只换编码（-c:v libx264）→ 丢得更多，仍然解码干净
 *  - 编码器按源编码选 → hevc 源重编码出 hevc，与 h264 段拼不起来
 *  - 帧率/时长按源帧率算 → 归一化后每段少 0.4s
 * 所以这里逐条钉住"必须判成不一致"和"基准怎么选"。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeSources, signatureOf, pickBaseline, matchesBaseline, planPerSource, withTargetCodec,
} = require('./compat');

/** 造一个源：只有参数，没有真实文件。 */
function src(id, { codec = 'h264', w = 320, h = 180, fps = 30, pix = 'yuv420p', sar = '1:1',
  ac = 'aac', sr = 44100, ch = 1, afmt = 'fltp' } = {}) {
  return {
    id,
    file: `${id}.mp4`,
    media: {
      video: { codec, width: w, height: h, fps, pixFmt: pix, sar },
      audioTracks: sr ? [{ codec: ac, sampleRate: sr, channels: ch, sampleFmt: afmt }] : [],
    },
  };
}

test('参数完全一致 → uniform，可全程流拷贝', () => {
  const r = analyzeSources([src('a'), src('b')]);
  assert.strictEqual(r.uniform, true);
  assert.deepStrictEqual(r.diffs, []);
  assert.ok(/纯流拷贝/.test(r.summary), r.summary);
});

test('每一项不同都必须判成"不一致"（少判一项就会静默丢帧）', () => {
  const base = src('a');
  const cases = [
    ['编码', src('b', { codec: 'hevc' })],
    ['宽', src('b', { w: 640 })],
    ['高', src('b', { h: 360 })],
    ['帧率', src('b', { fps: 25 })],
    ['像素格式', src('b', { pix: 'yuv422p' })],
    ['像素宽高比', src('b', { sar: '4:3' })],
    ['采样率', src('b', { sr: 48000 })],
    ['声道数', src('b', { ch: 2 })],
    ['采样格式', src('b', { afmt: 's16' })],
    ['音频编码', src('b', { ac: 'mp3' })],
  ];
  for (const [label, other] of cases) {
    const r = analyzeSources([base, other]);
    assert.strictEqual(r.uniform, false, `${label} 不同却没判成不一致`);
    assert.ok(r.diffs.some((d) => d.label === label), `差异里应列出"${label}"：${JSON.stringify(r.diffs.map((d) => d.label))}`);
  }
});

test('缺音轨 vs 有音轨：也必须判成不一致', () => {
  const r = analyzeSources([src('a'), src('b', { sr: 0 })]);
  assert.strictEqual(r.uniform, false);
  assert.ok(r.diffs.some((d) => d.key === 'a.present'), JSON.stringify(r.diffs));
});

test('差异明细不能把视频编码错标成音频编码（视频与音频都有 codec 键）', () => {
  const r = analyzeSources([src('a'), src('b', { codec: 'hevc' })]);
  const codecDiffs = r.diffs.filter((d) => d.label === '编码');
  assert.strictEqual(codecDiffs.length, 1, `应只有一条"编码"差异：${JSON.stringify(r.diffs.map((d) => d.key))}`);
  assert.strictEqual(codecDiffs[0].key, 'v.codec');
  // 音频编码相同（都是 aac），不该出现在差异里
  assert.ok(!r.diffs.some((d) => d.key === 'a.codec'), '音频编码其实相同，不该报差异');
});

test('基准取"最强的源"：分辨率优先，其次帧率、采样率、声道', () => {
  // 低清在前、高清在后 → 必须选高清，否则等于把好素材降质
  const r = analyzeSources([src('lo', { w: 320, h: 180 }), src('hi', { w: 640, h: 360 })]);
  assert.strictEqual(r.baseline.id, 'hi');
  assert.strictEqual(r.baseline.width, 640);
  // 同分辨率时比帧率
  const r2 = analyzeSources([src('a', { fps: 24 }), src('b', { fps: 60 })]);
  assert.strictEqual(r2.baseline.id, 'b');
  // 同分辨率同帧率时比采样率
  const r3 = analyzeSources([src('a', { sr: 44100 }), src('b', { sr: 48000 })]);
  assert.strictEqual(r3.baseline.id, 'b');
  // 全都相同时取第一个（时间轴顺序靠前的更符合直觉）
  const r4 = analyzeSources([src('a'), src('b')]);
  assert.strictEqual(r4.baseline.id, 'a');
});

test('逐源判定：基准源不必重编码，其余源必须重编码并给出原因', () => {
  const a = src('a', { w: 320, h: 180, fps: 30 });
  const b = src('b', { w: 640, h: 360, fps: 24 });
  const cmp = analyzeSources([a, b]);
  assert.strictEqual(cmp.baseline.id, 'b');
  const per = planPerSource([a, b], cmp.baseline, 'h264');
  const byId = Object.fromEntries(per.map((p) => [p.id, p]));
  assert.strictEqual(byId.b.reencode, false, '基准源参数已经对齐，不该重编码');
  assert.strictEqual(byId.a.reencode, true);
  assert.ok(byId.a.reasons.some((r) => /宽/.test(r)), byId.a.reasons.join(','));
});

test('源编码与目标编码不同 → 该源必须重编码（哪怕参数都一样）', () => {
  const a = src('a', { codec: 'h264' });
  const b = src('b', { codec: 'h264' });
  const per = planPerSource([a, b], pickBaseline([a, b]), 'hevc');
  assert.ok(per.every((p) => p.reencode), '选了 hevc 而源都是 h264，两段都得重编码');
  assert.ok(per[0].reasons.some((r) => /编码 h264→hevc/.test(r)), per[0].reasons.join(','));
});

test('源编码等于目标编码且参数一致 → 不重编码（保住零损失）', () => {
  const a = src('a', { codec: 'h264' });
  const b = src('b', { codec: 'h264' });
  const per = planPerSource([a, b], pickBaseline([a, b]), 'h264');
  assert.ok(per.every((p) => !p.reencode), JSON.stringify(per));
});

test('只有一段素材时不需要兼容判定（返回 null，界面不该弹红字）', () => {
  assert.strictEqual(analyzeSources([src('a')]), null);
  assert.strictEqual(analyzeSources([]), null);
});

test('缺字段要判成"不一致"（宁可多编一次，也不放过静默损坏）', () => {
  // 缺 width/帧率等 → 签名里是 null，与完整源必然不等，于是判"不一致、要重编码"
  const weird = { id: 'x', file: 'x.mp4', media: { video: { codec: 'h264', height: 180 }, audioTracks: [] } };
  const r = analyzeSources([src('a'), weird]);
  assert.strictEqual(r.uniform, false, '缺字段的源必须判成不一致');
  assert.ok(r.diffs.length > 0);
});

test('withTargetCodec 只改编码，不改其它基准参数', () => {
  const base = pickBaseline([src('a', { w: 640, h: 360 })]);
  const t = withTargetCodec(base, 'hevc');
  assert.strictEqual(t.codec, 'hevc');
  assert.strictEqual(t.width, base.width);
  assert.strictEqual(t.fps, base.fps);
});

test('matchesBaseline：非方形像素（SAR 不同）也算不匹配', () => {
  const a = src('a', { sar: '1:1' });
  const b = src('b', { sar: '4:3' });
  const base = pickBaseline([a, b]);
  const mismatched = [a, b].filter((s) => !matchesBaseline(s, base));
  assert.ok(mismatched.length >= 1, 'SAR 不同的源必须被判成不匹配');
});
