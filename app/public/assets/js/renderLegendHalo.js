/**
 * renderLegendHalo.js
 * =============================================================================
 * Glow + highlight broadcaster for legend pills.
 *
 * This module is intentionally ctx-free.
 * It does two things:
 *  1) Applies a temporary glow to a pill element (purely visual)
 *  2) Broadcasts the current highlighted category (semantic) as a DOM CustomEvent
 *
 * Consumers (renderer/barHoverController/etc.) can listen on the legend root:
 *   rootEl.addEventListener('legend:highlight', (e) => {
 *     const { cat } = e.detail;
 *     // set state.legendHighlightCat = cat; redraw(); OR update legend edges directly
 *   });
 *
 * Design principles
 * -----------------
 * - No DOM overlay nodes
 * - No transform writes (legend.js owns positioning)
 * - No mutation of background/text colors
 * - Stateless from the outside (purely visual)
 * - One controller per legend root (WeakMap cached)
 */

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function isEl(v) {
  return v && typeof v === "object" && v.nodeType === 1;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function ensurePositioned(root) {
  const cs = getComputedStyle(root);
  if (cs.position === "static") root.style.position = "relative";
}

function isLegendChip(el) {
  if (!isEl(el)) return false;
  const cl = el.classList;
  // Support current legend markup and legacy markup.
  return cl?.contains("legend-chip") || cl?.contains("pill") || cl?.contains("legend-pill");
}

function pickCat(opts, chipEl) {
  const direct = opts?.cat;
  if (typeof direct === "string" && direct.length) return direct;

  // Convention: legend.js sets data-cat on category pills
  const dc = chipEl?.dataset?.cat;
  if (typeof dc === "string" && dc.length) return dc;

  return null;
}

function dispatchHighlight(rootEl, cat, el, reason) {
  // Keep it non-throwing: UI events should not crash the app.
  try {
    rootEl.dispatchEvent(
      new CustomEvent("legend:highlight", {
        bubbles: true,
        detail: {
          cat: typeof cat === "string" && cat.length ? cat : null,
          el: isEl(el) ? el : null,
          reason: String(reason || "unknown"),
        },
      })
    );
  } catch (_) {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// Controller cache
// -----------------------------------------------------------------------------

/** @type {WeakMap<Element, any>} */
const controllerByRoot = new WeakMap();

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function ensureLegendHalo(rootEl) {
  if (!isEl(rootEl)) {
    throw new Error("ensureLegendHalo(rootEl): rootEl missing/invalid");
  }

  const existing = controllerByRoot.get(rootEl);
  if (existing) return existing;

  ensurePositioned(rootEl);

  // one-shot pulse animation on the active element
  /** @type {Animation|null} */
  let pulseAnim = null;

  /** @type {Element|null} */
  let activeEl = null;

  /** @type {string|null} */
  let activeCat = null;

  const prevStyleByEl = new WeakMap();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function resolveTarget(opts) {
    const direct = opts?.el || opts?.targetEl;
    if (isLegendChip(direct) && rootEl.contains(direct)) return direct;

    const x = Number(opts?.x);
    const y = Number(opts?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const rect = rootEl.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + x, rect.top + y);
    if (!hit) return null;

    const pill = hit.closest?.(".legend-chip, .pill, .legend-pill");
    return pill && rootEl.contains(pill) ? pill : null;
  }

  function rememberStyle(el) {
    if (!prevStyleByEl.has(el)) {
      prevStyleByEl.set(el, {
        boxShadow: el.style.boxShadow || "",
        filter: el.style.filter || "",
        zIndex: el.style.zIndex || "",
        isolation: el.style.isolation || "",
        willChange: el.style.willChange || "",
      });
    }
  }

  function restoreStyle(el) {
    const prev = prevStyleByEl.get(el);
    if (!prev) return;
    el.style.boxShadow = prev.boxShadow;
    el.style.filter = prev.filter;
    el.style.zIndex = prev.zIndex;
    el.style.isolation = prev.isolation;
    el.style.willChange = prev.willChange;
  }

  function stopAnim() {
    try {
      pulseAnim?.cancel();
    } catch (_) {
      // ignore
    }
    pulseAnim = null;
  }

  function clearActive(reason = "hide") {
    if (activeEl && activeEl.isConnected) {
      stopAnim();
      restoreStyle(activeEl);
    }

    activeEl = null;

    // broadcast semantic highlight clear if we had one
    if (activeCat != null) {
      activeCat = null;
      dispatchHighlight(rootEl, null, null, reason);
    }
  }

  function applyGlow(el, { strength, color }) {
    const s = clamp(strength ?? 0.85, 0.1, 1);
    const c = String(color ?? "rgba(255,255,255,0.9)");

    const blur = 8 + 22 * s;
    const blur2 = Math.round(blur * 1.35);
    const glowOpacity = 0.25 + 0.45 * s;
    const glowOpacity2 = Math.min(0.95, glowOpacity * 1.25);

    const bs1 = `
      0 0 0 2px rgba(0,0,0,0.55),
      0 0 0 4px ${c},
      0 0 ${blur}px rgba(255,255,255,${glowOpacity})
    `;

    const bs2 = `
      0 0 0 2px rgba(0,0,0,0.55),
      0 0 0 4px ${c},
      0 0 ${blur2}px rgba(255,255,255,${glowOpacity2})
    `;

    Object.assign(el.style, {
      isolation: "isolate",
      willChange: "filter, box-shadow",
      zIndex: "4",
      boxShadow: bs1,
      filter: `drop-shadow(0 0 ${blur}px rgba(255,255,255,${glowOpacity}))`,
    });

    stopAnim();

    pulseAnim = el.animate(
      [
        { filter: `drop-shadow(0 0 ${blur}px rgba(255,255,255,${glowOpacity}))`, boxShadow: bs1 },
        { filter: `drop-shadow(0 0 ${blur2}px rgba(255,255,255,${glowOpacity2}))`, boxShadow: bs2 },
        { filter: `drop-shadow(0 0 ${blur}px rgba(255,255,255,${glowOpacity}))`, boxShadow: bs1 },
      ],
      {
        duration: 380,
        iterations: 1,
        easing: "cubic-bezier(0.2, 0.9, 0.2, 1)",
        fill: "forwards",
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const api = {
    /**
     * Show glow on a pill.
     *
     * Options:
     * - el / targetEl: a pill element
     * - x,y          : coordinates relative to root (legacy)
     * - cat          : optional category identity; if absent, tries data-cat
     * - color        : highlight color (default white)
     * - strength     : 0..1
     */
    show(opts = {}) {
      const pill = resolveTarget(opts);
      if (!pill) return false;

      // If target changed, clear previous element styles.
      if (activeEl && activeEl !== pill) {
        clearActive("switch");
      }

      rememberStyle(pill);
      activeEl = pill;

      // Broadcast semantic highlight if we can resolve a category.
      const cat = pickCat(opts, pill);
      if (cat && cat !== activeCat) {
        activeCat = cat;
        dispatchHighlight(rootEl, cat, pill, "show");
      }

      applyGlow(pill, { strength: opts.strength, color: opts.color });
      return true;
    },

    /** Hide glow and clear highlight (if any). */
    hide() {
      clearActive("hide");
    },

    /**
     * Clear everything and remove controller.
     * (Does not remove any event listeners because we don't add any externally.)
     */
    destroy() {
      clearActive("destroy");
      controllerByRoot.delete(rootEl);
    },

    get active() {
      return activeEl;
    },

    get activeCat() {
      return activeCat;
    },
  };

  controllerByRoot.set(rootEl, api);
  return api;
}

export function createLegendHalo(rootEl) {
  return ensureLegendHalo(rootEl);
}

// -----------------------------------------------------------------------------
// Geometry helper (legacy support)
// -----------------------------------------------------------------------------

export function getHaloCenterFromElement(rootEl, targetEl, padPx = 6) {
  if (!isEl(rootEl) || !isEl(targetEl)) return null;

  const rootRect = rootEl.getBoundingClientRect();
  const r = targetEl.getBoundingClientRect();

  const cx = (r.left + r.right) / 2 - rootRect.left;
  const cy = (r.top + r.bottom) / 2 - rootRect.top;
  const base = Math.max(r.width, r.height) / 2;
  const rr = base + Number(padPx || 0);

  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(rr)) {
    return null;
  }

  return { x: cx, y: cy, r: rr };
}