// 两边共用：同一段回答、同一条「模型实际到达」时间表（固定种子，两边逐毫秒一致）。
(function () {
  function rng(seed) { // mulberry32
    return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  // 文字取自 Claude 实测报告（三段黑洞）。为了顺带演示「半截 Markdown」，把两个术语改成了 **粗体**。
  const TEXT = [
    "黑洞是时空中引力极强的区域，强到连光都无法逃脱。它的边界叫**事件视界**，任何东西一旦越过，就再也回不来。黑洞通常诞生于大质量恒星的生命末期：核燃料耗尽后，内部压力再也撑不住自身引力，物质向中心急剧坍缩，形成所谓的“奇点”。",
    "按质量，黑洞大致分几类。恒星级黑洞是太阳质量的几倍到几十倍；超大质量黑洞盘踞在星系中心，可达数百万甚至数十亿倍太阳质量，银河系中心的人马座A*约为四百万倍。",
    "黑洞也是现代物理最深的谜题之一。霍金提出，由于量子效应，黑洞会极其缓慢地向外辐射能量，最终可能完全蒸发，这被称为**霍金辐射**。",
  ].join("\n\n");

  const T = { user: 400, think: 900, swap: 3000, answer: 5200, end: 15600 };
  const STALL_AT = TEXT.indexOf("超大质量黑洞");
  const STALL_MS = 1050;

  // 模型到达：一阵一阵。每阵 2～28 字，阵间 40～210ms，偶尔 380～540ms；第二段中间卡 1.05 秒。
  function arrivals() {
    const r = rng(20261011);
    const out = []; let t = 0; let p = 0; let stalled = false;
    while (p < TEXT.length) {
      let n = r() < 0.15 ? 2 + Math.floor(r() * 3) : 6 + Math.floor(r() * 23);
      if (!stalled && p < STALL_AT && p + n > STALL_AT) n = STALL_AT - p;
      out.push({ t: Math.round(t), text: TEXT.slice(p, p + n) });
      p += n;
      if (!stalled && p === STALL_AT) { t += STALL_MS; stalled = true; continue; }
      t += r() < 0.1 ? 380 + r() * 160 : 40 + r() * 170;
    }
    return out;
  }

  window.BYS_STREAM = { TEXT, T, STALL_AT, STALL_MS, arrivals: arrivals(), rng };
})();
