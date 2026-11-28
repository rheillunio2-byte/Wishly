// Depth & motion layer: pointer tilt on cards, 3D hero deck parallax, count-up numbers.
// Purely visual: no app logic. Disabled for reduced-motion users; tilt only on devices with a real pointer.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

if (!reduce) {
  if (finePointer) {
    let el = null, rect = null, raf = 0, ev = null;
    const SEL = ".wish-card:not(.skeleton), .stat-card";
    const reset = n => { n.classList.remove("tilting"); n.style.removeProperty("--rx"); n.style.removeProperty("--ry"); };
    const apply = () => {
      raf = 0; if (!el || !rect) return;
      const x = (ev.clientX - rect.left) / rect.width, y = (ev.clientY - rect.top) / rect.height;
      const max = el.classList.contains("stat-card") ? 6 : 8;
      el.style.setProperty("--ry", ((x - 0.5) * 2 * max).toFixed(2) + "deg");
      el.style.setProperty("--rx", ((0.5 - y) * 2 * max).toFixed(2) + "deg");
      el.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
      el.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    };
    document.addEventListener("pointermove", e => {
      const hero = e.target.closest?.(".hero");
      if (hero) {
        const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        hero.style.setProperty("--px", (x * 100).toFixed(1) + "%"); hero.style.setProperty("--py", (y * 100).toFixed(1) + "%");
        const deck = hero.querySelector(".deck");
        if (deck) { deck.classList.add("live"); deck.style.setProperty("--ry", (-16 + (x - 0.5) * 36).toFixed(1) + "deg"); deck.style.setProperty("--rx", (10 + (0.5 - y) * 22).toFixed(1) + "deg"); }
      } else {
        const d = document.querySelector(".deck.live");
        if (d) { d.classList.remove("live"); d.style.removeProperty("--rx"); d.style.removeProperty("--ry"); }
      }
      const t = e.target.closest?.(SEL) || null;
      if (t !== el) { if (el) reset(el); el = t; rect = t ? t.getBoundingClientRect() : null; if (t) t.classList.add("tilting"); }
      if (el) { ev = e; if (!raf) raf = requestAnimationFrame(apply); }
    }, { passive: true });
    document.addEventListener("pointerleave", () => { if (el) reset(el); el = null; }, true);
    window.addEventListener("scroll", () => { if (el) rect = el.getBoundingClientRect(); }, { passive: true });
  }

  // Count-up for numeric stats (final text is always restored exactly).
  const done = new WeakSet();
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const n = en.target; io.unobserve(n);
      const m = /^(\D*?)(\d[\d,]*)(\.\d+)?(\D*)$/.exec(n.textContent.trim());
      if (!m) continue;
      const [, pre, whole, dec = "", post] = m;
      const target = parseFloat(whole.replace(/,/g, "") + dec), commas = whole.includes(","), digits = dec ? dec.length - 1 : 0, original = n.textContent;
      if (!isFinite(target) || target <= 0 || target > 1e9) continue;
      const t0 = performance.now(), dur = 1000;
      const step = now => {
        const p = Math.min(1, (now - t0) / dur), v = target * (1 - Math.pow(1 - p, 3));
        n.textContent = p >= 1 ? original : pre + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: commas }) + post;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.4 });
  const scan = root => root.querySelectorAll?.(".impact-strip strong, .stat-card strong").forEach(n => { if (!done.has(n)) { done.add(n); io.observe(n); } });
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) scan(n.matches?.(".impact-strip,.stat-card") ? n.parentNode : n); }))).observe(document.body, { childList: true, subtree: true });
  scan(document);
}
