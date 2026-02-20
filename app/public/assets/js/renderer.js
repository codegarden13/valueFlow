// /assets/js/renderer.js
// -----------------------------------------------------------------------------
// INDUSTRIAL RENDERER PIPELINE (RAW-in-Memory)
// -----------------------------------------------------------------------------
// Zielarchitektur (ohne Persistenz, ohne Fallbacks):
// - ctx.raw.bySource: Map<sid, { sid, text, delimiter, model }>
// - ctx.derived: { options, view, graph }
// - UI-State (User-Intent): ctx.state
//
// OPTION A (KATEGORIE-KONTRAKT):
// - Kategorie-Strings sind IDENTITÄT (case-/whitespace-/unicode-sensitiv)
// - Kategorien werden im Renderer NICHT normalisiert.
// - Typen dürfen normalisiert werden (cleanKey), Kategorien NICHT.
//
// Strict:
// - Contract-Verletzungen => throw
// -----------------------------------------------------------------------------

import { mergeModels } from "./api.js";
import { drawChart } from "./chart.js";
import { renderLegend } from "./legend.js";
import { cleanKey } from "./keys.js"; // Typen
import { aggregate } from "./aggregates.js";


import {
  getVisibleYearRange,
  getVisibleCatsForRange,
  makeVisibleModel,
  isModelEmpty,
  computeNetInfo,
  getYearDomain,
} from "./view-derivations.js";
import { createCategoryInspector } from "./categoryInspector.js";
import { createBarHoverController } from "./barHoverController.js";
import { syncUIFromState, renderSubtitle, setCtxTabUI } from "./ui.js";
import { buildLegendGraph } from "./graphBuilder.js";
import { buildColorByCat } from "./colorsByCat.js";
import { renderDerivedIntoDom, renderCategoryDetailsIntoDom } from "./renderGenTables.js";

// -----------------------------------------------------------------------------
// Pure Helper (Renderer-intern)
// -----------------------------------------------------------------------------

/** Strikter String-Array-Validator (keine Normalisierung). */
function assertStringArray(name, arr) {
  if (!Array.isArray(arr)) throw new Error(`renderer: ${name} must be an array`);
  for (const v of arr) {
    if (typeof v !== "string") {
      throw new Error(`renderer: ${name} contains non-string value: ${String(v)}`);
    }
    if (!v.length) {
      throw new Error(`renderer: ${name} contains empty string`);
    }
  }
  return arr;
}

/** Stable Dedupe (case-sensitiv): behält Einfügereihenfolge, ändert Strings nicht. */
function dedupeStable(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Option-A Identity: String unverändert lassen; nur whitespace-only gilt als leer. */
function asCatId(v) {
  const s = typeof v === "string" ? v : "";
  return s.trim().length ? s : "";
}

/** Normales Trim-String für nicht-Identity Felder (z.B. yearKey, typ). */
function asTrimmed(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : "";
}


// Stable category colors: build once per category universe, cache in ctx
function ensureStableColorByCat(ctx, catsUniverse) {
  if (!ctx) throw new Error("ensureStableColorByCat: ctx missing");
  if (!Array.isArray(catsUniverse)) throw new Error("ensureStableColorByCat: catsUniverse must be an array");

  // Signature changes only when the universe changes (order-sensitive = OK, universe is stable)
  const sig = catsUniverse.join("||");

  if (!ctx.colors) ctx.colors = {};

  // Reuse existing map if universe unchanged
  if (ctx.colors.catSig === sig && ctx.colors.catByCat instanceof Map) {
    return ctx.colors.catByCat;
  }

  // Build once (no config overrides)
  const m = buildColorByCat(catsUniverse);
  if (!(m instanceof Map)) throw new Error("ensureStableColorByCat: buildColorByCat must return a Map");

  ctx.colors.catSig = sig;
  ctx.colors.catByCat = m;
  return m;
}

// -----------------------------------------------------------------------------
// Merge cache (Renderer-intern)
// - Ziel: mergeModels NICHT mehrfach pro redraw/build-token ausführen.
// - Keying: ctx.flags.dataBuildToken + Auswahl-Signatur
// -----------------------------------------------------------------------------
function getMergeCache(ctx) {
  if (!ctx) throw new Error("getMergeCache: ctx missing");
  if (!ctx.__mergeCache || typeof ctx.__mergeCache !== "object") {
    ctx.__mergeCache = { token: Symbol("init"), byKey: new Map() };
  }

  // dataBuildToken is the contract for RAW rebuilds (boot/load/filter that changes RAW)
  const t = ctx?.flags?.dataBuildToken;
  const token = Number.isFinite(Number(t)) ? Number(t) : 0;

  // Reset cache when token changes
  if (ctx.__mergeCache.token !== token) {
    ctx.__mergeCache.token = token;
    ctx.__mergeCache.byKey = new Map();
  }

  return ctx.__mergeCache.byKey;
}

function cachedMergeModels(ctx, key, models) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  const cache = getMergeCache(ctx);
  if (cache.has(key)) return cache.get(key);

  const merged = mergeModels(list);
  cache.set(key, merged);
  return merged;
}

// -----------------------------------------------------------------------------
// Kategorie-Tab UI (Label + Farbe)
// - Der Tab bleibt im Template "dumm"; Styling erfolgt ausschließlich hier.
// - Quelle der Farbe: ctx.derived.colorByCat (Map<cat, color>)
// - Quelle der aktiven Kategorie: ctx.state.legendHighlightCat (gesetzt durch Legend-Hover-Bridge)
// -----------------------------------------------------------------------------

function getCategoryColor(ctx, cat) {
  const c = asCatId(cat);
  if (!c) return "";

  const m = ctx?.derived?.colorByCat;
  if (!(m instanceof Map)) return "";

  const v = m.get(c);
  return typeof v === "string" ? v : "";
}

function pickTextColor(bg) {
  // Simple contrast heuristic; falls parsing fails, keep default.
  const s = String(bg || "").trim();
  if (!s) return "";

  // Accept hex (#rgb/#rrggbb)
  if (s[0] === "#") {
    let r, g, b;
    if (s.length === 4) {
      r = parseInt(s[1] + s[1], 16);
      g = parseInt(s[2] + s[2], 16);
      b = parseInt(s[3] + s[3], 16);
    } else if (s.length === 7) {
      r = parseInt(s.slice(1, 3), 16);
      g = parseInt(s.slice(3, 5), 16);
      b = parseInt(s.slice(5, 7), 16);
    }
    if ([r, g, b].every((x) => Number.isFinite(x))) {
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return lum > 0.62 ? "#111" : "#fff";
    }
  }

  // Accept rgb/rgba
  const m = s.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    if ([r, g, b].every((x) => Number.isFinite(x))) {
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return lum > 0.62 ? "#111" : "#fff";
    }
  }

  return "";
}



function setCategoryTabUI(ctx, cat) {
  const btn = document.getElementById("categoryTab");

  console.log("[setCategoryTabUI] called", {
    incomingCat: cat,
    normalizedCat: asCatId(cat),
    activeCatState: ctx?.state?.activeCat,
    buttonFound: !!btn
  });

  // Trace when called with an empty/cleared category
  if (!asCatId(cat)) {
    console.trace("[setCategoryTabUI] EMPTY cat callsite");
  }

  if (!btn) {
    console.warn("[setCategoryTabUI] categoryTab button NOT found in DOM");
    return;
  }

  const c = asCatId(cat);

  // Label updates always (and title helps verify updates even if CSS hides changes).
  btn.textContent = c || "Kategorie";
  console.log("[setCategoryTabUI] textContent set to:", btn.textContent);
  try {
    btn.title = c || "";
  } catch {
    // ignore
  }

  // Clear styling if no active category.
  if (!c) {
    btn.style.removeProperty("background-color");
    btn.style.removeProperty("border-color");
    btn.style.removeProperty("color");
    return;
  }

  const bg = getCategoryColor(ctx, c);
  if (!bg) {
    btn.style.removeProperty("background-color");
    btn.style.removeProperty("border-color");
    btn.style.removeProperty("color");
    return;
  }

  // Force through Bootstrap/theme overrides.
  btn.style.setProperty("background-color", bg, "important");
  btn.style.setProperty("border-color", bg, "important");

  const fg = pickTextColor(bg);
  if (fg) btn.style.setProperty("color", fg, "important");
  else btn.style.removeProperty("color");
}






// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createRenderer() {
  // ---------------------------------------------------------------------------
  // ensureData(ctx)
  // ---------------------------------------------------------------------------
  // Neue RAW-in-Memory-Variante:
  // - loadData MUSS im Boot laufen und ctx.raw setzen
  // - Renderer lädt NICHT nach, er validiert nur den Contract
  // ---------------------------------------------------------------------------
  async function ensureData(ctx) {
    if (!ctx) throw new Error("ensureData: ctx missing");
    if (!ctx.raw) {
      throw new Error("ensureData: ctx.raw missing – loadData must run during boot");
    }
    if (!(ctx.raw.bySource instanceof Map)) {
      throw new Error("ensureData: ctx.raw.bySource missing/invalid (Map expected)");
    }
    return ctx.raw;
  }

  function renderNoDataForFilterState(ctx) {
    if (ctx?.dom?.subtitleEl) ctx.dom.subtitleEl.textContent = "Keine Daten für aktuelle Filter.";
    if (ctx?.dom?.svgEl) ctx.dom.svgEl.innerHTML = "";
    if (ctx?.dom?.legendEl) ctx.dom.legendEl.innerHTML = "";
  }

// ---------------------------------------------------------------------------
// Hover UX controllers (Chart ↔ Legend Halo ↔ Legend highlight ↔ Inspector)
// ---------------------------------------------------------------------------
function getHoverUX(ctx) {
  const CACHE_VERSION = 4; // bump when wiring changes

  if (ctx.__hoverUX && ctx.__hoverUX._v === CACHE_VERSION) return ctx.__hoverUX;

  const legendEl = ctx?.dom?.legendEl;
  if (!legendEl) throw new Error("getHoverUX: ctx.dom.legendEl missing");

  const inspector = createCategoryInspector(ctx, { syncTab: false });

  // Color resolver: prefer payload color, else derive from shared Map
  function getColor({ color, cat }) {
    const c = asTrimmed(color);
    if (c) return c;

    const k = asCatId(cat);
    const m = ctx?.derived?.colorByCat;
    if (m instanceof Map && k) {
      const v = m.get(k);
      if (typeof v === "string" && v) return v;
    }

    return "rgba(255,255,255,0.9)";
  }

  function pushInspector(model) {
    console.log("[pushInspector] model:", model);
    const cat = asCatId(model?.cat);
    console.log("[pushInspector] extracted cat:", cat);

    // No category -> clear hover UI + reset active selection.
    if (!cat) {
      inspector.clear();
      ctx.state.activeCat = "";
      setCategoryTabUI(ctx, "");
      renderCategoryDetailsIntoDom(ctx);
      return;
    }

    // Provide precise slice keys for inspector (hover table) so it can slice detailsByKey.
    const yearKey = asTrimmed(model?.yearKey || model?.year || model?.jahr);
    const typ = asTrimmed(model?.typ || model?.type);

    inspector.update({
      cat,
      ...(yearKey ? { yearKey } : null),
      ...(typ ? { typ } : null),
    });

    // Keep renderer-owned selection in sync.
    ctx.state.activeCat = cat;
    console.log("[pushInspector] activeCat updated:", ctx.state.activeCat);
    setCategoryTabUI(ctx, cat);

    // Persistent Kategorie-Tab table (separate from inspector hover table)
    renderCategoryDetailsIntoDom(ctx);
  }

  const hoverCtl = createBarHoverController({
    legendRootEl: legendEl,
    getColor,
    onHoverModel: pushInspector,
  });

  // Ensure leaving the chart clears hover effects
  if (ctx.dom?.svgEl) hoverCtl.attachChartLeave(ctx.dom.svgEl);

  // -------------------------------------------------------------------------
  // Legend highlight bridge (event -> state -> legend update)
  // -------------------------------------------------------------------------
  let rafId = 0;
  let pendingCat = null;
  let lastAppliedCat = Symbol("init");

  function applyLegendHighlight(cat) {
    // Strict: store identity string or null
    ctx.state.legendHighlightCat = cat;
    ctx.state.activeCat = asCatId(cat);
    setCategoryTabUI(ctx, ctx.state.activeCat);
    renderCategoryDetailsIntoDom(ctx);

    // Fast path: if legend.js exposes a lightweight update API
    const api = legendEl.__legendApi;
    if (api && typeof api.updateHighlight === "function") {
      api.updateHighlight(cat);
      return;
    }

    // Strict: legend must expose an incremental highlight API.
    throw new Error("applyLegendHighlight: legendEl.__legendApi.updateHighlight missing (fallback disabled)");
  }

  function onLegendHighlight(e) {
    const catRaw = e?.detail?.cat ?? null;
    const cat = catRaw == null ? null : String(catRaw);
    const year = e?.detail?.year ?? null;

    // IMPORTANT UX:
    // Legend/hover wiring can emit "empty" highlight payloads while moving between nodes.
    // We do NOT want to reset the Kategorie tab label to the template word "Kategorie".
    // Clearing can still be done explicitly by other controllers if desired.
    if (cat == null || cat.trim() === "") {
      return;
    }

    // Persist hovered year (string/number) so legend can render `minYear–activeYear`.
    if (year != null && String(year).trim() !== "") {
      ctx.state.legendHighlightYear = year;
    }

    // De-dupe hard (avoid loops + repaint storms)
    if (cat === lastAppliedCat) return;

    pendingCat = cat;
    if (rafId) return;

    rafId = requestAnimationFrame(() => {
      rafId = 0;

      const next = pendingCat;
      pendingCat = null;

      if (next === lastAppliedCat) return;
      lastAppliedCat = next;

      applyLegendHighlight(next);
    });
  }

  // Register listener exactly once per ctx (remove previous handler safely)
  const prevHandler = ctx.__hoverUX?.onLegendHighlight;
  if (prevHandler) legendEl.removeEventListener("legend:highlight", prevHandler);
  legendEl.addEventListener("legend:highlight", onLegendHighlight);

  ctx.__hoverUX = {
    _v: CACHE_VERSION,
    hoverCtl,
    inspector,
    onLegendHighlight,
  };

  return ctx.__hoverUX;
}

// ---------------------------------------------------------------------------
// computeDerived(ctx) – STRICT / Option A
// - Categories are identities (no normalization beyond required string checks)
// - Types are normalized via cleanKey
// - View is year-filtered; Legend graph includes undated regardless of year-range
// - Planned relations are legend-only and MUST NOT affect bars/totals
// - NEW: colorByCat is a single source of truth (Chart + Legend) and MUST be stable
// ---------------------------------------------------------------------------
async function computeDerived(ctx) {
  // -------------------------------------------------------------------------
  // 0) RAW Contract
  // -------------------------------------------------------------------------
  await ensureData(ctx);

  const rawBySource = ctx?.raw?.bySource;
  if (!(rawBySource instanceof Map)) {
    throw new Error("computeDerived: ctx.raw.bySource missing/invalid (Map expected)");
  }

  const rawEntries = Array.from(rawBySource.values());
  if (!rawEntries.length) {
    ctx.derived = { options: null, view: null, graph: null, aggregates: null, colorByCat: null };
    return;
  }

  const requireModel = (e, where) => {
    const m = e?.model;
    if (!m) throw new Error(`computeDerived: raw entry.model missing (${where})`);
    return m;
  };

  // -------------------------------------------------------------------------
  // 1) Base model (Universe / Domain) from RAW models (unfiltered)
  // -------------------------------------------------------------------------
  const allModels = rawEntries.map((e, i) => requireModel(e, `allModels[${i}]`));
  const base = cachedMergeModels(ctx, "base:allSources", allModels);
  if (!base) throw new Error("computeDerived: base model invalid");

  // -------------------------------------------------------------------------
  // 1a) Year Domain + State init/clamp
  // -------------------------------------------------------------------------
  const yearDomain = getYearDomain(base);
  if (!yearDomain) throw new Error("computeDerived: year domain invalid");

  const minY = Number(yearDomain.minY);
  const maxY = Number(yearDomain.maxY);
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY) {
    throw new Error("computeDerived: year domain has invalid min/max");
  }

  if (!Number.isFinite(ctx.state.yearFrom)) ctx.state.yearFrom = minY;
  if (!Number.isFinite(ctx.state.yearTo)) ctx.state.yearTo = maxY;

  ctx.state.yearFrom = Math.max(minY, Math.min(maxY, Number(ctx.state.yearFrom)));
  ctx.state.yearTo = Math.max(minY, Math.min(maxY, Number(ctx.state.yearTo)));
  if (ctx.state.yearFrom > ctx.state.yearTo) {
    [ctx.state.yearFrom, ctx.state.yearTo] = [ctx.state.yearTo, ctx.state.yearFrom];
  }

  const yearBounds = getVisibleYearRange(base, ctx.state);
  if (!yearBounds) throw new Error("computeDerived: year bounds invalid");

  // Types: canonical via cleanKey
  const typesUniverse = dedupeStable(
    assertStringArray("base.types", base.types || []).map(cleanKey).filter(Boolean)
  );
  if (!typesUniverse.length) throw new Error("computeDerived: types universe empty (data broken)");

  // Cats: Option A identity
  const catsUniverse = dedupeStable(assertStringArray("base.cats", base.cats || []).slice());
  if (!catsUniverse.length) throw new Error("computeDerived: cats universe empty (data broken)");


// -------------------------------------------------------------------------

 const colorByCat = ensureStableColorByCat(ctx, catsUniverse);

  // -------------------------------------------------------------------------
  // 1b) Options: universes + inRange (UI uses inRange.*)
  // -------------------------------------------------------------------------
  const options = {
    yearDomain, // {minY,maxY}
    yearBounds, // {yf,yt}
    sources: Array.from(rawBySource.keys()),

    // Full universes (stable)
    universe: {
      types: typesUniverse, // canonical
      cats: catsUniverse,   // identities
    },

    // Year-range-limited universes (computed from DATED bars only)
    inRange: {
      types: [],
      cats: [],
    },

    // UI contract (no legacy): dropdown values come from these two arrays
    types: [],
    cats: [],
  };

  // -------------------------------------------------------------------------
  // 2) Source filter (empty => all)
  // -------------------------------------------------------------------------
  const enabledSources =
    ctx.state.enabledSourceIds instanceof Set && ctx.state.enabledSourceIds.size
      ? new Set(ctx.state.enabledSourceIds)
      : new Set(options.sources);

  const enabledSourcesSig = Array.from(enabledSources).sort((a, b) => String(a).localeCompare(String(b), "de")).join("|");

  const sourceEntries = Array.from(rawBySource.entries()).filter(([sid]) => enabledSources.has(sid));
  if (!sourceEntries.length) {
    ctx.derived = { options, view: null, graph: null, aggregates: null, colorByCat };
    return;
  }

  // -------------------------------------------------------------------------
  // 3) Type filter (empty => all) – enabledTypes canonical (cleanKey)
  // -------------------------------------------------------------------------
  const enabledTypes =
    ctx.state.enabledTypes instanceof Set && ctx.state.enabledTypes.size
      ? new Set(ctx.state.enabledTypes)
      : new Set(options.universe.types);

  if (!enabledTypes.size) throw new Error("computeDerived: enabledTypes empty (types universe broken)");

  // Merge selected sources exactly once
  const selectedModels = sourceEntries.map(([, entry], i) => requireModel(entry, `selectedModels[${i}]`));

  // Optimization:
  // - Wenn enabledSources == alle Quellen, ist mergedSelected identisch zu base.
  // - Andernfalls: merge cached per enabledSourcesSig.
  const allSourcesSelected = enabledSources.size === options.sources.length;
  const mergedSelected = allSourcesSelected
    ? base
    : cachedMergeModels(ctx, `selected:${enabledSourcesSig}`, selectedModels);
  if (!mergedSelected) {
    ctx.derived = { options, view: null, graph: null, aggregates: null, colorByCat };
    return;
  }

  // -------------------------------------------------------------------------
  // 3a) Dropdown universe for current year-range (DATED bars only)
  //     - do NOT overwrite options.universe
  // -------------------------------------------------------------------------
  const computeUniverseForYearRange = (model, state, enabledTypesSet) => {
  const yf = Number(state.yearFrom);
  const yt = Number(state.yearTo);

  const types = new Set();
  const cats = new Set();

  for (const b of model?.bars || []) {
    const y = Number(b?.year);
    if (!Number.isFinite(y)) continue;
    if (Number.isFinite(yf) && y < yf) continue;
    if (Number.isFinite(yt) && y > yt) continue;

    const t = cleanKey(b?.type ?? b?.typ);
    const c = b?.cat; // Option A identity

    // Typ-Universe bleibt "alle Typen im Range" (damit man wieder re-aktivieren kann)
    if (t) types.add(t);

    // Kategorienliste soll Quelle+Typ+YearRange respektieren
    if (t && enabledTypesSet instanceof Set && !enabledTypesSet.has(t)) continue;

    if (typeof c === "string" && c.length) cats.add(c);
  }

  return {
    types: Array.from(types).sort((a, b) => a.localeCompare(b, "de")),
    cats: Array.from(cats).sort((a, b) => a.localeCompare(b, "de")),
  };
};

  //const uni = computeUniverseForYearRange(mergedSelected, ctx.state);
  const uni = computeUniverseForYearRange(mergedSelected, ctx.state, enabledTypes);

  options.inRange.types = uni.types.length ? uni.types : options.universe.types.slice();
  options.inRange.cats  = uni.cats.length  ? uni.cats  : options.universe.cats.slice();

  // UI contract (no legacy): dropdowns should use inRange universes
  options.types = options.inRange.types;
  options.cats  = options.inRange.cats;

  // Apply type filter + year-range (makeVisibleModel respects year-range for DATED)
  const typeFiltered = makeVisibleModel(mergedSelected, { ...ctx.state, enabledTypes });
  if (!typeFiltered) {
    ctx.derived = { options, view: null, graph: null, aggregates: null, colorByCat };
    return;
  }

  // -------------------------------------------------------------------------
  // 4) View (Year + Category filter)
  // -------------------------------------------------------------------------
  if (!(ctx.state.disabledCats instanceof Set)) ctx.state.disabledCats = new Set();

  const rawVisibleCats = getVisibleCatsForRange(typeFiltered, ctx.state) || [];
  assertStringArray("visibleCats", rawVisibleCats);
  const visibleCats = dedupeStable(rawVisibleCats.slice());

  // Clamp disabledCats ONLY to universe (persist user intent across filters)
  const universeCatsSet = new Set(options.universe.cats);
  for (const c of Array.from(ctx.state.disabledCats)) {
    if (!universeCatsSet.has(c)) ctx.state.disabledCats.delete(c);
  }

  const enabledCats = visibleCats.filter((c) => !ctx.state.disabledCats.has(c));
  const enabledCatSet = new Set(enabledCats);

  const view = makeVisibleModel(typeFiltered, { ...ctx.state, enabledCats: new Set(enabledCats) });
  if (!view) {
    ctx.derived = { options, view: null, graph: null, aggregates: null, colorByCat };
    return;
  }

  // -------------------------------------------------------------------------
  // 5) Central aggregates (single source of truth for totals + UI universes)
  // -------------------------------------------------------------------------
  const rows = [];
  for (const [sid, entry] of rawBySource.entries()) {
    const bars = Array.isArray(entry?.model?.bars) ? entry.model.bars : [];
    for (const b of bars) rows.push({ ...b, sourceId: sid });
  }

  const aggregates = aggregate({ rows }, ctx.state);

  // Keep disabledCats stable across slices; only clamp to universe
  const universeCatsSet2 = new Set(options.universe.cats);
  for (const c of Array.from(ctx.state.disabledCats)) {
    if (!universeCatsSet2.has(c)) ctx.state.disabledCats.delete(c);
  }

  // -------------------------------------------------------------------------
  // 6) GRAPH BUILDER (STRICT – legend.js Contract)
  // -------------------------------------------------------------------------
  // Legend should respect disabledCats, but must not drop planned-only categories.
  const legendEnabledCats = new Set(
    options.universe.cats.filter((c) => !ctx.state.disabledCats.has(c))
  );

  const undatedLabel = String(view?.undatedLabel || "Undatiert");

  const graph = buildLegendGraph({
    sourceEntries,
    enabledSources,
    enabledTypes,
    enabledCatSet,
    legendEnabledCats,
    mergedSelected,
    state: ctx.state,
    configSources: ctx.config?.sources,
    undatedLabel,
  });

  // -------------------------------------------------------------------------
  // 7) Commit (atomar)
  // -------------------------------------------------------------------------
  ctx.derived = { options, view, graph, aggregates, colorByCat };
}

  // ---------------------------------------------------------------------------
  // redraw(ctx)
  // -----------------------------------------------------------------------------
  // Strict Render Pipeline:
  // 1) computeDerived
  // 2) UI spiegeln (Derived → UI, dann State → UI, dann Options rendern)
  // 3) Chart
  // 4) Legend
  // 5) Subtitle
  // -----------------------------------------------------------------------------
  //
  // Design goals:
  // - deterministisch (keine impliziten Annahmen)
  // - klare Phasen + zentraler Error-Report
  // - kein „Debug-Spam“: ein kompakter Start-Snapshot reicht
  // ---------------------------------------------------------------------------

  // --- helpers extracted to top-level for compactness in redraw ---
  const requireCtx = (ctx) => {
    if (!ctx) throw new Error("redraw: ctx missing");
    if (!ctx.dom) throw new Error("redraw: ctx.dom missing");
    if (!ctx.state) throw new Error("redraw: ctx.state missing");

    const dom = ctx.dom;

    if (!dom.svgEl) {
      throw new Error(
        `redraw: ctx.dom.svgEl missing (domKeys=${Object.keys(dom).join(",")})`
      );
    }
    if (!dom.legendEl) {
      throw new Error(
        `redraw: ctx.dom.legendEl missing (domKeys=${Object.keys(dom).join(",")})`
      );
    }

    return dom;
  };

  const setPhase = (ctx, p) => {
    ctx.__renderPhase = p;
    return p;
  };

  const syncYearDomainToSliders = (ctx, options) => {
    const fromEl = ctx?.dom?.yearFromInput;
    const toEl = ctx?.dom?.yearToInput;
    if (!fromEl || !toEl) return;

    const dom = options?.yearDomain ?? options?.yearsDomain ?? null;
    if (!dom) return;

    const minY = Number(dom.minY);
    const maxY = Number(dom.maxY);
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY) return;

    fromEl.min = String(minY);
    fromEl.max = String(maxY);
    toEl.min = String(minY);
    toEl.max = String(maxY);

    const s = ctx.state;
    if (!Number.isFinite(s.yearFrom)) s.yearFrom = minY;
    if (!Number.isFinite(s.yearTo)) s.yearTo = maxY;

    s.yearFrom = Math.max(minY, Math.min(maxY, Number(s.yearFrom)));
    s.yearTo = Math.max(minY, Math.min(maxY, Number(s.yearTo)));
    if (s.yearFrom > s.yearTo) [s.yearFrom, s.yearTo] = [s.yearTo, s.yearFrom];

    fromEl.value = String(s.yearFrom);
    toEl.value = String(s.yearTo);
  };

  const syncUI = (ctx, options) => {
    setPhase(ctx, "syncUI:derived");
    syncYearDomainToSliders(ctx, options);

    if (ctx.ui?.syncFromDerived) {
      ctx.ui.syncFromDerived(ctx, options);
    } else if (typeof syncUIFromDerived === "function") {
      syncUIFromDerived(ctx, options);
    }

    setPhase(ctx, "syncUI:state");
    syncUIFromState(ctx);

    setPhase(ctx, "syncUI:options");
    if (ctx.ui?.renderOptions) ctx.ui.renderOptions(options);
  };

  const fail = (ctx, phase, err) => {
    console.groupCollapsed(
      `%credraw(ctx) failed in phase: ${phase}`,
      "color:#d92d20;font-weight:700"
    );
    console.error(err);
    console.error("stack:", err?.stack || "(no stack)");
    console.log("phase:", phase);
    console.log("ctx.flags:", ctx.flags);
    console.log("ctx.state:", ctx.state);
    console.log("ctx.derived:", ctx.derived);
    console.groupEnd();
  };

  async function redraw(ctx) {
    const dom = requireCtx(ctx);

    console.log("renderer.js [redraw]", { ready: ctx.flags?.ready, sources: ctx.raw?.bySource?.size ?? 0 });

    let phase = setPhase(ctx, "init");

    try {
      // 1) DERIVED
      phase = setPhase(ctx, "computeDerived");
      await computeDerived(ctx);
      if (!ctx.derived) throw new Error("redraw: ctx.derived missing after computeDerived");

      // Tabs (Labels) müssen nach jedem Re-Compute synchron sein.
      setCtxTabUI(ctx);
      setCategoryTabUI(ctx, ctx.state.activeCat);

      // CTX-Tab: derived als sortierbare Tabelle (Debug/Transparenz)
      renderDerivedIntoDom(ctx);

      // Kategorie-Tab + Kategorie-Details: nach jedem Re-Compute synchronisieren (z.B. nach Filterwechsel)
      renderCategoryDetailsIntoDom(ctx);

      const { options, view, graph, aggregates, colorByCat } = ctx.derived;

      // 2) UI spiegeln (Derived → UI, dann State → UI)
//
// WICHTIG:
// - Dropdown-Universe darf NICHT aus aggregates.visible* kommen,
//   weil aggregates bereits "sichtbar" (also durch enabledTypes/disabledCats) gefiltert ist.
//   Sonst verschwinden abgewählte Items und "x von y" ist falsch.
//
// Contract (computeDerived, neu):
// - options.sources              : string[] (Universe der Quellen; stabil)
// - options.inRange.types        : string[] (Year-range Universe; unabhängig von enabledTypes)
// - options.inRange.cats         : string[] (Year-range Universe; unabhängig von disabledCats)
// - options.yearDomain/yearBounds: bleiben wie gehabt
if (!options || typeof options !== "object") {
  throw new Error("redraw: ctx.derived.options missing/invalid");
}
if (!Array.isArray(options.sources)) {
  throw new Error("redraw: options.sources missing/invalid (array expected)");
}
if (!options.inRange || typeof options.inRange !== "object") {
  throw new Error("redraw: options.inRange missing/invalid (object expected)");
}
if (!Array.isArray(options.inRange.types)) {
  throw new Error("redraw: options.inRange.types missing/invalid (array expected)");
}
if (!Array.isArray(options.inRange.cats)) {
  throw new Error("redraw: options.inRange.cats missing/invalid (array expected)");
}

const uiOptions = {
  // keep non-dropdown option fields (yearDomain/yearBounds etc.)
  ...options,

  // Dropdown universes (explicit, strict)
  sources: options.sources,
  types: options.inRange.types,
  cats: options.inRange.cats,

  // pass through explicitly (avoid accidental overwrite)
  yearDomain: options.yearDomain,
  yearBounds: options.yearBounds,
};

syncUI(ctx, uiOptions);
      // 3) Early return: keine darstellbaren Daten
      phase = setPhase(ctx, "emptyViewCheck");
      if (!view || isModelEmpty(view)) {
        phase = setPhase(ctx, "renderNoData");
        renderNoDataForFilterState(ctx);

        // Tabs + CTX table: keep consistent even when chart is empty
        setCtxTabUI(ctx);
        renderDerivedIntoDom(ctx);
        return;
      }

      // 4) Chart
      phase = setPhase(ctx, "drawChart");

      const chartRes = drawChart({
        svgEl: dom.svgEl,
        rootEl: dom.panel,
        data: view,
        state: ctx.state,
        colorByCat,
        onBarHover: (payload) => getHoverUX(ctx).hoverCtl.onHover(payload),
      });

      if (!(colorByCat instanceof Map)) {
        throw new Error("redraw: derived.colorByCat missing/invalid (Map expected)");
      }
      if (chartRes?.colorByCat !== colorByCat) {
        throw new Error("redraw: chart did not return the shared colorByCat reference");
      }

      // 5) Legend
      phase = setPhase(ctx, "legend:preconditions");
      if (!graph) throw new Error("redraw: derived.graph missing (legend network required)");

      if (!aggregates) throw new Error("redraw: derived.aggregates missing");
      if (!(aggregates.totalsByCat instanceof Map)) {
        throw new Error("redraw: invalid totalsByCat for legend (Map expected)");
      }

      if (!(ctx.state.disabledCats instanceof Set)) {
        throw new Error("redraw: state.disabledCats missing (Set expected)");
      }

      phase = setPhase(ctx, "legend:cats");


      const viewCatsRaw = view.cats || [];
      assertStringArray("view.cats", viewCatsRaw);
      const legendCats = dedupeStable(viewCatsRaw.slice());

      // ---------------------------------------------------------------------
      // Category year span (min/max year per category)
      // ---------------------------------------------------------------------
      // Needed for legend active chip meta: `firstYear–activeYear`.
      // IMPORTANT:
      // - We respect enabled sources + enabled types.
      // - We intentionally do NOT clamp to the current visible year range;
      //   span is computed across all years present in the data.

      const enabledSources =
        ctx.state.enabledSourceIds instanceof Set && ctx.state.enabledSourceIds.size
          ? new Set(ctx.state.enabledSourceIds)
          : new Set(options.sources);

      const enabledTypes =
        ctx.state.enabledTypes instanceof Set && ctx.state.enabledTypes.size
          ? new Set(ctx.state.enabledTypes)
          : new Set(options.universe.types);

      const catYearSpan = new Map(); // cat -> {min,max}

      for (const [sid, entry] of ctx.raw.bySource.entries()) {
        if (!enabledSources.has(sid)) continue;
        const bars = Array.isArray(entry?.model?.bars) ? entry.model.bars : [];

        for (const b of bars) {
          const y = Number(b?.year);
          if (!Number.isFinite(y)) continue; // ignore undated

          const t = cleanKey(b?.type ?? b?.typ);
          if (!t || !enabledTypes.has(t)) continue;

          const c = b?.cat; // Option A identity
          if (typeof c !== "string" || !c.length) continue;

          const cur = catYearSpan.get(c);
          if (!cur) catYearSpan.set(c, { min: y, max: y });
          else catYearSpan.set(c, { min: Math.min(cur.min, y), max: Math.max(cur.max, y) });
        }
      }

      // Current year from hover/selection (set by barHoverController -> legend:highlight -> state)
      const highlightedYear = ctx.state.legendHighlightYear ?? null;

      phase = setPhase(ctx, "renderLegend");

      renderLegend({
        mountEl: dom.legendEl,
        cats: legendCats,
        state: ctx.state,
        colorByCat,
        catTotals: aggregates.totalsByCat,
        sourceTotals: aggregates.totalsBySource,   // summen auf den sourcenodes
        graph,
        catYearSpan,
        highlightedYear,
        onToggle: (catKey, checked) => {
          if (typeof catKey !== "string" || !catKey.length) {
            throw new Error("redraw/onToggle: catKey must be non-empty string");
          }

          if (checked) ctx.state.disabledCats.delete(catKey);
          else ctx.state.disabledCats.add(catKey);

          ctx.requestRedraw(ctx);
        },
      });

      // 6) Subtitle
      phase = setPhase(ctx, "renderSubtitle");

      renderSubtitle(ctx, computeNetInfo(view, ctx.state));

      setPhase(ctx, "done");
    } catch (err) {
      fail(ctx, phase, err);
      throw err;
    }
  }

  return { redraw, ensureData };
}