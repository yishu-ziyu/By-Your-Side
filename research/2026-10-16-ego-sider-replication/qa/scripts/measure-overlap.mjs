// Measure sideagent label/pill vs page controls. Used as after.check in run-task.
// Returns JSON-serializable object.
(() => {
  const controls = [...document.querySelectorAll('button, a, input, textarea, select, [role="button"]')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0;
    })
    .map(el => {
      const r = el.getBoundingClientRect();
      return { text: (el.innerText || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 40), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    });
  const hosts = [...document.querySelectorAll('[data-sideagent-overlay]')];
  const labels = [];
  const rings = [];
  for (const h of hosts) {
    const root = h.shadowRoot || h;
    for (const el of root.querySelectorAll('.point-cap, .cap, [class*="point-cap"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      labels.push({ kind: h.getAttribute('data-sideagent-overlay') || '?', text: (el.textContent || '').trim().slice(0, 60), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, small: el.classList.contains('small') });
    }
    for (const el of root.querySelectorAll('.ring, .mark-ring, [class*="ring"], canvas, svg')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      rings.push({ kind: h.getAttribute('data-sideagent-overlay') || '?', left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, tag: el.tagName });
    }
  }
  const overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  const area = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const send = controls.find(c => /^Send$/i.test(c.text));
  const draft = controls.find(c => /Save draft/i.test(c.text));
  const discard = controls.find(c => /Discard/i.test(c.text));
  const hits = [];
  for (const lab of labels) {
    for (const c of controls) {
      if (!overlap(lab, c)) continue;
      // Ignore the control the pill is meant to name if text matches
      const named = lab.text.includes(c.text) || (c.text && lab.text.includes(`「${c.text}」`));
      hits.push({ label: lab.text, small: lab.small, control: c.text, area: Math.round(area(lab, c)), named });
    }
  }
  const sendCovered = send ? hits.some(h => h.control === send.text && !h.named && h.area > 20) : null;
  const wrongCovers = hits.filter(h => !h.named && h.area > 20);
  return {
    nLabels: labels.length,
    nRings: rings.length,
    labels,
    send: send || null,
    draft: draft || null,
    discard: discard || null,
    hits,
    wrongCovers,
    sendCovered,
    hasSmallZheli: labels.some(l => l.small || l.text === '在这里' || l.text.includes('在这里')),
    pass: sendCovered === false && wrongCovers.length === 0
  };
})()
