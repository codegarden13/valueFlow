/**
 * aggregates.js
 * ============================================================================
 * ZENTRALE DOMÄNENAGGREGATION (Single Source of Truth)
 * ----------------------------------------------------------------------------
 * Ziel
 * - EIN Filterpfad (YearRange × Sources × Types × disabledCats)
 * - EIN Zahlenursprung (data.rows)
 * - Bars + Totals + Dropdown-Universen werden deterministisch aus rows abgeleitet
 *
 * Wichtige Konventionen
 * - Kategorien sind IDENTITÄTEN (keine Normalisierung außer: leer -> "?")
 * - Typen werden normalisiert (cleanKey), damit Filters/Keys stabil sind
 *
 * Input Contract
 * - data.rows: Array<Row>
 *   Row muss mindestens liefern:
 *   - year
 *   - cat
 *   - type
 *   - sourceId (oder sid/source)
 *   - kosten / menge (numerisch oder numerisch parsbar)
 *
 * State-Semantik (wie in deiner App vereinbart)
 * - enabledSourceIds: null/undefined => ALLE, Set.size===0 => KEINE
 * - enabledTypes:     null/undefined => ALLE, Set.size===0 => KEINE
 * - disabledCats:     Set<string> (exakt, case-sensitiv)
 * - yearFrom/yearTo:  sichtbarer Bereich (inklusive)
 * - mode:             "menge" | "kosten" (default: kosten)
 *
 * Output
 * - bars: Array<{ year, type, cat, kosten, menge }>
 *   (für Chart; aggregiert über alle ausgewählten Sources)
 * - totalsByCat / totalsBySource / totalsByType / totalsByYear: Map<key, number>
 *   (signiert; bezogen auf state.mode)
 * - visibleCats / visibleTypes / visibleSources: string[]
 *   (Dropdown-Universen basierend auf YearRange × Sources × Types; OHNE disabledCats)
 * - hasAny: boolean
 */

import { cleanKey } from "./keys.js";

// ============================================================================
// Helpers (strict + small)
// ============================================================================

function toFiniteNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toNonEmptyString(x) {
  const s = String(x ?? "");
  return s.length ? s : null;
}

function normalizeDim(v) {
  // NBSP -> space, trim; empty => "?" (kein leeres Dropdown-Item)
  const s = String(v ?? "").replace(/\u00A0/g, " ").trim();
  return s ? s : "?";
}

function getSourceId(row) {
  // tolerate different naming conventions
  const sid = row?.sourceId ?? row?.sid ?? row?.source;
  return toNonEmptyString(sid);
}

function getTypeKey(row) {
  // Typ wird normalisiert (stabiler Filter-Key)
  const t = toNonEmptyString(row?.type);
  if (!t) return null;
  const k = cleanKey(t);
  return k || null;
}

function getCatKey(row) {
  // Kategorien sind Identitäten; nur leer/invalid wird zu null (oder "?")
  const c = row?.cat;
  if (typeof c !== "string") return null;
  const s = normalizeDim(c);
  return s || null;
}

function getYear(row) {
  return toFiniteNumber(row?.year);
}

function addToMap(map, key, delta) {
  map.set(key, (map.get(key) || 0) + delta);
}

function pushUnique(out, seen, v) {
  if (!seen.has(v)) {
    seen.add(v);
    out.push(v);
  }
}

// ============================================================================
// aggregate(data, state)
// ============================================================================

export function aggregate(data, state) {
  if (!data || !Array.isArray(data.rows)) {
    throw new Error("aggregate: data.rows missing/invalid (Array expected)");
  }
  if (!state) throw new Error("aggregate: state missing");

  const mode = state.mode === "menge" ? "menge" : "kosten";

  // --- Filter sets ----------------------------------------------------------
  const enabledSourceIds = state.enabledSourceIds instanceof Set ? state.enabledSourceIds : null;
  const enabledTypes = state.enabledTypes instanceof Set ? state.enabledTypes : null;
  const disabledCats = state.disabledCats instanceof Set ? state.disabledCats : new Set();

  const yf = Number.isFinite(state.yearFrom) ? Number(state.yearFrom) : null;
  const yt = Number.isFinite(state.yearTo) ? Number(state.yearTo) : null;

  // Precompute filter semantics (null => all, size===0 => none)
  const sourcesNone = enabledSourceIds != null && enabledSourceIds.size === 0;
  const sourcesAll = enabledSourceIds == null;

  const typesNone = enabledTypes != null && enabledTypes.size === 0;
  const typesAll = enabledTypes == null;

  // --- Dropdown-Universen (depend on year × source × type; NOT on disabledCats)
  const visibleSources = [];
  const visibleTypes = [];
  const visibleCats = [];
  const seenSources = new Set();
  const seenTypes = new Set();
  const seenCats = new Set();

  // --- Totals (depend on ALL filters incl. disabledCats) ---------------------
  const totalsByCat = new Map();
  const totalsBySource = new Map();
  const totalsByType = new Map();
  const totalsByYear = new Map();

  // --- Bars: aggregate by (year,type,cat) across selected sources ------------
  // We keep both kosten + menge aggregated so mode switch remains consistent.
  const barMap = new Map(); // key -> { year,type,cat,kosten,menge }

  let hasAny = false;

  for (const row of data.rows) {
    const year = getYear(row);
    if (year == null) continue;

    // Year window (inclusive)
    if (yf != null && year < yf) continue;
    if (yt != null && year > yt) continue;

    const sid = getSourceId(row);
    if (!sid) continue;

    // Sources filter
    if (sourcesNone) continue;
    if (!sourcesAll && !enabledSourceIds.has(sid)) continue;

    const type = getTypeKey(row);
    if (!type) continue;

    // Types filter
    if (typesNone) continue;
    if (!typesAll && !enabledTypes.has(type)) continue;

    const cat = getCatKey(row);
    if (!cat) continue;

    // Dropdown options (based on year×source×type visibility)
    pushUnique(visibleSources, seenSources, sid);
    pushUnique(visibleTypes, seenTypes, type);
    pushUnique(visibleCats, seenCats, cat);

    // Category enabled filter (disabledCats are excluded from totals/bars)
    if (disabledCats.has(cat)) continue;

    // Values (keep both channels aggregated)
    const k = toFiniteNumber(row?.kosten);
    const m = toFiniteNumber(row?.menge);

    // If both missing, skip
    if (k == null && m == null) continue;

    // --- Bars (aggregate both channels) -------------------------------------
    const barKey = `${year}::${type}::${cat}`;
    let b = barMap.get(barKey);
    if (!b) {
      b = { year, type, cat, kosten: 0, menge: 0 };
      barMap.set(barKey, b);
    }
    if (k != null) b.kosten += k;
    if (m != null) b.menge += m;

    // --- Totals (mode-specific; sign preserved) ------------------------------
    const v = mode === "menge" ? m : k;
    if (v == null) continue;
    if (!Number.isFinite(v) || v === 0) continue;

    hasAny = true;
    addToMap(totalsByCat, cat, v);
    addToMap(totalsBySource, sid, v);
    addToMap(totalsByType, type, v);
    addToMap(totalsByYear, year, v);
  }

  const bars = Array.from(barMap.values()).sort((a, b) => {
    // stable-ish ordering: year asc, type asc, cat asc
    if (a.year !== b.year) return a.year - b.year;
    const t = a.type.localeCompare(b.type, "de");
    if (t) return t;
    return a.cat.localeCompare(b.cat, "de");
  });

  return {
    mode,
    bars,

    totalsByCat,
    totalsBySource,
    totalsByType,
    totalsByYear,

    // Dropdown universes for current (year×source×type) slice
    visibleCats,
    visibleTypes,
    visibleSources,

    hasAny,
  };
}