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

/** 规整单个区间：交换首尾、裁剪负数、丢弃空区间。`group` 原样带过去（导出分组用）。 */
function normalizeSegment(seg) {
  let { start, end } = seg;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = snap(Math.max(0, start));
  end = snap(Math.max(0, end));
  if (end < start) [start, end] = [end, start]; // 自动交换首尾
  // 小于一帧（1/240 s ≈ 4.2 ms）视为空区间，避免机读误差导致的零长片段
  if (end - start < MIN_LEN) return null;
  const out = { start, end };
  if (seg && seg.group !== undefined && seg.group !== null) out.group = seg.group;
  return out;
}

/**
 * 规整区间列表：去空、按起点排序、合并重叠与首尾相接。
 * merged: true 表示该区间与前一区间被合并（UI 可提示用户）。
 * 注意：必须先排序再合并，否则乱序输入会被错误地并进第一段（导出区间全错）。
 *
 * `keepAdjacent`（2026-10-18 新增，默认 false = 保持旧行为）：
 * 为 true 时**首尾严格相接的区间不再合并**，只有真正交叠的才并。
 * 「每段一个文件」必须走这条路：用户在播放头处连切两刀（还没删任何东西）时，
 * 保留区间就是 [0,3] [3,6] [6,9] 这种相邻形状；一旦并成 [0,9]，
 * 分组只剩一组，产物就是"一段包含所有片段的完整视频"——正是用户报的失效。
 * 相邻合并与否不影响总时长，所以 totalDuration 的语义两边一致。
 *
 * **不同分组（`group`）的区间永不合并**（与 keepAdjacent 无关）：
 * 合并只保留前一段的 group，后一段的归属会被静默抹掉——用户先分好组、
 * 再切到"每段一个文件"时，那几段的合并关系就串了（实测组1 把无关的段3 也吞进去）。
 * 分组是用户的显式意图，规整阶段不许改写它。
 */
function normalizeSegments(segs, opts = {}) {
  const keepAdjacent = !!opts.keepAdjacent;
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
    /**
     * 合并判据分两档（2026-10-18）：
     *  - **显式分组**的相邻区间照旧合并：用户已经把这几段并成"一个文件"了，
     *    在源上首尾相接就该合成一段（少切一刀、少一次 concat 接缝）。
     *  - 没有分组时看 keepAdjacent：split 模式要保住"相邻即两段"的分组边界，
     *    拼接模式仍按老行为合并。
     * 不同分组之间**永不合并**（分组是用户意图，规整不许改写）。
     */
    const prevG = prev ? prev.group : null;
    const segG = seg.group == null ? null : seg.group;
    const sameGroup = !prev || (prevG == null && segG == null) || prevG === segG;
    const explicitGroup = prevG != null && segG != null && prevG === segG;
    const joinable = explicitGroup || keepAdjacent === false;
    const touch = prev && (joinable ? seg.start <= prev.end + EPS : seg.start < prev.end - EPS);
    if (touch && sameGroup) {
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
