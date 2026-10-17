'use strict';

/**
 * ffprobe / ffmpeg 调用层：唯一允许出现"进程"的地方。
 * 上层（UI）只依赖这里导出的纯数据；替换成内置静态 ffmpeg 时只改 exec 路径。
 */

const { spawn } = require('child_process');
const { snap } = require('./segments');
const { familyOfFormat } = require('./containers');

/**
 * format.duration 有没有把 start_time 算进去，各家写法不一样（实测）：
 *  - mkv：22.368 = 偏移 12.322 + 内容 10.023 —— 算进去了，得减
 *  - mpegts：10.023 而 start_time 15.077 —— 没算进去，不能减
 * 只认这两族，其余（avi/webm/ts…）宁可当"没算进去"，减错会让时间轴比内容短。
 */
function includesOffset(formatName) {
  const family = familyOfFormat(formatName);
  return family === 'mov' || family === 'matroska';
}

/** 构造 ffmpeg 参数：把 run({args, ...}) 展开成数组，便于测试注入假执行器。 */
function run(bin, args, { onProgress, signal, timeoutMs = 6 * 60 * 60 * 1000, binary = false } = {}) {
  if (process.env.FASTCUT_TRACE) console.log(`[trace] ${bin} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    // binary=true 时按 Buffer 收集 stdout（裸码流是二进制，转成字符串会被破坏）
    let stdout = binary ? [] : '';
    let settled = false;

    const timer = setTimeout(() => {
      kill(child);
      settled = true;
      reject(new Error(`${bin} 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        kill(child);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('已取消'));
        }
      }, { once: true });
    }

    child.stdout.on('data', (d) => { if (binary) stdout.push(d); else stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (onProgress) {
        const p = parseProgress(stderr, onProgress);
        if (p) onProgress(p);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ${bin}：${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout: binary ? Buffer.concat(stdout) : stdout, stderr });
      else {
        const err = new Error(`${bin} 退出码 ${code}\n${tail(stderr)}`);
        // 调用方（导出自检的解码判据）要按 stderr 分辨"真报错"与封装层碎语，
        // 光看 message 会把"ffmpeg 退出码 69"那行也当成一条错误。
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function kill(child) {
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  // Windows 下 SIGKILL 可能只杀 shell，补一刀 taskkill
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  }
}

function tail(s, n = 800) {
  s = String(s || '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** 从 ffmpeg stderr 累积文本中解析最后一次进度（time=HH:MM:SS.cc）。 */
function parseProgress(stderr, onProgress) {
  const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return { seconds: snap(seconds), raw: m[0] };
}

/**
 * 探流：返回 Fast Cut 内部使用的媒体信息结构（已解析成纯数据）。
 * @param {string} ffprobePath
 * @param {string} file
 */
async function probeMedia(ffprobePath, file) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const raw = JSON.parse(stdout);
  return normalizeProbe(raw, file);
}

/** ffprobe JSON → 内部媒体信息。 */
function normalizeProbe(raw, file = '(unknown)') {
  const fmt = raw.format || {};
  const video = (raw.streams || []).find((s) => s.codec_type === 'video') || null;
  const audios = (raw.streams || []).filter((s) => s.codec_type === 'audio');
  const subs = (raw.streams || []).filter((s) => s.codec_type === 'subtitle');

  /**
   * 时间原点：ts / mpegts 录制和带 `-output_ts_offset` 的 mkv，首帧 pts 不是 0（实测相机
   * .ts 从 13.745s 起）。mkv 还会把这段偏移算进 format.duration（10s 的片子报 22.368s）。
   * 界面上所有时刻、关键帧表、-ss 都必须走"相对时间原点"的坐标，否则用户选 0.5–2.3s
   * 实际拿到的是文件开头那段，整条时间轴平移。换算只在这里做一次：
   * 对外（媒体信息、关键帧、时长）一律归零，只有下发 ffmpeg -ss 时再加回 startOffset。
   */
  const startOffset = snap(Number(fmt.start_time) || 0);
  const rawDur = snap(Number(fmt.duration ?? video?.duration ?? 0));
  const duration = startOffset > 0.01 && includesOffset(fmt.format_name) && rawDur > startOffset
    ? snap(rawDur - startOffset)
    : rawDur;
  /**
   * 帧网格原点（相对时间原点）：视频流自己的 start_time 可能比容器晚
   * （实测 HEVC 的 .mp4/.mkv 首帧 pts = 0.023，因为 DTS/PTS 有编码器延迟）。
   * 关键帧时间戳就落在这个原点 + N/fps 的格子上；按 0 去折算帧数，
   * 每个接缝都会差上半帧，拷贝段还会被算成与重编码段重叠 → 时长互相蚕食。
   */
  const streamStart = snap(Number(video?.start_time) || 0);
  const gridOrigin = streamStart > startOffset ? snap(streamStart - startOffset) : 0;

  const fps = video && video.avg_frame_rate && video.avg_frame_rate !== '0/0'
    ? safeRatio(video.avg_frame_rate)
    : null;
  // r_frame_rate 是容器声明的标称帧率；与 avg 差 1% 以上通常意味着 VFR（可变帧率）源。
  const nominalFps = video && video.r_frame_rate && video.r_frame_rate !== '0/0'
    ? safeRatio(video.r_frame_rate)
    : null;
  const vfr = !!(fps && nominalFps) && Math.abs(fps - nominalFps) > Math.max(0.02, nominalFps * 0.01);

  // 旋转：优先 side_data rotation，其次 tags rotate（旧版 ffmpeg）
  let rotation = 0;
  const sd = video?.side_data_list?.[0];
  if (sd && typeof sd.rotation === 'number') rotation = sd.rotation;
  else if (video?.tags?.rotate) rotation = Number(video.tags.rotate) || 0;

  // HDR / 10bit 判定（影响重编码段的像素格式与色彩参数）
  const hdr = !!video && (
    (video.color_primaries && video.color_primaries !== 'unknown' && video.color_primaries !== 'bt709') ||
    !!video.tags?.['color_range'] ||
    (video.pix_fmt && /10le|10be|12le|p010/.test(video.pix_fmt))
  );

  return {
    file,
    format: fmt.format_name || null,
    duration,
    startOffset,
    gridOrigin,
    sizeBytes: Number(fmt.size || 0),
    bitRate: Number(fmt.bit_rate || 0),
    video: video ? {
      index: video.index,
      codec: video.codec_name,
      profile: video.profile ?? null,
      width: video.width,
      height: video.height,
      // coded_* 是实际编码尺寸，width/height 可能已被 ffmpeg 按 rotation 交换过
      codedWidth: video.coded_width ?? video.width,
      codedHeight: video.coded_height ?? video.height,
      displayWidth: video.width,
      displayHeight: video.height,
      pixFmt: video.pix_fmt,
      fps,
      nominalFps,
      vfr,
      timeBase: video.time_base ? Number(String(video.time_base).split('/')[1]) || null : null,
      rotation,
      hdr,
      colorPrimaries: video.color_primaries ?? null,
      colorTransfer: video.color_transfer ?? null,
      colorSpace: video.color_space ?? null,
      /**
       * 重排深度 = 解码序与显示序差几帧（ffprobe 的 has_b_frames 是**数字**，不是 'P'）。
       * 流拷贝按解码序数包（`-frames:v`），出点会往前多带这么多帧、同时漏掉同样多帧
       * （实测 h264 双向预测源要 45 帧给出 {0..43, 47}：47 是用户已经删掉的素材）。
       * 拷贝段的出点帧数要按它减，见 cuttings.buildPlan。
       */
      reorderDepth: Math.max(0, Number(video.has_b_frames) || 0),
      hasBframes: (Number(video.has_b_frames) || 0) > 0,
    } : null,
    audioTracks: audios.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      sampleRate: a.sample_rate,
      /** 短段 MP4 导出音频转 aac 时按源码率走（缺失则按声道数折算，见 buildArgs）。 */
      bitRate: Number(a.bit_rate) || 0,
      language: a.tags?.language ?? null,
      title: a.tags?.title ?? null,
    })),
    subtitleTracks: subs.length,
    /** 字幕编码名：remux 换封装时要靠它判断"这个容器装不装得下"（见 core/containers.js）。 */
    subtitleCodecs: subs.map((s) => s.codec_name),
    rotation,
    hdr,
  };
}

function safeRatio(r) {
  const [a, b] = String(r).split('/').map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

/**
 * 关键帧列表（秒，严格升序去重）。
 *
 * 用**报文标志**而不是 `-skip_frame nokey` 的解码结果，两个原因：
 *  1. 快一个量级：只解封装、不进解码器。实测 30 min/720p/1.24 GB 从 3.78 s 降到 0.60 s，
 *     10 min/1080p/HEVC 从 638 ms 降到 134 ms。
 *  2. 更准：报文的 K 标志直接来自容器索引（mp4 的 stss / mkv 的 block keyframe 标志），
 *     而解码器的"是不是关键帧"判定不总可靠——实测 VP9/webm 用 `-skip_frame nokey`
 *     会把 300 帧全报成关键帧（真相只有 5 个），于是流拷贝根本不吸附，切点落在 GOP 中间。
 *
 * 三个历史坑仍然要防（见 docs/02 §2.6）：
 *  - csv 输出可能有空行，`Number('') === 0` 会凭空造出一个"0 秒关键帧"
 *  - 时间戳可能重复，必须去重，否则二分吸附会失准
 *  - 结果必须排序后才交给上层
 *
 * origin = 媒体的 startOffset：报文 pts 是**绝对**时间戳，而 ffmpeg 的输入侧 `-ss`、
 * 界面时间轴都以"文件开头"为 0（实测同一素材加 13.7s 偏移后 `-ss 2.0` 拿到的还是
 * 第 2 秒那一帧）。这张表必须减掉原点，否则相机 .ts / 带偏移的 mkv 会报出
 * "关键帧全在 13.7s 之后"——吸附永远找不到入点，每个区间都被迫从 0 开始，
 * 用户删掉的片段整个带回产物。
 */
async function probeKeyframes(ffprobePath, file, origin = 0) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    file,
  ]);

  const seen = new Set();
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;                       // 坑 1：空行转 Number 会得到 0
    const cols = line.split(',');
    const raw = String(cols[0] || '').trim();
    const flags = String(cols[1] || '').trim();
    if (!flags.includes('K')) continue;                // K = AV_PKT_FLAG_KEY
    if (!/^\d+(\.\d+)?$/.test(raw)) continue;          // 只认纯数字时间戳
    const t = snap(Math.max(0, Number(raw) - origin));
    if (!Number.isFinite(t) || seen.has(t)) continue;   // 坑 2：去重
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => a - b);                           // 坑 3：上层二分依赖升序
  return out;
}

/**
 * 取源在给定保留区间内的字幕 cue 时刻（相对时间原点），按字幕流分组。
 *
 * 只读区间内的报文（`-read_intervals` 用绝对时间戳，所以要加回 startOffset），
 * 不必把整片解一遍。用途是导出自检：分段流拷贝时 ffmpeg 对 Matroska 字幕轨的定位
 * 不可靠（实测会把窗口里的 cue 整条漏掉，也会把被删区间的 cue 串回来），
 * 而"漏一条 + 串一条"正好把条数抵消掉，所以要比**落点**而不是只数条数。
 *
 * @param {Array<[number,number]>} ranges 保留区间（相对时间原点）
 * @returns {Promise<number[][]>} 每条字幕轨的 cue 起点列表
 */
async function sourceSubtitleCues(ffprobePath, file, ranges, startOffset = 0, until = 0) {
  if (!ranges.length) return [];
  const off = Number(startOffset) || 0;
  const iv = ranges.map(([s, e]) => {
    const hi = until > 0 ? Math.min(e, until) : e;
    return `${(s + off).toFixed(3)}%${(hi + off).toFixed(3)}`;
  }).join(',');
  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=index,codec_type',
    '-show_entries', 'packet=stream_index,pts_time',
    '-read_intervals', iv, file,
  ]);
  const j = JSON.parse(stdout);
  const tracks = (j.streams || []).filter((s) => s.codec_type === 'subtitle').map((s) => Number(s.index));
  const hits = tracks.map(() => []);
  for (const p of j.packets || []) {
    const k = tracks.indexOf(Number(p.stream_index));
    if (k < 0) continue;
    const t = Number(p.pts_time);
    if (!Number.isFinite(t)) continue;
    const rel = t - off;
    if (ranges.some(([s, e]) => rel >= s - 0.001 && rel < e)) hits[k].push(rel);
  }
  return hits.map((list) => list.sort((a, b) => a - b));
}

/**
 * 源里到底有没有 RASL（HEVC NAL 8/9）？—— 决定要不要剥、要不要扣帧数。
 *
 * 为什么必须实测而不能靠猜（2026-10-17）：
 *  - x265 默认 `open-gop=1`，但**可以显式关掉**（`open-gop=0`）。闭合 GOP 的源
 *    每个关键帧都是 IDR，**根本没有 RASL 可剥**；可代码一律按"HEVC 就扣
 *    `段内关键帧数 × raslPerKf`"记账，实测白扣了 30 帧 = 1.03 秒**真实内容**：
 *    闭合 GOP 源切 [4.5, 25]，产物末帧只到源 23.967s，用户的出点内容整段没了。
 *  - 反过来，开放 GOP 不扣就会超收（末帧冲到 26.1s，把已删素材带回来）。
 *
 * **不能只看开头**（这是修这个 bug 时踩的坑）：RASL 只跟在**CRA 关键帧**后面，
 * 而第一个关键帧往往是 IDR。实测 `-preset veryfast` 编的源关键帧间隔 8.33s，
 * 第一个 CRA 在 8.33s —— 只扫前 2s 会判成"没有 RASL"，于是既不剥也不做接缝缓解，
 * 产物照样报 `Duplicate POC`。所以改成**围绕各关键帧扫**：默认每 5 秒开一个 2 秒窗，
 * 并在尾部补一个窗；扫到任意一个 RASL 即判开放 GOP。
 *
 * 扫不出 RASL 就按闭合处理——**宁可多给内容也不能凭空扣掉用户的帧**，
 * 且下游自检会比对帧数，真判错会响亮失败而不是静默交差。
 *
 * @param {string} ffmpegPath
 * @param {string} file
 * @param {number[]} keyframes 关键帧时刻（秒，相对时间原点）；给了就围绕它们扫
 * @param {number} duration 源时长（秒），用于在尾部补窗
 * @returns {Promise<boolean>} true = 源含 RASL（开放 GOP）
 */
async function probeHasRasl(ffmpegPath, file, keyframes = [], duration = 0) {
  /** 扫一个时间窗，命中 RASL 即 true；抽不出裸流时返回 null（交给调用方决定回退） */
  const scanWindow = async (at, len) => {
    let stdout;
    try {
      const args = ['-v', 'error'];
      if (at > 0.01) args.push('-ss', String(at));
      args.push('-t', String(len), '-i', file, '-map', '0:v:0', '-c', 'copy',
        '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', '-');
      ({ stdout } = await run(ffmpegPath, args, { binary: true }));
    } catch {
      return null;
    }
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'binary');
    // Annex B 起始码后第一个字节右移 1 位 = NAL type；8=RASL_N 9=RASL_R
    for (let i = 0; i + 4 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        const t = (buf[i + 3] >> 1) & 0x3f;
        if (t === 8 || t === 9) return true;
        i += 3;
      }
    }
    return false;
  };

  /**
   * 窗口计划：优先围绕关键帧扫（RASL 只可能跟在 CRA 后）。
   * 关键帧表为空或不给时，退化成"从 0 起每 5 秒一个窗"的盲扫。
   */
  const WIN = 2.0;
  const points = [];
  if (Array.isArray(keyframes) && keyframes.length) {
    for (const k of keyframes) {
      if (!Number.isFinite(k) || k < 0) continue;
      points.push(k);
      if (points.length >= 24) break;                  // 上限：24 个窗已足够判定
    }
  } else if (duration > 0) {
    for (let t = 0; t < duration; t += 5) points.push(t);
  } else {
    points.push(0);
  }
  // 尾部补一窗：RASL 密集的源开头可能全是 IDR，末端更容易命中
  if (duration > WIN + 0.1) points.push(Math.max(0, duration - WIN - 0.1));

  const uniq = [...new Set(points.map((p) => snap(Math.max(0, p))))];
  let sawAny = false;
  for (const at of uniq) {
    const r = await scanWindow(at, WIN);
    if (r === null) {
      // 一个窗都抽不出来（异常封装/损坏）：别自作聪明，按"有 RASL"走保守路径
      if (!sawAny) continue;
      return true;
    }
    sawAny = true;
    if (r === true) return true;
  }
  return sawAny ? false : true;                        // 全部抽不出 → 保守判"有"
}

module.exports = {
  run, parseProgress, probeMedia, probeKeyframes, normalizeProbe, sourceSubtitleCues,
  probeHasRasl,
};
