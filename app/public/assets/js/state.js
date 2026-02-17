// /app/public/assets/js/state.js
// -----------------------------------------------------------------------------
// State-Handling
// -----------------------------------------------------------------------------
// Zielbild (neu):
// - state.js liefert nur noch:
//   - Normalisierung / Parsing-Utilities
//   - Invariants (clamp) für Sets
//   - Helper um Default-State aus cfg abzuleiten
//   - state enthält enabled* Sets (empty == alle) und optional disabledCats für inverse-Selection UX
//
// WICHTIG:
// - Reload => Default-Zustand ("alles").
// - "alle" Semantik für Multi-Selects: empty Set === alle.
// -----------------------------------------------------------------------------

// ============================================================================
// 1) Normalisierung / Parsing (kanonisch; überall wiederverwenden)
// ============================================================================


import { cleanKey } from "/assets/js/keys.js";

export function normalizeMode(v) {
  return v === "menge" ? "menge" : "kosten";
}

export function parseYear(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Allgemeines "Dimension Value" Normalizing (für Typ/Kategorie wenn leer). */
export function normalizeDimValue(v, fallback = "?") {
  const s = String(v ?? "").replace(/\u00A0/g, " ").trim();
  return s ? s : fallback;
}

// ============================================================================
// 2) Config Helpers: Source-Universum (cfg ist die einzige Wahrheit)
// ============================================================================

/** Extrahiert gültige Source-IDs aus cfg.sources[]. Wirft bei leerem Ergebnis. */
export function getSourceIdsFromConfig(cfg) {
  const sources = Array.isArray(cfg?.sources) ? cfg.sources : [];
  const ids = sources.map((s) => String(s?.id ?? "").trim()).filter(Boolean);
  if (!ids.length) throw new Error("state.js: cfg.sources[] missing/empty");
  return ids;
}

// ============================================================================
// 3) Invariants / Normalizer (clamp auf aktuelles Universum)
// ============================================================================

/**
 * enabledCats := enabledCats ∩ availableCats
 * Mutiert state.enabledCats (damit call-sites nicht umkopieren müssen).
 *
 * Semantik:
 * - empty Set bleibt empty Set (== "alle") und wird NICHT aufgefüllt
 * - nur bei non-empty clampen
 */
export function normalizeEnabledCats(state, cats) {
  if (!state) return;

  const list = Array.isArray(cats) ? cats : [];
  const available = new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean));

  const cur = state.enabledCats instanceof Set ? state.enabledCats : new Set();

  // empty => alle (nicht clampen / nicht anfassen)
  if (cur.size === 0) {
    state.enabledCats = cur;
    return;
  }

  const next = new Set();
  for (const c of cur) {
    const k = String(c ?? "").trim();
    if (k && available.has(k)) next.add(k);
  }

  state.enabledCats = next;
}

/**
 * Generic clamp für Multi-Select Sets:
 * enabled := enabled ∩ universe
 *
 * Semantik:
 * - empty Set bleibt empty Set (== "alle")
 * - non-empty wird geschnitten
 */
export function normalizeEnabledSet(enabledSet, universe) {
  const all = Array.isArray(universe) ? universe.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const u = new Set(all);

  const cur = enabledSet instanceof Set ? enabledSet : new Set();

  if (cur.size === 0) return new Set(); // "alle"

  const next = new Set();
  for (const v of cur) {
    const k = String(v ?? "").trim();
    if (k && u.has(k)) next.add(k);
  }
  return next;
}

/**
 * Generic clamp für "disabled" Sets (inverse Auswahl):
 * disabled := disabled ∩ universe
 *
 * Semantik:
 * - disabled ist NIE "alle"; empty Set bedeutet "nichts explizit abgewählt"
 * - wird nur gegen das stabile Universum geklemmt (NICHT gegen aktuelle View/InRange),
 *   damit Abwahlen Filterwechsel überleben.
 */
export function normalizeDisabledSet(disabledSet, universe) {
  const all = Array.isArray(universe)
    ? universe.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  const u = new Set(all);

  const cur = disabledSet instanceof Set ? disabledSet : new Set();

  const next = new Set();
  for (const v of cur) {
    const k = String(v ?? "").trim();
    if (k && u.has(k)) next.add(k);
  }
  return next;
}

// ============================================================================
// 4) Default-State (ohne Persistenz)
// ============================================================================

/**
 * createDefaultState(cfg)
 * - "alles" als Default
 * - Jahre werden später aus dataAll gebounded (syncYearRangeUI)
 */
export function createDefaultState(cfg) {
  // Default: empty Sets = alle
  return {
    mode: "kosten",
    yearFrom: null,
    yearTo: null,

    enabledSourceIds: new Set(), // alle
    enabledTypes: new Set(),     // alle
    enabledCats: new Set(),      // alle
    disabledCats: new Set(),     // inverse Auswahl: explizit abgewählt (persistiert über Filter)
  };
}

/**
 * resolveInitialEnabledSourceIds(cfg)
 * - ohne Persistenz ist "alle" (empty Set) der gewünschte Default
 * - optional: falls du explizit mit cfg.defaultSource starten willst, kannst du
 *   hier umstellen. Aktuell: "alle".
 */
export function resolveInitialEnabledSourceIds(cfg) {
  // empty => alle
  // (falls du stattdessen defaultSource nutzen willst: new Set([cfg.defaultSource]) )
  void cfg;
  return new Set();
}