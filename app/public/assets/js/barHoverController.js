/**
 * barHoverController.js
 * =============================================================================
 * Orchestrates hover UX between Chart bars and Legend pills.
 *
 * Responsibilities:
 * - Normalize whatever the chart hover callback provides into a stable "hover model".
 * - Drive the legend halo (visual) AND broadcast semantic highlight via renderLegendHalo.js.
 * - Provide a tiny, ctx-free handler that renderer/chart can call.
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
      raw: payload,
    };
  }

  const p = payload && typeof payload === "object" ? payload : {};
  const event = p.event || p.e || p.mouseEvent || null;

  const cat = toStr(p.cat ?? p.category ?? p.kategorie ?? p.kat ?? p?.bar?.cat ?? p?.bar?.category);
  const color = toStr(p.color ?? p.fill ?? p.stroke ?? p?.bar?.color ?? p?.bar?.fill);

  const chipEl = pickFirst(
    p.chipEl,
    p.legendPillEl,
    p?.dom?.chipEl,
    p?.dom?.legendPillEl,
    p?.nodes?.chipEl,
    p?.nodes?.legendPillEl
  );

  return {
    event: event && typeof event === "object" ? event : null,
    cat,
    color,
    chipEl: isEl(chipEl) ? chipEl : null,
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
  const byData = legendRootEl.querySelector(
    `[data-cat="${esc(cat)}"], [data-category="${esc(cat)}"], [data-kategorie="${esc(cat)}"]`
  );
  if (isEl(byData)) return byData;

  // Try aria-label/title matches (fallback)
  const byAria = legendRootEl.querySelector(`[aria-label="${esc(cat)}"], [title="${esc(cat)}"]`);
  if (isEl(byAria)) return byAria;

  // Last resort: strict textContent match inside pill-ish elements
  const candidates = legendRootEl.querySelectorAll("button, a, .pill, .legend-pill, .legend__pill, .badge, span, div");
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
  if (!isEl(legendRootEl)) throw new Error("createBarHoverController: legendRootEl missing/invalid");

  const halo = createLegendHalo(legendRootEl);
  const resolvePill = typeof getPillEl === "function" ? getPillEl : defaultGetPillEl;
  const resolveColor = typeof getColor === "function" ? getColor : defaultGetColor;
  const emit = typeof onHoverModel === "function" ? onHoverModel : null;

  let lastKey = "";

  function broadcastHighlight({ cat, color }) {
    // Contract: legend highlight must be observable by legend.js even if halo impl changes.
    // Dispatch on legendRootEl (primary) and also on document (robust across mount/root refactors).
    const detail = { cat: cat || null, color: color || "" };
    try {
      legendRootEl.dispatchEvent(new CustomEvent("legend:highlight", { bubbles: true, detail }));
    } catch {}
    try {
      document.dispatchEvent(new CustomEvent("legend:highlight", { bubbles: true, detail }));
    } catch {}
  }

  function clear() {
    lastKey = "";
    halo.hide(); // also broadcasts legend:highlight {cat:null}
    broadcastHighlight({ cat: null, color: "" });
    emit?.(null);
  }

  function onHover(payload) {


    console.log("[barHover] onHover", payload);
    const n = normalizePayload(payload);

    // Chart sometimes signals "no bar" with empty payloads.
    // In sticky mode we keep the last halo/model.
    if (!n.event && !n.chipEl && !n.cat) {
      if (clearOnEmptyHover && !stickyHover) clear();
      return;
    }

    const chipEl = n.chipEl || resolvePill({ legendRootEl, cat: n.cat, payload: n.raw, event: n.event });
    const color = resolveColor({ color: n.color, cat: n.cat, payload: n.raw, event: n.event, chipEl });

    // Prefer a concrete element: most stable (no geometry drift) and enables semantic highlight.
    if (isEl(chipEl)) {
      const key = `EL||${n.cat || chipEl.dataset?.cat || "?"}||${color}`;
      if (key !== lastKey) {
        lastKey = key;

        // IMPORTANT: pass `el` and `cat` so renderLegendHalo can broadcast highlight.
        halo.show({ el: chipEl, cat: n.cat || chipEl.dataset?.cat || null, color, strength });

        broadcastHighlight({ cat: n.cat || chipEl.dataset?.cat || null, color });

        emit?.({
          cat: n.cat,
          color,
          chipEl,
          geo: null,
          raw: n.raw,
          event: n.event,
        });
      }
      return;
    }

    // Fallback: use pointer position relative to legend root.
    // renderLegendHalo will hit-test to find a pill and can still broadcast highlight if it resolves one.
    const pt = n.event ? getLocalPoint(legendRootEl, n.event) : null;
    if (!pt) {
      if (!stickyHover) clear();
      return;
    }

    const key = `XY||${n.cat || "?"}||${color}||${Math.round(pt.x)}||${Math.round(pt.y)}`;
    if (key !== lastKey) {
      lastKey = key;
      halo.show({ x: pt.x, y: pt.y, cat: n.cat || null, color, strength });

      broadcastHighlight({ cat: n.cat || null, color });

      emit?.({
        cat: n.cat,
        color,
        chipEl: null,
        geo: { x: pt.x, y: pt.y, r: 18 },
        raw: n.raw,
        event: n.event,
      });
    }
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