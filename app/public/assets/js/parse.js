// parse.js
// -----------------------------------------------------------------------------
// CSV Parser → Model Builder (pure)
// -----------------------------------------------------------------------------
// Expected header (recommended):
// Gegenpartei;Kostenart;Kategorie;Buchungstyp;Von;Bis;Jahr;Betrag;Menge;Einheit
//
// Contract (year / undated):
// - If Jahr cell contains a valid year => SOURCE OF TRUTH (never overwritten)
// - Else derive year from Bis (preferred) or Von
// - If Jahr, Von, Bis are ALL empty => row is UNDATED:
//     - year is NaN
//     - row remains chartable under a dedicated "Undatiert" bucket
// - Planned vs Actual is modeled via `status` (not via a virtual type)
// - Optional text is modeled via `memo`
//
// Output model (dimensioned; future-proof):
// - years: number[]
// - cats: string[]   (KATEGORIE; chart dimension / dropdown)
// - types: string[]  (BUCHUNGSTYP; filter / dropdown)
// - bars: { yearKey: string, year?: number|null, cat: string, type: string, kosten: number, menge: number }[]  (aggregated per (yearKey, Kategorie, Typ))
// - unitByCat: [cat, unit][]
// - detailsByKey: Map<`${yearKey}||${cat}||${typ}`, detailRow[]>
// - hasUndated: boolean
// - undatedLabel: string
// -----------------------------------------------------------------------------

import { cleanKey } from "/assets/js/keys.js";

function cleanText(s) {
  return String(s ?? "").replace(/^\uFEFF/, "").trim();
}



// For dimensions (Kategorie/Typ/etc.): empty -> "?"
function dimOrQuestion(s) {
  const t = cleanKey(s);
  return t ? t : "?";
}

function splitLine(line, delimiter) {
  // IMPORTANT: do NOT filter empty cells -> positions must stay stable
  return cleanText(line).split(delimiter).map((x) => cleanText(x));
}

function parseNumberStrict(s) {
  const t = cleanText(s);
  if (!t) return NaN;
  const normalized = t.replace(/[−–]/g, "-"); // safety
  const v = Number.parseFloat(normalized);
  return Number.isFinite(v) ? v : NaN;
}

function uniqueSorted(arr, locale = "de") {
  return Array.from(new Set((arr || []).filter(Boolean))).sort((a, b) =>
    String(a).localeCompare(String(b), locale)
  );
}

function isValidYear(y) {
  return Number.isFinite(y) && y >= 1900 && y <= 2100;
}

/**
 * Extract a year from common date formats.
 * Supports:
 * - YYYY-MM-DD (also with time suffix)
 * - YYYY/MM/DD
 * - DD.MM.YYYY
 * - DD/MM/YYYY
 */
function yearFromDateStr(s) {
  const t = cleanText(s);
  if (!t) return null;

  // YYYY-MM-DD / YYYY/MM/DD (optionally with time)
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (m) {
    const y = Number(m[1]);
    return isValidYear(y) ? y : null;
  }

  // DD.MM.YYYY / DD/MM/YYYY
  m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s.*)?$/);
  if (m) {
    const y = Number(m[3]);
    return isValidYear(y) ? y : null;
  }

  return null;
}

/**
 * Header index
 * - Required: Kategorie, Betrag
 * - Optional: Gegenpartei, Kostenart, Buchungstyp, Von, Bis, Jahr, Menge, Einheit, Status, Memo
 */
function headerIndex(headerParts) {
  const lc = headerParts.map((h) => cleanText(h).toLowerCase());
  const idx = (name) => lc.indexOf(name);

  const iGegenpartei = idx("gegenpartei");
  const iKostenart = idx("kostenart");
  const iKategorie = idx("kategorie");
  const iBuchungstyp = idx("buchungstyp");
  const iVon = idx("von");
  const iBis = idx("bis");
  const iJahr = idx("jahr");
  const iBetrag = idx("betrag");
  const iMenge = idx("menge");
  const iEinheit = idx("einheit");
  const iStatus = idx("status");
  const iMemo = idx("memo");

  if (iKategorie < 0 || iBetrag < 0) {
    throw new Error(
      `CSV Header unvollständig. Benötigt: Kategorie, Betrag. Header: ${headerParts.join(
        " | "
      )}`
    );
  }

  return {
    iGegenpartei,
    iKostenart,
    iKategorie,
    iBuchungstyp,
    iVon,
    iBis,
    iJahr,
    iBetrag,
    iMenge,
    iEinheit,
    iStatus,
    iMemo,
  };
}

/**
 * Parse rows into a normalized list.
 *
 * Canonical fields:
 * - year: number (may be NaN if undated)
 * - cat: Kategorie key (chart dimension; empty -> "?")
 * - typ: Buchungstyp key (filter dimension; empty -> "?")
 * - kostenart: Kostenart key (info dimension; empty -> "?")
 * - status: string ("planned" or "actual")
 * - memo: string (optional text)
 *
 * IMPORTANT year rule:
 * - If Jahr cell contains a valid year, it is the source of truth.
 * - Only if Jahr is empty/invalid, derive from Bis (preferred) or Von.
 * - A valid Jahr is NEVER overwritten by Von/Bis.
 * - If Jahr, Von, Bis are ALL empty => undated (year is NaN)
 */
function parseRows(rawLines, delimiter, cols) {
  const rows = [];
  const cell = (parts, idx) => (idx >= 0 && idx < parts.length ? parts[idx] : "");

  // Year resolution with strict precedence:
  // 1) valid Jahr
  // 2) derived from Bis
  // 3) derived from Von
  // 4) NaN
  const resolveYear = (jahrRaw, bisRaw, vonRaw) => {
    const jahrText = cleanText(jahrRaw);
    const hasJahrCell = jahrText.length > 0;

    if (hasJahrCell) {
      const y = Number.parseInt(jahrText, 10);
      if (isValidYear(y)) return y; // SOURCE OF TRUTH
      // Jahr present but invalid -> repair via dates
      return yearFromDateStr(bisRaw) ?? yearFromDateStr(vonRaw) ?? NaN;
    }

    // Jahr empty -> derive from dates
    return yearFromDateStr(bisRaw) ?? yearFromDateStr(vonRaw) ?? NaN;
  };

  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;

    const parts = splitLine(line, delimiter);

    // Raw fields (kept for tooltips/tables)
    const gegenpartei = cleanText(cell(parts, cols.iGegenpartei));
    const kostenartRaw = cleanText(cell(parts, cols.iKostenart));
    const kategorieRaw = cleanText(cell(parts, cols.iKategorie));
    const buchungstypRaw = cleanText(cell(parts, cols.iBuchungstyp));
    const von = cleanText(cell(parts, cols.iVon));
    const bis = cleanText(cell(parts, cols.iBis));
    const jahrRaw = cleanText(cell(parts, cols.iJahr));
    const betragRaw = cleanText(cell(parts, cols.iBetrag));
    const mengeRaw = cleanText(cell(parts, cols.iMenge));
    const einheitRaw = cleanText(cell(parts, cols.iEinheit));
    const statusRaw = cleanText(cell(parts, cols.iStatus));
    const memoRaw = cleanText(cell(parts, cols.iMemo));

    // Betrag required (strict)
    const betragNum = parseNumberStrict(betragRaw);
    if (!Number.isFinite(betragNum)) continue;

    // Menge optional
    const mengeNum = cols.iMenge >= 0 ? parseNumberStrict(mengeRaw) : NaN;

    // Undated detection: undated only if Jahr, Von, Bis are ALL empty
    const hasAnyDate = !!jahrRaw || !!von || !!bis;
    const isUndated = !hasAnyDate;

    // Year: do not let Von/Bis override a valid Jahr
    const year = isUndated ? NaN : resolveYear(jahrRaw, bis, von);

    // Canonical dimensions (NO cross-fallbacks!)
    const cat = dimOrQuestion(kategorieRaw);     // ✅ Kategorie is the chart dimension
    const kostenart = dimOrQuestion(kostenartRaw);
    const typ = dimOrQuestion(buchungstypRaw);  // ✅ Typ only from Buchungstyp

    // Status (planned/actual):
    // - If provided, normalize
    // - Else if undated => planned
    // - Else => actual
    const st = cleanKey(statusRaw).toLowerCase();
    const status = st === "planned" || st === "geplant" ? "planned"
                 : st === "actual" || st === "ist" ? "actual"
                 : (isUndated ? "planned" : "actual");

    const memo = memoRaw;

    rows.push({
      // canonical
      year,
      cat,         // Kategorie
      typ,         // Buchungstyp
      kostenart,   // Kostenart (info)
      kosten: betragNum,
      menge: mengeNum,
      einheit: cleanText(einheitRaw),
      status,
      memo,
      _isUndated: isUndated,

      // raw (for display)
      Gegenpartei: gegenpartei,
      Kostenart: kostenartRaw,
      Kategorie: kategorieRaw,
      Buchungstyp: buchungstypRaw,
      Von: von,
      Bis: bis,
      Jahr: jahrRaw,
      Betrag: betragRaw,
      Menge: mengeRaw,
      Einheit: einheitRaw,
    });
  }

  return rows;
}

/**
 * Aggregate rows into:
 *  A) bars (ONLY actual rows) by (yearKey, cat, type)
 *  B) planned relations (ONLY planned rows) as lightweight edges for the legend
 *
 * Dimensions:
 * - cat  = Kategorie (chart dimension)
 * - type = Buchungstyp (filter dimension)
 *
 * Contract / Output:
 * - years: number[] (sorted; only dated)
 * - cats : string[] (unique, sorted; includes planned cats)
 * - types: string[] (unique, sorted; includes planned types)
 * - bars : { yearKey:string, year:number|null, cat:string, type:string, kosten:number, menge:number }[]
 * - unitByCat: [cat, unit][]
 * - hasUndated: boolean
 * - undatedLabel: string
 *
 * Planned relations (NO amounts, for legend only):
 * - plannedSourceCat : string[]  // entries: `${sourceId}||${cat}`
 * - plannedSourceType: string[]  // entries: `${sourceId}||${type}`
 * - plannedTypeCat   : string[]  // entries: `${type}||${cat}`
 *
 * Notes:
 * - parse.js garantiert: leere Dimensionen sind bereits "?" (keine leeren Strings).
 * - Trotzdem defensiv: cleanKey + Guards bleiben.
 * - Year-rule: bars only built for rows that are dated OR explicitly undated (_isUndated).
 * - Planned rows do NOT affect bars/totals, but DO affect universes and planned relations.
 */
function buildAggregates(rows, sourceId) {
  const UNDATED_LABEL = "Undatiert";
  const sid = String(sourceId ?? "").trim(); // required for plannedSource* keys

  const all = Array.isArray(rows) ? rows : [];

  const isChartable = (r) => {
    const y = Number(r?.year);
    return isValidYear(y) || !!r?._isUndated;
  };

  const isPlanned = (r) => String(r?.status || "").toLowerCase() === "planned";

  // Keep only chartable rows (dated or undated). Planned/Actual both stay here.
  const chartRows = all.filter(isChartable);

  // ---- Universes (include planned, so UI can show these categories/types) ----
  const cats = uniqueSorted(
    chartRows.map((r) => cleanKey(r?.cat)).filter(Boolean)
  );

  const types = uniqueSorted(
    chartRows.map((r) => cleanKey(r?.typ)).filter(Boolean) // input-field bleibt typ
  );

  const years = Array.from(
    new Set(chartRows.map((r) => Number(r?.year)).filter(isValidYear))
  ).sort((a, b) => a - b);

  const hasUndated = chartRows.some((r) => !!r?._isUndated || !isValidYear(Number(r?.year)));

  // ---- Units per category (first wins) ----
  // We record units from any row (planned or actual). If you prefer "actual only", filter here.
  const unitByCat = new Map();
  for (const r of chartRows) {
    const cat = cleanKey(r?.cat);
    if (!cat) continue;
    if (!unitByCat.has(cat) && r?.einheit) unitByCat.set(cat, String(r.einheit));
  }

  // ---- Planned relations (legend-only; no money semantics) ----
  const plannedSourceCat = new Set();
  const plannedSourceType = new Set();
  const plannedTypeCat = new Set();

  // ---- Aggregate bars (ACTUAL only) ----
  // `${yearKey}||${cat}||${type}` -> bar
  const acc = new Map();

  for (const r of chartRows) {
    const cat = cleanKey(r?.cat);
    const type = cleanKey(r?.typ);
    if (!cat || !type) continue;

    // Planned rows: collect relations, skip amounts
    if (isPlanned(r)) {
      // Only create source-relations if we have a sourceId (should be true per-source file model)
      if (sid) {
        plannedSourceCat.add(`${sid}||${cat}`);
        plannedSourceType.add(`${sid}||${type}`);
      }
      plannedTypeCat.add(`${type}||${cat}`);
      continue;
    }

    // Actual rows: go into bars
    const yearNum = Number(r?.year);
    const undated = !!r?._isUndated || !isValidYear(yearNum);
    const yearKey = undated ? UNDATED_LABEL : String(yearNum);

    const key = `${yearKey}||${cat}||${type}`;
    let a = acc.get(key);
    if (!a) {
      a = { yearKey, year: undated ? null : yearNum, cat, type, kosten: 0, menge: 0 };
      acc.set(key, a);
    }

    const k = Number(r?.kosten);
    const m = Number(r?.menge);

    if (Number.isFinite(k)) a.kosten += k;
    if (Number.isFinite(m)) a.menge += m;
  }

  return {
    years,
    cats,
    types,
    bars: Array.from(acc.values()),
    unitByCat: Array.from(unitByCat.entries()),
    hasUndated,
    undatedLabel: UNDATED_LABEL,

    // legend-only planned relations
    plannedSourceCat: Array.from(plannedSourceCat),
    plannedSourceType: Array.from(plannedSourceType),
    plannedTypeCat: Array.from(plannedTypeCat),
  };
}

/**
 * buildModel(csvText, delimiter, opts)
 *
 * Pipeline:
 * 1) CSV -> lines (positionsstabil)
 * 2) Header mappen
 * 3) Rows parsen (canonical fields: year, cat, typ, kosten, menge, einheit, status, memo, _isUndated)
 * 4) Universe (cats/types) aus ALLEN rows (nicht nur gefiltert)
 * 5) Optional: Filter nach typ (Buchungstyp)
 * 6) detailsByKey bauen
 * 7) Aggregates (years/bars/unitByCat/hasUndated/undatedLabel) bauen
 *
 * opts:
 * - type: string | null | undefined   // Buchungstyp filter; falsy => ALL
 * - sourceId: string                  // required for tooltip provenance
 * - detailLimit: number               // max details per bucket
 */
export function buildModel(csvText, delimiter = ";", opts = {}) {
  // ---------------------------------------------------------------------------
  // 0) Options (deterministic)
  // ---------------------------------------------------------------------------
  const typeFilter = cleanKey(opts?.type ?? ""); // "" => ALL
  const sourceId = cleanText(opts?.sourceId ?? "");
  const detailLimit =
    Number.isFinite(opts?.detailLimit) && Number(opts.detailLimit) > 0
      ? Number(opts.detailLimit)
      : 50;

  // Wenn du wirklich willst, dass Quelle NIE leer ist: hart failen.
  // (Du hast gesagt: wenn leer, darf crashen)
  if (!sourceId) throw new Error("buildModel: opts.sourceId missing/empty (required for tooltip)");

  // ---------------------------------------------------------------------------
  // 1) Input -> lines (Positionsstabilität!)
  // ---------------------------------------------------------------------------
  const rawLines = String(csvText ?? "")
    .split(/\r?\n/)
    .map((l) => cleanText(l))
    .filter((l) => l.length > 0);

  if (rawLines.length < 2) throw new Error("CSV leer oder ohne Datenzeilen.");

  // ---------------------------------------------------------------------------
  // 2) Header + Parse
  // ---------------------------------------------------------------------------
  const headerParts = splitLine(rawLines[0], delimiter);
  const cols = headerIndex(headerParts);

  const allRows = parseRows(rawLines, delimiter, cols);
  if (!allRows.length) {
    throw new Error("Keine verwertbaren Zeilen. Prüfe Betrag/Delimiter/Spalten.");
  }

  // ---------------------------------------------------------------------------
  // 3) Universe (Dropdowns) aus ALLEN Rows
  // - parseRows liefert dimOrQuestion() => "?" ist explizit erlaubt.
  // - cleanKey defensiv; leere Strings werden entfernt.
  // ---------------------------------------------------------------------------
  const cats = uniqueSorted(allRows.map((r) => cleanKey(r?.cat)).filter(Boolean));
  const types = uniqueSorted(allRows.map((r) => cleanKey(r?.typ)).filter(Boolean));

  // ---------------------------------------------------------------------------
  // 4) Optionaler Typ-Filter (Buchungstyp)
  // ---------------------------------------------------------------------------
  const rows =
    typeFilter.length > 0
      ? allRows.filter((r) => cleanKey(r?.typ) === typeFilter)
      : allRows;

  // ---------------------------------------------------------------------------
  // 5) Tooltip Details
  // Key: `${yearKey}||${cat}||${typ}` (parse-seitig typ; app kann später auf type mappen)
  // ---------------------------------------------------------------------------
  const detailsByKey = new Map();

  const pushDetail = (key, rec) => {
    let arr = detailsByKey.get(key);
    if (!arr) detailsByKey.set(key, (arr = []));
    if (arr.length < detailLimit) arr.push(rec);
  };

  // Aggregates must be built before details to get undatedLabel
  const aggregates = buildAggregates(rows,sourceId);

  for (const r of rows) {
    const year = Number(r?.year);
    const catKey = cleanKey(r?.cat);
    const typKey = cleanKey(r?.typ);

    const isUndated = !!r?._isUndated || !isValidYear(year);
    const yearKey = isUndated ? (aggregates.undatedLabel ?? "Undatiert") : String(year);

    const rec = {
      Quelle: sourceId,

      // canonical-ish
      _cat: catKey,
      _typ: typKey,

      // raw display fields
      Gegenpartei: r?.Gegenpartei ?? "",
      Kostenart: r?.Kostenart ?? "",
      Kategorie: r?.Kategorie ?? "",
      Buchungstyp: r?.Buchungstyp ?? "",
      Von: r?.Von ?? "",
      Bis: r?.Bis ?? "",
      Jahr: r?.Jahr ?? "",
      Betrag: r?.Betrag ?? "",
      Menge: r?.Menge ?? "",
      Einheit: r?.Einheit ?? "",

      status: r?.status ?? "",
      memo: r?.memo ?? "",
      _isUndated: !!r?._isUndated,
    };

    // chartable only
    if (!catKey || !typKey) continue;

    pushDetail(`${yearKey}||${catKey}||${typKey}`, rec);
  }

  // ---------------------------------------------------------------------------
  // 6) Return (stable model shape)
  // ---------------------------------------------------------------------------
  return {
  // Universe (immer aus ALLEN Rows; UI soll nicht "verschwinden", nur weil Filter aktiv ist)
  cats,
  types,

  // Aggregates (ACTUAL only bars; planned is excluded there by design)
  years: aggregates.years,
  bars: aggregates.bars,
  unitByCat: aggregates.unitByCat,

  // Planned relations (legend-only, no money semantics)
  plannedSourceCat: aggregates.plannedSourceCat ?? [],
  plannedSourceType: aggregates.plannedSourceType ?? [],
  plannedTypeCat: aggregates.plannedTypeCat ?? [],

  // Extras
  detailsByKey,
  hasUndated: !!aggregates.hasUndated,
  undatedLabel: aggregates.undatedLabel ?? "Undatiert",
};
}