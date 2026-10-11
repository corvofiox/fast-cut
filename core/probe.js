'use strict';

/**
 * ffprobe / ffmpeg 调用层：唯一允许出现"进程"的地方。
 * 上层（UI）只依赖这里导出的纯数据；替换成内置静态 ffmpeg 时只改 exec 路径。
 */

const { spawn } = require('child_process');
const { snap } = require('./segments');

/** 构造 ffmpeg 参数：把 run({args, ...}) 展开成数组，便于测试注入假执行器。 */
function run(bin, args, { onProgress, signal, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
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

    child.stdout.on('data', (d) => { stdout += d.toString(); });
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
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${bin} 退出码 ${code}\n${tail(stderr)}`));
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

  const duration = snap(Number(fmt.duration ?? video?.duration ?? 0));
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

  // HDR / 10bit 判定（影响精确模式的编码参数）
  const hdr = !!video && (
    (video.color_primaries && video.color_primaries !== 'unknown' && video.color_primaries !== 'bt709') ||
    !!video.tags?.['color_range'] ||
    (video.pix_fmt && /10le|10be|12le|p010/.test(video.pix_fmt))
  );

  return {
    file,
    format: fmt.format_name || null,
    duration,
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
      hasBframes: /p/.test(String(video.has_b_frames ?? '')),
    } : null,
    audioTracks: audios.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      sampleRate: a.sample_rate,
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
 */
async function probeKeyframes(ffprobePath, file) {
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
    const t = snap(Number(raw));
    if (!Number.isFinite(t) || t < 0 || seen.has(t)) continue;   // 坑 2：去重
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => a - b);                           // 坑 3：上层二分依赖升序
  return out;
}

module.exports = { run, parseProgress, probeMedia, probeKeyframes, normalizeProbe };
