// app-boot.js
// -----------------------------------------------------------------------------
// Bootstrapping (einmalig, ohne Persistenz)
// -----------------------------------------------------------------------------
// Verantwortlichkeiten:
// - ctx erstellen (config + state + flags + dom + model placeholders)
// - DOM lookup
// - optional weiteres UI wiring (Dropdowns/Mode/Years) via opts.wireUI(ctx)
// - initial UI aus State spiegeln (ohne redraw)
// - Rohdaten (RAW) einmalig laden (loadData)
// - initialen redraw coalesced triggern (requestRedraw)
// 
// State-Contracts (Industrial Style):
// - enabledSourceIds: explizit, leer = alle aktiv (UI-Komprimierung)
// - enabledTypes: explizit, null => "alle" (UI-Komprimierung)
// - disabledCats: expliziter UI-State, leer = alle Kategorien aktiv
// - enabledCats: existiert NICHT mehr
// -----------------------------------------------------------------------------

import { fetchConfig, loadData } from "./api.js";
import { getSourceIdsFromConfig } from "./state.js";
import { initUI } from "./ui.js";

// ============================================================================
// 1) Public API
// ============================================================================

/**
 * Boot (einmalig)
 * @param {Object} opts
 * @param {(ctx:any)=>void|Promise<void>} opts.requestRedraw  - Pflicht: Redraw triggern/queue'n
 * @param {(ctx:any)=>any}  [opts.wireUI]                     - Optional: verdrahtet restliche Controls
 */
export async function boot(opts = {}) {
  console.log("app-boot.js - [boot] called");

  const { requestRedraw, wireUI } = opts;

  // 0) Input-Validierung
  assertBootOptions({ requestRedraw, wireUI });

  // 1) Context erstellen + Flags
  const ctx = await createContext();
  if (!ctx.flags) ctx.flags = {};
  ctx.flags.ready = false;
  if (typeof ctx.flags.redrawQueued !== "boolean") ctx.flags.redrawQueued = false;

  // ---------------------------------------------------------------------------
  // 2) Redraw-Gate: während Boot puffern, erst nach ready ausführen
  // ---------------------------------------------------------------------------
  const requestRedrawGated = async (c) => {
    // Während Boot: nur merken, dass ein Redraw gewünscht ist.
    if (!c?.flags?.ready) {
      c.flags.redrawQueued = true;
      return;
    }
    // Nach Boot: echte Redraw-Pipeline aufrufen
    return requestRedraw(c);
  };

  // Zentrales Hook (UI/Legend/Chart dürfen ausschließlich darüber redraw anfordern)
  ctx.requestRedraw = requestRedrawGated;

  // ---------------------------------------------------------------------------
  // 3) DOM Lookup (MUSS vor Panels/Wiring passieren)
  // ---------------------------------------------------------------------------
  initUI(ctx);

  // ---------------------------------------------------------------------------
  // 4) Optionales UI wiring (Dropdowns/Mode/Years etc.)
  //    Wichtig: Listener dürfen requestRedraw aufrufen -> wird bis ready gepuffert.
  // ---------------------------------------------------------------------------
  wireOptionalUI(ctx, wireUI);

  // ---------------------------------------------------------------------------
  // 5) Rohdaten (RAW) einmalig laden
  //    Erwartung: loadData(ctx) setzt ctx.raw.bySource (oder äquivalent)
  // ---------------------------------------------------------------------------
  await loadData(ctx);

  // Optional: Wenn du flags/dataDirty nutzt, hier sauber markieren:
  // ctx.flags.dataDirty = true;

  // ---------------------------------------------------------------------------
  // 6) Boot abschließen + initialen Render coalesced triggern
  // ---------------------------------------------------------------------------
  await finalizeBootAndRender(ctx);

  return ctx;
}

// ============================================================================
// 2) Context Composition (keine UI-Seitenwirkungen)
// ============================================================================

async function createContext() {

  console.log("app-boot.js - [createContext] called");
  
  // 1) Config laden (Server ist Source of Truth) + normalisieren #TODO:Besser verstehen was cfg vs config
  const cfg = await fetchConfig();
  const config = buildConfig(cfg);

  // 2) State initialisieren (OHNE Persistenz)
  const state = createInitialState(config);

  // 3) ctx erzeugen (Single Owner)
  const ctx = {
    // Daten/Config/State
    config,
    state,

    // Pipeline- & UI-Flags
    flags: createInitialFlags(),

    // Rohdaten (werden einmalig in boot() via loadData(ctx) befüllt)
    raw: null,

    // DOM (wird in initUI() befüllt)
    dom: createEmptyDomRefs(),

    // optional UI handle
    ui: null,
  };

  return ctx;
}

function buildConfig(cfg) {
  const sources = Array.isArray(cfg?.sources) ? cfg.sources : [];
  if (!sources.length) throw new Error("createContext: config has no sources[]");

  const sourceIds = getSourceIdsFromConfig(cfg);

  const defaultSourceId =
    String(cfg?.defaultSource ?? "").trim() || String(sources[0]?.id ?? "").trim();

  return {
    delimiter: String(cfg?.delimiter || ";"),
    sources,
    sourceIds,
    defaultSourceId,
  };
}

/**
 * Initial State (persistenzfrei, industrial contract)
 *
 * Boot-Default:
 * - enabledSourceIds: explizit alle Quellen aktiv (leer = alle aktiv, UI-Intent)
 * - enabledTypes: null => "alle" (UI-Komprimierung)
 * - disabledCats: expliziter UI-State, leer = alle Kategorien aktiv
 * - yearFrom/yearTo: null (wird datenabhängig in UI/Derivations gesetzt)
 */
function createInitialState(config) {
  console.log("app-boot.js - [createInitialState] called");
  const allSourceIds = Array.isArray(config?.sources)
    ? config.sources.map((s) => String(s?.id ?? "").trim()).filter(Boolean)
    : [];

  return {
    mode: "kosten",

    // datenabhängig / UI-range
    yearFrom: null,
    yearTo: null,

    // Quellen: explizite Auswahl, leer = alle aktiv (UI-Komprimierung)
    enabledSourceIds: new Set(allSourceIds),

    // Typen: null => "alle" (UI-Komprimierung)
    enabledTypes: null,

    // Kategorien: invertierte Logik (UI-Intent)
    // disabledCats: expliziter UI-State, leer = alle Kategorien aktiv
    disabledCats: new Set(),
  };
}

// ============================================================================
// 3) Boot Helpers (Wiring + Guarding)
// ============================================================================

function assertBootOptions({ requestRedraw, wireUI }) {
  if (typeof requestRedraw !== "function") {
    throw new Error("boot(opts): opts.requestRedraw must be a function");
  }

  if (wireUI != null && typeof wireUI !== "function") {
    throw new Error("boot(opts): opts.wireUI must be a function or undefined");
  }
}

function wireOptionalUI(ctx, wireUI) {
  // Optionales Rest-UI wiring (Dropdowns/Mode/Years)
  // - wireUI darf z.B. ctx.ui setzen (dropdown rerender handle)
  // - während ready=false keine redraws auslösen
  if (!wireUI) return;

  const uiHandle = wireUI(ctx);
  if (uiHandle && typeof uiHandle === "object") ctx.ui = uiHandle;
}

async function finalizeBootAndRender(ctx) {
  // Redraws freigeben
  ctx.flags.ready = true;

  // Genau EIN initialer Render – egal wie viele Requests während Boot kamen.
  // Wir nutzen absichtlich den Gated-Hook, damit die Pipeline konsistent bleibt.
  if (ctx.flags.redrawQueued) {
    ctx.flags.redrawQueued = false;
    await ctx.requestRedraw(ctx);
    return;
  }

  // Auch wenn niemand während Boot ein Redraw angefordert hat,
  // rendert die App initial genau einmal.
  await ctx.requestRedraw(ctx);
}

// ============================================================================
// 4) Initial Structures (Flags + DOM refs)
// ============================================================================

function createInitialFlags() {
  return {
    // Datenpipeline (RAW wird einmalig beim Boot geladen)
    dataBuildToken: 0,

    // UI-Reset Flags
    resetCats: true,
    resetYears: true,

    // redraw coalescing (boot + runtime)
    redrawInFlight: false,
    redrawQueued: false,

    // boot-guard
    ready: false,
  };
}

function createEmptyDomRefs() {
  return {
    // Mount / Layout
    mountEl: null,
    panel: null,
    subtitleEl: null,

    // Sources (Bootstrap Dropdown, Multi-Select)
    srcBtn: null,
    srcAllBtn: null,

    srcList: null,

    // Types (Bootstrap Dropdown, Multi-Select)
    typeBtn: null,
    typeAllBtn: null,
    typeResetBtn: null,
    typeList: null,

    // Categories (Bootstrap Dropdown, Multi-Select)
    catBtn: null,
    catAllBtn: null,
    catResetBtn: null,
    catList: null,

    // Other Filters / Chart
    modeSelect: null,
    legendEl: null,
    svgEl: null,

    // Year Range
    yearFromInput: null,
    yearToInput: null,
    yearFromValue: null,
    yearToValue: null,
   
  };
}