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
  } else {
    add('视频编码一致', sVideo.codec_name === oVideo.codec_name, `源 ${sVideo.codec_name} → 导出 ${oVideo.codec_name}`);
    add('分辨率一致', sameWH(sVideo, oVideo), `源 ${sVideo.width}x${sVideo.height} → 导出 ${oVideo.width}x${oVideo.height}`);
    add('像素格式一致', sVideo.pix_fmt === oVideo.pix_fmt, `源 ${sVideo.pix_fmt} → 导出 ${oVideo.pix_fmt}`);
    // 帧率：用 r_frame_rate（容器声明的标称帧率）判定，不要用 avg_frame_rate。
    // avg 是 ffprobe 用 duration/nb_frames 倒推的，首帧 PTS 非 0 时会失真
    // （实测：精确模式产物 116 帧 @30fps、帧间隔严格 1/30，但 avg 显示 3480/119 ≈ 29.24）。
    add('帧率一致', frameRateEq(sVideo.r_frame_rate || sVideo.avg_frame_rate, oVideo.r_frame_rate || oVideo.avg_frame_rate),
      `源 ${sVideo.r_frame_rate || sVideo.avg_frame_rate} → 导出 ${oVideo.r_frame_rate || oVideo.avg_frame_rate}`);
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

  // 时长：关键帧吸附只会让产物变长（多带内容），绝不会变短。
  // 因此只校验下界；上界留足一个 GOP 的余量。
  const outDur = Number(outMeta.format.duration || 0);
  const gopBudget = Math.max(8, (srcMeta?.format?.duration ?? 0) * 0.05);
  const durOk = outDur >= expect.duration - 1.0 && outDur <= expect.duration + gopBudget;
  add('时长符合预期', durOk, `用户选区 ≈${expect.duration.toFixed(3)}s（吸附后只增不减），实际 ${snap(outDur)}s，允许多出 ≤${gopBudget.toFixed(1)}s`);

  // 播放性：完整解码全片。比"能打开"更强的判据，能抓出索引损坏/花屏/丢帧。
  // 注意：`-xerror` 并不能拦住所有解码错误——实测 HEVC 开 GOP 的多段拼接产物
  // 会打 "Could not find ref with POC n"，但 ffmpeg 仍以退出码 0 结束。
  // 因此这里以 `-v error` 的 stderr 为准：该级别下输出的都是真问题。
  try {
    const { stderr } = await run(ffmpegPath, ['-v', 'error', '-xerror', '-i', outFile, '-f', 'null', '-']);
    const noise = decodeErrors(stderr);
    add('完整解码无错误', noise.length === 0,
      noise.length ? `解码报错：${noise[0]}${noise.length > 1 ? ` （共 ${noise.length} 条）` : ''}` : 'ffmpeg -xerror 全量解码通过');
  } catch (e) {
    add('完整解码无错误', false, e.message);
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * `-f null` 也要过一遍 muxer：带字幕轨的 mkv 会冒出
 * "non monotonically increasing dts to muxer"（字幕包共享同一个 DTS），
 * 那是封装层的碎语，不是画面/声音坏了。除此以外的 -v error 输出都按真错误处理。
 */
const BENIGN_DECODE_NOISE = /non monotonically increasing dts to muxer/i;

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

function first(streams, type) { return (streams || []).find((s) => s.codec_type === type) || null; }
function all(streams, type) { return (streams || []).filter((s) => s.codec_type === type); }
function sameWH(a, b) { return a.width === b.width && a.height === b.height; }

/** 帧率比对用 0.5% 相对误差：concat 重封装会把 30/1 改写成等价的大分子分母时分比。 */
function frameRateEq(a, b) {
  const na = toFps(a);
  const nb = toFps(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= Math.max(0.001, nb * 0.005);
}

function toFps(r) {
  const [x, y] = String(r).split('/').map(Number);
  if (!x || !y) return null;
  return x / y;
}

function ratioEq(a, b) {
  return frameRateEq(a, b);
}

module.exports = { verifyExport, decodeErrors };
