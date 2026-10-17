'use strict';

/**
 * 多素材兼容性判定：几段素材能不能**纯流拷贝**拼成一条？不能的话差在哪、要统一到什么参数？
 *
 * 为什么需要这个模块（2026-10-18 定案，五组实验，见 docs 与 commit 说明）：
 * ffmpeg 的 concat 对"参数一致"的要求比想象中严格得多，而**违反后并不都报错**——
 * 很多情况是静默损坏，产物能播放、解码也不报错，但内容已经错了：
 *
 *  实验素材：两段都是 h264 / mp4，只有分辨率(320x180 vs 640x360)、帧率(30 vs 25)、
 *  音频(44.1k 单声道 vs 48k 双声道)不同。纯流拷贝拼接的结果：
 *    · 时长 10.908s（应 10.000）、**帧数 273（应 300）**、末帧停在 8.32s
 *    · 帧间隔出现 3 种取值，其中 **0.0001s**（多帧挤在同一时刻 = 播不出来）
 *    · **解码 stderr 干净** —— 只看"能不能解码"的话，这份坏产物会被判为通过
 *  而"只指定编码重编码一次"（-c:v libx264）更糟：**251 帧**，仍然解码干净。
 *
 * 所以判据必须是"逐项参数是否完全一致"，而不是"能不能拼出来"。
 *
 * 一致的项（任一不同 → 不能纯流拷贝）：
 *  视频：编码、宽、高、SAR、帧率、像素格式
 *  音频：编码、采样率、声道数、采样格式
 *  （封装不同不致命——可以先各自纯拷成统一容器再拼；编码不同则必须重编码）
 */

/** 参与"能否流拷贝"判定的视频参数。顺序固定，报差异时按这个顺序列。 */
const VIDEO_KEYS = [
  ['codec', '编码', (v) => v.codec],
  ['width', '宽', (v) => v.width],
  ['height', '高', (v) => v.height],
  ['sar', '像素宽高比', (v) => v.sar || '1:1'],
  ['fps', '帧率', (v) => (Number.isFinite(v.fps) ? Math.round(v.fps * 1000) / 1000 : null)],
  ['pixFmt', '像素格式', (v) => v.pixFmt],
];

/** 参与判定的音频参数（只看第一条音轨：本产品只处理单主音轨的拼接）。 */
const AUDIO_KEYS = [
  ['codec', '音频编码', (a) => a.codec],
  ['sampleRate', '采样率', (a) => a.sampleRate],
  ['channels', '声道数', (a) => a.channels],
  ['sampleFmt', '采样格式', (a) => a.sampleFmt],
];

function firstAudio(media) {
  const list = media?.audioTracks || [];
  return list.length ? list[0] : null;
}

/**
 * 单个源的"参数签名"——签名相同才能纯流拷贝互拼。
 * 缺字段一律当 null 参与比较（宁可判成"不一致、要重编码"，也不要放过静默损坏）。
 */
function signatureOf(media) {
  const v = media?.video || {};
  const a = firstAudio(media);
  const sig = {};
  for (const [k, , get] of VIDEO_KEYS) sig[`v.${k}`] = get(v) ?? null;
  for (const [k, , get] of AUDIO_KEYS) sig[`a.${k}`] = a ? (get(a) ?? null) : null;
  // 无音轨也是合法的"一致"：两段都没音频就都记 null
  sig['a.present'] = a ? true : false;
  return sig;
}

/** 把签名里不一致的项整理成人话，供界面红字与警告使用。 */
function diffOf(aSig, bSig) {
  const out = [];
  for (const [k, label] of VIDEO_KEYS) {
    const key = `v.${k}`;
    if (aSig[key] !== bSig[key]) out.push({ key, label, a: aSig[key], b: bSig[key] });
  }
  for (const [k, label] of AUDIO_KEYS) {
    const key = `a.${k}`;
    if (aSig[key] !== bSig[key]) out.push({ key, label, a: aSig[key], b: bSig[key] });
  }
  if (aSig['a.present'] !== bSig['a.present']) {
    out.push({ key: 'a.present', label: '音轨', a: aSig['a.present'] ? '有' : '无', b: bSig['a.present'] ? '有' : '无' });
  }
  return out;
}

/**
 * 判定整组素材。
 *
 * @param {Array<{id:string,file:string,media:object}>} sources
 * @returns {{
 *   uniform: boolean,               // 全部参数一致 → 可以"跟随源"纯流拷贝拼接
 *   groups: Array,                  // 按签名分组（组内可流拷贝互拼）
 *   baseline: object|null,          // 参数"最强"的源：统一重编码时的基准
 *   diffs: Array,                   // 每一项参数的差异明细（界面红字用）
 *   summary: string,                // 一句话摘要
 * }|null}
 */
function analyzeSources(sources) {
  const list = (sources || []).filter((s) => s && s.media);
  if (list.length < 2) return null;

  const sigs = list.map((s) => ({ src: s, sig: signatureOf(s.media) }));
  // 分组：签名完全相同的放一组（JSON 比较足够——签名都是标量）
  const groups = [];
  for (const item of sigs) {
    const key = JSON.stringify(item.sig);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, sig: item.sig, sources: [] }; groups.push(g); }
    g.sources.push(item.src);
  }

  // 差异明细：逐项列出所有源的取值（界面红字与警告都用它）
  const diffs = [];
  if (groups.length > 1) {
    /**
     * key 前缀决定这项属于视频还是音频。旧实现靠"VIDEO_KEYS 里有没有这个 k"反推，
     * 而视频与音频**都有名为 codec 的键**，于是音频的 codec 被错标成 v.codec，
     * 报出"音频编码 h264 / hevc"这种假差异（实测），把真正的差异淹掉了。
     * 现在两组合并遍历时就带着各自的前缀，不再反推。
     */
    const allKeys = [
      ...VIDEO_KEYS.map(([k, label, get]) => ({ key: `v.${k}`, label, get })),
      ...AUDIO_KEYS.map(([k, label, get]) => ({ key: `a.${k}`, label, get })),
    ];
    for (const { key, label } of allKeys) {
      const vals = [...new Set(sigs.map((x) => x.sig[key]))];
      if (vals.length > 1) {
        diffs.push({
          key,
          label,
          values: vals.map((v) => ({ value: v, sources: sigs.filter((x) => x.sig[key] === v).map((x) => x.src.id) })),
        });
      }
    }
    const present = [...new Set(sigs.map((x) => x.sig['a.present']))];
    if (present.length > 1) {
      diffs.push({
        key: 'a.present',
        label: '音轨',
        values: sigs.map((x) => ({ value: x.sig['a.present'] ? '有' : '无', sources: [x.src.id] })),
      });
    }
  }

  return {
    uniform: groups.length === 1,
    groups: groups.map((g) => ({ sig: g.sig, ids: g.sources.map((s) => s.id) })),
    baseline: pickBaseline(list),
    diffs,
    summary: groups.length === 1
      ? '素材参数完全一致，可全程纯流拷贝（零损失）'
      : `${list.length} 段素材分成 ${groups.length} 组不同参数，无法直接流拷贝拼接`,
  };
}

/**
 * 选"基准参数"：不一致时其余源向它对齐。
 *
 * 优先级（都是为了**不降级**，宁可多编也不要让高清素材被降到低清）：
 *  1. 像素多（宽×高）——4K 向 1080p 对齐是降质，反过来只是画质不变、体积变大
 *  2. 帧率高——高帧率降到低帧率会丢动作细节
 *  3. 采样率高 → 声道多 → 视频轨更多（同分辨率下优先原盘）
 *
 * 同分时取**第一个**（用户在时间轴上的顺序即导出顺序，取靠前的更符合直觉）。
 */
function pickBaseline(list) {
  let best = null;
  let bestScore = null;
  for (const s of list) {
    const m = s.media || {};
    const v = m.video || {};
    const a = firstAudio(m) || {};
    const score = [
      (Number(v.width) || 0) * (Number(v.height) || 0),
      Number(v.fps) || 0,
      Number(a.sampleRate) || 0,
      Number(a.channels) || 0,
    ];
    if (!best || cmpScore(score, bestScore) > 0) {
      best = s;
      bestScore = score;
    }
  }
  if (!best) return null;
  const v = best.media.video || {};
  const a = firstAudio(best.media) || {};
  return {
    id: best.id,
    file: best.file,
    width: v.width,
    height: v.height,
    sar: v.sar || '1:1',
    fps: v.fps,
    pixFmt: v.pixFmt,
    codec: v.codec,
    audio: a ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, sampleFmt: a.sampleFmt } : null,
  };
}

function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 某个源是否**完全等于**基准参数（等于 → 可以流拷贝，不必重编码）。
 * 注意编码也要比：基准的编码是"用户最终选的编码"而不是源编码时，
 * 调用方应先用 withTargetCodec 改写基准。
 */
function matchesBaseline(source, baseline) {
  const v = source.media?.video || {};
  const a = firstAudio(source.media) || {};
  if (!baseline) return true;
  const eq = (x, y) => (x ?? null) === (y ?? null);
  return eq(v.width, baseline.width)
    && eq(v.height, baseline.height)
    && eq(roundFps(v.fps), roundFps(baseline.fps))
    && eq(v.pixFmt, baseline.pixFmt)
    && eq(v.sar || '1:1', baseline.sar || '1:1')
    && (baseline.audio
      ? eq(a.sampleRate, baseline.audio.sampleRate) && eq(a.channels, baseline.audio.channels)
      : !a);
}

function roundFps(x) {
  return Number.isFinite(Number(x)) ? Math.round(Number(x) * 1000) / 1000 : null;
}

/**
 * 用户选了"目标编码"后，基准里的编码换成目标编码。
 * 语义：源编码 === 目标编码 且其余参数都等于基准 → 这段可以流拷贝；
 * 否则这段必须整段重编码（编码不同，或参数被统一改过）。
 */
function withTargetCodec(baseline, codec) {
  if (!baseline) return null;
  return { ...baseline, codec: codec || baseline.codec };
}

/**
 * 逐源判定：哪些源需要重编码（整段），哪些可以流拷贝。
 * @returns {Array<{id:string, reencode:boolean, reasons:string[]}>}
 */
function planPerSource(sources, baseline, targetCodec) {
  const base = withTargetCodec(baseline, targetCodec);
  return (sources || []).map((s) => {
    const v = s.media?.video || {};
    const a = firstAudio(s.media) || {};
    const reasons = [];
    const eq = (x, y) => (x ?? null) === (y ?? null);
    const codec = targetCodec || base?.codec;
    if (codec && v.codec !== codec) reasons.push(`编码 ${v.codec}→${codec}`);
    if (base && !eq(v.width, base.width)) reasons.push(`宽 ${v.width}→${base.width}`);
    if (base && !eq(v.height, base.height)) reasons.push(`高 ${v.height}→${base.height}`);
    if (base && !eq(roundFps(v.fps), roundFps(base.fps))) reasons.push(`帧率 ${roundFps(v.fps)}→${roundFps(base.fps)}`);
    if (base && !eq(v.pixFmt, base.pixFmt)) reasons.push(`像素格式 ${v.pixFmt}→${base.pixFmt}`);
    if (base && !eq(v.sar || '1:1', base.sar || '1:1')) reasons.push(`像素宽高比 ${v.sar || '1:1'}→${base.sar || '1:1'}`);
    if (base?.audio) {
      if (!eq(a.sampleRate, base.audio.sampleRate)) reasons.push(`采样率 ${a.sampleRate}→${base.audio.sampleRate}`);
      if (!eq(a.channels, base.audio.channels)) reasons.push(`声道 ${a.channels}→${base.audio.channels}`);
    }
    return { id: s.id, reencode: reasons.length > 0, reasons };
  });
}

module.exports = {
  analyzeSources,
  signatureOf,
  diffOf,
  pickBaseline,
  matchesBaseline,
  withTargetCodec,
  planPerSource,
  firstAudio,
  VIDEO_KEYS,
  AUDIO_KEYS,
};
