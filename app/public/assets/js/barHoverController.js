/**
 * barHoverController.js
 * =============================================================================
 * Orchestrates hover UX between Chart bars and Legend pills.
 *
 * Responsibilities:
 * - Normalize whatever the chart hover callback provides into a stable "hover model".
 * - Drive the legend halo (visual) AND broadcast semantic highlight via renderLegendHalo.js.
 * - Provide a tiny, ctx-free handler that renderer/chart can call.
 * - Include yearKey/type in the hover model when the chart provides it (so the inspector can slice details precisely).
 *
 * This module intentionally does NOT:
 * - compute aggregates
 * - mutate ctx.state
 * - know about inspector panels
 *
 * Export:
 * - createBarHoverController({ legendRootEl, getPillEl, getColor, onHoverModel })
 *   -> { onHover(payload), clear(), attachChartLeave(chartEl), _debug }
 * =============================================================================
 */

import { createLegendHalo } from "./renderLegendHalo.js";

function isEl(v) {
  return v && typeof v === "object" && v.nodeType === 1;
}

function pickFirst(...vals) {
  for (const v of vals) if (v != null) return v;
  return null;
}

function toStr(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : "";
}

function isMouseEventLike(v) {
  return v && typeof v === "object" && typeof v.type === "string" && "target" in v;
}

function normalizePayload(payload) {
  // Allow MouseEvent directly
  if (isMouseEventLike(payload)) {
    return {
      event: payload,
      cat: "",
      color: "",
      chipEl: null,
      yearKey: "",
      typ: "",
      raw: payload,
    };
  }

  const p = payload && typeof payload === "object" ? payload : {};
  const event = p.event || p.e || p.mouseEvent || null;

  const cat = toStr(p.cat ?? p?.bar?.cat);
  const color = toStr(p.color ?? p?.bar?.color ?? p?.bar?.fill);
  const yearKey = toStr(p.yearKey ?? p?.bar?.yearKey ?? p?.bar?.year ?? p?.bar?.x);
  const typ = toStr(p.typ ?? p?.bar?.typ ?? p?.bar?.type);
  const chipEl = pickFirst(p.chipEl, p?.dom?.chipEl, p?.nodes?.chipEl);

  return {
    event: event && typeof event === "object" ? event : null,
    cat,
    color,
    chipEl: isEl(chipEl) ? chipEl : null,
    yearKey,
    typ,
    raw: payload,
  };
}

/**
 * Default pill resolver
 * ---------------------------------------------------------------------------
 * Tries to find a legend pill for a given category using common patterns.
 */
function defaultGetPillEl({ legendRootEl, cat }) {
  if (!isEl(legendRootEl) || !cat) return null;

  const esc = (s) => CSS.escape(String(s));

  // Try data attributes first
  const byData = legendRootEl.querySelector(`[data-cat="${esc(cat)}"]`);
  if (isEl(byData)) return byData;

  // Last resort: strict textContent match inside pill-ish elements
  const candidates = legendRootEl.querySelectorAll(".legend-node--cat, .legend-chip");
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (t === cat) return el;
  }

  return null;
}

function defaultGetColor({ color }) {
  return color || "rgba(255,255,255,0.9)";
}

function getLocalPoint(legendRootEl, event) {
  if (!isEl(legendRootEl) || !event) return null;

  const cx = event.clientX;
  const cy = event.clientY;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const r = legendRootEl.getBoundingClientRect();
  return {
    x: cx - r.left,
    y: cy - r.top,
  };
}

function dispatchLegendEvent(rootEl, type, detail) {
  if (!isEl(rootEl)) return;
  try {
    rootEl.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // ignore (older environments)
  }
}

function broadcastHighlight(legendRootEl, { cat, yearKey }) {
  const c = toStr(cat);
  const y = toStr(yearKey);
  dispatchLegendEvent(legendRootEl, "legend:highlight", {
    cat: c || null,
    year: y || null,
  });
}

function broadcastClear(legendRootEl) {
  dispatchLegendEvent(legendRootEl, "legend:clearHighlight", {});
}

/**
 * createBarHoverController(...)
 */
export function createBarHoverController({
  legendRootEl,
  getPillEl,
  getColor,
  onHoverModel,
  strength = 0.85,

  // Sticky UX:
  // - When the pointer leaves a bar and the chart sends an "empty" hover payload (or none),
  //   we keep the last halo + inspector state.
  // - Clearing is driven by the next bar hover, or manually by caller via .clear().
  stickyHover = true,
  clearOnEmptyHover = false,
  clearOnChartLeave = false,
} = {}) {
  if (!isEl(legendRootEl)) {
    throw new Error("createBarHoverController: legendRootEl missing/invalid");
  }

  const halo = createLegendHalo(legendRootEl);

  const resolvePill = typeof getPillEl === "function" ? getPillEl : defaultGetPillEl;
  const resolveColor = typeof getColor === "function" ? getColor : defaultGetColor;
  const emit = typeof onHoverModel === "function" ? onHoverModel : null;

  let lastCacheKey = "";

  function emitHover(model) {
    emit?.(model);
  }

  function resolveCat(chipEl, n) {
    // Prefer semantic payload; fallback to DOM dataset.
    return n.cat || (isEl(chipEl) ? chipEl.dataset?.cat || "" : "");
  }

  function resolveSlice(n) {
    return {
      yearKey: n.yearKey || "",
      typ: n.typ || "",
    };
  }

  function cacheKeyForEl({ yearKey, cat, typ, color }) {
    const y = yearKey || "?";
    const c = cat || "?";
    const t = typ || "?";
    return `EL||${y}||${c}||${t}||${color}`;
  }

  function cacheKeyForPt({ yearKey, cat, typ, color, x, y }) {
    const yy = yearKey || "?";
    const c = cat || "?";
    const t = typ || "?";
    return `XY||${yy}||${c}||${t}||${color}||${x}||${y}`;
  }

  function clear() {
    lastCacheKey = "";
    // Visual halo cleanup + semantic clear.
    halo.hide(); // also broadcasts legend:highlight {cat:null}
    broadcastClear(legendRootEl);
    emitHover(null);
  }

  function onHover(payload) {
    const n = normalizePayload(payload);

    // Chart sometimes signals "no bar" with empty payloads.
    // In sticky mode we keep the last halo/model.
    const isEmptySignal = !n.event && !n.chipEl && !n.cat;
    if (isEmptySignal) {
      // Keep semantics of your current code:
      // only clear if caller wants it AND sticky is off.
      if (clearOnEmptyHover && !stickyHover) clear();
      return;
    }

    const chipEl = n.chipEl || resolvePill({ legendRootEl, cat: n.cat, payload: n.raw, event: n.event });

    const color = resolveColor({
      color: n.color,
      cat: n.cat,
      payload: n.raw,
      event: n.event,
      chipEl,
    });

    const cat = resolveCat(chipEl, n);
    const { yearKey, typ } = resolveSlice(n);

    // Prefer a concrete element: most stable (no geometry drift) and enables semantic highlight.
    if (isEl(chipEl)) {
      const key = cacheKeyForEl({ yearKey, cat, typ, color });
      console.log("[hover.key]", { key, lastCacheKey, cat, yearKey, typ, color });

      if (key === lastCacheKey) return;
      lastCacheKey = key;

      // IMPORTANT: pass `el` and `cat` so renderLegendHalo can broadcast highlight.
      halo.show({ el: chipEl, cat: cat || null, color, strength });
      // Semantic highlight (cat + year) — legend uses this to render year meta on the active chip.
      broadcastHighlight(legendRootEl, { cat, yearKey });

      emitHover({
        cat,
        yearKey,
        typ,
        color,
        chipEl,
        geo: null,
        raw: n.raw,
        event: n.event,
      });

      return;
    }

    // Fallback: use pointer position relative to legend root.
    // renderLegendHalo will hit-test to find a pill and can still broadcast highlight if it resolves one.
    const pt = n.event ? getLocalPoint(legendRootEl, n.event) : null;
    if (!pt) {
      if (!stickyHover) clear();
      return;
    }

    const rx = Math.round(pt.x);
    const ry = Math.round(pt.y);
    const key = cacheKeyForPt({ yearKey, cat: n.cat || "", typ, color, x: rx, y: ry });

    if (key === lastCacheKey) return;
    lastCacheKey = key;

    halo.show({ x: pt.x, y: pt.y, cat: n.cat || null, color, strength });
    // Semantic highlight (cat + year) — best-effort for XY hover.
    broadcastHighlight(legendRootEl, { cat: n.cat || "", yearKey });

    emitHover({
      cat: n.cat || "", // XY path cannot guarantee a DOM-derived cat
      yearKey,
      typ,
      color,
      chipEl: null,
      geo: { x: pt.x, y: pt.y, r: 18 },
      raw: n.raw,
      event: n.event,
    });
  }

  function attachChartLeave(chartEl) {
    if (!isEl(chartEl)) return;
    if (!clearOnChartLeave) return;

    chartEl.addEventListener("mouseleave", () => clear());
    chartEl.addEventListener("blur", () => clear());
  }

  return {
    onHover,
    clear,
    attachChartLeave,
    _debug: { halo },
  };
}