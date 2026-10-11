'use strict';

/**
 * 容器封装能力表 —— remux（只换封装、不重编码）的判据集中在这里。
 *
 * 结论都是拿随包 ffmpeg 实测出来的，不是照抄"mp4 装不下大文件"的老话：
 *  - 5.76 GiB 的 mp4 一次流拷贝写成：`mdat` 自动改用 64 位 largesize，块偏移表自动从
 *    `stco` 升到 `co64`，越 over 4 GB 处寻址正常，全片解封装零报错 —— 所以 mp4 没有 4 GB 上限，
 *    那个数字是 FAT32 的单文件上限，换成 mkv 一样撞墙。
 *  - 真正会失败的是字幕：`-c copy` 把 subrip 塞进 mp4 直接
 *    "Could not find tag for codec subrip … not currently supported in container"。
 *  - `-display_rotation` 是 mov muxer 的私有选项，写给 mkv 会当非法输出选项报错，必须按家族分支。
 *  - pcm 音轨进 mp4 实测可以（新版写 ipcm/sowt），所以音频不设限。
 */

const EXPORT_CONTAINERS = [
  { id: 'mp4', ext: '.mp4', label: 'MP4', family: 'mov' },
  { id: 'm4v', ext: '.m4v', label: 'M4V', family: 'mov' },
  { id: 'mov', ext: '.mov', label: 'MOV', family: 'mov' },
  { id: 'mkv', ext: '.mkv', label: 'MKV', family: 'matroska' },
];

/** ffprobe 的 format_name 是逗号串（mp4 报 "mov,mp4,m4a,3gp,3g2,mj2"），所以按家族比对。 */
const FAMILY_FORMATS = {
  mov: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  matroska: ['matroska', 'webm'],
};

/** mov/mp4 能用 `-c copy` 原样装下的字幕编码。其余一律显式省略，不偷偷转码。 */
const MOV_SUBTITLE_CODECS = new Set([
  'mov_text', 'dvb_teletext', 'eia_608', 'eia_708', 'ttml', 'webvtt',
]);

function byId(id) {
  return EXPORT_CONTAINERS.find((c) => c.id === String(id || '').toLowerCase()) || null;
}

function byExt(ext) {
  const want = String(ext || '').toLowerCase();
  return EXPORT_CONTAINERS.find((c) => c.ext === (want.startsWith('.') ? want : `.${want}`)) || null;
}

function familyOfExt(ext) {
  const c = byExt(ext);
  return c ? c.family : null;
}

/** 把 ffprobe 的 format_name 串归到家族；认不出就 null（例如 avi/webm/ts 作为源时）。 */
function familyOfFormat(formatName) {
  const names = String(formatName || '').split(',').map((s) => s.trim());
  for (const [family, list] of Object.entries(FAMILY_FORMATS)) {
    if (names.some((n) => list.includes(n))) return family;
  }
  return null;
}

/**
 * 目标容器装不下的字幕编码。
 * 返回空数组表示"字幕全留"；非空表示导出时必须把字幕轨整条排除掉。
 */
function unmuxableSubtitles(family, codecs) {
  if (family !== 'mov') return [];
  return (codecs || []).filter((c) => !MOV_SUBTITLE_CODECS.has(c));
}

module.exports = {
  EXPORT_CONTAINERS,
  FAMILY_FORMATS,
  MOV_SUBTITLE_CODECS,
  byId,
  byExt,
  familyOfExt,
  familyOfFormat,
  unmuxableSubtitles,
};
