/**
 * barHoverController.js
 * =============================================================================
 * Orchestriert Hover UX zwischen Chart-Bars und Legend-Pills.
 *
 * Aufgaben:
 * - Normalisiert Chart-Hover-Payloads in ein stabiles Hover-Model.
 * - Steuert den Legend-Halo (visuell) und broadcastet semantische Highlight-Events.
 * - Liefert einen kleinen, ctx-freien Controller für renderer/chart.
 * - Enthält yearKey + typ/type, sofern das Chart sie liefert.
 *
 * Wichtige Contracts:
 * - Kategorie ist Option-A Identity: whitespace-sensitiv.
 *   -> Wir trimmen Kategorien NICHT; whitespace-only gilt als "leer".
 * - Typ kann als `type` (Chart) oder `typ` (legacy) kommen.
 *   -> Wir akzeptieren beides und halten `typ`/`type` synchron.
 *
 * Export:
 * - createBarHoverController({ legendRootEl, getPillEl, getColor, onHoverModel })
 *   -> { onHover(payload), clear(), attachChartLeave(chartEl), _debug }
 * =============================================================================
 */

import { createLegendHalo } from "./renderLegendHalo.js";

// -----------------------------------------------------------------------------
// DOM + Utility
// -----------------------------------------------------------------------------

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

function toId(v) {
  // Option A identity: preserve as-is, but treat whitespace-only as empty.
  const s = String(v ?? "");
  return s.trim().length ? s : "";
}

function isMouseEventLike(v) {
  return v && typeof v === "object" && typeof v.type === "string" && "target" in v;
}

// -----------------------------------------------------------------------------
// Payload normalization
// -----------------------------------------------------------------------------

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
      type: "",
      raw: payload,
    };
  }

  const p = payload && typeof payload === "object" ? payload : {};
  const event = p.event || p.e || p.mouseEvent || null;

  const cat = toId(p.cat ?? p?.bar?.cat);
  const color = toStr(p.color ?? p?.bar?.color ?? p?.bar?.fill);
  const yearKey = toStr(p.yearKey ?? p?.bar?.yearKey ?? p?.bar?.year ?? p?.bar?.x);

  // Chart emits `type`, legacy emits `typ`.
  const typeIn = toStr(p.type ?? p?.bar?.type);
  const typIn = toStr(p.typ ?? p?.bar?.typ);

  const chipEl = pickFirst(p.chipEl, p?.dom?.chipEl, p?.nodes?.chipEl);

  // Keep both in sync (do NOT coerce "?" here; that is a display/cache concern)
  const typ = typIn || typeIn;
  const type = typeIn || typIn;

  return {
    event: event && typeof event === "object" ? event : null,
    cat,
    color,
    chipEl: isEl(chipEl) ? chipEl : null,
    yearKey,
    typ,
    type,
    raw: payload,
  };
}

// -----------------------------------------------------------------------------
// Default pill resolvers
// -----------------------------------------------------------------------------

function defaultGetPillEl({ legendRootEl, cat }) {
  if (!isEl(legendRootEl) || !cat) return null;

  const esc = (s) => CSS.escape(String(s));

  // Prefer data attributes
  const byData = legendRootEl.querySelector(`[data-cat="${esc(cat)}"]`);
  if (isEl(byData)) return byData;

  // Fallback: strict text match
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

// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------

function getLocalPoint(legendRootEl, event) {
  if (!isEl(legendRootEl) || !event) return null;

  const cx = event.clientX;
  const cy = event.clientY;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const r = legendRootEl.getBoundingClientRect();
  return { x: cx - r.left, y: cy - r.top };
}

// -----------------------------------------------------------------------------
// Legend event bridge
// -----------------------------------------------------------------------------

function dispatchLegendEvent(rootEl, type, detail) {
  if (!isEl(rootEl)) return;
  try {
    rootEl.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // ignore (older environments)
  }
}

function broadcastHighlight(legendRootEl, { cat, yearKey }) {
  const c = toId(cat);
  const y = toStr(yearKey);
  dispatchLegendEvent(legendRootEl, "legend:highlight", {
    cat: c || null,
    year: y || null,
  });
}

function broadcastClear(legendRootEl) {
  dispatchLegendEvent(legendRootEl, "legend:clearHighlight", {});
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

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
  let lastModel = null;

  function emitHover(model) {
    lastModel = model;
    emit?.(model);
  }

  function resolveCat(chipEl, n) {
    // Prefer semantic payload; fallback to DOM dataset.
    return n.cat || (isEl(chipEl) ? toId(chipEl.dataset?.cat || "") : "");
  }

  function resolveSlice(n) {
    // Prefer typ; fallback to type.
    return {
      yearKey: n.yearKey || "",
      typ: n.typ || n.type || "",
      type: n.type || n.typ || "",
    };
  }

  function cacheKeyForEl({ yearKey, cat, typ, type, color }) {
    const y = yearKey || "?";
    const c = cat || "?";
    const t = typ || type || "?";
    return `EL||${y}||${c}||${t}||${color}`;
  }

  function cacheKeyForPt({ yearKey, cat, typ, type, color, x, y }) {
    const yy = yearKey || "?";
    const c = cat || "?";
    const t = typ || type || "?";
    return `XY||${yy}||${c}||${t}||${color}||${x}||${y}`;
  }

  function clear() {
    lastCacheKey = "";
    lastModel = null;

    // Visual halo cleanup + semantic clear.
    halo.hide();
    broadcastClear(legendRootEl);

    emitHover(null);
  }

  function onHover(payload) {
    const n = normalizePayload(payload);

    // Chart sometimes signals "no bar" with empty payloads.
    // In sticky mode we keep the last halo/model.
    const isEmptySignal = !n.event && !n.chipEl && !n.cat;
    if (isEmptySignal) {
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
    const { yearKey, typ, type } = resolveSlice(n);

    // Prefer a concrete element: stable + allows semantic highlight.
    if (isEl(chipEl)) {
      const key = cacheKeyForEl({ yearKey, cat, typ, type, color });
      if (key === lastCacheKey) return;
      lastCacheKey = key;

      halo.show({ el: chipEl, cat: cat || null, color, strength });
      broadcastHighlight(legendRootEl, { cat, yearKey });

      emitHover({
        cat,
        yearKey,
        typ,
        type,
        color,
        chipEl,
        geo: null,
        raw: n.raw,
        event: n.event,
      });

      return;
    }

    // Fallback: pointer position relative to legend root.
    const pt = n.event ? getLocalPoint(legendRootEl, n.event) : null;
    if (!pt) {
      if (!stickyHover) clear();
      return;
    }

    const rx = Math.round(pt.x);
    const ry = Math.round(pt.y);
    const key = cacheKeyForPt({ yearKey, cat: n.cat || "", typ, type, color, x: rx, y: ry });

    if (key === lastCacheKey) return;
    lastCacheKey = key;

    halo.show({ x: pt.x, y: pt.y, cat: n.cat || null, color, strength });
    broadcastHighlight(legendRootEl, { cat: n.cat || "", yearKey });

    emitHover({
      cat: n.cat || "",
      yearKey,
      typ,
      type,
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
    _debug: {
      halo,
      get lastCacheKey() {
        return lastCacheKey;
      },
      get lastModel() {
        return lastModel;
      },
    },
  };
}