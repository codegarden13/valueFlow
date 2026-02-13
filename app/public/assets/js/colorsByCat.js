// /assets/js/colorsByCat.js
// -----------------------------------------------------------------------------
// Category Color System (Single Source of Truth)
// -----------------------------------------------------------------------------
// Contract:
// - Category strings are identity keys (Option A: no normalization).
// - Deterministic color generation via FNV-1a hash → HSL.
// - Optional config override map: { [catIdentity]: "#hex" | "hsl(...)" }
// - Returned structure MUST be a stable Map<string, string>.
//
// This module is pure and side-effect free.
// -----------------------------------------------------------------------------

/**
 * Normalize override string (no transformation, just trim).
 */
export function normalizeHex(input) {
  return String(input || "").trim();
}

/**
 * Deterministic hash → hue (FNV-1a 32-bit)
 * Ensures stable color for same category string.
 */
export function stableHueColor(key) {
  const str = String(key ?? "");
  let h = 2166136261; // FNV-1a seed

  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 70% 55%)`;
}

/**
 * buildColorByCat(catUniverse, overrides?)
 *
 * @param {string[]} catUniverse - full category universe (identity strings)
 * @param {object} overrides - optional config map: { [cat]: colorString }
 * @returns {Map<string,string>}
 */
export function buildColorByCat(catUniverse, overrides) {
  if (!Array.isArray(catUniverse)) {
    throw new Error("buildColorByCat: catUniverse must be array");
  }

  const out = new Map();
  const cfg = overrides && typeof overrides === "object" ? overrides : null;

  for (const cat of catUniverse) {
    if (typeof cat !== "string" || cat.length === 0) continue;
    if (out.has(cat)) continue;

    const overrideColor = cfg ? normalizeHex(cfg[cat]) : "";
    const finalColor = overrideColor || stableHueColor(cat);

    out.set(cat, finalColor);
  }

  return out;
}