'use strict';

/**
 * 导出自检：导出完成后必须验证"真的原样导出了"。
 * 比对输出与源的容器/编码参数，任何一项不一致即视为失败（宁可失败也不要交花屏）。
 */

const { run } = require('./probe');
const { snap } = require('./segments');
const { familyOfFormat } = require('./containers');

/**
 * @param {string} ffmpegPath  ffmpeg 可执行文件（全量解码校验用）
 * @param {string} ffprobePath ffprobe 可执行文件（探流比对用）
 * @param {string} srcFile
 * @param {string} outFile
 * @param {{duration:number}} expect
 * @returns {Promise<{ok:boolean, checks:Array<{name:string,ok:boolean,detail:string}>}>}
 */
async function verifyExport(ffmpegPath, ffprobePath, srcFile, outFile, expect) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  let srcMeta = null;
  let outMeta = null;
  try {
    srcMeta = await probeRaw(ffprobePath, srcFile);
  } catch (e) {
    add('probe-source', false, `源文件探流失败：${e.message}`);
  }
  try {
    outMeta = await probeRaw(ffprobePath, outFile);
  } catch (e) {
    add('probe-output', false, `导出文件探流失败：${e.message}`);
  }

  if (!srcMeta || !outMeta) return { ok: false, checks };

  const sName = String(srcMeta.format.format_name || '');
  const oName = String(outMeta.format.format_name || '');
  const sameContainer = sName.split(',').some((n) => oName.split(',').includes(n));
  if (expect.container) {
    // remux 换封装是用户主动选的，这时"和源不一致"才是对的：只比对目标家族
    const want = expect.container;
    const got = familyOfFormat(oName);
    add('容器为所选封装', got === want.family,
      `所选 ${want.label}（${want.ext}）→ 导出 ${oName}${sameContainer ? '' : `，与源 ${sName} 不同`}`);
  } else {
    add('容器一致', sameContainer, `源 ${sName} → 导出 ${oName}`);
  }

  const sVideo = first(srcMeta.streams, 'video');
  const oVideo = first(outMeta.streams, 'video');
  if (!sVideo || !oVideo) {
    add('视频轨存在', false, `源视频轨 ${!!sVideo}，导出 ${!!oVideo}`);
  } else if (expect.codec && expect.codec !== sVideo.codec_name) {
    // 源编码没有同编码的重编码器时整段重编码，编码必然改变：这是明说的设计而不是故障，
    // 拿"所选编码"比对，而不是拿源比对
    add('编码为重编码所选', oVideo.codec_name === expect.codec,
      `源 ${sVideo.codec_name} → 导出 ${oVideo.codec_name}（整段重编码，非流拷贝）`);
    add('分辨率一致', sameWH(sVideo, oVideo), `源 ${sVideo.width}x${sVideo.height} → 导出 ${oVideo.width}x${oVideo.height}`);
  } else {
    add('视频编码一致', sVideo.codec_name === oVideo.codec_name, `源 ${sVideo.codec_name} → 导出 ${oVideo.codec_name}`);
    add('分辨率一致', sameWH(sVideo, oVideo), `源 ${sVideo.width}x${sVideo.height} → 导出 ${oVideo.width}x${oVideo.height}`);
    add('像素格式一致', sVideo.pix_fmt === oVideo.pix_fmt, `源 ${sVideo.pix_fmt} → 导出 ${oVideo.pix_fmt}`);
    /**
     * 帧率：真正要守住的是"这么多帧占满这么长时间"，也就是 frames / duration。
     * 拿源与产物的 r_frame_rate 对口径会被两件事绊倒（都实测过）：
     *  - ffprobe 的 r/avg 都是**推断**，ts 的 1/30 落在 90kHz 上会报成 60/1，
     *    mkv 的块时长按毫秒取整会把 30/1 报成 645/22 ≈ 29.32；
     *  - 含双向预测的源在出点上按解码序留了余量，有几帧画面会多显示一帧时间——
     *    帧数、总时长都精确，唯独"最常见的帧间隔"变长了，那不是导出坏了。
     * 所以判据换成：产物的任一帧率口径 ≈ 计划帧数 / 计划时长（2% 内），
     * 或者与源的口径一致（0.5% 内，纯拷贝不裁帧时本来就是它）。
     */
    if (expect.vfr) {
      add('可变帧率源', true, `源标称 ${sVideo.r_frame_rate} / 实测 ${sVideo.avg_frame_rate}，整段按定帧率重编码导出，不强求与源一致`);
    } else {
      /**
       * 允差不是拍脑袋的百分比，而是**计划自己允许的偏差**：
       * 含双向预测的源在出点按解码序留了余量（trimmed 帧），那几帧的时间仍占着格子，
       * "最常见的帧间隔"就被拉长（实测 43 帧的计划报成 645/22 ≈ 29.32 而非 30）。
       * 真把帧率改歪（25 当成 30 编）远超这个数，照样会被判失败。
       */
      const slack = Math.max(0.005, (expect.rateSlack || 0) + 0.01);
      const planRate = expect.frames && expect.duration > 0 ? expect.frames / expect.duration : null;
      const srcRates = [toFps(sVideo.r_frame_rate), toFps(sVideo.avg_frame_rate)];
      const outRates = [toFps(oVideo.r_frame_rate), toFps(oVideo.avg_frame_rate)];
      const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(0.001, b * slack);
      const ok = outRates.some((o) => srcRates.some((s) => close(o, s)))
        || (planRate !== null && outRates.some((o) => close(o, planRate)));
      add('帧率与计划一致', ok,
        `源 ${sVideo.r_frame_rate}/${sVideo.avg_frame_rate} → 导出 ${oVideo.r_frame_rate}/${oVideo.avg_frame_rate}`
        + `（计划 ${expect.frames || '?'} 帧 / ${Number(expect.duration).toFixed(3)}s ≈ ${planRate ? planRate.toFixed(2) : '?'} fps，允差 ${(slack * 100).toFixed(1)}%）`);
    }
    if (sVideo.profile) {
      add('profile 一致', String(sVideo.profile) === String(oVideo.profile), `源 ${sVideo.profile} → 导出 ${oVideo.profile}`);
    }
    if (sVideo.color_primaries && sVideo.color_primaries !== 'unknown') {
      add('色彩原色一致', sVideo.color_primaries === oVideo.color_primaries, `源 ${sVideo.color_primaries} → 导出 ${oVideo.color_primaries}`);
    }
    if (sVideo.color_transfer && sVideo.color_transfer !== 'unknown') {
      add('传输特性一致', sVideo.color_transfer === oVideo.color_transfer, `源 ${sVideo.color_transfer} → 导出 ${oVideo.color_transfer}`);
    }
  }

  const sAudios = all(srcMeta.streams, 'audio').length;
  const oAudios = all(outMeta.streams, 'audio').length;
  add('音轨数量一致', sAudios === oAudios, `源 ${sAudios} → 导出 ${oAudios}`);

  const sSubs = all(srcMeta.streams, 'subtitle').length;
  const oSubs = all(outMeta.streams, 'subtitle').length;
  if (sSubs > 0) {
    if (expect.dropSubtitles) {
      add('字幕轨已按所选容器省略', oSubs === 0,
        `源 ${sSubs} 条装不进所选容器，导出 ${oSubs} 条（要保留字幕请选 MKV）`);
    } else {
      add('字幕轨数量一致', sSubs === oSubs, `源 ${sSubs} → 导出 ${oSubs}`);
    }
  }

  /**
   * 帧数：计划要导出多少帧，视频轨就得有多少个报文。
   * 这是"剪辑位置精确"最硬的一条判据——时长会被容器记账口径糊弄（mkv 的块时长、
   * ts 的 90kHz 取整），帧数不会。允差 1 帧只给封装器自己的边界取整留余地。
   */
  if (expect.frames != null) {
    const n = await countVideoPackets(ffprobePath, outFile);
    add('帧数符合切割计划', n !== null && Math.abs(n - expect.frames) <= 1,
      n == null ? `计划 ${expect.frames} 帧，视频包数没读到`
        : `计划 ${expect.frames} 帧 → 实际 ${n} 帧（差 ${n - expect.frames}）${n > expect.frames ? '：多出来的是你已经删掉的素材' : ''}`);
  }

  // 时长：`expect.duration` 是**切割计划实算的时长之和**（整帧取整后的真值）。
  // 上界不再按"源长 5%"给：98 分钟的素材等于允许多带 5 分钟，把"整段被并回去、
  // 剪辑等于没做"那种事故直接放行（实测）。多带的每一秒都是用户已经删掉的素材，
  // 所以上界要紧，下界留给"音频尾巴/封装口径"那种看得见的无害差。
  // 量的必须是**视频轨**：拷贝过去的音频常常比画面长半秒，拿容器时长（各流取最大）判
  // 会把这种音频尾巴算成"多导了内容"（实测 .ts 源 +0.6s 误报），而那类病自有"音画时间线一致"把关。
  const outDur = videoDuration(outMeta) ?? Number(outMeta.format.duration || 0);
  const slack = Math.max(0.5, expect.duration * 0.02);
  const lower = expect.duration - 1.0;
  const durOk = outDur >= lower && outDur <= expect.duration + slack;
  const seam = outDur > expect.duration + slack && expect.parts > 1
    ? `；比计划多 ${(outDur - expect.duration).toFixed(3)}s —— 多段拼接的接缝被拉长（源时间戳不规范时在段内就烧好了，实测偏移 .ts），勾「每段一个文件」可绕开 concat`
    : '';
  add('时长符合预期', durOk,
    `切割计划 ${expect.duration.toFixed(3)}s（用户选区 ${(expect.userSecs ?? expect.duration).toFixed(3)}s）`
    + ` → 视频轨 ${snap(outDur)}s，允差 -1.0s / +${slack.toFixed(2)}s${seam}`);

  // 音画时间线对齐：容器总时长看不出"音频比视频长半秒"这类接缝病。
  // 实测两种病都出在拼接：重编码段的拷贝音频不按入点收口（长 0.5s）、
  // 各段视频刻度不一致（帧被越拉越开，5.8s 摊成 38.7s）。两处都修了，
  // 留 0.3s 允差是给"吸附多带的不足一帧"和音频帧取整的余量。
  const aV = avSpread(outMeta);
  if (aV !== null) {
    const budget = 0.3;
    add('音画时间线一致', Math.abs(aV) <= budget,
      `音频比视频${aV >= 0 ? '长' : '短'} ${Math.abs(aV).toFixed(3)}s（允差 ${budget}s）`);
  }

  // 播放性：完整解码全片。比"能打开"更强的判据，能抓出索引损坏/花屏/丢帧。
  // 注意：`-xerror` 并不能拦住所有解码错误——实测 HEVC 开 GOP 的多段拼接产物
  // 会打 "Could not find ref with POC n"，但 ffmpeg 仍以退出码 0 结束。
  // 因此这里以 `-v error` 的 stderr 为准：该级别下输出的都是真问题。
  try {
    const { stderr } = await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', outFile, '-f', 'null', '-']);
    const noise = decodeErrors(stderr);
    add('完整解码无错误', noise.length === 0,
      noise.length ? `解码报错：${noise[0]}${noise.length > 1 ? ` （共 ${noise.length} 条）` : ''}${hevcHint(expect, noise)}` : 'ffmpeg -xerror 全量解码通过');
  } catch (e) {
    add('完整解码无错误', false, e.message);
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * 音频与视频各自的时间线跨度差（秒）；任一缺失（mkv 常不写流时长）就返回 null 不判。
 */
function avSpread(outMeta) {
  const v = streamSpan(first(outMeta.streams, 'video'));
  const a = streamSpan(first(outMeta.streams, 'audio'));
  if (v === null || a === null) return null;
  return a - v;
}

function streamSpan(s) {
  if (!s) return null;
  const direct = Number(s.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const ts = Number(s.duration_ts);
  const base = String(s.time_base || '').split('/').map(Number);
  if (Number.isFinite(ts) && ts > 0 && base[0] && base[1]) return (ts * base[0]) / base[1];
  return null;
}

/** 视频轨时长；mkv 一类不写流时长时返回 null，由调用方退回容器时长。 */
function videoDuration(meta) {
  return streamSpan(first(meta && meta.streams, 'video'));
}

/**
 * 已知踩过的坑，给一条能照着做的出路，别只丢一句"解码报错"。
 * 实测：同一段 HEVC 在 mp4 里多段拼接干净，在 mkv 里同样切法必报 "Duplicate POC"，
 * 而"每段一个文件"（不进 concat）是干净的。
 */
function hevcHint(expect, noise) {
  const pocLike = /POC|Could not find ref/i.test(noise.join(' '));
  if (!pocLike) return '';
  if (expect.parts > 1 && familyOfFormat(expect.sourceFormat) === 'matroska') {
    return '；源是 Matroska 容器里的 HEVC，多段拼接的接缝解码不过（实测）——勾"每段一个文件"导出即可，那条路不进 concat';
  }
  return '';
}

/**
 * `-f null` 也要过一遍 muxer：带字幕轨的 mkv 会冒出
 * "non monotonically increasing dts to muxer"（字幕包共享同一个 DTS），
 * 那是封装层的碎语，不是画面/声音坏了。
 * "Last message repeated N times" 是 ffmpeg 自己的复读机，同一件事不算新证据。
 */
const BENIGN_DECODE_NOISE = /non monotonically increasing dts to muxer|Last message repeated \d+ times/i;

/** 从 ffmpeg 的 stderr 里挑出真正的错误行。 */
function decodeErrors(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !BENIGN_DECODE_NOISE.test(line));
}

async function probeRaw(ffprobePath, file) {
  const { stdout } = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(stdout);
}

/** 视频轨报文数（按解码序数包，比 `-count_frames` 全量解码便宜得多，判帧数够用）。 */
async function countVideoPackets(ffprobePath, file) {
  try {
    const { stdout } = await run(ffprobePath, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts', '-of', 'csv=p=0', file]);
    const n = stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length;
    return n || null;
  } catch {
    return null;
  }
}

function first(streams, type) { return (streams || []).find((s) => s.codec_type === type) || null; }
function all(streams, type) { return (streams || []).filter((s) => s.codec_type === type); }
function sameWH(a, b) { return a.width === b.width && a.height === b.height; }

function toFps(r) {
  const [x, y] = String(r).split('/').map(Number);
  if (!x || !y) return null;
  return x / y;
}

module.exports = { verifyExport, decodeErrors };
