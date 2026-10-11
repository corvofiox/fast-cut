'use strict';

/**
 * ffmpeg 命令行构造：纯函数 + 参数白名单，杜绝命令注入。
 * 上游只允许传入"计划项 + 输出路径"，不允许传入任意字符串片段。
 */

const path = require('path');
const { snap } = require('./segments');

/**
 * 构造单段切割命令。
 *
 * ffmpeg 语义（N-113109 实测，见 docs/02 技术方案 §3）：
 *  - `-ss` 放在 -i 之前（输入定位）：入点必须自己吸附到关键帧，否则 ffmpeg 只会更晚开始
 *  - 长度控制优先用 `-frames:v N`（帧数）：`-t 1.5` 在 30fps 下只产出 45 帧，
 *    而 mp4 记录的时长是"末帧 PTS + 一帧"以外的值（实测 seg0 时长 1.467s），
 *    concat 时后段会被接到这个偏短的位置，引发 PTS 错位/回跳。
 *  - `-avoid_negative_ts make_zero` 必须加，否则时间戳不归零，播放器可能显示错乱
 *  - 不要把 `-ss` 放在 -i 之后再用 `-to`：输入定位时 `-to` 会被当成输出总时长
 */
function argsForSegment(item, media, outPath, opts = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  args.push('-ss', fmtTime(item.start));
  args.push('-i', media.file);

  // 长度：能折算成帧数就用 -frames:v，避免"帧数与时长不一致"导致 concat 错位
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : null;
  if (fps && Number.isFinite(item.duration)) {
    args.push('-frames:v', String(Math.max(1, Math.round(item.duration * fps))));
  } else {
    args.push('-t', fmtTime(item.duration));
  }

  if (item.kind === 'copy') {
    args.push('-c', 'copy');
    // 流拷贝必须显式规避负时间戳导致的花屏/首帧丢失
    args.push('-avoid_negative_ts', 'make_zero');
    // 与重编码段保持同一时间轴刻度，否则 concat 混拼会把帧率拉歪
    // 单段时间基无需干预：各段输出都是规整的 30/1，歪帧发生在 concat 阶段，
    // 由 argsForConcat 的 -video_track_timescale 统一修正（实测 ts=15360 无效、ts=fps 有效）。
    args.push('-map', '0');                       // 保留全部音轨 / 字幕轨
    args.push('-map_metadata', '0');             // 保留元数据与章节
    args.push('-dn');                            // 丢弃数据轨（章节附件字体常导致失败）
    if (media.rotation && media.rotation !== 0) {
      args.push('-display_rotation', 'copy');    // 保留旋转信息，避免竖屏视频方向错乱
    }
  } else {
    const codec = pickVideoCodec(media, opts);
    args.push('-map', '0');
    args.push('-map_metadata', '0');
    args.push('-c:v', codec);
    args.push('-c:a', 'copy');
    args.push('-c:s', 'copy');
    args.push('-crf', String(opts.crf ?? 18));
    args.push(...speedArgs(codec));
    // 精确模式的小段用同 profile 编码，减少与源不一致造成的兼容问题
    const profile = profileArg(media.video, codec);
    if (profile) args.push('-profile:v', profile);
    if (media.video?.pixFmt) args.push('-pix_fmt', media.video.pixFmt);
    if (media.video?.fps) args.push('-r', String(media.video.fps));
    // 定帧率输出，时间戳连续，避免拼接处 PTS 回跳
    args.push('-fps_mode', 'cfr');
    if (media.video?.colorPrimaries && media.video.colorPrimaries !== 'unknown') {
      args.push('-color_primaries', media.video.colorPrimaries);
    }
    if (media.video?.colorTransfer && media.video.colorTransfer !== 'unknown') {
      args.push('-color_trc', media.video.colorTransfer);
    }
    if (media.video?.colorSpace && media.video.colorSpace !== 'unknown') {
      args.push('-colorspace', media.video.colorSpace);
    }
  }

  args.push(outPath);
  return args;
}

/** 精确模式选编码器：源是 H.265/AV1 时用对应软件编码器；未知编码按 h264 处理（mp4/mov 最稳）。 */
function pickVideoCodec(media, opts = {}) {
  if (opts.reencodeCodec) return opts.reencodeCodec;
  const c = media?.video?.codec;
  if (c === 'hevc') return 'libx265';
  if (c === 'av1') return 'libsvtav1';
  if (c === 'vp9') return 'libvpx-vp9';
  return 'libx264';
}

/**
 * ffprobe 报的 profile 名能不能直接喂给编码器：
 *  - libx264 原样接受（实测 'High' 可用）
 *  - libx265 只认小写且不带空格：源 profile="Main" 原样传进去会
 *    "Error while opening encoder"（实测 HEVC 精确模式必崩）
 *  - VP9 / AV1 的 profile 写法完全不同（"Profile 0" 之类），交给编码器自己选，
 *    自检阶段会比对 profile 是否一致，不一致会明确报错而不是静默。
 */
function profileArg(video, codec) {
  const p = video && video.profile;
  if (!p) return null;
  if (codec === 'libx265') return String(p).toLowerCase().replace(/\s+/g, '');
  if (codec === 'libx264') return String(p);
  return null;
}

/**
 * "快"这个参数每个编码器写法不同，写错了是打不开编码器（实测 libsvtav1 收到
 * `-preset veryfast` 直接 -22 Invalid argument），所以按编码器分支。
 */
function speedArgs(codec) {
  if (codec === 'libvpx-vp9') return ['-deadline', 'good', '-cpu-used', '2', '-row-mt', '1'];
  if (codec === 'libsvtav1') return ['-preset', '8'];
  if (codec === 'libaom-av1') return ['-cpu-used', '4'];
  return ['-preset', 'veryfast'];
}

/**
 * concat 输出的时间轴刻度。
 *
 * 实测结论（见 docs/02 技术方案 §3）：
 *  两段各自规整（30/1），concat demuxer 拷贝时把后段首帧 PTS 接到前段末尾。若前段时长不是
 *  帧长的整数倍（重编码段 0.6s @30fps），PTS 落半格，ffmpeg 只能把时基压到 1/15360 兼容，
 *  最终 avg_frame_rate 显示 356352/12161 ≈ 29.30 —— 帧率真的被拉歪。
 *  仅当 timescale 设为帧率本身（或帧率的整数倍）时，ffmpeg 才会把 PTS 就近取整到整帧，
 *  帧率恢复正常：ts=30 → 30/1，ts=15360 / 90000 → 依然歪。
 * 取源帧率，取不到就退回 30。
 */
function outputTimeScale(media) {
  const fps = Math.round(Number(media?.video?.fps) || 30);
  return Number.isFinite(fps) && fps > 0 ? String(fps) : '30';
}

/**
 * 构造拼接命令。
 *
 * 关键点：
 *  - concat demuxer 快速但要求各段编码参数一致（v0.1 默认路径）
 *  - 拼接时必须用 -video_track_timescale 统一时基，否则帧率被拉歪（见 outputTimeScale 注释）
 *  - strategy 'concat_filter' 是参数不一致时的兜底（慢，需重编码）
 */
function argsForConcat(parts, outPath, media, strategy = 'concat_demuxer') {
  const tsArg = ['-video_track_timescale', outputTimeScale(media)];

  if (parts.length === 1) {
    return ['-hide_banner', '-loglevel', 'error', '-y', '-i', parts[0],
      '-c', 'copy', '-map', '0', '-map_metadata', '0', ...tsArg, outPath];
  }

  if (strategy === 'concat_demuxer') {
    return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPathOf(outPath),
      '-c', 'copy', '-map', '0', '-map_metadata', '0', ...tsArg, outPath];
  }

  // concat filter：所有输入统一重编码（仅在参数不一致时使用）
  const inputs = parts.flatMap((p) => ['-i', p]);
  const fps = media?.video?.fps ? String(media.video.fps) : '30';
  return ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', `[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=${parts.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', pickVideoCodec(media, {}), '-c:a', 'aac', '-r', fps, '-fps_mode', 'cfr',
    ...tsArg, outPath];
}

/** 生成 concat demuxer 的清单文件内容。单引号需转义为 '\''（先结束字符串再转义单引号）。 */
function concatListBody(parts) {
  return parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** concat 清单文件路径：与输出同目录，避免跨盘符/长路径问题。 */
function listPathOf(outPath) {
  return path.join(path.dirname(path.resolve(outPath)), '.fast-cut-concat.txt');
}

/** 秒 → ffmpeg 时间戳 HH:MM:SS.mmm（比 -ss 裸秒数可读性更好，也避免 1e-3 之类的科学计数法）。 */
function fmtTime(seconds) {
  const t = Math.max(0, snap(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(whole, 2)}.${String(ms).padStart(3, '0')}`;
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

module.exports = { argsForSegment, argsForConcat, concatListBody, listPathOf, fmtTime, pickVideoCodec, profileArg };
