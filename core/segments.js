'use strict';

/**
 * 区间运算：纯函数，无副作用。
 * 区间表示：{ start: number, end: number }，单位秒，开区间约定 start <= t < end。
 * 所有函数都对浮点误差做了吸附处理，避免 2.999999 !== 3.0 导致区间判空。
 */

/**
 * 最小有效区间长度：一帧（以 240fps 上界折算 ≈ 4.2 ms）。
 * 用"帧"而不是 EPS 判定：机读浮点误差在毫秒级，但用户误点产生的 1 ms 区间应当被丢弃。
 */
const MIN_LEN = 1 / 240;
const EPS = 1e-6;

/** 把接近整帧/整秒的浮点误差抹平，返回规整后的秒数。 */
function snap(t) {
  if (!Number.isFinite(t)) return 0;
  const r = Math.round(t * 1000) / 1000; // 毫秒精度足够表达帧级
  return Math.abs(r) < EPS ? 0 : r;
}

/** 规整单个区间：交换首尾、裁剪负数、丢弃空区间。 */
function normalizeSegment(seg) {
  let { start, end } = seg;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = snap(Math.max(0, start));
  end = snap(Math.max(0, end));
  if (end < start) [start, end] = [end, start]; // 自动交换首尾
  // 小于一帧（1/240 s ≈ 4.2 ms）视为空区间，避免机读误差导致的零长片段
  if (end - start < MIN_LEN) return null;
  return { start, end };
}

/**
 * 规整区间列表：去空、按起点排序、合并重叠与首尾相接。
 * merged: true 表示该区间与前一区间被合并（UI 可提示用户）。
 * 注意：必须先排序再合并，否则乱序输入会被错误地并进第一段（导出区间全错）。
 */
function normalizeSegments(segs) {
  const valid = [];
  for (const raw of segs) {
    const seg = normalizeSegment(raw);
    if (seg) valid.push(seg);
  }
  // 必须先排序再合并
  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  for (const seg of valid) {
    const prev = out[out.length - 1];
    if (prev && seg.start <= prev.end + EPS) {
      prev.end = Math.max(prev.end, seg.end);
      prev.merged = true;
    } else {
      out.push({ ...seg, merged: false });
    }
  }
  return out;
}

/** 合并两个已排序区间列表，返回保留区间的并集（用于"保留 A"再叠加"保留 B"）。 */
function unionSegments(a, b) {
  return normalizeSegments([...a, ...b]);
}

/** 反相：保留区间 → 被裁剪掉的区间（用于预览时提示"这里会被删掉"）。 */
function invertSegments(segs, total) {
  const norm = normalizeSegments(segs);
  const out = [];
  let cursor = 0;
  for (const seg of norm) {
    if (seg.start - cursor > EPS) out.push({ start: cursor, end: seg.start });
    cursor = Math.max(cursor, seg.end);
  }
  if (total - cursor > EPS) out.push({ start: cursor, end: snap(total) });
  return out;
}

/** 总保留时长（秒）。 */
function totalDuration(segs) {
  return snap(normalizeSegments(segs).reduce((acc, s) => acc + (s.end - s.start), 0));
}

module.exports = {
  EPS,
  MIN_LEN,
  snap,
  normalizeSegment,
  normalizeSegments,
  unionSegments,
  invertSegments,
  totalDuration,
};
