// view-derivations.js
// -----------------------------------------------------------------------------
// View-Derivations (pure)
// -----------------------------------------------------------------------------
// Ziel:
// - Pure Ableitungen aus (data, state) → Derived Values
// - Keine DOM-Zugriffe, keine Persistenz, kein ctx
// - Deterministisch & testbar
//
// Konventionen / Contracts:
// - data: { years?: number[], cats?: string[], bars?: Bar[] }
// - Bar:  { year: number, cat: string, kosten?: number, menge?: number, type?: string }
// - state: { yearFrom?: number|null, yearTo?: number|null, mode?: "kosten"|"menge", enabledTypes?: Set<string> }
// - enabledTypes: leeres/fehlendes Set => ALLE Typen
// -----------------------------------------------------------------------------

import { cleanKey } from "/assets/js/keys.js";

// -----------------------------------------------------------------------------
// 0) Small, shared helpers
// -----------------------------------------------------------------------------

function cleanTypeKey(v) {
  return String(v ?? "").trim();
}

/**
 * enabledTypes Semantik:
 * - missing / not Set / empty Set => alle Typen erlaubt
 * - sonst: membership test
 */
function isTypeAllowed(state, type) {
  const set = state?.enabledTypes;
  if (!(set instanceof Set) || set.size === 0) return true;
  return set.has(cleanTypeKey(type));
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function safeBars(data) {
  return safeArray(data?.bars);
}

function safeCats(data) {
  return safeArray(data?.cats);
}

function safeYears(data) {
  return safeArray(data?.years);
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// -----------------------------------------------------------------------------
// 1) Year Range (Basis für alles Weitere)
// -----------------------------------------------------------------------------

/**
 * Universe-Jahresdomäne (min/max) aus data.years.
 * - Unabhängig vom state.
 * - Rückgabe null, wenn keine validen Jahre vorhanden.
 */
export function getYearDomain(data) {
  const years = safeYears(data)
    .map((y) => Number(y))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (years.length === 0) return null;

  return { minY: years[0], maxY: years[years.length - 1] };
}

/**
 * Sichtbarer Jahrbereich (state → clamp in Universe-Domain).
 * Nutzt `getYearDomain(data)` als Universe-Domäne (min/max).
 * - Falls state.yearFrom/yearTo fehlen: full range.
 * - Rückgabe null, wenn keine validen Jahre vorhanden.
 */
export function getVisibleYearRange(data, state) {
  const dom = getYearDomain(data);
  if (!dom) return null;

  const { minY, maxY } = dom;

  const from = Number.isFinite(state?.yearFrom) ? Number(state.yearFrom) : minY;
  const to = Number.isFinite(state?.yearTo) ? Number(state.yearTo) : maxY;

  const yf = Math.max(minY, Math.min(maxY, Math.min(from, to)));
  const yt = Math.max(minY, Math.min(maxY, Math.max(from, to)));

  return { yf, yt };
}

// -----------------------------------------------------------------------------
// 2) Guards / Empty States
// -----------------------------------------------------------------------------

/**
 * "leer" heißt: keine darstellbaren Datenpunkte.
 * - years/cats sind nice-to-have, aber bars sind die harte Voraussetzung.
 */
export function isModelEmpty(model) {
  const bars = safeBars(model);
  return bars.length === 0;
}

// -----------------------------------------------------------------------------
// 3) Visibility – welche Kategorien existieren im aktuellen Fenster?
// -----------------------------------------------------------------------------

/**
 * Kategorien, die im aktuellen (YearRange × TypeFilter) vorkommen.
 * - Fallback: wenn keine Bars oder kein YearRange -> data.cats (normalisiert)
 */
export function getVisibleCatsForRange(data, state) {
  if (!data) return [];

  const bars = safeBars(data);
  if (bars.length === 0) {
    return safeCats(data).map(cleanKey).filter(Boolean);
  }

  const r = getVisibleYearRange(data, state);
  if (!r) {
    return safeCats(data).map(cleanKey).filter(Boolean);
  }

  const { yf, yt } = r;
  const out = new Set();

  for (const b of bars) {
    const y = toFiniteNumber(b?.year);
    if (y == null || y < yf || y > yt) continue;
    if (!isTypeAllowed(state, b?.type)) continue;

    const c = cleanKey(b?.cat);
    if (c) out.add(c);
  }

  return out.size
    ? Array.from(out)
    : safeCats(data).map(cleanKey).filter(Boolean);
}

// -----------------------------------------------------------------------------
// 4) Sichtbares Datenmodell (für Chart)
// -----------------------------------------------------------------------------

/**
 * Schneidet bars auf (YearRange × TypeFilter) und baut years neu aus bars.
 * - cats/types werden als Universe unverändert durchgereicht (Spread).
 */
export function makeVisibleModel(data, state) {
  if (!data) return data;

  const bars = safeBars(data);
  if (bars.length === 0) return { ...data, years: [] };

  const r = getVisibleYearRange(data, state);
  if (!r) return { ...data, bars: [], years: [] };

  const { yf, yt } = r;

  const visibleBars = [];
  const yearSet = new Set();

  for (const b of bars) {
    const y = toFiniteNumber(b?.year);
    if (y == null || y < yf || y > yt) continue;
    if (!isTypeAllowed(state, b?.type)) continue;

    visibleBars.push(b);
    yearSet.add(y);
  }

  const years = Array.from(yearSet).sort((a, b) => a - b);

  return { ...data, bars: visibleBars, years };
}

// -----------------------------------------------------------------------------
// 5) Aggregationen (Totals)
// -----------------------------------------------------------------------------

/**
 * Summe – aggregiert pro Kategorie über (YearRange × TypeFilter × CategoryFilter).
 *
 * STRIKTE SEMANTIK:
 * - Kategorien sind IDENTITÄTEN (keine Normalisierung, kein cleanKey)
 * - Es werden exakt dieselben Bars berücksichtigt wie im Chart
 *
 * @return {{
 *   totals: Map<string, number>, // catKey → Summe
 *   hasAny: boolean              // mindestens ein valider Wert
 * }}
 */
export function computeTotalsForVisibleRange(data, state) {
  const range = getVisibleYearRange(data, state);
  if (!range) return { totals: new Map(), hasAny: false };

  const { yf, yt } = range;
  const mode = state?.mode === "menge" ? "menge" : "kosten";

  const enabledCats =
    state?.enabledCats instanceof Set ? state.enabledCats : null;

  const totals = new Map();
  let hasAny = false;

  for (const b of safeBars(data)) {
    // --- Jahr-Filter ---------------------------------------------------------
    const year = toFiniteNumber(b?.year);
    if (year == null || year < yf || year > yt) continue;

    // --- Typ-Filter ----------------------------------------------------------
    if (!isTypeAllowed(state, b?.type)) continue;

    // --- Kategorie (IDENTITÄT, unverändert) ---------------------------------
    const cat = b?.cat;
    if (typeof cat !== "string" || cat.length === 0) continue;

    if (enabledCats && enabledCats.size > 0 && !enabledCats.has(cat)) {
      continue;
    }

    // --- Wert ---------------------------------------------------------------
    const raw =
      mode === "menge"
        ? b?.menge
        : b?.kosten;

    const value = toFiniteNumber(raw);
    if (value == null) continue;

    // --- Aggregation ---------------------------------------------------------
    hasAny = true;
    totals.set(cat, (totals.get(cat) || 0) + value);
  }

  return { totals, hasAny };
}

// -----------------------------------------------------------------------------
// 6) Net Info (UI-nahe, aber weiterhin pure)
// -----------------------------------------------------------------------------

export function computeNetInfo(data, state) {
  const r = getVisibleYearRange(data, state);
  if (!r) return null;

  const { yf, yt } = r;
  const { totals } = computeTotalsForVisibleRange(data, state);

  let net = 0;
  for (const v of totals.values()) {
    if (Number.isFinite(v)) net += v;
  }

  return {
    net,
    yf,
    yt,
    mode: state?.mode === "menge" ? "menge" : "kosten",
  };
}