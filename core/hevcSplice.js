'use strict';

/**
 * HEVC 拼接点修补：把切点上的 CRA 改写成 BLA。
 *
 * ## 为什么需要
 *
 * 开放 GOP 的 HEVC，切点上的随机接入点通常是 **CRA**（Clean Random Access，NAL 21）。
 * CRA 后面紧跟的 RASL 画面（NAL 8/9）在**显示顺序上早于**这个 CRA，它们参考的是
 * 上一个 GOP 的画面。整段流拷贝切出来时，那批参考画面不在产物里了：
 *
 *   - 单独播这一段：解封装/封装层把负时间戳的 RASL 标成"丢弃"，解码器不看它们 → 没事；
 *   - 拼起来：concat 重新计时，丢弃标记丢了 → 解码器真去解 RASL → 找不到参考帧
 *     （实测 ffmpeg 9.0.2 报 `Could not find ref with POC 116`，`-xerror` 直接失败）。
 *
 * ## 为什么不是"剔掉 RASL"
 *
 * `filter_units=remove_types=8|9` 是**按 NAL 类型整段生效**的：它会把段内每个关键帧
 * 后面的 RASL 一起删掉，而那些是**真画面**（显示时刻落在本段内），等于每过一个 GOP
 * 丢两三帧。这个坑 2026-10-17 踩过并回滚过（见 buildArgs 顶部注释）。
 *
 * ## 正解
 *
 * HEVC 规范给"拼接导致前导画面断链"准备的正规做法，是把切点上的 **CRA(21) 改写成
 * **BLA_W_LP(16)**：BLA 语义就是"随机接入点，但前导画面是断的"，解码器据此置
 * NoRaslOutputFlag、按规范丢弃 RASL——**帧一个不少、时间戳一个不动**，只是让码流
 * 自己说清楚"这里接不上"。ffmpeg 没有做这件事的 bsf，所以这里直接改 NAL 头。
 *
 * NAL 头是 2 字节：`forbidden_zero(1) | nal_unit_type(6) | nuh_layer_id(6) | tid+1(3)`，
 * 所以 type = (byte0 >> 1) & 0x3f，改写只动 byte0 的中间 6 位，layer_id / tid 原样保留。
 */

const fs = require('fs');

const CRA_NUT = 21;
const BLA_W_LP = 16;

/** 从 2 字节 NAL 头里取 nal_unit_type。 */
function nalType(b0) {
  return (b0 >> 1) & 0x3f;
}

/**
 * 就地改一个 NAL 的类型。只动 byte0 的类型位，其余位保留。
 * @returns {number} 改写后的类型（没动就是原类型）
 */
function rewriteNalType(buf, at, newType) {
  const before = nalType(buf[at]);
  buf[at] = (buf[at] & 0x81) | ((newType & 0x3f) << 1);
  return before;
}

/**
 * 在一个 MP4 视频包（4 字节长度前缀 + 若干个 NAL）里找 CRA 并改成 BLA。
 *
 * 包内可能先有 AUD / SEI / 参数集，所以必须逐个 NAL 走，不能只看第一个。
 * 只改**第一个** CRA，其余不动（后续 NAL 是同一访问单元的片子，不该动）。
 *
 * @param {Buffer} buf      整个文件（或包）的字节
 * @param {number} pos      包在文件里的偏移
 * @param {number} size     包的字节数
 * @returns {{changed:boolean, from?:number, at?:number, reason?:string}}
 */
function patchPacket(buf, pos, size) {
  if (!Number.isFinite(pos) || !Number.isFinite(size) || pos < 0 || size < 6) {
    return { changed: false, reason: '包位置/长度不可用' };
  }
  if (pos + size > buf.length) return { changed: false, reason: '包越界' };
  let at = pos;
  const end = pos + size;
  while (at + 6 <= end) {
    const len = buf.readUInt32BE(at);
    if (len < 2 || at + 4 + len > end) return { changed: false, reason: `NAL 长度异常（${len}）` };
    const t = nalType(buf[at + 4]);
    if (t === CRA_NUT) {
      rewriteNalType(buf, at + 4, BLA_W_LP);
      return { changed: true, from: CRA_NUT, at: at + 4 };
    }
    // 已经是 BLA/IDR 起头：这段本来就是干净的，不用改
    if (t === BLA_W_LP || t === 19 || t === 20) return { changed: false, reason: `已是接入点类型 ${t}` };
    at += 4 + len;
  }
  return { changed: false, reason: '包内没有 CRA' };
}

/**
 * 对切好的一个拷贝段做"接缝修补"：把首个视频包里的 CRA 改成 BLA。
 *
 * @param {string} file      段文件（MP4）
 * @param {{pos:number,size:number}} packet  首个视频包的位置与长度（由调用方用 ffprobe 取）
 * @returns {{changed:boolean, reason?:string}}
 */
function patchSegmentFirstKeyframe(file, packet) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    const need = 4 + (packet.size || 0);
    const buf = Buffer.alloc(Math.max(need, 64));
    fs.readSync(fd, buf, 0, buf.length, packet.pos);
    const r = patchPacket(buf, 0, packet.size);
    if (r.changed) fs.writeSync(fd, buf, 0, buf.length, packet.pos);
    return r;
  } catch (e) {
    return { changed: false, reason: String(e.message || e).slice(0, 80) };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
  }
}

module.exports = { patchPacket, patchSegmentFirstKeyframe, rewriteNalType, nalType, CRA_NUT, BLA_W_LP };
