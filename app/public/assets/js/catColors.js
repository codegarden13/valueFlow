// catColors.js
// Stable category colors (build once, reuse everywhere)

const GOLDEN_ANGLE = 137.50776405003785; // degrees

// Fast, stable string hash (FNV-1a 32bit)
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (with overflow)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function toHexFromD3Color(d3Color) {
  // d3Color may be object with .formatHex()
  if (d3Color?.formatHex) return d3Color.formatHex();
  // fallback: try rgb conversion
  const rgb = d3Color?.rgb?.();
  if (rgb?.formatHex) return rgb.formatHex();
  return null;
}

/**
 * makeBaseColor(cat, d3)
 * - Uses OKLCH if available (d3.oklch)
 * - Else falls back to HCL (d3.hcl)
 */
function makeBaseColor(cat, d3) {
  const h = hash32(cat);

  // Hue: hash-driven + golden angle scatter
  const hue = (h % 360 + ((h >>> 8) % 360) * 0.07 + GOLDEN_ANGLE) % 360;

  // Keep lightness/chroma in a safe, readable range.
  // Slight deterministic jitter to avoid near-collisions.
  const j1 = ((h >>> 16) & 255) / 255; // 0..1
  const j2 = ((h >>> 24) & 255) / 255;

  // Targets (tuned for UI on light background)
  const L = clamp(0.72 + (j1 - 0.5) * 0.10, 0.62, 0.80); // OKLCH L: 0..1-ish
  const C = clamp(0.16 + (j2 - 0.5) * 0.08, 0.10, 0.22); // OKLCH C

  // If d3.oklch exists, use it; else fall back to HCL.
  if (d3?.oklch) {
    // d3.oklch(L, C, hue) -> color
    const col = d3.oklch(L, C, hue);
    const hex = toHexFromD3Color(col);
    if (hex) return hex;
  }

  // HCL fallback: d3.hcl(hue, chroma, lightness)
  // HCL uses different scales (L ~ 0..100, C typical 0..100)
  if (d3?.hcl) {
    const hclL = clamp(70 + (j1 - 0.5) * 10, 62, 80);
    const hclC = clamp(50 + (j2 - 0.5) * 18, 38, 68);
    const col = d3.hcl(hue, hclC, hclL);
    const hex = toHexFromD3Color(col);
    if (hex) return hex;
  }

  // Absolute last resort (shouldn't happen if d3 is present)
  return "#888888";
}

/**
 * buildStableCatColors(catsUniverse, overrides)
 * - catsUniverse: array of canonical category keys (strings)
 * - overrides: optional object { [cat]: "#RRGGBB" } from config
 * Returns: Map(cat -> hex)
 */
export function buildStableCatColors(catsUniverse, overrides, d3 = window.d3) {
  const ov = overrides && typeof overrides === "object" ? overrides : {};
  const map = new Map();

  for (const cat of catsUniverse || []) {
    if (!cat) continue;

    // Config override wins
    const forced = ov[cat];
    if (typeof forced === "string" && forced.trim()) {
      map.set(cat, forced.trim());
      continue;
    }

    map.set(cat, makeBaseColor(cat, d3));
  }

  return map;
}

/**
 * Optional: build a deterministic signature so you only rebuild if catsUniverse changes.
 */
export function signatureForCats(catsUniverse) {
  const s = (catsUniverse || []).join("||");
  return String(hash32(s));
}