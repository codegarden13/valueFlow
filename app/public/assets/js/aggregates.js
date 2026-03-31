/**
 * aggregates.js
 * ============================================================================
 * ZENTRALE DOMÄNENAGGREGATION (Single Source of Truth)
 * ----------------------------------------------------------------------------
 * Ziel
 * 
 * 
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

function normalizeAggregateState(state) {
  return {
    mode: state.mode === "menge" ? "menge" : "kosten",
    enabledSourceIds: state.enabledSourceIds instanceof Set ? state.enabledSourceIds : null,
    enabledTypes: state.enabledTypes instanceof Set ? state.enabledTypes : null,
    disabledCats: state.disabledCats instanceof Set ? state.disabledCats : new Set(),
    yearFrom: Number.isFinite(state.yearFrom) ? Number(state.yearFrom) : null,
    yearTo: Number.isFinite(state.yearTo) ? Number(state.yearTo) : null
  };
}

function buildVisibilityBuckets() {
  return {
    visibleSources: [],
    visibleTypes: [],
    visibleCats: [],
    seenSources: new Set(),
    seenTypes: new Set(),
    seenCats: new Set()
  };
}

function buildTotalsBuckets() {
  return {
    totalsByCat: new Map(),
    totalsBySource: new Map(),
    totalsByType: new Map(),
    totalsByYear: new Map()
  };
}

function buildAggregateContext(state) {
  const normalized = normalizeAggregateState(state);

  return {
    ...normalized,
    sourcesAll: normalized.enabledSourceIds == null,
    sourcesNone: normalized.enabledSourceIds != null && normalized.enabledSourceIds.size === 0,
    typesAll: normalized.enabledTypes == null,
    typesNone: normalized.enabledTypes != null && normalized.enabledTypes.size === 0,
    ...buildVisibilityBuckets(),
    ...buildTotalsBuckets(),
    barMap: new Map(),
    hasAny: false
  };
}

function isRowInYearRange(year, ctx) {
  if (year == null) return false;
  if (ctx.yearFrom != null && year < ctx.yearFrom) return false;
  if (ctx.yearTo != null && year > ctx.yearTo) return false;
  return true;
}

function isSourceEnabled(sourceId, ctx) {
  if (!sourceId) return false;
  if (ctx.sourcesNone) return false;
  if (ctx.sourcesAll) return true;
  return ctx.enabledSourceIds.has(sourceId);
}

function isTypeEnabled(type, ctx) {
  if (!type) return false;
  if (ctx.typesNone) return false;
  if (ctx.typesAll) return true;
  return ctx.enabledTypes.has(type);
}

function collectVisibleDimensions(ctx, sourceId, type, cat) {
  pushUnique(ctx.visibleSources, ctx.seenSources, sourceId);
  pushUnique(ctx.visibleTypes, ctx.seenTypes, type);
  pushUnique(ctx.visibleCats, ctx.seenCats, cat);
}

function readRowMetrics(row) {
  const kosten = toFiniteNumber(row?.kosten);
  const menge = toFiniteNumber(row?.menge);

  if (kosten == null && menge == null) return null;

  return { kosten, menge };
}

function addBarValue(barMap, year, type, cat, metrics) {
  const key = `${year}::${type}::${cat}`;
  let bar = barMap.get(key);

  if (!bar) {
    bar = { year, type, cat, kosten: 0, menge: 0 };
    barMap.set(key, bar);
  }

  if (metrics.kosten != null) bar.kosten += metrics.kosten;
  if (metrics.menge != null) bar.menge += metrics.menge;
}

function addTotals(ctx, sourceId, type, cat, year, metrics) {
  const value = ctx.mode === "menge" ? metrics.menge : metrics.kosten;
  if (value == null || !Number.isFinite(value) || value === 0) return;

  ctx.hasAny = true;
  addToMap(ctx.totalsByCat, cat, value);
  addToMap(ctx.totalsBySource, sourceId, value);
  addToMap(ctx.totalsByType, type, value);
  addToMap(ctx.totalsByYear, year, value);
}

function sortBars(barMap) {
  return Array.from(barMap.values()).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const byType = a.type.localeCompare(b.type, "de");
    if (byType) return byType;
    return a.cat.localeCompare(b.cat, "de");
  });
}

// ============================================================================
// aggregate(data, state)
// ============================================================================

export function aggregate(data, state) {
  if (!data || !Array.isArray(data.rows)) {
    throw new Error("aggregate: data.rows missing/invalid (Array expected)");
  }
  if (!state) throw new Error("aggregate: state missing");

  const ctx = buildAggregateContext(state);

  for (const row of data.rows) {
    const year = getYear(row);
    if (!isRowInYearRange(year, ctx)) continue;

    const sourceId = getSourceId(row);
    if (!isSourceEnabled(sourceId, ctx)) continue;

    const type = getTypeKey(row);
    if (!isTypeEnabled(type, ctx)) continue;

    const cat = getCatKey(row);
    if (!cat) continue;

    collectVisibleDimensions(ctx, sourceId, type, cat);
    if (ctx.disabledCats.has(cat)) continue;

    const metrics = readRowMetrics(row);
    if (!metrics) continue;

    addBarValue(ctx.barMap, year, type, cat, metrics);
    addTotals(ctx, sourceId, type, cat, year, metrics);
  }

  return {
    mode: ctx.mode,
    bars: sortBars(ctx.barMap),
    totalsByCat: ctx.totalsByCat,
    totalsBySource: ctx.totalsBySource,
    totalsByType: ctx.totalsByType,
    totalsByYear: ctx.totalsByYear,
    visibleCats: ctx.visibleCats,
    visibleTypes: ctx.visibleTypes,
    visibleSources: ctx.visibleSources,
    hasAny: ctx.hasAny
  };
}