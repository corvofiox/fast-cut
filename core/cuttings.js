'use strict';

/**
 * 从"保留区间"推导实际执行的切割计划。
 *
 * 契约：**剪辑位置是硬性要求，入点绝不吸附关键帧。**
 * 流拷贝没法从非关键帧起步（实测 `-ss 3.4` 会晚到 4.0 才起步，用户删掉的开头被带回来，
 * 关键帧比剪辑粒度粗时甚至会把整段间隙吞回产物），所以入点那一小段重编码、其余仍流拷贝。
 * 代价是接缝处有损、要多编一小段——这是明说的取舍，不再提供"吸附"这条路。
 *
 * 切割计划项：
 * {
 *   kind: 'copy' | 'reencode',
 *   role: 'whole' | 'head' | 'tail',   // 整条区间 / 入点小段 / 入点之后的拷贝段
 *   start: number,      // 源上的入点；copy 段的 start 必定是关键帧
 *   duration: number,   // 秒，已折算成整数帧
 *   snapFrom: number,   // 用户原始入点（现在与 start 恒等，留字段给 UI 沿用）
 *   keepEnd: number,    // 用户原始选择的区间终点
 *   keepIndex: number,
 *   codecChange?: boolean,  // 这次重编码把编码换了（源编码没有同编码重编码器）
 *   note?: string
 * }
 *
 * 语义（已用 ffmpeg N-113109 实测确认，见 docs/02-技术方案.md §3）：
 *  - 入点：就是要哪一秒，从哪一秒起。落在关键帧上→整段流拷贝；落在 GOP 中间→
 *    [入点, 之后第一个够长的关键帧) 重编码，剩下的流拷贝。
 *  - 出点：只需要时长。重编码段与拷贝段都按整帧取长，且**绝不越过用户出点**
 *    （越界等于把已删的素材带回来）。
 *  - 帧数取自源的平均帧率：VFR 源也只能按它折算，实测按时间 `-t` 限长根本收不住。
 */

const { snap, EPS } = require('./segments');

/** 判"某个时刻是不是关键帧"的容差：关键帧时间戳来自源自身，误差只有毫秒级。 */
const KEY_TOL = 0.0005;

/**
 * @param {Array<{start:number,end:number}>} keeps 已规整的保留区间
 * @param {{keyframes:number[], duration:number, fps?:number, ordered?:boolean, sameCodec?:boolean}} opts
 *        ordered=true 表示 keeps 的顺序就是导出顺序（用户拖动改过），此时不做相邻合并；
 *        sameCodec=false 表示重编码出来的不是源那个编码，绝不与流拷贝段混拼
 * @returns {{plan:Array, warnings:string[]}}
 */
function buildPlan(keeps, opts) {
  const { keyframes = [], duration, fps, ordered = false, sameCodec = true, gridOrigin = 0, reorderDepth = 0, forceReencode = false } = opts;
  const fpsNum = Number(fps) > 0 ? Number(fps) : null;
  const bdepth = Math.max(0, Number(reorderDepth) || 0);
  // 帧网格原点：源首帧 pts 不一定落在 0（实测 HEVC 的 .mp4/.mkv 首帧 pts = 0.023，
  // 编码器 DTS/PTS 延迟），关键帧都在 origin + N/fps 的格子上，原点弄错每个接缝就差半帧。
  const origin = Number(gridOrigin) > 0 ? Number(gridOrigin) : 0;
  // 入点重编码段至少两帧：实测切出 1 帧的窄段会配上十几个音频包，进 concat 后偏移炸掉
  // （.ts 相机素材的关键帧落在 0.023/2.023/8.023 这种非整帧刻度上，正好踩过）。
  const minHead = fpsNum ? 2 / fpsNum : 1 / 15;
  const warnings = [];
  const plan = [];
  let warnedVfr = false;
  let warnedSubs = false;

  /**
   * [from, to) 之间有多少帧 = 会被导出的帧数。
   * 两头都按"第 N 帧的时刻 = N/fps"算，规则只有一条：**帧必须严格早于 to**。
   * 四舍五入有一半概率把 to 那一帧也算进来，接缝上就把同一帧导出两遍（head 的 to 是
   * 拷贝段起点=关键帧，尾巴的 to 是用户出点，越过去等于把已删的素材带回来）。
   */
  const span = (from, to) => {
    if (!fpsNum) return snap(to - from);
    const idx = (t) => Math.ceil((t - origin) * fpsNum - 1e-9);
    // 不抹毫秒：37/30 被 snap 成 1.233 就不是整帧时刻了，concat 推偏移会落半格
    return Math.max(0, idx(to) - idx(from)) / fpsNum;
  };

  /**
   * 拷贝段：流拷贝只能按**解码序**数包，含双向预测的源到出点会漏掉窗口末尾几帧
   * （实测 h264 双向预测源要 45 帧只给出 {0..43,47}：44 丢了，47 是用户删掉的素材）。
   * 所以帧数按重排深度减几帧，**时长仍按用户的窗口算**——拼接占位不变、总时长精确等于
   * 选区，少掉的那几帧在画面上表现为末端多停一下，绝不把已删的素材带回来。
   * 区间接到源尾时不用减（后面本来没有帧）。
   * @returns {{duration:number, frames:(number|null), trimmed:number}}
   */
  const atEnd = (to) => Number.isFinite(duration) && to >= duration - EPS;
  const copyPart = (from, to) => {
    const window = span(from, to);
    if (!fpsNum || !bdepth || atEnd(to)) return { duration: window, frames: null, trimmed: 0 };
    const frames = Math.round(window * fpsNum) - bdepth;
    return frames > 0
      ? { duration: window, frames, trimmed: bdepth }
      : { duration: 0, frames: null, trimmed: 0 };
  };

  for (let ki = 0; ki < keeps.length; ki++) {
    const keep = keeps[ki];
    const start = snap(keep.start);
    const end = Math.min(snap(keep.end), Number.isFinite(duration) ? duration : keep.end);
    if (end - start <= EPS) {
      warnings.push(`区间 ${keep.start.toFixed(3)}s–${keep.end.toFixed(3)}s 超出源尾，已忽略`);
      continue;
    }
    const wholeDur = span(start, end);
    if (wholeDur <= EPS) {
      warnings.push(`区间 ${start.toFixed(3)}s–${end.toFixed(3)}s 不足一帧，已忽略`);
      continue;
    }

    /**
     * 可变帧率源：帧长本身就不均匀，"按帧数切"出来的时长和音频对不上
     * （实测 VFR 源每条区间视频比音频短 0.3~0.5s，自检判音画不一致）。
     * 只能整段重编码成定帧率输出，用有损换"时长与剪辑位置说得准"。
     */
    if (forceReencode) {
      if (!warnedVfr) {
        warnedVfr = true;
        warnings.push('源是可变帧率（VFR）：帧长不均匀，流拷贝按帧数切会对不准时长——这段改为整段重编码（有损，输出为定帧率）');
      }
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: '源是可变帧率：按帧数切不准，整段重编码为定帧率（有损）',
      });
      continue;
    }

    // 入点正好是关键帧：不需要重编码，整段流拷贝就是帧级精确的。
    if (hasKeyframeAt(start, keyframes)) {
      const part = copyPart(start, end);
      if (part.duration > EPS) {
        plan.push({
          kind: 'copy', role: 'whole', start, duration: part.duration, frames: part.frames,
          snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, trimmed: part.trimmed,
          note: '入点正好落在关键帧上：整段流拷贝',
        });
      } else {
        plan.push({
          kind: 'reencode', role: 'whole', start, duration: wholeDur,
          snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
          note: '区间比双向预测的重排窗口还短，流拷贝切不干净：整段重编码（有损）',
        });
      }
      continue;
    }

    if (keyframes.length === 0) {
      warnings.push(`没有关键帧索引：区间 ${start.toFixed(3)}s–${end.toFixed(3)}s 整段重编码以保证剪辑精确`);
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: '没有关键帧索引：整段重编码（有损）',
      });
      continue;
    }

    // 没有对应的同编码重编码器时，重编码段与拷贝段混拼会把帧率/时长全弄乱
    // （实测 mpeg2 .ts：5.9s 选区拼出 35.8s、avg_frame_rate 60/1）。整段重编码，编码改变。
    if (!sameCodec) {
      warnings.push(
        `入点 ${start.toFixed(3)}s 不在关键帧上，而源编码没有同编码的重编码器：`
        + `这一段整段重编码，导出编码会与源不同（有损，且不流拷贝）`,
      );
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, codecChange: true,
        note: '入点不在关键帧上，源编码没有同编码重编码器：整段重编码（编码改变，不混拼）',
      });
      continue;
    }

    // 局部精确：[入点, 之后第一个关键帧) 重编码，其余流拷贝。
    // 关键帧必须离入点至少 minHead，否则宁可往后多取一个关键帧，也不切窄段、
    // 也绝不为了少编两帧而从关键帧起拷贝（那等于偷偷把剪辑位置挪走）。
    const kfHead = firstKeyframeAtLeast(start + minHead, keyframes);
    if (kfHead === null || kfHead >= end - EPS) {
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: '入点不在关键帧上，这一段落在一个 GOP 内（后面没有可接续的关键帧）：整段重编码（有损）',
      });
      continue;
    }

    const head = span(start, kfHead);
    const tailRaw = span(kfHead, end);
    const tailPart = copyPart(kfHead, end);
    if (tailPart.duration <= EPS) {
      // 拷贝段被重排余量吃光（或关键帧已贴到出点）：整段重编码，宁可多编也不要切错
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: tailRaw > EPS
          ? `可接续的关键帧之后只剩 ${Math.round(tailRaw * (fpsNum || 1))} 帧，减去双向预测的重排余量就没了：整段重编码（有损）`
          : '入点不在关键帧上，可接续的关键帧已贴到出点：整段重编码（有损）',
      });
      continue;
    }

    plan.push({
      kind: 'reencode', role: 'head', start, duration: head,
      snapFrom: keep.start, keepEnd: keep.end, note: '入点小段重编码（帧级精确）',
    });
    plan.push({
      kind: 'copy', role: 'tail', start: kfHead, duration: tailPart.duration, frames: tailPart.frames,
      snapFrom: keep.start, keepEnd: keep.end, actualEnd: keep.end, trimmed: tailPart.trimmed,
      note: `入点重编码 ${head.toFixed(3)}s，其余流拷贝`,
    });
    // 上面两段属于同一条保留区间，统一打标，上层按 keepIndex 分组才能"每条区间一个文件"
    plan[plan.length - 2].keepIndex = ki;
    plan[plan.length - 1].keepIndex = ki;
  }

  const trimmedN = plan.reduce((a, p) => Math.max(a, p.trimmed || 0), 0);
  if (trimmedN > 0) {
    warnings.push(
      `源含双向预测帧（B 帧，重排 ${trimmedN} 帧）：流拷贝只能按解码序收尾，`
      + `每个裁剪末端会少导 ${trimmedN} 帧（约 ${(trimmedN / (fpsNum || 30) * 1000).toFixed(0)}ms）——`
      + '宁可短也不把你已经删掉的素材带回来；要末端也一帧不差，把出点挪到关键帧上（那一段就整段流拷贝了）',
    );
  }

  // 乱序（用户拖动改过顺序）时必须跳过 dedupePlan：它按"时间递增"假设合并相邻段，
  // 遇到 [5-10, 0-5] 这种会把后一段整个吞掉，导出就少了一半内容。
  return { plan: ordered ? plan.filter((p) => p.duration > EPS) : dedupePlan(plan), warnings };
}

/** t 处正好是关键帧吗？ */
function hasKeyframeAt(t, keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return false;
  for (const k of keyframes) {
    if (Math.abs(k - t) <= KEY_TOL) return true;
    if (k > t + KEY_TOL) break; // keyframes 已升序
  }
  return false;
}

/** ≥ t 的第一个关键帧（keyframes 已升序；没有则 null）。 */
function firstKeyframeAtLeast(t, keyframes) {
  for (const k of keyframes) {
    if (k >= t - KEY_TOL) return k;
  }
  return null;
}

/**
 * 把相邻的同类段合并，避免生成零长或重复片段。
 * 相邻 = 前段结束时刻 ≥ 后段开始（允许重叠，不允许留下空洞）。
 *
 * 两条铁律：
 *  - **拷贝段的起点钉在关键帧上，挪不得**：一旦把它的 start 往后推（哪怕只推一帧），
 *    ffmpeg 流拷贝会直接跳到下一个关键帧，中间整段 GOP 全空（实测少几十秒内容，
 *    而总时长被 `-t` 补回来，自检照样看不出来）。所以重叠时改截前一段。
 *  - 重编码段起点随便挪（它能从任意时刻起），所以后段是重编码时仍按老办法对齐到前段末尾。
 */
function dedupePlan(plan) {
  const out = [];
  for (const raw of plan) {
    let prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...raw });
      continue;
    }
    const prevEnd = prev.start + prev.duration;
    const itemEnd = raw.start + raw.duration;

    if (prev.kind === raw.kind && raw.start <= prevEnd + EPS) {
      // 同类型：吸收后段新增的部分（可能重叠，不重复计算时长）
      prev.duration = Math.max(prev.duration, itemEnd - prev.start);
      prev.keepEnd = Math.max(prev.keepEnd, raw.keepEnd);
      prev.frames = null;   // 时长变了，原来算好的包数不再成立（由 buildArgs 按时长重算）
      prev.trimmed = 0;
      continue;
    }

    if (raw.start < prevEnd - EPS && raw.kind === 'copy' && raw.start > prev.start + EPS) {
      // 后段是拷贝段：把它起点保住，反过来把前一段截断到关键帧处
      prev.duration = snap(raw.start - prev.start);
      prev.frames = null;
      prev.trimmed = 0;
      if (prev.duration <= EPS) out.pop();
      prev = out[out.length - 1];
      if (!prev) {
        out.push({ ...raw });
        continue;
      }
      out.push({ ...raw });
      continue;
    }

    if (raw.start < prevEnd - EPS) {
      // 不同类型且重叠：后段起点对齐到前段结束时刻
      const newStart = Math.min(prevEnd, itemEnd);
      if (itemEnd - newStart <= EPS) continue; // 整段被前段覆盖，丢弃
      out.push({ ...raw, start: newStart, duration: itemEnd - newStart });
      continue;
    }

    out.push({ ...raw });
  }
  return out.filter((p) => p.duration > EPS);
}

module.exports = { buildPlan };
