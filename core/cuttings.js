'use strict';

/**
 * 从"保留区间"推导实际执行的切割计划。
 *
 * 切割计划项：
 * {
 *   kind: 'copy' | 'reencode',
 *   start: number,      // 源上的入点（秒）
 *   duration: number,   // 时长（秒）→ 传给 ffmpeg -t
 *   snapFrom: number,   // 用户原始选择的区间起点（UI 提示"少掉多少"用）
 *   keepEnd: number,    // 用户原始选择的区间终点
 *   note?: string
 * }
 *
 * 语义（已用 ffmpeg N-113109 实测确认，见 docs/02-技术方案.md §3）：
 *  - 入点：前移到 ≤ start 的最后一个关键帧。非关键帧入点交给 ffmpeg 只会**更晚**开始
 *    （实测 -ss 3.4 → 实际从 4.0 起），所以必须自己吸附，否则用户想删的开头会被带出去。
 *  - 出点：只需要时长。帧会被"多带一帧"，时长可精确指定，无需吸附到关键帧。
 *  - 精确模式：只把 [start, 下一个关键帧) 这一小段重编码，其余流拷贝再拼接。
 */

const { snap, EPS } = require('./segments');

/**
 * @param {Array<{start:number,end:number}>} keeps 已规整的保留区间
 * @param {{keyframes:number[], precise:boolean, duration:number, ordered?:boolean}} opts
 *        ordered=true 表示 keeps 的顺序就是导出顺序（用户拖动改过），此时不做相邻合并
 * @returns {{plan:Array, warnings:string[]}}
 */
function buildPlan(keeps, opts) {
  const { keyframes = [], precise = false, duration, fps, ordered = false, sameCodec = true } = opts;
  const fpsNum = Number(fps) > 0 ? Number(fps) : null;
  // 帧长一律按"第 N 帧 = N/fps 秒"推导：1/30 = 0.0333… 用定点小数会引入误差，
  // 产生 .310 / .014 这类看着像整帧其实不是的时刻，concat 时仍会落半格。
  const roundToFrames = (sec) => (fpsNum ? snap(Math.round(sec * fpsNum) / fpsNum) : snap(sec));
  const warnings = [];
  const plan = [];

  for (let ki = 0; ki < keeps.length; ki++) {
    const keep = keeps[ki];
    const kfStart = lastKeyframeAtMost(keep.start, keyframes);   // ≤ start
    let start;
    if (kfStart === null) {
      // 第一个关键帧晚于入点：只能从 0 开始，这不是"吸附偏差"，是唯一可行解
      start = 0;
      warnings.push(`区间起点 ${keep.start.toFixed(3)}s 之前没有关键帧，已从 0 开始（会多出 ${keep.start.toFixed(3)}s 内容）`);
    } else {
      start = kfStart;
    }
    const end = Math.min(keep.end, Number.isFinite(duration) ? duration : keep.end);
    if (end - start <= EPS) {
      warnings.push(`区间 ${keep.start.toFixed(3)}s–${keep.end.toFixed(3)}s 与关键帧对齐后为空，已忽略`);
      continue;
    }

    // 吸附只会让起点前移，终点必须仍是用户选的 keep.end。
    // 时长 = keep.end - start（不是 keep.end - keep.start），否则会把用户已经删掉的开头又导出去。
    // 取整到整帧：非整帧时长会让 concat 的 PTS 落半格，被就近取整后出现 1 帧回跳。
    const durationSec = roundToFrames(end - start);

    const headNote = start === 0 && kfStart === null
      ? '入点之前没有关键帧，从 0 开始'
      : (start < keep.start - EPS
        ? `入点已前移至关键帧 ${start.toFixed(3)}s（多 ${(keep.start - start).toFixed(3)}s 内容）`
        : '入点正好落在关键帧上');

    /**
     * 吸附回溯跨过上一条保留段的出点 = 把用户删掉的间隙吞回导出；两段还会被 dedupe 并成一段，
     * 剪辑等于没做（实测 98 分钟 .mkv，关键帧间隔 ~10.4s：删掉 1.9s，产物却是整部片，
     * 而自检因为"允许多出 5%"照样判通过）。流拷贝没法从非关键帧起，所以这种保留段
     * 就地改成"局部精确"：入点那一小段重编码，其余仍然拷贝 —— 用户剪掉的就是剪掉了。
     *
     * 但只在"重编码不换编码"时才自动做：源是 mpeg4/mjpeg 这类没有同编码重编码器时，
     * 自动精确会把 h264 段混进拷贝段，拼出来是坏文件（矩阵实测：产物解码报错 +
     * "源 mpeg4 → 导出 h264"）。那种情况宁可照旧吸附，并把带回多少秒说清楚。
     */
    const prevEnd = ki > 0 ? keeps[ki - 1].end : null;
    const crosses = start < keep.start - EPS && prevEnd != null && start < prevEnd - EPS;
    const swallowsGap = crosses && sameCodec;
    if (crosses && !sameCodec) {
      warnings.push(
        `关键帧间隔比剪辑粒度粗：入点回溯到 ${start.toFixed(3)}s 会带回已删的 ${(prevEnd - start).toFixed(3)}s；`
        + '源编码没有同编码重编码器，不能自动局部精确（会把两种编码混拼）—— 勾「精确模式」整段重编码可避免',
      );
    } else if (swallowsGap) {
      warnings.push(
        `关键帧间隔比剪辑粒度粗（入点要回溯到 ${start.toFixed(3)}s，会吃掉已删的 ${(prevEnd - start).toFixed(3)}s）：这一段已自动局部精确（入点一小段重编码，其余仍流拷贝）`,
      );
    }

    if ((!precise && !swallowsGap) || start >= keep.start - EPS) {
      plan.push({ kind: 'copy', start, duration: durationSec, snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, note: headNote });
      continue;
    }

    const before = plan.length;
    // 窄段下限：两帧。fps 报不出来时按 1/15s（≈ 常见帧率的两帧）兜底
    pushPrecise(plan, keep, start, end, keyframes, headNote, warnings, roundToFrames, sameCodec,
      fpsNum ? 2 / fpsNum : 1 / 15);
    // 精确模式会往一条保留区间里塞两段（重编码 + 流拷贝），统一标记归属，
    // 上层按 keepIndex 分组才能做到"每条保留区间一个文件"。
    for (let n = before; n < plan.length; n++) {
      plan[n].keepIndex = ki;
      if (swallowsGap && !precise) {
        plan[n].autoPrecise = true;
        plan[n].note = `关键帧比剪辑粒度粗，自动局部精确 · ${plan[n].note}`;
      }
    }
  }

  // 乱序（用户拖动改过顺序）时必须跳过 dedupePlan：它按"时间递增"假设合并相邻段，
  // 遇到 [5-10, 0-5] 这种会把后一段整个吞掉，导出就少了一半内容。
  return { plan: ordered ? plan.filter((p) => p.duration > EPS) : dedupePlan(plan), warnings };
}

/**
 * 精确模式：入点小段重编码，其余流拷贝。
 * @param {(sec:number)=>number} roundToFrames 帧取整函数（由 buildPlan 注入，含 fps）
 * @param {boolean} sameCodec 重编码出来还是源那个编码吗？false 时绝不混拼
 * @param {number} minHead 入点到下一个关键帧不足这个秒数时不切窄段（由 fps 折算，默认 2 帧）
 */
function pushPrecise(plan, keep, start, end, keyframes, headNote, warnings, roundToFrames, sameCodec = true, minHead = 0) {
  const kfAfter = nextKeyAfter(keep.start, keyframes);

  // 换编码的重编码段和流拷贝段拼在一起，产物帧率/时长全乱
  // （实测 mpeg2 .ts 精确模式：5.9s 选区拼出 35.8s、avg_frame_rate 60/1）。
  // 这时整条区间都重编码：编码变了但至少是一个干净、帧准的单编码文件。
  if (!sameCodec) {
    plan.push({
      kind: 'reencode', start: keep.start, duration: roundToFrames(keep.end - keep.start),
      snapFrom: keep.start, keepEnd: keep.end, note: '精确模式：源编码没有对应的同编码重编码器，整段重编码（不混拼）',
    });
    return;
  }

  /**
   * 入点离下一个关键帧不到 minHead 时，不要切"1 帧重编码 + 其余拷贝"：
   * 实测 .ts 相机素材的关键帧落在 0.023/2.023/8.023 这种非整帧刻度上，选 8.000s 入点
   * 就切出一个 0.033s 的窄段——13 个音频包配 1 帧画面，进 concat 后偏移炸掉，
   * 5.9s 选区拼出 39s 的产物。这时直接从那个关键帧流拷贝，误差本来就不满 2 帧。
   */
  if (kfAfter !== null && kfAfter - keep.start < minHead) {
    const lost = roundToFrames(kfAfter - keep.start);
    plan.push({
      kind: 'copy', start: kfAfter, duration: roundToFrames(end - kfAfter),
      snapFrom: keep.start, keepEnd: keep.end,
      note: `精确模式：入点距关键帧不足 ${Math.round(minHead * 1000)}ms，直接从关键帧 ${kfAfter.toFixed(3)}s 流拷贝（少 ${lost.toFixed(3)}s 内容，切不出这么窄的重编码段）`,
    });
    warnings.push(`精确模式：入点 ${keep.start.toFixed(3)}s 距下一个关键帧只有 ${lost.toFixed(3)}s，不足 ${Math.round(minHead * 1000)}ms，已改从关键帧起流拷贝，这 ${lost.toFixed(3)}s 内容没有导出`);
    return;
  }

  // 没有更晚的关键帧，或重编码段会吞掉整个区间：整段重编码以换取帧级入点
  if (kfAfter === null || kfAfter >= end - EPS) {
    plan.push({
      kind: 'reencode', start: keep.start, duration: roundToFrames(keep.end - keep.start),
      snapFrom: keep.start, keepEnd: keep.end, note: '精确模式：区间落在一个 GOP 内，整段有损重编码',
    });
    return;
  }

  // 重编码段时长取整到整帧：否则 concat 时后段首帧 PTS 落在两帧之间，
  // 被 -video_track_timescale 就近取整后会出现 1 帧 PTS 回跳（实测 2.500→2.467）。
  plan.push({
    kind: 'reencode', start: keep.start, duration: roundToFrames(kfAfter - keep.start),
    snapFrom: keep.start, keepEnd: keep.end, note: '精确模式：入点小段有损重编码',
  });

  // 精确模式下，[keep.end, 下一个关键帧) 这一段既不属于重编码段也不可被流拷贝，
  // 只能丢弃。用 keepEnd 标记真实终点，让 UI/自检知道产物比用户选区短。
  const nextKfEnd = nextKeyAfter(keep.end, keyframes);
  if (nextKfEnd !== null && nextKfEnd > keep.end + EPS) {
    warnings.push(
      `精确模式：出点 ${keep.end.toFixed(3)}s 到下一个关键帧 ${nextKfEnd.toFixed(3)}s 之间的内容无法保留（半个 GOP 既不能拷贝也不值得编码），已丢弃`,
    );
  }

  plan.push({
    kind: 'copy', start: kfAfter, duration: roundToFrames(end - kfAfter),
    snapFrom: keep.start, keepEnd: keep.end, note: `精确模式：其余部分流拷贝；${headNote}`,
    actualEnd: keep.end,
  });
}

/** ≤ t 的最后一个关键帧。 */
function lastKeyframeAtMost(t, keyframes) {
  let best = null;
  for (const k of keyframes) {
    if (k <= t + EPS) best = k;
    else break; // keyframes 已升序
  }
  return best;
}

function nextKeyAfter(t, keyframes) {
  for (const k of keyframes) {
    if (k > t + EPS) return k;
  }
  return null;
}

/**
 * 把相邻的同类段合并，避免生成零长或重复片段。
 * 相邻 = 前段结束时刻 ≥ 后段开始（允许重叠，不允许留下空洞）。
 * 同类型合并；不同类型在时间上重叠时，把后段起点对齐到前段结束时刻，
 * 保证拼接点严格重合，既不空洞也不把同一段内容导出两遍。
 */
function dedupePlan(plan) {
  const out = [];
  for (const raw of plan) {
    const prev = out[out.length - 1];
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
