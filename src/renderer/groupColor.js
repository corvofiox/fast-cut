'use strict';

/**
 * 分组配色：把"组号"映射成一个稳定的颜色。
 *
 * 为什么要有它（2026-10-18，用户反馈）：分了两组时，时间轴和片段栏都只写"组1"，
 * 两组都叫组1 就完全没法区分；光靠文字（组1/组2）在密集的胶片条上也不够快。
 * 颜色是**第二套编码**，和组号一一对应：组1 恒为青色、组2 恒为琥珀色……
 * 时间轴块、分组连线、右侧片段栏共用同一套色，三处对得上才算"能一眼区分"。
 *
 * 只依赖组号（1 起、按出现顺序），不依赖内部 id：撤销/拆分后组号会重排，
 * 颜色跟着组号走才不会出现"组1 是青色又是紫色"。
 */
(function () {
  'use strict';

  /**
   * 调色板：在深色底上互相可辨，且尽量照顾色盲——相邻两色不只靠色相区分，
   * 明度也拉开（青色偏亮、紫/玫瑰偏暗）。8 个够用：超过 8 组会循环，
   * 但那种规模下用户本来也记不住颜色，组号仍是主标识。
   */
  const PALETTE = [
    '#4fc3d9',   // 1 青
    '#e8b04b',   // 2 琥珀
    '#b08ce8',   // 3 紫
    '#e87b9a',   // 4 玫瑰
    '#9bd45f',   // 5 青柠
    '#5fa8e8',   // 6 天蓝
    '#e8845f',   // 7 珊瑚
    '#5fd4a8',   // 8 薄荷
  ];

  /** 组号（1 起）→ 颜色。组号非法时退回第 1 色，绝不返回 undefined（CSS 里会变成继承色）。 */
  function groupColorOf(no) {
    const n = Number(no);
    if (!Number.isFinite(n) || n < 1) return PALETTE[0];
    return PALETTE[(Math.round(n) - 1) % PALETTE.length];
  }

  /** 同色但带透明度：用于底纹、连线这类不该压住画面内容的地方。 */
  function groupTintOf(no, alpha) {
    const hex = groupColorOf(no).replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Number.isFinite(alpha) ? alpha : 0.16;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  window.groupColorOf = groupColorOf;
  window.groupTintOf = groupTintOf;
})();
