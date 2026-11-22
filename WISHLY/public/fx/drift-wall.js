// DriftWall — vanilla port of the React Bits <DriftWall /> component (styles live in drift-wall.css).
// Usage: const fx = createDriftWall(containerEl, { items: [{ image, title?, href? }], columns: 5, ... });
//        fx.update({...}) changes any option · fx.destroy() removes it.
// Extra option vs. the React version: `decorative: true` hides the wall from assistive tech and removes the tiles
// from the tab order (use it when the wall is background art, e.g. behind a login form).

const DEFAULT_ITEMS = Array.from({ length: 15 }, (_, i) => {
  const ids = [1015, 1025, 1039, 1043, 1044, 1050, 1062, 1069, 1074, 1080, 1084, 106, 110, 133, 164];
  return { image: `https://picsum.photos/id/${ids[i % ids.length]}/600/400`, title: `Tile ${i + 1}`, href: undefined };
});

const DEFAULTS = {
  items: DEFAULT_ITEMS,
  columns: 5,
  tileWidth: 200,
  tileHeight: 132,
  gap: 18,
  radius: 14,
  tilt: 16,
  turn: -14,
  roll: 0,
  perspective: 1200,
  depth: 120,
  speed: 42,
  direction: 'up',
  variance: 0.45,
  parallax: 0.6,
  pauseOnHover: false,
  lift: 64,
  fade: 0.6,
  dim: 0.55,
  grayscale: false,
  overlayColor: '#060010',
  className: '',
  style: {},
  decorative: false
};

const columnFactor = (index, variance) => {
  const pseudo = ((index * 0.6180339887 + 0.35) % 1) * 2 - 1;
  return 1 + variance * pseudo;
};

export function createDriftWall(container, options = {}) {
  let o = { ...DEFAULTS, ...options };
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = mq.matches;

  const root = document.createElement('div');
  const plane = document.createElement('div');
  plane.className = 'drift-wall__plane';
  root.appendChild(plane);
  container.appendChild(root);

  let columnItems = [];
  let columnMeta = [];
  let baseVelocities = [];
  let trackEls = [];
  let builtKey = '';
  let containerHeight = 600;

  let offsets = [];
  let velocities = [];
  let hoveredCol = -1;
  let wallHovered = false;
  let activeId = null;
  let activeEl = null;
  let pointer = { x: 0, y: 0 };
  const pointerDamped = { x: 0, y: 0 };
  let lastTs = null;
  let raf = null;

  const compute = () => {
    const { items, columns, tileHeight, gap, speed, direction, variance } = o;
    const cols = Array.from({ length: columns }, () => []);
    items.forEach((item, i) => cols[i % columns].push(item));
    columnItems = cols.map(col => (col.length ? col : items.slice(0, 1)));
    const unit = tileHeight + gap;
    columnMeta = columnItems.map(col => {
      const copyHeight = Math.max(unit, col.length * unit);
      const copies = Math.max(2, Math.ceil((containerHeight * 1.6) / copyHeight) + 1);
      return { copyHeight, copies };
    });
    const dirSign = direction === 'up' ? 1 : -1;
    baseVelocities = columnItems.map((_, c) => speed * columnFactor(c, variance) * dirSign * (c % 2 === 0 ? 1 : -1));
  };

  const applyClassAndVars = () => {
    root.className = ['drift-wall', reduced ? 'drift-wall--reduced' : '', o.className].filter(Boolean).join(' ');
    if (o.decorative) {
      root.setAttribute('aria-hidden', 'true');
      root.removeAttribute('role');
      root.removeAttribute('aria-label');
    } else {
      root.removeAttribute('aria-hidden');
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', 'Drifting wall of tiles');
    }
    const vars = {
      '--dw-tile-w': `${o.tileWidth}px`,
      '--dw-tile-h': `${o.tileHeight}px`,
      '--dw-gap': `${o.gap}px`,
      '--dw-radius': `${o.radius}px`,
      '--dw-perspective': `${o.perspective}px`,
      '--dw-lift': `${o.lift}px`,
      '--dw-dim': o.dim,
      '--dw-gray': o.grayscale ? 1 : 0,
      '--dw-overlay': o.overlayColor,
      '--dw-edge': `${Math.max(0, (1 - o.fade) * 100)}%`,
      ...o.style
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, String(v));
  };

  const setActive = (id, col, el) => {
    if (activeEl && activeEl !== el) activeEl.classList.remove('is-active');
    activeId = id;
    hoveredCol = col;
    activeEl = el;
    if (el) el.classList.add('is-active');
  };
  const release = () => setActive(null, -1, null);

  const makeTile = (item, id, colIndex) => {
    const tile = document.createElement(item.href && !o.decorative ? 'a' : 'div');
    tile.className = 'drift-wall__tile';
    tile.dataset.tileId = id;
    tile.dataset.col = String(colIndex);
    if (tile.tagName === 'A') {
      tile.href = item.href;
      tile.target = '_blank';
      tile.rel = 'noreferrer noopener';
    } else if (!o.decorative) {
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', item.title ?? 'tile');
    }
    const inner = document.createElement('span');
    inner.className = 'drift-wall__inner';
    const img = document.createElement('img');
    img.src = item.image;
    img.alt = o.decorative ? '' : (item.title ?? '');
    img.decoding = 'async';
    img.draggable = false;
    const overlay = document.createElement('span');
    overlay.className = 'drift-wall__overlay';
    overlay.setAttribute('aria-hidden', 'true');
    inner.append(img, overlay);
    tile.appendChild(inner);
    return tile;
  };

  // (Re)build the DOM only when the structure changes (items / columns / sizes / number of copies).
  const build = () => {
    const key = JSON.stringify([o.items, o.columns, o.tileHeight, o.gap, o.decorative, columnMeta.map(m => m.copies)]);
    if (key === builtKey) return;
    builtKey = key;
    release();
    plane.textContent = '';
    trackEls = [];
    columnItems.forEach((col, c) => {
      const colEl = document.createElement('div');
      colEl.className = 'drift-wall__col';
      const track = document.createElement('div');
      track.className = 'drift-wall__track';
      for (let copy = 0; copy < columnMeta[c].copies; copy++) {
        col.forEach((item, i) => track.appendChild(makeTile(item, `${c}-${copy}-${i}`, c)));
      }
      colEl.appendChild(track);
      plane.appendChild(colEl);
      trackEls[c] = track;
    });
    offsets = columnMeta.map((meta, c) => {
      const prev = offsets[c];
      return prev !== undefined ? prev % meta.copyHeight : meta.copyHeight * ((c * 0.37) % 1);
    });
    velocities = columnItems.map((_, c) => velocities[c] ?? 0);
  };

  const applyPlaneTransform = (px, py) => {
    plane.style.transform =
      `translate(-50%, -50%) scale(1.18) ` +
      `rotateX(${o.tilt + py}deg) rotateY(${o.turn + px}deg) rotateZ(${o.roll}deg) ` +
      `translateZ(${-o.depth}px)`;
  };

  const animate = ts => {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min(0.05, Math.max(0, ts - lastTs) / 1000);
    lastTs = ts;

    const maxTilt = o.parallax * 8;
    const targetX = pointer.x * maxTilt;
    const targetY = -pointer.y * maxTilt;
    const damp = 1 - Math.exp(-dt / 0.12);
    pointerDamped.x += (targetX - pointerDamped.x) * damp;
    pointerDamped.y += (targetY - pointerDamped.y) * damp;
    applyPlaneTransform(pointerDamped.x, pointerDamped.y);

    for (let c = 0; c < trackEls.length; c++) {
      const meta = columnMeta[c];
      const el = trackEls[c];
      if (!meta || !el) continue;
      if (!reduced) {
        const paused = wallHovered && o.pauseOnHover;
        const factor = paused || hoveredCol === c ? 0 : 1;
        const target = baseVelocities[c] * factor;
        const ease = 1 - Math.exp(-dt / (target === 0 ? 0.16 : 0.28));
        velocities[c] += (target - velocities[c]) * ease;
        let next = (offsets[c] ?? 0) + velocities[c] * dt;
        next = ((next % meta.copyHeight) + meta.copyHeight) % meta.copyHeight;
        offsets[c] = next;
      }
      el.style.transform = `translate3d(0, ${-(offsets[c] ?? 0)}px, 0)`;
    }
    raf = requestAnimationFrame(animate);
  };

  const start = () => {
    if (raf === null) raf = requestAnimationFrame(animate);
  };
  const stop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    lastTs = null;
  };

  const onPointerMove = e => {
    const rect = root.getBoundingClientRect();
    if (!rect.width) return;
    if (o.parallax > 0 && !reduced) {
      pointer = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
    }
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const tile = hit && hit.closest ? hit.closest('[data-tile-id]') : null;
    if (!tile || !root.contains(tile)) return;
    const id = tile.dataset.tileId;
    if (id === activeId) return;
    setActive(id, Number(tile.dataset.col), tile);
  };
  const onPointerEnter = () => {
    wallHovered = true;
  };
  const onPointerLeave = () => {
    wallHovered = false;
    pointer = { x: 0, y: 0 };
    release();
  };
  const onFocusIn = e => {
    const tile = e.target.closest?.('[data-tile-id]');
    if (tile) setActive(tile.dataset.tileId, Number(tile.dataset.col), tile);
  };
  const onFocusOut = release;
  const onMotionChange = e => {
    reduced = e.matches;
    applyClassAndVars();
  };

  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerenter', onPointerEnter);
  root.addEventListener('pointerleave', onPointerLeave);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  mq.addEventListener('change', onMotionChange);

  // Track the container: follow its height (to size the tile loop) and sleep while it's hidden (display:none).
  const refresh = () => {
    compute();
    applyClassAndVars();
    build();
  };
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (!width || !height) {
      stop();
      return;
    }
    if (Math.abs(height - containerHeight) > 1) {
      containerHeight = height;
      refresh();
    }
    start();
  });
  ro.observe(container);

  containerHeight = container.clientHeight || 600;
  refresh();
  applyPlaneTransform(0, 0);
  if (container.clientWidth) start();

  return {
    update(next = {}) {
      o = { ...o, ...next };
      refresh();
    },
    destroy() {
      stop();
      ro.disconnect();
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerenter', onPointerEnter);
      root.removeEventListener('pointerleave', onPointerLeave);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      mq.removeEventListener('change', onMotionChange);
      root.remove();
    }
  };
}
