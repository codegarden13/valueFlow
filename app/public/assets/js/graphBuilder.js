// /assets/js/graphBuilder.js
import { cleanKey } from "./keys.js";

/**
 * buildLegendGraph(params)
 * -----------------------------------------------------------------------------
 * Baut das Legend-Netzwerk (ACTUAL weights + PLANNED relations).
 *
 * Contract:
 * - returned graph has:
 *   sources: [{id,label}]
 *   types: string[]
 *   sourceTypeWeight/typeCatWeight/sourceCatWeight: Map<string, number>
 *   sourceTypePlanned/typeCatPlanned/sourceCatPlanned: Map<string, number>
 *
 * Notes:
 * - "ACTUAL" respects:
 *   - enabledSources, enabledTypes, enabledCatSet
 *   - year range for DATED bars; undated always included
 *   - state.mode determines kosten/menge weight
 * - "PLANNED" respects:
 *   - enabledSources, enabledTypes, legendEnabledCats
 *   - never uses year filter / amounts
 */
export function buildLegendGraph({
  sourceEntries,        // Array<[sid, entry]> (already filtered by enabledSources)
  enabledSources,       // Set<string>
  enabledTypes,         // Set<string> (canonical: cleanKey)
  enabledCatSet,        // Set<string> (Option A identity)
  legendEnabledCats,    // Set<string> (cats allowed in legend even if planned-only)
  mergedSelected,       // model containing planned* arrays
  state,                // ctx.state (needs mode/yearFrom/yearTo)
  configSources,        // ctx.config.sources (for labels)
  undatedLabel,         // string e.g. "Undatiert"
}) {
  if (!Array.isArray(sourceEntries)) throw new Error("buildLegendGraph: sourceEntries must be array");
  if (!(enabledSources instanceof Set)) throw new Error("buildLegendGraph: enabledSources must be Set");
  if (!(enabledTypes instanceof Set)) throw new Error("buildLegendGraph: enabledTypes must be Set");
  if (!(enabledCatSet instanceof Set)) throw new Error("buildLegendGraph: enabledCatSet must be Set");
  if (!(legendEnabledCats instanceof Set)) throw new Error("buildLegendGraph: legendEnabledCats must be Set");

  const graph = {
    sources: sourceEntries.map(([sid]) => {
      const cfg = Array.isArray(configSources)
        ? configSources.find((s) => s?.id === sid)
        : null;
      return { id: sid, label: cfg?.label || cfg?.name || sid };
    }),

    types: Array.from(enabledTypes),

    // ACTUAL weights
    sourceTypeWeight: new Map(),
    typeCatWeight: new Map(),
    sourceCatWeight: new Map(),

    // PLANNED relations (legend-only)
    sourceTypePlanned: new Map(),
    typeCatPlanned: new Map(),
    sourceCatPlanned: new Map(),
  };

  const add = (map, k, v = 1) => map.set(k, (map.get(k) || 0) + v);

  const yf = Number(state?.yearFrom);
  const yt = Number(state?.yearTo);

  // ---------------------------------------------------------------------------
  // A) ACTUAL bars → weights (per selected source)
  // ---------------------------------------------------------------------------
  for (const [sidRaw, entry] of sourceEntries) {
    const sid = String(sidRaw ?? "").trim();
    if (!sid) continue;

    const bars = Array.isArray(entry?.model?.bars) ? entry.model.bars : [];
    for (const b of bars) {
      const c = typeof b?.cat === "string" ? b.cat : "";
      if (!c || !enabledCatSet.has(c)) continue;

      const t = cleanKey(b?.type ?? b?.typ);
      if (!t || !enabledTypes.has(t)) continue;

      const yearNum = Number(b?.year);
      const yearKey = String(b?.yearKey || "");
      const isUndated = yearKey === undatedLabel || !Number.isFinite(yearNum);

      // DATED respects range; undated always included
      if (!isUndated) {
        if (Number.isFinite(yf) && yearNum < yf) continue;
        if (Number.isFinite(yt) && yearNum > yt) continue;
      }

      const rawV = state?.mode === "menge" ? b?.menge : b?.kosten;
      const v = Number(rawV);
      if (!Number.isFinite(v) || v === 0) continue;

      const w = Math.abs(v);

      add(graph.sourceTypeWeight, `${sid}::${t}`, w);
      add(graph.typeCatWeight, `${t}::${c}`, w);
      add(graph.sourceCatWeight, `${sid}::${c}`, w);
    }
  }

  // ---------------------------------------------------------------------------
  // B) PLANNED relations (from mergedSelected; no year filter, no amounts)
  // ---------------------------------------------------------------------------
  const pm = mergedSelected || {};

  // Source ↔ Type
  for (const k of pm.plannedSourceType || []) {
    const [sid, typ] = String(k).split("||");
    const t = cleanKey(typ);
    if (!sid || !t) continue;
    if (!enabledSources.has(sid)) continue;
    if (!enabledTypes.has(t)) continue;
    add(graph.sourceTypePlanned, `${sid}::${t}`);
  }

  // Source ↔ Category (Option A identity)
  for (const k of pm.plannedSourceCat || []) {
    const [sid, cat] = String(k).split("||");
    if (!sid || !cat) continue;
    if (!enabledSources.has(sid)) continue;
    if (!legendEnabledCats.has(cat)) continue;
    add(graph.sourceCatPlanned, `${sid}::${cat}`);
  }

  // Type ↔ Category (Option A identity)
  for (const k of pm.plannedTypeCat || []) {
    const [typ, cat] = String(k).split("||");
    const t = cleanKey(typ);
    if (!t || !cat) continue;
    if (!enabledTypes.has(t)) continue;
    if (!legendEnabledCats.has(cat)) continue;
    add(graph.typeCatPlanned, `${t}::${cat}`);
  }

  return graph;
}