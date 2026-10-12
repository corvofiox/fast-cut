'use strict';

/**
 * 字幕按文本重新计时 —— 纯函数，不碰文件系统也不跑 ffmpeg。
 *
 * 为什么要这一层：分段流拷贝时 ffmpeg 对字幕轨的定位不可靠（实测 Matroska 的 subrip
 * 会整条漏掉落在切割窗口里的 cue，也会把被删区间的 cue 串回来；而 `-frames:v` 一到
 * 视频帧数就把输出收了，字幕包还没读出来）。音视频能按帧精确切，字幕只能自己重算时间：
 * 从源取出文本 → 按保留区间映射到成片时刻 → 再 remux 回产物。这也是 mkvmerge
 * `--timestamps` 那一派工具的做法。
 *
 * 只支持文本字幕（srt / ass）。位图字幕（PGS、DVD）重排需要 OCR，这里明确不做，
 * 调用方拿到 null 就该退回"自检拦下"那条路。
 */

/* ------------------------------------------------------------------ 时间格式 */

/** SRT：HH:MM:SS,mmm */
function parseSrtTime(s) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function fmtSrtTime(sec) {
  const t = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const ms = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** ASS：H:MM:SS.cc（百分秒，小时可以进位到一位数） */
function parseAssTime(s) {
  const m = /^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(2, '0')) / 100;
}

function fmtAssTime(sec) {
  const t = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(t / 360000);
  const m = Math.floor((t % 360000) / 6000);
  const s = Math.floor((t % 6000) / 100);
  const cs = t % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ 解析 / 回写 */

/**
 * SRT 解析。解析不出时间轴就抛错（调用方退回"拦下"那条路），
 * 绝不"尽力而为"地吐一份可能对不上的字幕。
 */
function parseSrt(text) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of body.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) throw new Error('SRT 里找不到时间轴行');
    const [a, b] = lines[idx].split('-->');
    const start = parseSrtTime(a);
    const end = parseSrtTime(b);
    if (start === null || end === null) throw new Error(`SRT 时间轴无法解析：${lines[idx].trim()}`);
    cues.push({ start, end, text: lines.slice(idx + 1).join('\n').replace(/\s+$/, '') });
  }
  return { kind: 'srt', cues };
}

function stringifySrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

/**
 * ASS/SSA 解析：保留除事件时间以外的每一行原样，只改 Start/End。
 * `Format:` 行的字段顺序可以被人改过，所以按表头找下标，不写死位置。
 * 文本字段可能含逗号，所以只按前 n-1 个逗号切，剩下整段算文本。
 */
function parseAss(text) {
  const raw = String(text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const evStart = lines.findIndex((l) => /^\[events\]$/i.test(l.trim()));
  if (evStart < 0) throw new Error('ASS 里没有 [Events] 段');
  let fmt = null;
  const events = [];
  const pre = lines.slice(0, evStart + 1);
  const rest = lines.slice(evStart + 1);
  const out = [];
  for (const line of rest) {
    const fm = /^Format:\s*(.*)$/i.exec(line);
    if (fm) { fmt = fm[1].split(',').map((x) => x.trim().toLowerCase()); out.push({ kind: 'keep', line }); continue; }
    const cm = /^Comment:/i.exec(line);
    if (cm) { out.push({ kind: 'keep', line }); continue; }        // 注释行原样留着，不参与重排
    const dm = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!dm) { out.push({ kind: 'keep', line }); continue; }
    if (!fmt) throw new Error('ASS 的 [Events] 段缺 Format: 表头，无法定位时间字段');
    const si = fmt.indexOf('start');
    const ei = fmt.indexOf('end');
    if (si < 0 || ei < 0) throw new Error('ASS 的 Format 表头里没有 Start/End 字段，无法重排时间');
    const fields = splitAss(dm[1], fmt.length);
    const start = parseAssTime(fields[si]);
    const end = parseAssTime(fields[ei]);
    if (start === null || end === null) throw new Error(`ASS 时间字段无法解析：${line.trim()}`);
    out.push({ kind: 'event', prefix: 'Dialogue', fields, start, end, si, ei, raw: line });
    events.push({ start, end });
  }
  return { kind: 'ass', pre, body: out, header: pre.join('\n'), format: fmt, cues: events };
}

function splitAss(value, n) {
  const parts = [];
  let rest = value;
  for (let i = 0; i < n - 1; i++) {
    const c = rest.indexOf(',');
    if (c < 0) break;
    parts.push(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  parts.push(rest);
  return parts;
}

/** 把改了时间的字段按 ASS 规则拼回去（等号两侧的空格与源一致，直接原样保留字段）。 */
function setAssTime(node, start, end) {
  const fields = [...node.fields];
  fields[node.si] = fmtAssTime(start);
  fields[node.ei] = fmtAssTime(end);
  return `${node.prefix}: ${fields.join(',')}`;
}

/* ------------------------------------------------------------------ 重新计时 */

/**
 * 把源时刻的 cue 列表映射到成片时刻。
 *
 * 规则（与"删掉中间一段"的直觉一致）：
 *  - cue 的**起点**必须落在某条保留区间内，否则整条丢掉（起点被删了，后半句没有上下文）；
 *  - 结尾超过该区间末尾就截断；跨到下一条保留区间的部分**不**重复出现（同一条字幕
 *    在拼接后重播一次会很怪，主流字幕编辑器也是截断）；
 *  - 截断后长度为零的丢掉。
 *
 * @param {Array<{start:number,end:number}>} cues 源时刻
 * @param {Array<{start:number,end:number}>} keeps 保留区间（源时刻，已按成片顺序）
 * @param {number[]} progStarts 每条保留区间在成片里的起点
 */
function retime(cues, keeps, progStarts) {
  const out = [];
  cues.forEach((c, index) => {
    const k = keeps.findIndex((seg) => c.start >= seg.start - 1e-6 && c.start < seg.end - 1e-6);
    if (k < 0) return;
    const seg = keeps[k];
    const base = (progStarts && progStarts[k]) || 0;
    const start = base + (c.start - seg.start);
    const end = base + (Math.min(c.end, seg.end) - seg.start);
    if (end - start <= 1e-6) return;
    out.push(Object.assign({}, c, {
      from: index,
      start: Math.round(start * 1e6) / 1e6,
      end: Math.round(end * 1e6) / 1e6,
    }));
  });
  return out;
}

/**
 * 把重排后的时刻写回原文本。
 * `cues` 是 `retime()` 的产物：只包含活下来的 cue，每条带 `from`（源里的第几条），
 * 所以 SRT 直接按新列表输出，ASS 按 `from` 决定哪些 Dialogue 留下、时间改成多少。
 * 少了 from（手工传进来的列表）就要求条数一致，否则宁可不写。
 */
function applyRetime(doc, cues) {
  if (doc.kind === 'srt') return stringifySrt(cues);
  const events = doc.body.filter((n) => n.kind === 'event');
  const byIndex = new Map();
  const traceable = cues.every((c) => Number.isInteger(c.from));
  if (traceable) {
    for (const c of cues) {
      if (byIndex.has(c.from)) throw new Error(`字幕重排结果里第 ${c.from} 条出现了两次，不敢写`);
      byIndex.set(c.from, c);
    }
  } else {
    if (events.length !== cues.length) {
      throw new Error(`字幕条数对不上（原 ${events.length} / 重排后 ${cues.length}），不能交这份字幕`);
    }
    events.forEach((_, i) => byIndex.set(i, cues[i]));
  }
  let i = 0;
  const body = doc.body.map((n) => {
    if (n.kind !== 'event') return n.line;
    const src = i++;
    const c = byIndex.get(src);
    if (!c) return null;                     // 这条区间的字幕被删掉了：整行不写
    return setAssTime(n, c.start, c.end);
  }).filter((l) => l !== null).join('\n');
  // 表头（[Script Info] / [V4+ Styles]）必须一起写回去：只有 [Events] 的文本
  // ffmpeg 认不出来，当输入打开就报 Invalid data（实测）。
  return `${doc.pre.join('\n')}\n${body}\n`;
}

/** 能重排的文本字幕编码（ffprobe 的 codec_name）。 */
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa']);

function isTextSubtitle(codec) {
  return TEXT_SUB_CODECS.has(String(codec || '').toLowerCase());
}

module.exports = {
  parseSrt, stringifySrt, parseAss, setAssTime, applyRetime, retime,
  parseSrtTime, fmtSrtTime, parseAssTime, fmtAssTime, isTextSubtitle, TEXT_SUB_CODECS,
};
