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
      d.__dragging = true;
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
      d.__dragging = false;
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
  // --- Focus/highlight helpers
  function resolveHighlightCat(state) {
    const v =
      state?.legendHighlightCat ??
      state?.highlightedCategory ??
      state?.hoverCat ??
      state?.haloCat;
    return typeof v === "string" && v.length ? v : null;
  }

  function focusCatId() {
    const hi = resolveHighlightCat(state);
    return hi ? `cat:${hi}` : null;
  }

  function isFocusCat(n) {
    const id = focusCatId();
    return !!id && n?.kind === "cat" && n?.id === id;
  }

  // Cached focus meta for this tick (kept in sync via resolveHighlightCat(state))
  function getFocusMeta() {
    const id = focusCatId();
    if (!id) return null;
    const cx = width * 0.5;
    const cy = height * 0.5;
    return { id, cx, cy };
  }

  function isFocusId(id) {
    const meta = getFocusMeta();
    return !!meta && id === meta.id;
  }

  // ---------------------------------------------------------------------------
  // Deterministic seeding (prevents NaN targets / unstable layouts)
  // ---------------------------------------------------------------------------
  function hash32(str) {
    const s = String(str ?? "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function jitter01(id, salt) {
    const h = hash32(`${id}::${salt}`);
    return (h & 0xffff) / 0xffff; // 0..1
  }

  function seedNodePositions() {
    // Group by kind so we can distribute Y positions in a stable way.
    const groups = { source: [], type: [], cat: [] };
    for (const n of nodes || []) {
      const k = n?.kind === "source" || n?.kind === "type" ? n.kind : "cat";
      groups[k].push(n);
    }

    for (const kind of ["source", "type", "cat"]) {
      const list = groups[kind];
      const m = list.length || 1;

      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const id = n?.id || `${kind}:${i}`;

        // X seed: band lane + small deterministic jitter
        if (!Number.isFinite(n.x)) {
          const j = (jitter01(id, "x") - 0.5) * 48;
          n.x = bandX(width, kind, band) + j;
        }

        // Y seed: evenly spaced + small deterministic jitter
        if (!Number.isFinite(n.y)) {
          const base = ((i + 1) / (m + 1)) * height;
          const j = (jitter01(id, "y") - 0.5) * 120;
          n.y = Math.max(24, Math.min(height - 24, base + j));
        }

        if (!Number.isFinite(n.vx)) n.vx = 0;
        if (!Number.isFinite(n.vy)) n.vy = 0;

        // Stable seeds used as force targets (avoid using d.y as a moving target)
        if (!Number.isFinite(n.__seedX)) n.__seedX = n.x;
        if (!Number.isFinite(n.__seedY)) n.__seedY = n.y;
      }
    }
  }

  // Seed once at start to avoid NaN forces (forceY uses d.y for non-focus nodes).
  seedNodePositions();

  // ---------------------------------------------------------------------------
  // Focus pinning (reliable centering)
  // ---------------------------------------------------------------------------
  let __lastPinnedFocusId = null;
  function applyFocusPin() {
    const id = focusCatId();

    // If focus cleared: release ALL focus pins.
    if (!id) {
      __lastPinnedFocusId = null;
      for (const n of nodes || []) {
        if (n?.__focusPinned) {
          n.fx = null;
          n.fy = null;
          n.__focusPinned = false;
        }
      }
      return;
    }

    // Focus changed: aggressively unpin previous focused node so it cannot remain
    // in the center and evade focusRepel due to fx/fy.
    if (__lastPinnedFocusId && __lastPinnedFocusId !== id) {
      for (const n of nodes || []) {
        if (n?.kind === "cat" && n?.id === __lastPinnedFocusId) {
          if (n.__focusPinned) {
            n.fx = null;
            n.fy = null;
            n.__focusPinned = false;
          }
          // Give it a deterministic kick away from center to avoid "stuck under".
          const cx = width * 0.5;
          const cy = height * 0.5;
          const dx = (n.x - cx) || (Math.random() - 0.5);
          const dy = (n.y - cy) || (Math.random() - 0.5);
          const dist = Math.hypot(dx, dy) || 1;
          const ux = dx / dist;
          const uy = dy / dist;
          n.vx = (n.vx || 0) + ux * 2.8;
          n.vy = (n.vy || 0) + uy * 2.8;
        }
      }
    }

    // Safety: release any stale focus pins (except the current focus).
    for (const n of nodes || []) {
      if (n?.__focusPinned && !(n?.kind === "cat" && n?.id === id)) {
        n.fx = null;
        n.fy = null;
        n.__focusPinned = false;
      }
    }

    __lastPinnedFocusId = id;

    // Pin current focused cat node to center (unless user is actively dragging it).
    const cx = width * 0.5;
    const cy = height * 0.5;

    for (const n of nodes || []) {
      if (n?.kind !== "cat" || n?.id !== id) continue;

      if (!n.__dragging) {
        n.fx = cx;
        n.fy = cy;
        n.x = cx;
        n.y = cy;
        n.__focusPinned = true;
      }
      break;
    }
  }

  // Dedicated focus force: gently but reliably pulls the highlighted category toward center.
  // This is more robust than only using forceX/forceY strengths when the layout is crowded.
  function focusForce(alpha) {
    const id = focusCatId();
    if (!id) return;

    // Pinning is handled by applyFocusPin() (fx/fy). Keep this force as a no-op.
    // (Retained to avoid changing external expectations.)
    return;
  }

  focusForce.initialize = () => {};

  // ---- DOM-accurate edge trimming
  const EDGE_PAD = 8;
  const MEASURE_PAD = 10; // breathing room for glow/halo

  // Cache measured DOM half-sizes so we don't trigger layout on every tick.
  // id -> { rx, ry, w, h }
  const halfSizeById = new Map();
  let _tickCount = 0;

  function refreshMeasurements(force = false) {
    // Measure once initially, then only occasionally. Force when focus changes.
    if (!force && _tickCount > 0 && _tickCount % 6 !== 0) return;

    for (const n of nodes || []) {
      const id = n?.id;
      if (!id) continue;
      const el = nodeElById.get(id);
      if (!el) continue;

      const w = el.offsetWidth || 0;
      const h = el.offsetHeight || 0;
      if (!(w > 0 && h > 0)) continue;

      const prev = halfSizeById.get(id);
      if (!prev || prev.w !== w || prev.h !== h) {
        halfSizeById.set(id, { rx: w / 2, ry: h / 2, w, h });
      }
    }
  }

  function fallbackHalfSize(n) {
    const r = Number(collideR?.[n?.kind]) || 80;
    return { rx: r, ry: r, w: r * 2, h: r * 2 };
  }

  function getHalfSize(n) {
    const id = n?.id;
    if (!id) return fallbackHalfSize(n);
    return halfSizeById.get(id) || fallbackHalfSize(n);
  }

  function visualRadius(n) {
    const hs = getHalfSize(n);
    const rx = Math.max(12, (hs?.rx || 0) + MEASURE_PAD);
    const ry = Math.max(12, (hs?.ry || 0) + MEASURE_PAD);
    return Math.max(rx, ry);
  }

  function getFocusNode() {
    const meta = getFocusMeta();
    if (!meta) return null;
    // nodes are small; linear scan is fine and avoids extra state
    for (const n of nodes || []) {
      if (n?.kind === "cat" && n?.id === meta.id) return n;
    }
    return null;
  }

  function focusClearRadius() {
    const fn = getFocusNode();
    if (!fn) return 0;
    // Make a conservative "no-go" radius around the focused chip.
    return visualRadius(fn) + 70;
  }

  function clampNodeToBounds(n) {
    // Use cached DOM half-size so chips never get clipped (no layout reads here).
    const hs = getHalfSize(n);

    const rx = Math.max(12, (hs?.rx || 0) + MEASURE_PAD);
    const ry = Math.max(12, (hs?.ry || 0) + MEASURE_PAD);

    n.x = Math.max(rx, Math.min(width - rx, n.x));
    n.y = Math.max(ry, Math.min(height - ry, n.y));
  }

  function ellipseBoundaryDist(rx, ry, ux, uy) {
    const rx2 = rx * rx || 1;
    const ry2 = ry * ry || 1;
    const denom = Math.sqrt((ux * ux) / rx2 + (uy * uy) / ry2) || 1;
    return 1 / denom;
  }

  function boundaryOffset(n, ux, uy) {
    const hs = getHalfSize(n);
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

  // ---------------------------------------------------------------------------
  // Focus repulsion force
  // Prevents nodes from sitting underneath/behind the focused chip (z-order hides them).
  // This complements collide (pairwise) with a direct "keep-out" field around focus.
  // ---------------------------------------------------------------------------
  function focusRepel(alpha) {
    const meta = getFocusMeta();
    if (!meta) return;

    const fx = meta.cx;
    const fy = meta.cy;
    const focusNode = getFocusNode();
    const keepOut = focusClearRadius();
    if (!focusNode || !(keepOut > 0)) return;

    for (const n of nodes || []) {
      if (!n || n === focusNode) continue;

      // Do not fight the user while dragging (explicit flag from enableDrag).
      if (n.__dragging) continue;

      const dx = (n.x - fx) || 0;
      const dy = (n.y - fy) || 0;
      const dist = Math.hypot(dx, dy) || 0.0001;

      // Add the node's own visual radius so long pills get pushed far enough.
      const minDist = keepOut + visualRadius(n) + 20;
      if (dist >= minDist) continue;

      // Push outward with a smooth strength (stronger when deeper inside).
      const overlap = (minDist - dist);
      const ux = dx / dist;
      const uy = dy / dist;

      // Soft impulse
      const push = (overlap / minDist) * 1.55 * alpha;
      n.vx += ux * push;
      n.vy += uy * push;

      // Hard correction: if a node is significantly inside the keep-out region,
      // move it to the boundary immediately so it cannot stay hidden behind focus.
      // This avoids rare "stuck under" cases due to symmetric forces / low alpha.
      if (overlap > minDist * 0.35) {
        n.x = fx + ux * minDist;
        n.y = fy + uy * minDist;
        // Add a bit of outward velocity to prevent immediate re-penetration.
        n.vx += ux * 0.6;
        n.vy += uy * 0.6;
      }
    }
  }

  focusRepel.initialize = () => {};

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
    .force(
      "charge",
      d3.forceManyBody().strength(-420)
    )
    .force(
      "collide",
      d3
        .forceCollide()
        .radius((d) => {
          const base = visualRadius(d);
          const meta = getFocusMeta();
          if (!meta) return base;

          // Focused category: reserve substantially more space (halo + readability)
          if (d?.kind === "cat" && d?.id === meta.id) return base + 60;

          // Others: add a modest buffer while focus is active
          return base + 14;
        })
        .strength(1.0)
        .iterations(7)
    )
    .force(
      "y",
      d3
        .forceY((d) => {
          // Pull highlighted category toward center; keep others near their original seeded y.
          return isFocusCat(d) ? height * 0.5 : (Number.isFinite(d.__seedY) ? d.__seedY : d.y);
        })
        .strength((d) => (isFocusCat(d) ? 0.22 : 0.14))
    )
    .force(
      "x",
      d3
        .forceX((d) => {
          // Pull highlighted category toward center; keep others in their lane band.
          if (isFocusCat(d)) return width * 0.5;
          // Cats are allowed some horizontal freedom; types/sources stay in lanes.
          return d.kind === "cat" ? (Number.isFinite(d.__seedX) ? d.__seedX : d.x) : bandX(width, d.kind, band);
        })
        .strength((d) => {
          if (isFocusCat(d)) return 0.65;
          return d.kind === "type" ? 0.36 : 0.30;
        })
    )
    .force(
      "orbit",
      d3
        .forceRadial(
          (d) => {
            const meta = getFocusMeta();
            if (!meta) return 0;
            if (d?.kind === "cat" && d?.id === meta.id) return 0;

            // Ring radius scales with viewport and is also kept outside the focused chip.
            const base = Math.min(width, height) * 0.34;
            const ring = Math.max(140, Math.min(260, base));
            const minRing = focusClearRadius() + 60;
            return Math.max(ring, minRing);
          },
          width * 0.5,
          height * 0.5
        )
        .strength((d) => {
          const meta = getFocusMeta();
          if (!meta) return 0;
          if (d?.kind === "cat" && d?.id === meta.id) return 0;
          return 0.10;
        })
    )
    .force("focusRepel", focusRepel)
    .force("focus", focusForce);

  sim.alpha(1).alphaMin(0.01).alphaDecay(0.045);

  // Extra damping to reduce visible jitter when many nodes collide.
  // (Higher velocityDecay => more friction)
  sim.velocityDecay(0.62);

  enableDrag(d3, sim, nodesHost);

  // Prime DOM measurements once after nodes are bound (prevents early overlap/jitter).
  try { refreshMeasurements(true); } catch {}

  sim.on("tick", () => {
    _tickCount++;

    // Refresh cached DOM sizes occasionally to avoid layout thrash.
    const focusNow = getFocusMeta()?.id || null;
    if (runSimulation.__lastFocusId !== focusNow) {
      runSimulation.__lastFocusId = focusNow;
      refreshMeasurements(true);

      // Re-trigger rhythm envelope on focus change so the motion feels "on the beat".
      // Uses the same STOP_SAFE computed below (or fallback 4000).
      const stopMs = Number.isFinite(STOP_SAFE) && STOP_SAFE > 0 ? STOP_SAFE : 4000;
      scheduleSettlingEnvelope(stopMs);
    } else {
      refreshMeasurements(false);
    }

    // Ensure focus pin is applied continuously (highlight can change while sim is running).
    applyFocusPin();

    // Keep orbit center correct in case the host resizes.
    const orbit = sim.force("orbit");
    if (orbit && orbit.x && orbit.y) {
      orbit.x(width * 0.5);
      orbit.y(height * 0.5);
    }

    // clamp first
    for (const n of nodes) clampNodeToBounds(n);

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

  // ---------------------------------------------------------------------------
  // Timed settling envelope (driven by legendStopMs)
  // Purpose: reduce visible jitter by injecting energy briefly, then increasing
  // damping and letting the system settle before stop.
  // ---------------------------------------------------------------------------
  function scheduleSettlingEnvelope(stopMs) {
    const total = Math.max(800, Number(stopMs) || 0);

    // Clear any previous envelope timers
    if (runSimulation._settleTimers) {
      for (const t of runSimulation._settleTimers) clearTimeout(t);
    }
    runSimulation._settleTimers = [];

    // If timing.js provides a rhythm schedule, use it.
    const rhythmFn = typeof legendStopMs === "function" ? legendStopMs.rhythm : null;
    const events = typeof rhythmFn === "function" ? rhythmFn(state, total) : null;

    if (Array.isArray(events) && events.length) {
      // Apply first event immediately
      const first = events[0];
      if (first?.velocityDecay != null) sim.velocityDecay(first.velocityDecay);
      if (first?.alphaTarget != null) sim.alphaTarget(first.alphaTarget);
      if (first?.alphaBoost != null) sim.alpha(Math.max(sim.alpha(), first.alphaBoost)).restart();

      // Schedule remaining events
      for (let i = 1; i < events.length; i++) {
        const e = events[i];
        runSimulation._settleTimers.push(
          setTimeout(() => {
            try {
              if (e?.velocityDecay != null) sim.velocityDecay(e.velocityDecay);
              if (e?.alphaTarget != null) sim.alphaTarget(e.alphaTarget);
              if (e?.alphaBoost != null && e.alphaBoost > 0) {
                sim.alpha(Math.max(sim.alpha(), e.alphaBoost)).restart();
              }
            } catch {}
          }, Math.max(0, e.t | 0))
        );
      }
      return;
    }

    // Fallback (keine rhythm() verfügbar): einfache 3-Phasen Envelope
    const warmupMs = Math.max(120, Math.min(320, total * 0.10));
    const settleMs = Math.max(240, Math.min(820, total * 0.22));

    sim.alphaTarget(0.28);
    sim.velocityDecay(0.54);
    sim.alpha(Math.max(sim.alpha(), 0.45)).restart();

    runSimulation._settleTimers.push(
      setTimeout(() => {
        try {
          sim.alphaTarget(0.08);
          sim.velocityDecay(0.66);
          sim.alpha(Math.max(sim.alpha(), 0.22)).restart();
        } catch {}
      }, warmupMs)
    );

    runSimulation._settleTimers.push(
      setTimeout(() => {
        try {
          sim.alphaTarget(0);
          sim.velocityDecay(0.70);
        } catch {}
      }, warmupMs + settleMs)
    );
  }

  // stop timer
  const STOP_AFTER_MS = typeof legendStopMs === "function" ? legendStopMs(state) : 4000;
  const STOP_SAFE = Number.isFinite(STOP_AFTER_MS) && STOP_AFTER_MS > 0 ? STOP_AFTER_MS : 4000;

  // Use the stop duration as timing source for the settling envelope.
  scheduleSettlingEnvelope(STOP_SAFE);

  if (runSimulation._stopTimer) clearTimeout(runSimulation._stopTimer);
  runSimulation._stopTimer = setTimeout(() => {
    try { sim.stop(); } catch {}
    runSimulation._stopTimer = null;

    // Cleanup settle timers
    if (runSimulation._settleTimers) {
      for (const t of runSimulation._settleTimers) clearTimeout(t);
      runSimulation._settleTimers = null;
    }
  }, STOP_SAFE);

  return sim;
}