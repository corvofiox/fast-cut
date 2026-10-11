'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { argsForSegment, argsForConcat, concatListBody, fmtTime, pickVideoCodec, profileArg, keepsSourceCodec } = require('./buildArgs');

const MEDIA = {
  file: 'C:\\videos\\src.mp4',
  video: { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', fps: 30, colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709' },
  audioTracks: [{ index: 1 }, { index: 2 }],
  rotation: 0,
};

test('拷贝段命令：有 fps 时用 -frames:v 控制长度（避免帧数与时长不一致）', () => {
  const args = argsForSegment({ kind: 'copy', start: 2, duration: 4 }, MEDIA, 'out.mp4', { fps: 30 });
  const i = (x) => args.indexOf(x);
  assert.ok(i('-ss') >= 0 && i('-i') >= 0 && i('-frames:v') >= 0);
  assert.strictEqual(args[i('-ss') + 1], '00:00:02.000');
  assert.strictEqual(args[i('-i') + 1], 'C:\\videos\\src.mp4');
  assert.strictEqual(args[i('-frames:v') + 1], '120'); // 4s × 30fps
  assert.strictEqual(args[i('-c') + 1], 'copy');
  assert.ok(args.includes('-avoid_negative_ts'));
  assert.strictEqual(args[i('-map') + 1], '0');
  assert.ok(args.includes('-map_metadata'));
  assert.ok(args.includes('-dn'));
});

test('HEVC 流拷贝段剔掉 RASL 前导帧：开放 GOP 多段拼接报 "Could not find ref with POC n" 的根因', () => {
  const hevc = { ...MEDIA, video: { codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p', fps: 30 } };
  const args = argsForSegment({ kind: 'copy', start: 0, duration: 2 }, hevc, 'out.mp4', { fps: 30 });
  const i = args.indexOf('-bsf:v');
  assert.ok(i >= 0);
  assert.strictEqual(args[i + 1], 'filter_units=remove_types=8|9');
});

test('H.264 段与重编码段都不下发该过滤器（NAL 编号不同 / 那一段本来就是新编码的）', () => {
  assert.ok(!argsForSegment({ kind: 'copy', start: 0, duration: 2 }, MEDIA, 'out.mp4', { fps: 30 }).includes('-bsf:v'));
  const hevc = { ...MEDIA, video: { codec: 'hevc', fps: 30 } };
  assert.ok(!argsForSegment({ kind: 'reencode', start: 0, duration: 2 }, hevc, 'out.mp4').includes('-bsf:v'));
});

test('无 fps 时退回 -t 时长控制', () => {
  const args = argsForSegment({ kind: 'copy', start: 2, duration: 4 }, MEDIA, 'out.mp4');
  const i = (x) => args.indexOf(x);
  assert.ok(args.includes('-t'));
  assert.strictEqual(args[i('-t') + 1], '00:00:04.000');
  assert.ok(!args.includes('-frames:v'));
});

test('有旋转信息的源显式携带 display_rotation', () => {
  const args = argsForSegment({ kind: 'copy', start: 0, end: 1 }, { ...MEDIA, rotation: -90 }, 'out.mp4');
  const i = args.indexOf('-display_rotation');
  assert.ok(i >= 0);
  assert.strictEqual(args[i + 1], 'copy');
});

test('remux 到 mkv 不下发 display_rotation：它是 mov muxer 私有选项，写给 mkv 整条命令失败（实测）', () => {
  const args = argsForSegment({ kind: 'copy', start: 0, duration: 1 }, { ...MEDIA, rotation: -90 }, 'out.mkv');
  assert.ok(!args.includes('-display_rotation'));
  assert.ok(args.includes('-c'));
});

test('目标容器装不下字幕时用 -map -0:s 整条排除，而不是等 ffmpeg 报 Could not find tag', () => {
  const args = argsForSegment({ kind: 'copy', start: 0, duration: 1 }, MEDIA, 'out.mp4', { dropSubtitles: true });
  assert.strictEqual(args[args.lastIndexOf('-map') + 1], '-0:s');
  assert.ok(!args.includes('-c:s'));
});

test('重编码段排除字幕时同样不再下发 -c:s copy', () => {
  const args = argsForSegment({ kind: 'reencode', start: 0, duration: 1 }, MEDIA, 'out.mp4', { dropSubtitles: true });
  assert.ok(args.includes('-0:s'));
  assert.ok(!args.includes('-c:s'));
});

test('不排除字幕时保持原样：-map 0 且带 -c:s copy', () => {
  const args = argsForSegment({ kind: 'reencode', start: 0, duration: 1 }, MEDIA, 'out.mkv');
  assert.ok(!args.includes('-0:s'));
  assert.ok(args.includes('-c:s'));
});

test('重编码段沿用源的编码参数，音轨仍拷贝', () => {
  const args = argsForSegment({ kind: 'reencode', start: 3, end: 4, duration: 1 }, MEDIA, 'out.mp4', { fps: 30 });
  const i = (x) => args.indexOf(x);
  assert.strictEqual(args[i('-c:v') + 1], 'libx264');
  assert.strictEqual(args[i('-c:a') + 1], 'copy');
  assert.strictEqual(args[i('-crf') + 1], '18');
  // profile 名要按编码器的写法给：ffprobe 报的 "High" 直接喂 x264 可以，
  // 但 "Constrained Baseline" 之类会 "invalid profile" 打不开编码器（实测）
  assert.strictEqual(args[i('-profile:v') + 1], 'high');
  assert.strictEqual(args[i('-pix_fmt') + 1], 'yuv420p');
  assert.strictEqual(args[i('-color_primaries') + 1], 'bt709');
  assert.strictEqual(args[i('-r') + 1], '30');
  // 重编码段刻意不下 -avoid_negative_ts：编码器已经把时间戳归零，再加它会被
  // 按"最小的音频 dts"整体平移，视频首帧跑到 +0.2~0.3s，段首变成有声无画（实测）
  assert.ok(!args.includes('-avoid_negative_ts'));
});

test('H.265 源精确模式选 libx265，且 colorRange unknown 不注入空参数', () => {
  const hevc = { ...MEDIA, video: { codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p', fps: 25, colorPrimaries: 'unknown', colorTransfer: 'unknown', colorSpace: 'unknown' } };
  const args = argsForSegment({ kind: 'reencode', start: 1, end: 2 }, hevc, 'out.mp4');
  const i = (x) => args.indexOf(x);
  assert.ok(args.includes('libx265'));
  assert.ok(!args.includes('unknown'));
  // libx265 只认小写无空格的 profile，原样传 "Main" 会打不开编码器（实测）
  assert.strictEqual(args[i('-profile:v') + 1], 'main');
});

test('VP9 / AV1 源不注入 profile（写法不同，交给编码器）', () => {
  const vp9 = { ...MEDIA, video: { codec: 'vp9', profile: 'Profile 0', pixFmt: 'yuv420p', fps: 30 } };
  assert.ok(!argsForSegment({ kind: 'reencode', start: 1, end: 2 }, vp9, 'out.webm').includes('-profile:v'));
  assert.strictEqual(profileArg(vp9.video, 'libvpx-vp9'), null);
  assert.strictEqual(profileArg({ profile: 'Main 10' }, 'libx265'), 'main10');
});

test('单段输出退化为直接拷贝到目标', () => {
  const args = argsForConcat(['a.mp4'], 'out.mp4', MEDIA);
  assert.strictEqual(args[args.indexOf('-i') + 1], 'a.mp4');
  assert.strictEqual(args[args.indexOf('-c') + 1], 'copy');
});

test('多段输出走 concat demuxer 且清单内容合法（含空格与单引号的转义）', () => {
  const args = argsForConcat(['a.mp4', 'b.mp4'], 'out.mp4', MEDIA);
  assert.ok(args.includes('concat'));
  assert.strictEqual(args[args.indexOf('-safe') + 1], '0');
  // 反斜杠在 concat 清单里是转义符：临时目录带空格（C:\Users\John Smith\…）时
  // 原样写会把解析打断，实测报 "Line 2: unknown keyword"（ffmpeg 在 Windows 认正斜杠）
  const body = concatListBody(["C:\\a b\\it's.mp4"]);
  assert.strictEqual(body, "file 'C:/a b/it'\\''s.mp4'\n");
});

test('profile 名按编码器口径映射，认不出来就不传', () => {
  // 手机/屏幕录制常见的约束基线：原样传 "Constrained Baseline" 会让 x264 报 invalid profile
  assert.strictEqual(profileArg({ profile: 'Constrained Baseline' }, 'libx264'), 'baseline');
  assert.strictEqual(profileArg({ profile: 'Progressive High' }, 'libx264'), 'high');
  assert.strictEqual(profileArg({ profile: 'High 4:2:2' }, 'libx264'), 'high422');
  assert.strictEqual(profileArg({ profile: 'High 10' }, 'libx264'), 'high10');
  // 别的编码的 profile 名字喂不过来（xvid / ProRes），宁可不传让编码器按像素格式自选
  assert.strictEqual(profileArg({ profile: 'Simple Profile' }, 'libx264'), null);
  assert.strictEqual(profileArg({ profile: 'Advanced Simple Profile' }, 'libx264'), null);
  assert.strictEqual(profileArg({ profile: 'Standard' }, 'libx264'), null);
  assert.strictEqual(profileArg({ profile: 'Main Still Picture' }, 'libx265'), 'main');
  assert.strictEqual(profileArg({ profile: 'Range Extensions' }, 'libx265'), null);
});

test('源编码没有同编码重编码器时，精确模式不许混拼', () => {
  assert.strictEqual(keepsSourceCodec({ video: { codec: 'h264' } }), true);
  assert.strictEqual(keepsSourceCodec({ video: { codec: 'hevc' } }), true);
  assert.strictEqual(keepsSourceCodec({ video: { codec: 'vp9' } }), true);
  // 实测 mpeg2video 源混拼出 5.9s 选区变 35.8s、avg_frame_rate 60/1 的怪文件
  assert.strictEqual(keepsSourceCodec({ video: { codec: 'mpeg2video' } }), false);
  assert.strictEqual(keepsSourceCodec({ video: { codec: 'prores' } }), false);
  assert.strictEqual(keepsSourceCodec({ video: null }), true);
});

test('时间戳格式：无科学计数法、零填充、毫秒三位', () => {
  assert.strictEqual(fmtTime(0), '00:00:00.000');
  assert.strictEqual(fmtTime(2.5), '00:00:02.500');
  assert.strictEqual(fmtTime(3661.25), '01:01:01.250');
  assert.strictEqual(fmtTime(1e-3), '00:00:00.001');
  assert.strictEqual(fmtTime(-5), '00:00:00.000');
});

test('未知编码按 h264 处理', () => {
  assert.strictEqual(pickVideoCodec({ video: { codec: 'mpeg4' } }), 'libx264');
  assert.strictEqual(pickVideoCodec({ video: { codec: 'vp9' } }), 'libvpx-vp9');
  assert.strictEqual(pickVideoCodec({ video: null }), 'libx264');
});
