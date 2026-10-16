'use strict';

/**
 * ffmpeg 命令行构造：纯函数 + 参数白名单，杜绝命令注入。
 * 上游只允许传入"计划项 + 输出路径"，不允许传入任意字符串片段。
 */

const path = require('path');
const { snap } = require('./segments');
const { familyOfExt } = require('./containers');

/**
 * HEVC 开放 GOP 的多段拼接救法：剔掉 RASL（NAL 类型 8=RASL_N、9=RASL_R）。
 *
 * x265 默认 open-gop=1，IDR 之后会跟着若干"引用了 IDR 之前画面"的前导帧。整段播放时
 * 解码器在随机接入点本来就要丢弃它们，所以单段没问题；可一旦把两段首尾相接，接缝不再是
 * 解码器认可的接入点，那些参考就找不到了 —— 报 "Could not find ref with POC n"，画面在
 * 接缝处坏几帧。既然规范上这些帧在接入点就该被丢，**在封装层把它们剔掉是等价且合法的**：
 * 不重编码、不丢任何会显示的画面，拼接后全量解码零报错（实测 mov 与 mkv 两种目标都成立）。
 *
 * 别顺手把 RADL（6/7）也剔了：实测照样报错（说明坏的不是 RADL），而 RADL 是真会显示的帧。
 * 也别对 H.264 下发：那是另一套 NAL 编号，且 h264 路径本来就没有这个问题。
 */
const HEVC_DROP_RASL = 'filter_units=remove_types=8|9';

/**
 * 混拼（计划里同时有重编码段和流拷贝段）时的参数集内嵌。
 *
 * 根因（2026-10-15 实测，HEVC 源入点在 GOP 中间必触发）：MP4 每条视频轨只存**一份**
 * 参数集（hvcC），拼接产物取第一段的。重编码段的参数集是编码器新造的，与源的不一致
 * （实测 md5：VPS 71e2… vs 962f…、SPS b0ea… vs f36c…），拷贝段的包却按源参数集编码——
 * 解码器拿着头段那套 SPS/PPS 去解拷贝段，全部解析错乱
 * （chroma_log2_weight_denom / slice_qp / cu_qp_delta 越界、Could not find ref with POC）。
 * H.264 也会撞同样的结构问题，只是 x264 重编码参数集与源足够接近被解码器容错了——
 * 同样补上，不能赌运气。
 *
 * 修法：先把流转成 Annex B（mp4toannexb 顺带把 extradata 换成裸参数集），
 * 再用 dump_extra 把参数集内嵌进每个关键帧包。拼接时输出 muxer 会把两套参数集
 * 都收进 hvcC，而拷贝段关键帧前还带着就地可用的那套——两条路都通。无损：
 * 参数集本来就是解码必需的元数据，多存一份不改变任何画面。
 */
const MIXED_PARAM_BSF = {
  hevc: 'hevc_mp4toannexb,dump_extra=freq=keyframe',
  h264: 'h264_mp4toannexb,dump_extra=freq=keyframe',
};

/** 重编码段粗定位的提前量：够大到保住长视频寻址速度，多出来的再由输出侧 -ss 精确剪掉。 */
const SEEK_LEAD = 2.0;

function streamBsfFor(item, media, opts = {}) {
  const codec = media?.video?.codec;
  /**
   * 重编码段也要把参数集内嵌进关键帧包（混拼时）。
   *
   * 根因（2026-10-17 实测，逐相邻组合对照）：concat 产物的参数集取**第一段**的 hvcC，
   * 而 MP4 每轨只容得下一份。实测 `R→C` 干净、`C→R` 报参数集错乱、`R→C→R` 报错、
   * `C→C` 报 Duplicate POC —— 规律是"**任何段只要不在第一位、且自身没有带内参数集，
   * 就会拿别人的参数集解码**"。拷贝段本就有 dump_extra（3cdce0f 加的），
   * 所以只有"重编码段排在后面"的那几路会炸：多区间精确模式（R→C→R→C）必中，
   * 而单区间（R→C）侥幸能过——这正是矩阵 10s 素材只切 3 段、看不出问题的原因。
   *
   * 修法：重编码段同样内嵌参数集。实测 `dump_extra=freq=keyframe` 一条即可让
   * C→R / R→C→R / 完整 R→C→R→C 全部解码干净。不改任何画面数据，只多带解码必需的元数据。
   */
  if (item.kind === 'reencode') {
    if (!opts.dumpParams || !codec) return [];
    return MIXED_PARAM_BSF[codec] ? ['-bsf:v', MIXED_PARAM_BSF[codec]] : [];
  }
  if (codec === 'hevc') {
    if (opts.dumpParams) return ['-bsf:v', `${HEVC_DROP_RASL},${MIXED_PARAM_BSF.hevc}`];
    return ['-bsf:v', HEVC_DROP_RASL];
  }
  if (codec === 'h264' && opts.dumpParams) return ['-bsf:v', MIXED_PARAM_BSF.h264];
  return [];
}

/**
 * 构造单段切割命令。
 *
 * ffmpeg 语义（N-113109 实测，见 docs/02 技术方案 §3）：
 *  - 流拷贝段：`-ss` 只放在 -i 之前（输入定位），入点必须自己吸附到关键帧，
 *    否则 ffmpeg 只会更晚开始
 *  - 重编码段：输入侧粗定位 + 输出侧 `-ss` 剪余量（原因见下方 lead 的注释）——
 *    单靠输入侧 -ss 会让拷贝的音频从入点前 0.5s 就开始，拼接后帧被越拉越开
 *  - 长度控制优先用 `-frames:v N`（帧数）：`-t 1.5` 在 30fps 下只产出 45 帧，
 *    而 mp4 记录的时长是"末帧 PTS + 一帧"以外的值（实测 seg0 时长 1.467s），
 *    concat 时后段会被接到这个偏短的位置，引发 PTS 错位/回跳。
 *  - `-avoid_negative_ts disabled`（仅拷贝段）：段内视频必须严格从 0 起，
 *    `make_zero` 会按最小的音频包把视频推后一帧，拼接后每个接缝多一帧（见下方注释）
 *  - 不要把 `-ss` 放在 -i 之后再用 `-to`：输入定位时 `-to` 会被当成输出总时长
 *
 * remux 换容器时由目标文件的扩展名决定 muxer，两处按家族分支：
 *  - `-display_rotation` 只有 mov muxer 认（写给 mkv 会当非法输出选项整条命令失败）
 *  - 目标装不下的字幕轨用 `-map -0:s` **整条排除**，而不是让 ffmpeg 报
 *    "Could not find tag for codec subrip"；也不改成 `-c:s mov_text` 偷偷转码
 */
function argsForSegment(item, media, outPath, opts = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const family = familyOfExt(path.extname(outPath));
  const mapArgs = opts.dropSubtitles ? ['-map', '0', '-map', '-0:s'] : ['-map', '0'];

  /**
   * 重编码段的入点必须**分两段下**：只把 `-ss` 放在 -i 前面时，音频是流拷贝的，
   * ffmpeg 的精确寻址只裁解码流、不裁拷贝流，段里的音频从入点前约 0.5s 就开始
   * （实测 audio[-0.523→1.497] 配 video[0.000→1.500]）。拼接时后一段按"最大的那条
   * 流"取偏移，帧被越拉越开：三条区间的 mkv 产物把 5.9s 摊成 18.5s，帧间隔 0.1s。
   * 先输入侧粗定位（提前 SEEK_LEAD 秒，保住大文件寻址速度），再在 -i 之后用输出侧
   * `-ss` 把这段余量精确剪掉，音视频就同时从 0 起（实测 audio[0.010→1.486] / video[0→1.500]）。
   */
  const lead = item.kind === 'reencode' ? Math.min(Math.max(0, item.start), SEEK_LEAD) : 0;
  const coarse = item.start - lead;
  if (coarse > 0.0005) args.push('-ss', fmtTime(coarse));
  args.push('-i', media.file);
  if (lead > 0.0005) args.push('-ss', fmtTime(lead));

  // 长度：能折算成帧数就用 -frames:v，避免"帧数与时长不一致"导致 concat 错位。
  // 计划给了明确包数时（拷贝段要按解码序留双向预测余量）一律以计划为准。
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : null;
  const frames = Number.isFinite(item.frames) && item.frames > 0
    ? Math.round(item.frames)
    : (fps && Number.isFinite(item.duration) ? Math.round(item.duration * fps) : null);
  if (frames) args.push('-frames:v', String(Math.max(1, frames)));
  else args.push('-t', fmtTime(item.duration));
  /**
   * 重编码段必须同时给 -t 上限（= 帧数×帧间隔）：-frames:v 的停止条件是第 N 帧
   * **穿过编码器**，x264/x265 的 lookahead 让这滞后于 demuxer 好几十秒——期间流拷贝
   * 的音频被原样灌进 muxer（实测 1.5s 的重编码头段音频拖到 47.5s，每条接缝被拉长
   * 几十秒；30 分钟 .ts 素材两段混拼报"视频轨比计划多 226s"就是这个）。
   * -t 与 -frames:v 双重约束后视频仍恰好 N 帧（实测 -t=帧数×帧间隔 不丢帧；取比
   * "末帧 PTS"更长的整段时长才安全，取末帧 PTS 本身会削掉最后一帧），音频尾差被压回
   * 约一个 AAC 包粒度，与拷贝段形态一致。拷贝段无编码器延迟、包数一到立即停止，
   * 实测音频贴合视频，不存在此问题，刻意不下发。
   */
  if (item.kind === 'reencode' && fps && frames) args.push('-t', fmtTime(frames / fps));

  if (item.kind === 'copy') {
    args.push('-c', 'copy');
    /**
     * 拷贝段默认**不归零**时间戳。计划里的拷贝段起点必定是关键帧，归零反而是害：
     * `make_zero` 按"所有流里最小的那个"整体平移，而音频帧边界不会正好压在关键帧上，
     * 于是音频归零、视频被推后约一帧（实测 30fps 段 start_time=0.0333）。
     * concat 按各段自身时长推偏移，段里视频晚一帧 → 每个接缝多一帧：
     * 4 段拼出来 4.4667s（该 4.4000s），多出来的正是用户已经删掉的素材。
     * 用 disabled 让段内视频严格从 0 起，负的那点音频尾巴由容器自己
     * （mov 走 edit list / mkv 允许 3ms 偏移）吸收，拼接后时长、帧数、起点全对。
     *
     * 唯一例外由上层指定（copyTs='make_zero'）：**读 Matroska 源**时 disabled 会让段里
     * 所有报文丢掉时间戳（实测 pts=N/A，拼接报 unknown timestamp）。
     * 上层会先把源纯拷成 MP4 再切，切不动时才退回 make_zero 并承担每接缝一帧的偏差。
     */
    args.push('-avoid_negative_ts', opts.copyTs === 'make_zero' ? 'make_zero' : 'disabled');
    // 各段必须用同一个视频刻度：拷贝段的刻度是**从源继承**的（.ts 就是 1/90000），
    // 重编码段却是 mov muxer 默认的 1/15360，concat 按前一段的刻度推下一段的偏移，
    // 单位一混就把 5.8s 的内容摊成 38.7s（实测偏移 .ts 源重编码接缝）。
    if (family === 'mov') args.push('-video_track_timescale', outputTimeScale(media));
    args.push(...mapArgs);                        // 保留全部音轨 / 字幕轨
    args.push('-map_metadata', '0');             // 保留元数据与章节
    args.push('-dn');                            // 丢弃数据轨（章节附件字体常导致失败）
    args.push(...streamBsfFor(item, media, opts));   // HEVC 剔 RASL；混拼时内嵌参数集，见上方注释
    if (media.rotation && media.rotation !== 0 && family === 'mov') {
      args.push('-display_rotation', 'copy');    // 保留旋转信息，避免竖屏视频方向错乱
    }
  } else {
    const codec = pickVideoCodec(media, opts);
    args.push(...mapArgs);
    args.push('-map_metadata', '0');
    // 这里刻意不加 -avoid_negative_ts：重编码段的时间戳本来就被编码器归零，
    // 加上它反而按"最小的音频 dts"整体平移，视频首帧被推到 +0.2~0.3s（实测），
    // 段首就多出一截只有声音没有画面的空档。
    args.push('-c:v', codec);
    /**
     * 音频平时 copy（零损失），但**短段 + MP4 族目标是唯一会丢整条音轨的组合**：
     * 重编码段不足 3 帧时（33ms 窗口只装得下 1 个 23ms 的 AAC 包），mp4 muxer 对
     * "copy 进来的音轨一个包都没有" 直接不写这条轨（实测 mkv muxer 会写、ffmpeg 无警告）；
     * 音频重编码（aac）时编码器按窗口填充就没这个问题。触发条件 = 精确模式整段重编码
     * + 选区只有一两帧 + 输出 mp4/mov——极窄但真实（用户切 1 帧去导出就踩）。
     * 段时长按帧数折算：≥3 帧一律 copy（正常路径不受影响）。
     */
    const tinyFrames = fps && Number.isFinite(item.duration) ? item.duration * fps : Infinity;
    if (family === 'mov' && tinyFrames < 3) {
      args.push('-c:a', 'aac');
      const br = Number(media.audioTracks?.[0]?.bitRate) || 0;
      if (br > 0) args.push('-b:a', String(Math.round(br)));
      else if (media.audioTracks?.[0]?.channels) args.push('-b:a', `${96 * media.audioTracks[0].channels}k`);
    } else {
      args.push('-c:a', 'copy');
    }
    // 重编码段也用同一个刻度，理由见上面拷贝段那段注释
    if (family === 'mov') args.push('-video_track_timescale', outputTimeScale(media));
    if (!opts.dropSubtitles) args.push('-c:s', 'copy');
    args.push('-crf', String(opts.crf ?? 18));
    args.push(...speedArgs(codec));
    // 入点小段用同 profile 编码，减少与源不一致造成的兼容问题
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
    /**
     * 混拼时重编码段也要内嵌参数集（见 streamBsfFor 顶部注释：任何不在第一位的段
     * 若自身不带参数集，就会拿产物第一段的 hvcC 去解码 → 参数集错乱）。
     * 必须放在所有编码选项之后：`-bsf:v` 作用于编码器输出流。
     */
    args.push(...streamBsfFor(item, media, opts));
  }

  args.push(outPath);
  return args;
}

/** 重编码段选编码器：源是 H.265/AV1 时用对应软件编码器；未知编码按 h264 处理（mp4/mov 最稳）。 */
function pickVideoCodec(media, opts = {}) {
  if (opts.reencodeCodec) return opts.reencodeCodec;
  const c = media?.video?.codec;
  if (c === 'hevc') return 'libx265';
  if (c === 'av1') return 'libsvtav1';
  if (c === 'vp9') return 'libvpx-vp9';
  return 'libx264';
}

/**
 * 编码器产出的 codec_name（ffprobe 口径）。
 * 拿 h264 编码器去接 mpeg2 的流拷贝段，拼出来的文件帧率、时长全乱
 * （实测 mpeg2 .ts 混拼产物 5.9s 选区变成 35.8s）——所以先问一句
 * "重编码出来还是源那个编码吗"，不是就别混拼。
 */
const CODEC_OF_ENCODER = {
  libx264: 'h264',
  libx265: 'hevc',
  'libvpx-vp9': 'vp9',
  libsvtav1: 'av1',
  'libaom-av1': 'av1',
  mpeg4: 'mpeg4',
  mjpeg: 'mjpeg',
};

function keepsSourceCodec(media, opts = {}) {
  const enc = pickVideoCodec(media, opts);
  const src = media?.video?.codec;
  if (!src) return true;
  return (CODEC_OF_ENCODER[enc] || enc) === src;
}

/**
 * ffprobe 报的 profile 名不能直接喂给编码器：两边写法不同（都拿随包 ffmpeg 实测）。
 *  - "Constrained Baseline"（手机/屏幕录制很常见）、"Simple Profile"（xvid）、
 *    "Standard"（ProRes）原样传进去 → "invalid profile" → 打不开编码器，整条重编码命令
 *    命令以退出码非 0 结束；"High 10"/"Progressive High" 同理。
 *  - libx265 只认小写无空格：源 profile="Main" 原样传会崩（实测 HEVC 源直接传必崩）。
 * 认不出来的就不传，让编码器按像素格式自己选——总比传一个错的强。
 * VP9 / AV1 的 profile 写法又是另一套（"Profile 0" 之类），一律不传，
 * 自检阶段会比对 profile 是否一致，不一致会明确报错而不是静默。
 */
const PROFILE_NAME_BY_ENCODER = {
  libx264: new Set(['baseline', 'main', 'extended', 'high', 'high10', 'high422', 'high444']),
  libx265: new Set(['main', 'main10', 'main12', 'monochrome', 'monochrome10', 'monochrome12']),
};

/** ffprobe 的长名字 → 编码器认的短名字（只在同一编码内部映射）。 */
const PROFILE_ALIASES = {
  constrainedbaseline: 'baseline',
  progressivehigh: 'high',
  high444predictive: 'high444',
  mainstillpicture: 'main',
};

function profileArg(video, codec) {
  const allowed = PROFILE_NAME_BY_ENCODER[codec];
  if (!allowed) return null;
  const raw = String(video && video.profile ? video.profile : '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!raw) return null;
  const name = PROFILE_ALIASES[raw] || raw;
  return allowed.has(name) ? name : null;
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
 *  - opts.subs：重新计时过的字幕 sidecar。**在拼接这一步一起 mux**，不用多跑一遍：
 *    段里刻意不带字幕（ffmpeg 逐段定位字幕轨会漏包/串包），字幕只在成片时刻上轨一次
 */
function argsForConcat(parts, outPath, media, strategy = 'concat_demuxer', opts = {}) {
  const tsArg = ['-video_track_timescale', outputTimeScale(media)];
  const subs = opts.subs || [];
  const subInputs = subs.flatMap((f) => ['-i', f]);
  // sidecar 的编码由扩展名决定（.srt → subrip，.ass → ass），remux 进容器不需要重编码
  const subMaps = subs.map((_, i) => ['-map', `${i + 1}:s`]).flat();

  if (parts.length === 1) {
    return ['-hide_banner', '-loglevel', 'error', '-y', '-i', parts[0], ...subInputs,
      '-c', 'copy', '-map', '0', ...subMaps, '-map_metadata', '0', ...tsArg, outPath];
  }

  if (strategy === 'concat_demuxer') {
    return ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPathOf(outPath),
      ...subInputs,
      '-c', 'copy', '-map', '0', ...subMaps, '-map_metadata', '0', ...tsArg, outPath];
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

/**
 * 生成 concat demuxer 的清单文件内容。
 *
 * 两个必须处理的写法（实测）：
 *  - 单引号要转义成 '\'' （先结束字符串再补一个转义单引号）
 *  - 反斜杠会被当转义符：临时目录是 `C:\Users\John Smith\…` 这种带空格的路径时，
 *    `\ ` 直接把解析打断，报 "Line 2: unknown keyword 'Coding\Fast'"。
 *    ffmpeg 在 Windows 上认正斜杠，所以统一换成 /，盘符 `C:` 保留
 */
function concatListBody(parts) {
  return parts.map((p) => `file '${slash(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

function slash(p) {
  return String(p).replace(/\\/g, '/');
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

module.exports = {
  argsForSegment, argsForConcat, concatListBody, listPathOf, fmtTime,
  pickVideoCodec, profileArg, keepsSourceCodec, CODEC_OF_ENCODER,
};
