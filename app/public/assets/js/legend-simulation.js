// legend-simulation.js
// =============================================================================
// Legend simulation (D3 force + drag + edge trimming)
// - no DOM creation (but uses nodeElById for accurate trimming)
// =============================================================================

export function computeSize(mountEl, { minW = 320, minH = 220 } = {}) {
  const width = Math.max(minW, mountEl.clientWidth || 0);
  const height = Math.max(minH, mountEl.clientHeight || 0);
  return { width, height };
}

export function bandX(width, kind, band = { source: 0.18, type: 0.50, cat: 0.82 }) {
  if (kind === "source") return width * band.source;
  if (kind === "type") return width * band.type;
  return width * band.cat;
}

export function clampToBounds(n, width, height, collideR) {
  const r = Number(collideR?.[n?.kind]) || 80;
  n.x = Math.max(r, Math.min(width - r, n.x));
  n.y = Math.max(r, Math.min(height - r, n.y));
}

/**
 * Enable dragging on ALL nodes (HTML elements bound with d3.datum(node)).
 * Sets dataset.drag so click handlers can ignore synthetic click after drag.
 */
export function enableDrag(d3, sim, nodesHost) {
  const drag = d3
    .drag()
    .on("start", (event, d) => {
      d.fx = d.x;
      d.fy = d.y;
      if (!event.active) sim.alphaTarget(0.25).restart();
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;

      const srcEl = event.sourceEvent?.target;
      const nodeEl = srcEl && srcEl.closest ? srcEl.closest(".legend-node") : null;
      if (nodeEl) nodeEl.dataset.drag = "true";
    })
    .on("end", (event, d) => {
      d.fx = null;
      d.fy = null;
      if (!event.active) sim.alphaTarget(0);

      const srcEl = event.sourceEvent?.target;
      const nodeEl = srcEl && srcEl.closest ? srcEl.closest(".legend-node") : null;
      if (nodeEl) setTimeout(() => (nodeEl.dataset.drag = "false"), 0);
    });

  d3.select(nodesHost).selectAll(".legend-node").call(drag);
}

/**
 * Run simulation and keep SVG edges + HTML nodes in sync.
 * Uses DOM-accurate edge trimming (fixes “padding around nodes”).
 */
export function runSimulation({
  d3,
  nodes,
  links,
  linkSel,
  nodeElById,
  nodesHost,
  width,
  height,
  state,
  edgeConf,
  collideR,
  band,
  legendStopMs,
}) {
  const sim = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance((d) => edgeConf?.[d.kind]?.dist || 135)
        .strength(0.9)
    )
    .force("charge", d3.forceManyBody().strength(-520))
    .force(
      "collide",
      d3
        .forceCollide()
        .radius((d) => Number(collideR?.[d.kind]) || 80)
        .strength(1.0)
        .iterations(6)
    )
    .force("y", d3.forceY((d) => d.y).strength(0.14))
    .force(
      "x",
      d3.forceX((d) => bandX(width, d.kind, band)).strength((d) => (d.kind === "type" ? 0.36 : 0.30))
    );

  sim.alpha(1).alphaMin(0.01).alphaDecay(0.045);

  enableDrag(d3, sim, nodesHost);

  // ---- DOM-accurate edge trimming
  const EDGE_PAD = 3;
  const halfSizeById = new Map(); // id -> { rx, ry }

  function measureHalfSize(n) {
    const id = n?.id;
    if (!id) return null;

    const el = nodeElById.get(id);
    if (!el) return null;

    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    if (!(w > 0 && h > 0)) return null;

    const hs = { rx: w / 2, ry: h / 2 };
    halfSizeById.set(id, hs);
    return hs;
  }

  function fallbackHalfSize(n) {
    const r = Number(collideR?.[n?.kind]) || 80;
    return { rx: r, ry: r };
  }

  function ellipseBoundaryDist(rx, ry, ux, uy) {
    const rx2 = rx * rx || 1;
    const ry2 = ry * ry || 1;
    const denom = Math.sqrt((ux * ux) / rx2 + (uy * uy) / ry2) || 1;
    return 1 / denom;
  }

  function boundaryOffset(n, ux, uy) {
    const hs = measureHalfSize(n) || halfSizeById.get(n?.id) || fallbackHalfSize(n);
    const dist = ellipseBoundaryDist(hs.rx, hs.ry, ux, uy);
    return Math.max(6, dist - EDGE_PAD);
  }

  const trimmedEndpoints = (src, dst) => {
    const sx = Number(src?.x) || 0;
    const sy = Number(src?.y) || 0;
    const tx = Number(dst?.x) || 0;
    const ty = Number(dst?.y) || 0;

    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;

    const ux = dx / dist;
    const uy = dy / dist;

    const rs = boundaryOffset(src, ux, uy);
    const rt = boundaryOffset(dst, ux, uy);

    return {
      x1: sx + ux * rs,
      y1: sy + uy * rs,
      x2: tx - ux * rt,
      y2: ty - uy * rt,
    };
  };

  sim.on("tick", () => {
    // clamp first
    for (const n of nodes) clampToBounds(n, width, height, collideR);

    // links (trimmed)
    linkSel.each(function (d) {
      const p = trimmedEndpoints(d.source, d.target);
      d3.select(this).attr("x1", p.x1).attr("y1", p.y1).attr("x2", p.x2).attr("y2", p.y2);
    });

    // nodes
    for (const n of nodes) {
      const nodeEl = nodeElById.get(n.id);
      if (nodeEl) nodeEl.style.transform = `translate(${n.x}px, ${n.y}px) translate(-50%, -50%)`;
    }
  });

  // stop timer
  const STOP_AFTER_MS = typeof legendStopMs === "function" ? legendStopMs(state) : 4000;
  const STOP_SAFE = Number.isFinite(STOP_AFTER_MS) && STOP_AFTER_MS > 0 ? STOP_AFTER_MS : 4000;

  if (runSimulation._stopTimer) clearTimeout(runSimulation._stopTimer);
  runSimulation._stopTimer = setTimeout(() => {
    try { sim.stop(); } catch {}
    runSimulation._stopTimer = null;
  }, STOP_SAFE);

  return sim;
}