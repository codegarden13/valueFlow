// /assets/js/colorsByCat.js
// -----------------------------------------------------------------------------
// Category Color System (Single Source of Truth)
// -----------------------------------------------------------------------------
// Contract:
// - Category strings are identity keys (Option A: no normalization).
// - Deterministic color generation via FNV-1a hash + OKLCH/HCL + golden angle (with HSL fallback).
// - Returned structure MUST be a stable Map<string, string>.
//
// This module is pure and side-effect free.
// -----------------------------------------------------------------------------

const GOLDEN_ANGLE = 137.50776405003785; // degrees

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Deterministic hash (FNV-1a 32-bit)
 * Stable across sessions and platforms.
 */
export function hash32(key) {
  const str = String(key ?? "");
  let h = 2166136261; // FNV-1a seed

  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function toHexFromD3Color(c) {
  if (c?.formatHex) return c.formatHex();
  const rgb = c?.rgb?.();
  if (rgb?.formatHex) return rgb.formatHex();
  return null;
}

/**
 * stableCatColor(key)
 * ---------------------------------------------------------------------------
 * Deterministic category → color mapping.
 *
 * Preferred: OKLCH (perceptually uniform), fallback: HCL, last resort: HSL.
 * Uses golden-angle hue scattering to keep categories visually separated.
 */
export function stableCatColor(key, d3 = window.d3) {
  const h = hash32(key);

  // Hue: scatter with golden angle + a tiny deterministic perturbation.
  const hue = ((h % 360) + GOLDEN_ANGLE + (((h >>> 8) % 360) * 0.07)) % 360;

  // Deterministic jitter for lightness/chroma within safe UI bounds
  const j1 = ((h >>> 16) & 255) / 255; // 0..1
  const j2 = ((h >>> 24) & 255) / 255;

  // OKLCH ranges: L in ~[0..1], C typically ~[0..0.4] for sRGB-safe colors.
  const L = clamp(0.72 + (j1 - 0.5) * 0.10, 0.62, 0.80);
  const C = clamp(0.16 + (j2 - 0.5) * 0.08, 0.10, 0.22);

  if (d3?.oklch) {
    const col = d3.oklch(L, C, hue);
    const hex = toHexFromD3Color(col);
    if (hex) return hex;
  }

  // HCL fallback (different scale): L ~ 0..100, C typical ~ 0..100
  if (d3?.hcl) {
    const hclL = clamp(70 + (j1 - 0.5) * 10, 62, 80);
    const hclC = clamp(50 + (j2 - 0.5) * 18, 38, 68);
    const col = d3.hcl(hue, hclC, hclL);
    const hex = toHexFromD3Color(col);
    if (hex) return hex;
  }

  // Last resort: HSL string (still stable)
  const sat = 70;
  const light = 55;
  return `hsl(${Math.round(hue)} ${sat}% ${light}%)`;
}

/**
 * buildColorByCat(catUniverse)
 *
 * @param {string[]} catUniverse - full category universe (identity strings)
 * @returns {Map<string,string>}
 */
export function buildColorByCat(catUniverse) {
  if (!Array.isArray(catUniverse)) {
    throw new Error("buildColorByCat: catUniverse must be array");
  }

  const out = new Map();

  for (const cat of catUniverse) {
    if (typeof cat !== "string" || cat.length === 0) continue;
    if (out.has(cat)) continue;

    out.set(cat, stableCatColor(cat));
  }

  return out;
}