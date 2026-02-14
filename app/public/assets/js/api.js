// public/api.js
// -----------------------------------------------------------------------------
// API + Data Build Pipeline (Browser-side)
// -----------------------------------------------------------------------------
// Responsibilities
// - fetchConfig(): holt /api/config (Sources + Default delimiter)
// - fetchCsvText(sourceId): holt /api/data (CSV text + delimiter)
// - loadData(ctx): lädt alle CSV Quellen und baut RAW-Modelle pro Source
//     * ctx.raw.bySource : Map<sourceId, { sid, text, delimiter, model }>
// - mergeModels(models): kombiniert mehrere Source-Modelle deterministisch (yearKey-aware)
// -----------------------------------------------------------------------------


import { buildModel } from "./parse.js";

// ============================================================================
// 1) Small fetch helpers (server is source of truth)
// ============================================================================

export async function fetchConfig() {
  const res = await fetch("/api/config", { cache: "no-store" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error: /api/config");

  // Server is source of truth: forward config as-is (plus safe derived defaults).
  // This keeps "timing" (BPM) available to chart.js / legend.js via state.config.
  const cfg = (json && typeof json === "object") ? json : {};

  const delimiter = String(cfg.delimiter || ";");
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  const defaultSource = cfg.defaultSource || (sources?.[0]?.id ?? null);

  return {
    ...cfg,
    delimiter,
    sources,
    defaultSource,
  };
}

export async function fetchCsvText(sourceId) {
  const url = sourceId
    ? `/api/data?sourceId=${encodeURIComponent(sourceId)}`
    : "/api/data";

  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error: /api/data");

  return {
    text: json.text,
    delimiter: json.delimiter || ";",
    source: json.source || null,   // optional: {id,label}
    csvPath: json.csvPath || null, // optional: debug aid
  };
}


/// ============================================================================
// loadData(ctx) – Single Source of Truth (RAW-in-Memory-Modell Variante B)
// ============================================================================

export async function loadData(ctx) {
  if (!ctx) throw new Error("loadData: ctx missing");
  if (!ctx.config) throw new Error("loadData: ctx.config missing");
  if (!ctx.flags) ctx.flags = {};

  const DEFAULT_DELIM = ";";

  const token = (ctx.flags.dataBuildToken = (ctx.flags.dataBuildToken || 0) + 1);
  const isFresh = () => token === ctx.flags.dataBuildToken;

  if (!Array.isArray(ctx.config.sources)) {
    throw new Error("loadData: ctx.config.sources must be array");
  }

  const sourceIds = ctx.config.sources
    .map(s => String(s?.id ?? "").trim())
    .filter(Boolean);

  if (!sourceIds.length) return null;

  ctx.raw = ctx.raw || {};
  ctx.raw.bySource = ctx.raw.bySource || new Map();

  async function loadSource(sid) {
    if (ctx.raw.bySource.has(sid)) return ctx.raw.bySource.get(sid);

    const res = await fetchCsvText(sid);
    if (!res?.text) throw new Error(`CSV load failed for source ${sid}`);

    const model = buildModel(res.text, res.delimiter || DEFAULT_DELIM, {
      sourceId: sid,
    });

    if (!model) throw new Error(`buildModel failed for source ${sid}`);

    const entry = {
      sid,
      text: res.text,
      delimiter: res.delimiter || DEFAULT_DELIM,
      model,
    };

    ctx.raw.bySource.set(sid, entry);
    return entry;
  }

  const entries = await Promise.all(sourceIds.map(loadSource));
  if (!isFresh()) return ctx.raw;

  console.log("api.js [loadData] raw loaded", {
    sources: entries.length,
    totalBars: entries.reduce((a, e) => a + (e.model?.bars?.length || 0), 0),
  });

  return ctx.raw;
}

// ============================================================================
// 3) mergeModels(models) – deterministic, type-aware merge
// ============================================================================

/**
 * mergeModels(models)
 * -----------------------------------------------------------------------------
 * Kombiniert mehrere per-Quelle erzeugte Modelle zu EINEM Modell.
 *
 * CONTRACT (Option A strict + Planned relations):
 * - years: number[] (NUR numerische Jahre; undatiert ist NICHT Teil von years)
 * - cats:  string[] (Kategorie-Identities; *identity-preserving*, keine inhaltliche Normalisierung)
 * - types: string[] (Typ-Keys; identity-preserving; Sort ok)
 *
 * - bars: Aggregates pro (yearKey, cat, type)
 *   - yearKey: string (z.B. "2024" oder "Undatiert")
 *   - year: number | null (nur numerisch, sonst null)
 *   - akzeptiert Eingaben mit .type ODER .typ (defensiv), schreibt canonical als .type
 *
 * - unitByCat: erster Treffer gewinnt (stabil)
 * - detailsByKey: concat arrays (key bleibt unverändert; erwartet `${yearKey}||${cat}||${type}`)
 *
 * - planned relations (legend-only; NO money semantics):
 *   - plannedSourceCat : string[]  // `${sourceId}||${cat}`
 *   - plannedSourceType: string[]  // `${sourceId}||${type}`
 *   - plannedTypeCat   : string[]  // `${type}||${cat}`
 *
 * - hasUndated / undatedLabel: Meta für UI (Chart/Legend)
 */
export function mergeModels(models) {
  console.log("api.js [mergeModels] called");

  const list = Array.isArray(models) ? models : [];
  const DEFAULT_UNDATED = "Undatiert";

  // ----------------------------------------------------------------------------
  // Helpers (strict)
  // ----------------------------------------------------------------------------
  const normKey = (v) => String(v ?? "").trim(); // "?" bleibt "?"
  const isValidYear = (y) => Number.isFinite(y) && y >= 1900 && y <= 2100;

  const toValidYearOrNull = (v) => {
    const y = Number(v);
    return isValidYear(y) ? y : null;
  };

  const resolveUndatedLabel = (m) => normKey(m?.undatedLabel) || DEFAULT_UNDATED;

  // Universe label stability (first occurrence wins)
  // Map<key, firstRawLabel>
  const addUniverse = (map, raw) => {
    const key = normKey(raw);
    if (!key) return;
    if (!map.has(key)) map.set(key, raw);
  };

  const addUnit = (unitByCat, cat, unit) => {
    const c = normKey(cat);
    const u = String(unit ?? "").trim();
    if (!c || !u) return;
    if (!unitByCat.has(c)) unitByCat.set(c, u);
  };

  // Accept Map, array-of-pairs, or object (but normalize output to array-of-pairs)
  const iterEntries = (maybeMapOrArrayOrObj) => {
    if (!maybeMapOrArrayOrObj) return [];
    if (maybeMapOrArrayOrObj instanceof Map) return maybeMapOrArrayOrObj.entries();
    if (Array.isArray(maybeMapOrArrayOrObj)) return maybeMapOrArrayOrObj;
    if (typeof maybeMapOrArrayOrObj === "object") return Object.entries(maybeMapOrArrayOrObj);
    return [];
  };

  const addStringArrayDedup = (set, arr) => {
    if (!Array.isArray(arr)) return;
    for (const v of arr) {
      const s = normKey(v);
      if (!s) continue;
      set.add(s);
    }
  };

  // ----------------------------------------------------------------------------
  // Pass 1: determine global undated label (stable)
  // ----------------------------------------------------------------------------
  let undatedLabelFinal = DEFAULT_UNDATED;
  for (const m of list) {
    if (!m) continue;
    const ul = resolveUndatedLabel(m);
    if (ul && ul !== DEFAULT_UNDATED) {
      undatedLabelFinal = ul;
      break;
    }
  }

  // ----------------------------------------------------------------------------
  // Accumulators
  // ----------------------------------------------------------------------------
  const yearsSet = new Set();     // numeric-only
  const catsSet = new Map();      // Map<catKey, firstRawLabel>
  const typesSet = new Map();     // Map<typeKey, firstRawLabel>
  const unitByCat = new Map();    // Map<catKey, unit>
  const barsAcc = new Map();      // key = `${yearKey}||${cat}||${type}` -> aggregate
  const detailsByKey = new Map(); // Map<string, any[]>

  // planned relations (dedup)
  const plannedSourceCatSet = new Set();  // `${sid}||${cat}`
  const plannedSourceTypeSet = new Set(); // `${sid}||${type}`
  const plannedTypeCatSet = new Set();    // `${type}||${cat}`

  const resolveBarType = (b) => normKey(b?.type ?? b?.typ);
  const resolveBarCat = (b) => normKey(b?.cat);

  const resolveBarYearKeyAndYear = (b) => {
    // Prefer explicit yearKey; else derive from numeric year; else undated.
    let yearKey = normKey(b?.yearKey);
    let year = toValidYearOrNull(b?.year);

    // If yearKey is numeric-like and year is missing/invalid, derive numeric year from yearKey.
    if (year == null && yearKey) {
      const yFromKey = toValidYearOrNull(yearKey);
      if (yFromKey != null) year = yFromKey;
    }

    // If no yearKey, derive it from year; else normalize undated label variants.
    if (!yearKey) {
      yearKey = year != null ? String(year) : undatedLabelFinal;
    } else {
      // normalize per-model undated label variants to undatedLabelFinal when undated
      const perModelUndated = normKey(b?.undatedLabel);
      if (year == null && yearKey && (yearKey === perModelUndated || yearKey === DEFAULT_UNDATED)) {
        yearKey = undatedLabelFinal;
      }
    }

    // Final guard: if undated, force yearKey to undatedLabelFinal
    if (year == null) yearKey = undatedLabelFinal;

    return { yearKey, year };
  };

  const addBar = (b) => {
    const cat = resolveBarCat(b);
    const type = resolveBarType(b);
    if (!cat || !type) return;

    const { yearKey, year } = resolveBarYearKeyAndYear(b);
    if (!yearKey) return;

    if (year != null) yearsSet.add(year);

    const k = `${yearKey}||${cat}||${type}`;
    let acc = barsAcc.get(k);
    if (!acc) {
      acc = { yearKey, year, type, cat, kosten: 0, menge: 0 };
      barsAcc.set(k, acc);
    } else {
      // Defensive: keep the "best" year value (numeric beats null)
      if (acc.year == null && year != null) acc.year = year;
    }

    const kosten = Number(b?.kosten);
    const menge = Number(b?.menge);
    if (Number.isFinite(kosten)) acc.kosten += kosten;
    if (Number.isFinite(menge)) acc.menge += menge;
  };

  const addDetails = (m) => {
    const src = m?.detailsByKey;

    // Accept Map or plain object
    if (src instanceof Map) {
      for (const [key, arr] of src.entries()) {
        if (!Array.isArray(arr) || arr.length === 0) continue;
        let out = detailsByKey.get(key);
        if (!out) detailsByKey.set(key, (out = []));
        out.push(...arr);
      }
      return;
    }

    if (src && typeof src === "object") {
      for (const [key, arr] of Object.entries(src)) {
        if (!Array.isArray(arr) || arr.length === 0) continue;
        let out = detailsByKey.get(key);
        if (!out) detailsByKey.set(key, (out = []));
        out.push(...arr);
      }
    }
  };

  // ----------------------------------------------------------------------------
  // Merge
  // ----------------------------------------------------------------------------
  for (const m of list) {
    if (!m) continue;

    // years (numeric-only, strict range)
    for (const y of m.years || []) {
      const year = toValidYearOrNull(y);
      if (year != null) yearsSet.add(year);
    }

    // cats/types universes (identity-preserving; first occurrence wins)
    for (const raw of m.cats || []) addUniverse(catsSet, raw);
    for (const raw of m.types || []) addUniverse(typesSet, raw);

    // units: accept Map, array-of-pairs, or object
    for (const entry of iterEntries(m.unitByCat)) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      addUnit(unitByCat, entry[0], entry[1]);
    }

    // bars: yearKey-aware; undated allowed; type fallback (.typ)
    for (const b of m.bars || []) addBar(b);

    // planned relations (legend-only)
    addStringArrayDedup(plannedSourceCatSet, m.plannedSourceCat);
    addStringArrayDedup(plannedSourceTypeSet, m.plannedSourceType);
    addStringArrayDedup(plannedTypeCatSet, m.plannedTypeCat);

    // details: concat
    addDetails(m);
  }

  // ----------------------------------------------------------------------------
  // Finalize (deterministic order)
  // ----------------------------------------------------------------------------
  const years = Array.from(yearsSet).sort((a, b) => a - b);

  // Preserve insertion order for cats (stable)
  const cats = Array.from(catsSet.keys());

  // Deterministic order for types
  const types = Array.from(typesSet.keys()).sort((a, b) =>
    String(a).localeCompare(String(b), "de")
  );

  const bars = Array.from(barsAcc.values());

  // hasUndated if any bar is undated
  const hasUndated = bars.some((b) => b?.year == null || String(b?.yearKey) === undatedLabelFinal);

  return {
    years,
    cats,
    types,
    bars,
    unitByCat: Array.from(unitByCat.entries()),
    detailsByKey, // Map<string, any[]>

    // planned relations (deduped, stable order)
    plannedSourceCat: Array.from(plannedSourceCatSet),
    plannedSourceType: Array.from(plannedSourceTypeSet),
    plannedTypeCat: Array.from(plannedTypeCatSet),

    hasUndated,
    undatedLabel: undatedLabelFinal,
  };
}