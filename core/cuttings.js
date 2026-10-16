'use strict';

/**
 * 从"保留区间"推导实际执行的切割计划。
 *
 * 两种切割模式（`opts.precise`）：
 *  - **吸附模式（precise=false，应用层默认）**：入点前移到 ≤ 它的最后一个关键帧，整段流拷贝，
 *    零重编码、零画质损失、最快。代价是切点最多前移一个 GOP，会多带开头一点素材（UI 明说）。
 *  - **精确模式（precise=true，本模块缺省）**：剪辑位置是硬性要求，入点绝不吸附关键帧。
 *    流拷贝没法从非关键帧起步（实测 `-ss 3.4` 会晚到 4.0 才起步，用户删掉的开头被带回来，
 *    关键帧比剪辑粒度粗时甚至会把整段间隙吞回产物），所以入点那一小段重编码、其余仍流拷贝。
 *    代价是接缝处有损、要多编一小段——这是明说的取舍。
 *
 * 两种模式各自带钳制，共两条：
 *  - **防吞**：吸附回溯绝不越过上一条已排拷贝段的出点，跨界时自动降级
 *    （能同编码 → autoPrecise 局部精确；不能 → 整段重编码），"删了等于没删"永远不会发生。
 *  - **防重叠**（乱序专用）：吸附扩出的区间若与已排拷贝段重叠，起点钳到重叠段右界之后
 *    的第一个关键帧（firstKeyframeAtLeast），保流拷贝；钳不动则整段重编码。
 *    实测乱序 [9,10] [0,2] [5,8]（关键帧 [0,2,6]）曾导出 copy[6,10]+copy[2,8]，[6,8] 重复导出 2 秒。
 * 不变式：任何计划里拷贝段两两在源上不重叠（见 snapOverlaps 断言与 core/cuttings.test.js）。
 *
 * 切割计划项：
 * {
 *   kind: 'copy' | 'reencode',
 *   role: 'whole' | 'head' | 'tail',   // 整条区间 / 入点小段 / 入点之后的拷贝段
 *   start: number,      // 源上的入点；copy 段的 start 必定是关键帧
 *   duration: number,   // 秒，已折算成整数帧
 *   snapFrom: number,   // 用户原始入点。精确模式下与 start 恒等；吸附模式下 start 已前移到关键帧，
 *                       // 二者相差就是这一段"多带"的秒数（UI 用它画多带延伸块）
 *   keepEnd: number,    // 用户原始选择的区间终点
 *   keepIndex: number,
 *   codecChange?: boolean,  // 这次重编码把编码换了（源编码没有同编码重编码器）
 *   note?: string
 * }
 *
 * 语义（已用 ffmpeg N-113109 实测确认，见 docs/02-技术方案.md §3）：
 *  - 入点（精确模式）：就是要哪一秒，从哪一秒起。落在关键帧上→整段流拷贝；落在 GOP 中间→
 *    [入点, 之后第一个够长的关键帧) 重编码，剩下的流拷贝。
 *  - 入点（吸附模式，默认）：前移到 ≤ 用户入点的最后一个关键帧，整段流拷贝（零重编码）。
 *    与已排拷贝段冲突时按上面的两道钳制降级。
 *  - 出点：只需要时长。重编码段与拷贝段都按整帧取长，且**绝不越过用户出点**
 *    （越界等于把已删的素材带回来）。
 *  - 帧数取自源的平均帧率：VFR 源也只能按它折算，实测按时间 `-t` 限长根本收不住。
 */

const { snap, EPS } = require('./segments');

/** 判"某个时刻是不是关键帧"的容差：关键帧时间戳来自源自身，误差只有毫秒级。 */
const KEY_TOL = 0.0005;

/**
 * 帧网格序号：时刻 t 是第几帧。规则只有一条——**帧必须严格早于上界**，所以向上取整
 * （四舍五入有一半概率把上界那一帧也算进来，接缝上就把同一帧导出两遍）。
 * 网格原点是 origin（源首帧未必落在 0，实测 HEVC 首帧 pts = 0.023）。
 */
function frameIndex(t, fps, origin = 0) {
  return Math.ceil((t - origin) * fps - 1e-9);
}

/**
 * @param {Array<{start:number,end:number}>} keeps 已规整的保留区间
 * @param {{keyframes:number[], duration:number, fps?:number, ordered?:boolean, sameCodec?:boolean}} opts
 *        ordered=true 表示 keeps 的顺序就是导出顺序（用户拖动改过），此时不做相邻合并；
 *        sameCodec=false 表示重编码出来的不是源那个编码，绝不与流拷贝段混拼
 * @returns {{plan:Array, warnings:string[]}}
 */
function buildPlan(keeps, opts) {
  const { keyframes = [], duration, fps, ordered = false, sameCodec = true, gridOrigin = 0, reorderDepth = 0, forceReencode = false, precise = true, raslPerKf = 0, seamNeedsIdr = false, forceWholeReencode = false } = opts;
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
  let warnedSeamBroken = false;
  let raslCounted = 0;              // RASL 剥除帧数：copyPart（源尾分支）与收尾循环共同累计，去重后给警告

  /**
   * [from, to) 之间有多少帧 = 会被导出的帧数。
   * 两头都按"第 N 帧的时刻 = N/fps"算，规则只有一条：**帧必须严格早于 to**。
   * 四舍五入有一半概率把 to 那一帧也算进来，接缝上就把同一帧导出两遍（head 的 to 是
   * 拷贝段起点=关键帧，尾巴的 to 是用户出点，越过去等于把已删的素材带回来）。
   */
  const span = (from, to) => {
    if (!fpsNum) return snap(to - from);
    const idx = (t) => frameIndex(t, fpsNum, origin);
    // 不抹毫秒：37/30 被 snap 成 1.233 就不是整帧时刻了，concat 推偏移会落半格
    return Math.max(0, idx(to) - idx(from)) / fpsNum;
  };

  /**
   * 拷贝段：流拷贝只能按**解码序**数包，含双向预测的源到出点会漏掉窗口末尾几帧
   * （实测 h264 双向预测源要 45 帧只给出 {0..43,47}：44 丢了，47 是用户删掉的素材）。
   * 所以帧数按重排深度减几帧，**绝不把已删的素材带回来**。
   *
   * 代价（2026-10-13 逐项实测，has_b_frames=2 / 30fps）：
   *  - 每个"结束在源中间"的片段，视频轨比选区**少 2 帧（67ms）**：选区 2.000s 出 58 帧。
   *  - 多段会累积：5 个这样的片段，容器时长 5.000s → 4.7866s（少 0.2134s）。
   *    所以**总时长并不精确等于选区**（早期注释这么写过，是错的）。
   *  - 音画**不失步**：逐报文算两条流跨度差 0.0199s，远小于自检阈值 0.3s。
   *  - 观感上表现为接缝处末帧多显示一下：按恒定 30fps 重采样，每个接缝出现 1 处重复帧。
   *  - 结束在源尾的片段不减（后面本来没有帧），一点不少。
   * @returns {{duration:number, frames:(number|null), trimmed:number}}
   */
  const atEnd = (to) => Number.isFinite(duration) && to >= duration - EPS;
  /**
   * [from, to) 里有多少个关键帧（不含 from 本身、含 to 吗？不含——区间端点约定与 span 一致，左闭右开）。
   * HEVC 开放 GOP 的 RASL 剥除按「每个关键帧剥 raslPerKf 帧」记账用：filter_units 按解码序
   * 把每个 IDR/CRA 之后的 RASL 包整个剥掉，无法区分"引用段内还是段外"，段内有几个
   * 关键帧（不含起点——起点关键帧之后的 RASL 才会被切进段里）就剥几组。
   */
  const kfCountIn = (from, to) => {
    let n = 0;
    for (const k of keyframes) {
      if (k <= from + KEY_TOL) continue;
      if (k >= to - KEY_TOL) break;
      n++;
    }
    return n;
  };
  const copyPart = (from, to) => {
    const window = span(from, to);
    if (!fpsNum || !bdepth || atEnd(to)) {
      // 源尾不加防吞余量（后面本来没有帧），但 **HEVC 的 RASL 剥除照剥**——
      // filter_units 不管段尾是不是源尾，段内每个关键帧后的 RASL 都会消失，
      // 所以哪怕到源尾也要给出明确的 frames 预期（null = 按 -t 收口，剥完就少帧、自检挂）
      if (raslPerKf > 0 && fpsNum) {
        const n = kfCountIn(from, to);
        if (n > 0) {
          const frames = Math.round(window * fpsNum) - n * raslPerKf;
          if (frames > 0) {
            raslCounted += n * raslPerKf;
            return { duration: window, frames, trimmed: 0, raslTrimmed: true };
          }
        }
      }
      return { duration: window, frames: null, trimmed: 0 };
    }
    const frames = Math.round(window * fpsNum) - bdepth;
    return frames > 0
      ? { duration: window, frames, trimmed: bdepth }
      : { duration: 0, frames: null, trimmed: 0 };
  };

  /**
   * HEVC 开放 GOP 的 RASL 记账：拷贝段里的每个关键帧（**不含段起点**——起点关键帧之后的
   * RASL 才会被切进段里）后面都跟着 raslPerKf 个 RASL 帧，`filter_units remove_types=8|9`
   * 会把这些包整个剥掉（NAL 级无法区分"引用段内还是段外"）。剥掉的帧不会出现在产物里，
   * 帧数预期必须同步扣掉，否则"帧数符合切割计划"自检必挂。
   *
   * 实测（x265 open-gop，has_b_frames=2）：每个关键帧跟 3 个 RASL（= 深度 + 1），由上层折算传入。
   * 只影响 frames 记账，duration 不动（RASL 显示时刻本就在段外或被后续帧补位）。
   */

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
    // 吸附模式跨界自动降级标记：本条保留区间走了"局部精确"兜底时置位，
    // 下面精确路径推出的段会带上 autoPrecise 与说明前缀（供 UI 区分"用户勾的"和"自动的"）。
    let autoDegrade = false;
    let autoNote = '';

    /**
     * 通用探针判定"单个拷贝段自己就解不开"时的整段重编码。
     *
     * 实测（x264 开放 GOP）：它的"关键帧"NAL type 是 1（非 IDR），不是 5；
     * ffprobe 的 K 标志只表示"可随机接入标记"，而这些帧从任意位置流拷贝出来
     * 都报 `Missing reference picture` / `mmco: unref short failure`。
     * 此时"开头重编码一小段"救不了——拷贝尾段本身就是从非 IDR 起的。
     * 唯一保证可解码的出路是每个片段整段重编码（有损，但帧精确、必然可解）。
     *
     * 与 VFR 那条不同：这条是**通用探针实测结论**，不看编码。
     */
    if (forceWholeReencode && sameCodec) {
      if (!warnedSeamBroken) {
        warnedSeamBroken = true;
        warnings.push(
          '源的关键帧不是自包含随机接入点（实测：从它流拷贝出来的片段自己就解不开，'
          + '报 "Missing reference picture" / "mmco: unref short failure"）——'
          + '这类源的每个片段都改为整段重编码（有损，但可解码、切点精确）。'
          + '常见于 x264 的开放 GOP（open-gop=1）编码',
        );
      }
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: '源的关键帧不可独立起段：整段重编码（有损）',
      });
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

    /**
     * 吸附模式（precise=false）：入点前移到 ≤ 它的最后一个关键帧，整段流拷贝。
     *
     * 两道钳制，任何一道触发都自动降级（能同编码 → autoPrecise 局部精确；
     * 不能（mpeg4/mjpeg…）→ 整段重编码不混拼）：
     *
     * 1. **防吞**（cc1ff73 的教训，98 分钟 .mkv：删 1.9s 产物是整部片）：回溯跨过
     *    【已排段的源出点】= 把用户删掉的间隙吞回产物。判据不是"数组里上一条"——
     * 乱序导出（用户拖过顺序）时数组相邻 ≠ 源相邻，必须查**所有已排拷贝段**；
     * 2. **防重叠**（乱序专属，cc1ff73 就有、自检因"计划自身含重复帧"拦不住）：
     *    两条保留区间的吸附拷贝段可能在源上互相重叠（如 [6,10] 与 [2,8]），
     *    concat 会把同一画面导出两遍。处理：吸附起点钳到重叠段右界后的第一个关键帧
     *    （保住流拷贝）；钳不动才整段重编码。
     */
    if (!precise) {
      const kfStart = lastKeyframeAtMost(keep.start, keyframes);
      const snapStart = kfStart === null ? 0 : kfStart;
      /**
       * 多段纯拷贝拼接的接缝必须由 IDR 重置 POC。
       *
       * 判据来自**通用探针的实测结果**（`seamNeedsIdr`，见 pipeline.scanKeyframes 里
       * 的 probePureCopySeams），不按编码写死规则：实测这一步能同时抓住
       * HEVC 开放 GOP（`Duplicate POC`）与 H.264 开放 GOP（`mmco: unref short failure`），
       * 以及将来任何未知格式——它们单段都能解、拼起来才炸。
       *
       * 做法：只要这**不是第一个拷贝段**，就让本段走局部精确——入点那一小段重编码
       * （自带 IDR）把 POC 重置掉，其余仍流拷贝。代价是该片段开头 ≤ 一个关键帧间隔有损
       * （与精确模式同价），换来接缝可解码；第一个片段不受影响。
       *
       * 试过但无效（都实测过，别再走）：源里插 EOS/EOB（muxer 会丢掉）、
       * 把 CRA 改写成 IDR（`Could not find ref with POC`）、加长重编码段（无差别）。
       */
      const needIdrSeam = seamNeedsIdr && plan.some((p) => p.kind === 'copy');
      // 已排【计划段】（源时间轴上的实际拷贝范围，含前几条吸附扩出来的部分）：
      // 本段吸附拷贝 [snapStart, end) 若与它们交叠 = 吞已删内容或重复导出。
      // 对照 keeps 原始区间是错的——乱序下吸附扩出来的 [6,10] 不在任何 keep 源区间里。
      const placedCopy = plan.filter((p) => p.kind === 'copy');
      // 防吞：吸附起点落进某条已排拷贝段的内部（真回溯吃内容，关键帧对齐时无代价无所谓）
      const swallow = placedCopy.find((p) => snapStart > p.start + EPS && snapStart < p.start + p.duration - EPS);
      const crosses = swallow != null && snapStart < start - EPS;
      // 开放 GOP 的非首个拷贝段：接缝必须由 IDR 重置 POC，走局部精确（见上方 needIdrSeam 注释）
      if (needIdrSeam && sameCodec && !crosses) {
        warnings.push(
          `源是 HEVC 开放 GOP（全片只有一个 IDR，其余是 CRA）：第二个及以后的片段若也整段流拷贝，`
          + `接缝处 POC 不重置、解码报 "Duplicate POC"（实测接缝后会出现源里不存在的坏帧）。`
          + `这一段已自动改为局部精确——入点那一小段（≤ 一个关键帧间隔）重编码以重置 POC，其余仍流拷贝`,
        );
        autoDegrade = true;
        autoNote = '开放 GOP 接缝需重置 POC，自动局部精确';
      }
      if (crosses && sameCodec) {
        warnings.push(
          `关键帧间隔比剪辑粒度粗（入点回溯到 ${snapStart.toFixed(3)}s，会吃掉已删的 ${(swallow.start + swallow.duration - snapStart).toFixed(3)}s）：这一段已自动改为局部精确（入点一小段重编码，其余仍流拷贝）`,
        );
        // 落下去走下面的局部精确分支，并打上自动降级标记
        autoDegrade = true;
        autoNote = '关键帧比剪辑粒度粗，自动局部精确';
      } else if (crosses) {
        warnings.push(
          `关键帧间隔比剪辑粒度粗：入点回溯到 ${snapStart.toFixed(3)}s 会带回已删的 ${(swallow.start + swallow.duration - snapStart).toFixed(3)}s；`
          + '源编码没有同编码重编码器，这一段整段重编码（不混拼）',
        );
        plan.push({
          kind: 'reencode', role: 'whole', start, duration: wholeDur,
          snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, codecChange: true,
          note: '吸附会吞掉已删的间隙，且源编码没有同编码重编码器：整段重编码（编码改变）',
        });
        continue;
      } else {
        // 防重叠：吸附拷贝段 [snapStart, end) 与已排拷贝段真重叠（相接不算）——
        // concat 会把同一画面导出两遍，且"帧数符合计划"的自检拦不住（计划自身就含重复）。
        // 处理：吸附起点**钳到已排重叠段右界之后的第一个关键帧**——既保住流拷贝，又无重叠；
        // 钳完已越过出点、或没有更晚的关键帧（或换编码源不能混拼）时才整段重编码。
        // （只降级"局部精确"不够：精确路径的拷贝尾段仍会与已排段重叠，实测 copy[6,8] ⊂ copy[6,10]。）
        const overlap = placedCopy.find((p) => Math.min(p.start + p.duration, end) - Math.max(p.start, snapStart) > EPS);
        if (overlap) {
          const right = overlap.start + overlap.duration;
          const clamped = sameCodec ? firstKeyframeAtLeast(right + EPS, keyframes) : null;
          if (clamped !== null && clamped < end - EPS) {
            const part = copyPart(clamped, end);
            if (part.duration > EPS) {
              warnings.push(
                `吸附会与另一段的拷贝段在源上重叠（原回溯到 ${snapStart.toFixed(3)}s，与 [${overlap.start.toFixed(3)}–${right.toFixed(3)}] 交叠）：本段吸附起点钳到关键帧 ${clamped.toFixed(3)}s（少 ${(clamped - keep.start).toFixed(3)}s 片段开头）`,
              );
              plan.push({
                kind: 'copy', role: 'whole', start: clamped, duration: part.duration, frames: part.frames,
                snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, trimmed: part.trimmed,
                raslTrimmed: part.raslTrimmed || undefined,
                autoPrecise: true,
                note: `吸附避开重叠：从关键帧 ${clamped.toFixed(3)}s 起（少 ${(clamped - keep.start).toFixed(3)}s 片段开头）`,
              });
              continue;
            }
          }
          warnings.push(
            `吸附会让拷贝段在源上重叠（回溯到 ${snapStart.toFixed(3)}s 与 [${overlap.start.toFixed(3)}–${right.toFixed(3)}] 交叠），且无法避开`
              + (sameCodec ? '：这一段整段重编码' : '；源编码没有同编码重编码器，整段重编码（不混拼）'),
          );
          plan.push({
            kind: 'reencode', role: 'whole', start, duration: wholeDur,
            snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, autoPrecise: true,
            codecChange: !sameCodec || undefined,
            note: '吸附拷贝段源区间重叠且无法避开：整段重编码（' + (sameCodec ? '同编码' : '编码改变，不混拼') + '）',
          });
          continue;
        } else if (autoDegrade && sameCodec) {
          /**
           * 已判定要走局部精确（开放 GOP 接缝需重置 POC，或防吞降级）：
           * 这里不再产出整段拷贝段，而是落到函数末尾的"局部精确"分支去
           * ——入点那一小段重编码（自带 IDR）+ 其余流拷贝。
           */
        } else {
          const snapDur = span(snapStart, end);
          if (snapDur > EPS) {
            const part = copyPart(snapStart, end);
            if (part.duration > EPS) {
              plan.push({
                kind: 'copy', role: 'whole', start: snapStart, duration: part.duration, frames: part.frames,
                snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, trimmed: part.trimmed,
                raslTrimmed: part.raslTrimmed || undefined,
                note: kfStart === null
                  ? `入点之前没有关键帧，从 0 开始（多 ${keep.start.toFixed(3)}s 内容）`
                  : snapStart < keep.start - EPS
                    ? `入点前移到关键帧 ${snapStart.toFixed(3)}s（多带 ${(keep.start - snapStart).toFixed(3)}s）`
                    : '整段流拷贝（不转码）',
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
          warnings.push(`区间 ${start.toFixed(3)}s–${end.toFixed(3)}s 与关键帧对齐后为空，已忽略`);
          continue;
        }
      }
    }

    // 入点落在 GOP 中间：需要重编码入点那一小段才能从任意时刻起；其余仍流拷贝。
    if (hasKeyframeAt(start, keyframes)) {
      const part = copyPart(start, end);
      if (part.duration > EPS) {
        plan.push({
          kind: 'copy', role: 'whole', start, duration: part.duration, frames: part.frames,
          snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki, trimmed: part.trimmed,
          raslTrimmed: part.raslTrimmed || undefined,
          note: '整段流拷贝（不转码）',
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
      warnings.push(`没有可用关键帧索引：区间 ${start.toFixed(3)}s–${end.toFixed(3)}s 整段重编码以保证剪辑精确`);
      plan.push({
        kind: 'reencode', role: 'whole', start, duration: wholeDur,
        snapFrom: keep.start, keepEnd: keep.end, keepIndex: ki,
        note: '没有可用关键帧：整段重编码（有损）',
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
        autoPrecise: autoDegrade || undefined,
        note: autoDegrade ? `${autoNote} · 区间落在一个 GOP 内，整段重编码（有损）`
          : '入点不在关键帧上，这一段落在一个 GOP 内（后面没有可接续的关键帧）：整段重编码（有损）',
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
          ? `后面只剩 ${Math.round(tailRaw * (fpsNum || 1))} 帧，减去双向预测余量就不够了：整段重编码（有损）`
          : '关键帧已贴到出点：整段重编码（有损）',
      });
      continue;
    }

    plan.push({
      kind: 'reencode', role: 'head', start, duration: head,
      snapFrom: keep.start, keepEnd: keep.end,
      autoPrecise: autoDegrade || undefined,
      note: autoDegrade ? `${autoNote} · 入点小段重编码` : '入点小段重编码',
    });
    plan.push({
      kind: 'copy', role: 'tail', start: kfHead, duration: tailPart.duration, frames: tailPart.frames,
      snapFrom: keep.start, keepEnd: keep.end, actualEnd: keep.end, trimmed: tailPart.trimmed,
      raslTrimmed: tailPart.raslTrimmed || undefined,
      autoPrecise: autoDegrade || undefined,
      note: autoDegrade ? `${autoNote} · 其余流拷贝` : `入点重编码 ${head.toFixed(3)}s，其余流拷贝`,
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
      + '宁可短也不把你已经删掉的素材带回来；要末端也一帧不差只有一条路——这一段一直切到源尾'
      + '（实测把出点挪到关键帧上免不掉这个余量：2s→4s 两个关键帧之间照样少给 2 帧）',
    );
  }

  /**
   * HEVC 开放 GOP：把 RASL 剥除的帧数从拷贝段预期里扣掉。
   * `filter_units remove_types=8|9` 按**解码序**剥掉每个 IDR/CRA 之后的 RASL 包，
   * 无法区分"这一条 RASL 引用的画面在段内还是段外"，所以段内几个关键帧（不含段起点——
   * 起点关键帧的 RASL 显示序在起点之前，本来就不在拷贝窗口里）就剥几组。
   * 剥掉的帧确实不出现在产物里，帧数预期不同步扣，"帧数符合切割计划"自检必挂
   * （实测 HEVC 源入点在 GOP 中间、拷贝到源尾：期望 300 实际 297，差 3 = 1 个段内关键帧 × 3）。
   *
   * `copyPart` 的"切到源尾"分支已经扣过（见 raslTrimmed 标记），这里只补
   * 走了 bdepth 路径的普通拷贝段，别两头重复扣。
   */
  if (raslPerKf > 0 && fpsNum) {
    for (const p of plan) {
      if (p.kind !== 'copy' || !Number.isFinite(p.frames) || p.frames <= 0) continue;
      if (p.raslTrimmed) continue;
      const n = kfCountIn(p.start, p.start + p.duration);
      if (n > 0) {
        p.frames = Math.max(1, p.frames - n * raslPerKf);
        // 记在段上：上层算"产物该多长"时要把这些帧的显示时长加回去（见返回值的 raslStripped）
        p.raslStripped = n * raslPerKf;
        raslCounted += n * raslPerKf;
      }
    }
    if (raslCounted > 0) {
      warnings.push(
        `源是 HEVC 开放 GOP：拼接用的参数集修正要求剥掉关键帧后的 RASL 前导帧，`
        + `本次导出共剥 ${raslCounted} 帧（约 ${(raslCounted / (fpsNum || 30) * 1000).toFixed(0)}ms，分散在各关键帧处）——`
        + '这是流拷贝拼接的固有代价，画面无损',
      );
    }
  }

  // 乱序（用户拖动改过顺序）时必须跳过 dedupePlan：它按"时间递增"假设合并相邻段，
  // 遇到 [5-10, 0-5] 这种会把后一段整个吞掉，导出就少了一半内容。
  return {
    plan: ordered ? plan.filter((p) => p.duration > EPS) : dedupePlan(plan),
    warnings,
    /**
     * 本次计划因剥 RASL 一共少了多少帧。上层算"产物该多长"时必须把它加回去：
     * `filter_units` 剥掉的是包，**剩下的帧仍保留原 PTS**，所以时间轴上留下空洞、
     * 容器时长并不随之缩短。实测（30s 开放 GOP 源、精确模式）：Σframes/fps = 16.967s，
     * 而产物视频轨 17.733s —— 差的 0.766s 就是被剥掉的 23 帧（23/30 ≈ 0.767s）。
     * 拿 Σframes/fps 当基准会把这个固有代价判成"接缝被拉长"。
     */
    raslStripped: raslCounted,
  };
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

/**
 * 入点 t 实际会落在哪一帧（源时间轴上的时刻）。
 *
 * 入点不在帧网格上时，导出的第一帧是网格里**不早于**它的那一格（`span` 就是这么数帧的）。
 * 字幕按文本重计时必须拿这个时刻当基准：拿用户输入的 0.5 当基准，而画面其实从 0.523 起，
 * 每条 cue 都会整体晚 0.023s——还不够一帧，但字幕与口型就是一致地偏晚。
 */
function frameStart(t, fps, origin = 0) {
  const f = Number(fps) > 0 ? Number(fps) : null;
  if (!f) return t;
  const o = Number(origin) > 0 ? Number(origin) : 0;
  return o + Math.max(0, frameIndex(t, f, o)) / f;
}

/** ≥ t 的第一个关键帧（keyframes 已升序；没有则 null）。二分：长素材关键帧表上万条时 O(log n)。 */
function firstKeyframeAtLeast(t, keyframes) {
  let lo = 0, hi = keyframes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid] < t - KEY_TOL) lo = mid + 1;
    else hi = mid;
  }
  return lo < keyframes.length ? keyframes[lo] : null;
}

/** ≤ t 的最后一个关键帧（keyframes 已升序；没有则 null）。吸附模式用。二分。 */
function lastKeyframeAtMost(t, keyframes) {
  let lo = 0, hi = keyframes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid] <= t + KEY_TOL) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? keyframes[lo - 1] : null;
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

module.exports = { buildPlan, frameStart, lastKeyframeAtMost };
