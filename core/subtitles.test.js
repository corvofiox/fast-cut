'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseSrt, stringifySrt, parseAss, setAssTime, retime,
  parseSrtTime, fmtSrtTime, parseAssTime, fmtAssTime, isTextSubtitle,
} = require('./subtitles');

const SRT = `1
00:00:00,800 --> 00:00:01,200
cue-1

2
00:00:02,100 --> 00:00:02,500
cue-2

3
00:00:05,000 --> 00:00:06,000
cue-3

4
00:00:08,200 --> 00:00:09,000
cue-4
`;

// 保留区间 [[0.5,2.3],[4.1,6.7],[8.0,9.5]] 在成片里依次从 0 / 1.8 / 4.4 开始
const KEEPS = [{ start: 0.5, end: 2.3 }, { start: 4.1, end: 6.7 }, { start: 8.0, end: 9.5 }];
const PROG = [0, 1.8, 4.4];

test('时间戳格式：SRT 逗号毫秒、ASS 点号百分秒', () => {
  assert.strictEqual(parseSrtTime('00:01:23,456'), 83.456);
  assert.strictEqual(fmtSrtTime(83.456), '00:01:23,456');
  assert.strictEqual(parseAssTime('0:01:23.45'), 83.45);
  assert.strictEqual(fmtAssTime(83.45), '0:01:23.45');
  assert.strictEqual(parseAssTime('1:00:00.00'), 3600);
  assert.strictEqual(parseSrtTime('垃圾'), null);
});

test('SRT 解析出每条 cue 的起止与正文', () => {
  const { cues } = parseSrt(SRT);
  assert.strictEqual(cues.length, 4);
  assert.strictEqual(cues[0].start, 0.8);
  assert.strictEqual(cues[0].text, 'cue-1');
  assert.ok(Math.abs(cues[3].end - 9.0) < 1e-9);
});

test('SRT 回写能再读回来，时间不漂移', () => {
  const cues = parseSrt(SRT).cues;
  const again = parseSrt(stringifySrt(cues)).cues;
  assert.deepStrictEqual(again.map((c) => [+c.start.toFixed(3), +c.end.toFixed(3)]),
    cues.map((c) => [+c.start.toFixed(3), +c.end.toFixed(3)]));
});

test('重新计时：落在保留区间内的 cue 平移到成片时刻', () => {
  const out = retime(parseSrt(SRT).cues, KEEPS, PROG);
  assert.deepStrictEqual(out.map((c) => c.text), ['cue-1', 'cue-2', 'cue-3', 'cue-4']);
  assert.deepStrictEqual(out.map((c) => +c.start.toFixed(3)), [0.300, 1.600, 2.700, 4.600]);
});

test('重新计时：起点在被删区间的 cue 整条丢掉', () => {
  const cues = [{ start: 3.0, end: 3.6, text: '在被删的间隙里' }];
  assert.deepStrictEqual(retime(cues, KEEPS, PROG), []);
});

test('重新计时：跨到区间末尾的字幕截断，不在下一段重播', () => {
  // 源 6.4→7.2 只有一半在 [4.1,6.7] 里
  const cues = [{ start: 6.4, end: 7.2, text: '跨边界' }];
  const out = retime(cues, KEEPS, PROG);
  assert.strictEqual(out.length, 1);
  assert.ok(Math.abs(out[0].start - (1.8 + (6.4 - 4.1))) < 1e-6);
  assert.ok(Math.abs(out[0].end - (1.8 + (6.7 - 4.1))) < 1e-6);   // 截到区间末尾，不接下一个区间
});

test('重新计时：截断后长度为零的丢掉，不留空 cue', () => {
  const cues = [{ start: 2.29, end: 2.31, text: '贴着末尾' }];
  assert.strictEqual(retime(cues, KEEPS, PROG).length, 1);
  const cues2 = [{ start: 2.3, end: 2.3, text: '只剩零长' }];
  assert.strictEqual(retime(cues2, KEEPS, PROG).length, 0);
});

test('单条保留区间（每段一个文件）按该段自身起点归零', () => {
  const one = [KEEPS[1]];
  const out = retime(parseSrt(SRT).cues, one, [0]);
  assert.deepStrictEqual(out.map((c) => c.text), ['cue-3']);
  assert.strictEqual(out[0].start, 0.9);
});

test('ASS 解析按 Format 表头定位时间字段，文本里的逗号不破坏字段', () => {
  const ass = String.raw`[Script Info]
Title: 测试

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.80,0:00:01.20,Default,,0000,0000,0000,,第一句，带逗号
Dialogue: 0,0:00:02.10,0:00:02.50,Default,,0000,0000,0000,,{\b1}带特效{\b0}的第二句
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,注释行不重排
`;
  const doc = parseAss(ass);
  const events = doc.body.filter((n) => n.kind === 'event');
  assert.strictEqual(events.length, 2, 'Comment 行不参与重排');
  assert.strictEqual(events[0].start, 0.8);
  assert.strictEqual(events[1].end, 2.5);
  assert.strictEqual(setAssTime(events[0], 0.3, 0.7),
    'Dialogue: 0,0:00:00.30,0:00:00.70,Default,,0000,0000,0000,,第一句，带逗号');
  assert.strictEqual(setAssTime(events[1], 1.6, 1.75),
    'Dialogue: 0,0:00:01.60,0:00:01.75,Default,,0000,0000,0000,,{\\b1}带特效{\\b0}的第二句');
  // 整篇回写：注释行与表头原样保留，只有 Dialogue 的时间变了
  const back = require('./subtitles').applyRetime(doc, [
    Object.assign({}, events[0], { start: 0.3, end: 0.7 }),
    Object.assign({}, events[1], { start: 1.6, end: 1.75 }),
  ]);
  assert.ok(back.includes('Comment: 0,0:00:00.00,0:00:00.00'), '注释行原样');
  assert.ok(back.includes('Format: Layer, Start, End'), '表头原样');
  assert.ok(back.includes('0:00:00.30'), '第一条时间已重排');
});

test('ASS 只留下活下来的 Dialogue：删掉的字幕整行不写，不串位', () => {
  const ass = String.raw`[Script Info]
Title: t

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.80,0:00:01.60,Default,,0,0,0,,第一条
Dialogue: 0,0:00:02.10,0:00:02.90,Default,,0,0,0,,第二条在被删区间
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,第三条
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,注释
`;
  const doc = parseAss(ass);
  const events = doc.body.filter((n) => n.kind === 'event');
  const kept = retime(events, [{ start: 4.1, end: 6.7 }], [0]);   // 只保留第 2 条区间
  assert.deepStrictEqual(kept.map((c) => [c.from, +c.start.toFixed(2)]), [[2, 0.9]]);
  const out = require('./subtitles').applyRetime(doc, kept);
  assert.ok(out.includes('[Script Info]'), '表头必须一起写回，否则 ffmpeg 不认这份 sidecar');
  assert.ok(!out.includes('第一条') && !out.includes('第二条'), '被删区间的字幕整行不写');
  assert.ok(out.includes('0:00:00.90'), '活下来的那条时间已按本段起点重排');
  assert.ok(out.includes('第三条'), '保留的那条正文还在');
  assert.ok(out.includes('Comment:'), '注释行原样保留');
});

test('认不出的字幕文本要抛错，不能尽力而为吐一份对不上的', () => {
  assert.throws(() => parseSrt('没有时间的文本\n第二行\n'), /时间轴/);
  assert.throws(() => parseAss('[Events]\nFormat: Layer, Text\nDialogue: 0,正文\n'), /Start\/End|无法解析/);
});

test('只有文本字幕可重排', () => {
  assert.strictEqual(isTextSubtitle('subrip'), true);
  assert.strictEqual(isTextSubtitle('ASS'), true);
  assert.strictEqual(isTextSubtitle('hdmv_pgs_subtitle'), false);
  assert.strictEqual(isTextSubtitle('mov_text'), false);
});

// 基准取"这一段实际第一帧的时刻"：入点 0.5 不在 30fps 的网格上（原点 0.023）时画面从 0.523 起，
// 用 0.5 做减法会让每条 cue 都比口型晚 0.023s（实测 mkv 源就是这个数）。
test('重新计时：aligns 给实际第一帧时刻，cue 不再整体偏晚半帧', () => {
  const keeps = [{ start: 0.5, end: 2.3 }];
  const cues = [{ start: 0.823, end: 1.223, text: 'x' }];
  assert.strictEqual(retime(cues, keeps, [0])[0].start, 0.323);           // 没给对齐时刻：按用户入点
  assert.strictEqual(retime(cues, keeps, [0], [0.523])[0].start, 0.3);    // 给了：按第一帧
});

test('重新计时：压着入点的 cue 顶到该段开头，不写出负时刻', () => {
  const out = retime([{ start: 0.505, end: 1.2, text: '压线' }], [{ start: 0.5, end: 2.3 }], [0], [0.523]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].start, 0);
  assert.ok(Math.abs(out[0].end - (1.2 - 0.523)) < 1e-6);
});
