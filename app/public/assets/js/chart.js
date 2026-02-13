// chart.js
// -----------------------------------------------------------------------------
// Grouped bar chart (D3) – Year × Type × Category
//
// Responsibilities (strict):
// - Render the SVG chart (scales, axes, bars).
// - Emit interaction events (hover) via callbacks.
//
// Non-responsibilities (renderer-owned):
// - DOM composition (accordion/inspector panels).
// - Rendering tables / “categoryInspector” content.
//
// Data contract (Option A strict):
// - data.years: number[] (numeric years only)
// - data.bars: aggregates with { yearKey, year|null, cat, type|typ, kosten, menge }
// - data.cats: string[] (category identities; no normalization beyond trim)
// - data.hasUndated / data.undatedLabel: support “Undatiert” bucket
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Interaction contract
// -----------------------------------------------------------------------------
// The renderer may pass callbacks to integrate chart interactions with UI.
// Keep chart.js free of direct DOM dependencies (accordion, inspector panel, etc.).
//
// onBarHover(payload) is called on pointerenter/move of a bar.
// payload = {
//   event: PointerEvent|MouseEvent,  // IMPORTANT for overlay positioning
//   yearKey: string,
//   type: string,
//   cat: string,
//   mode: "kosten" | "menge",
//   value: number,          // value in current mode
//   unit: string            // "€" or unit for menge
// }

import { cleanKey } from "/assets/js/keys.js";
import { chartAnimMs } from "/assets/js/timing.js";

function drawEmpty(svg, msg, w, h) {
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${w} ${h}`);
  svg
    .append("text")
    .attr("class", "empty-text")
    .attr("x", 12)
    .attr("y", 24)
    .text(msg);
}

export function drawChart({ svgEl, rootEl, data, state, colorByCat, onBarHover }) {
  const d3 = window.d3;
  if (!d3) throw new Error("D3 not loaded");

  const emitBarHover = typeof onBarHover === "function" ? onBarHover : null;

  // ---------------------------------------------------------------------------
  // SVG init and dimensions
  // ---------------------------------------------------------------------------
  const w = Math.max(640, svgEl.clientWidth || 820);
  const h = Math.max(360, svgEl.clientHeight || 520);

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.classed("kpi-chart", true);
  svg.attr("viewBox", `0 0 ${w} ${h}`);

  // ---------------------------------------------------------------------------
  // Input contract
  // ---------------------------------------------------------------------------
  if (!data) throw new Error("chart.js: data missing");
  if (!Array.isArray(data.bars)) throw new Error("chart.js: data.bars missing");
  if (!Array.isArray(data.cats)) throw new Error("chart.js: data.cats missing");

  // Color contract: single source of truth (provided by computeDerived)
  if (!(colorByCat instanceof Map)) {
    throw new Error("chart.js: colorByCat missing/invalid (Map required; provided by computeDerived)");
  }

  // data.years is numeric-only (may be empty if fully undated)
  if (data.years != null && !Array.isArray(data.years)) {
    throw new Error("chart.js: data.years invalid");
  }

  const mode = state.mode === "menge" ? "menge" : "kosten";
  const valueOf = (b) => (mode === "kosten" ? b.kosten : b.menge);

  // ---------------------------------------------------------------------------
  // Animation timing (single source of truth)
  // ---------------------------------------------------------------------------
  // ANIM_MS is derived from config.timing (BPM + chartBeats / chart.length).
  // timing.js handles fallbacks; do NOT compute BPM math in multiple places.
  const ANIM_MS = chartAnimMs(state);
  const ANIM_EASE = d3.easeCubicOut;

  // Guard: if timing is misconfigured, fail safe to 1000ms so chart stays visible.
  if (!Number.isFinite(ANIM_MS) || ANIM_MS <= 0) {
    console.warn("chart.js: invalid ANIM_MS from timing.js, falling back to 1000", { ANIM_MS });
  }
  const ANIM_MS_SAFE = Number.isFinite(ANIM_MS) && ANIM_MS > 0 ? ANIM_MS : 1000;

  // Option A: categories are identities (do NOT cleanKey unit keys)
  const unitMap = new Map(
    (data?.unitByCat || []).map(([k, v]) => [String(k ?? "").trim(), String(v || "").trim()])
  );
  const unitFor = (cat) => (mode === "kosten" ? "€" : unitMap.get(String(cat ?? "").trim()) || "");

  // ---------------------------------------------------------------------------
  // Year domain (yearKey-based)
  // ---------------------------------------------------------------------------
  const undatedLabel = String(data?.undatedLabel || "Undatiert");

  const numericYears = (data?.years || [])
    .map((y) => Number(y))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const yearKeysOrdered = numericYears.map(String);

  const yearKeysFromBars = Array.from(
    new Set((data.bars || []).map((b) => String(b.yearKey || "")).filter(Boolean))
  );

  for (const k of yearKeysFromBars) {
    if (k === undatedLabel) continue;
    if (!yearKeysOrdered.includes(k)) yearKeysOrdered.push(k);
  }

  const hasUndated = !!data.hasUndated || yearKeysFromBars.includes(undatedLabel);
  if (hasUndated && !yearKeysOrdered.includes(undatedLabel)) {
    yearKeysOrdered.push(undatedLabel);
  }

  if (!yearKeysOrdered.length) {
    drawEmpty(svg, "Keine Jahre im aktuellen Filter.", w, h);
    return { colorByCat };
  }

  const yearStrings = yearKeysOrdered;

  // ---------------------------------------------------------------------------
  // Normalize bars
  // ---------------------------------------------------------------------------
  const getType = (b) => cleanKey(b?.type ?? b?.typ ?? b?.Buchungstyp ?? "") || "Unbekannt";

  const barsRaw = data.bars.map((b) => ({
    yearKey: String(b.yearKey ?? (b.year == null ? "" : String(b.year))).trim(),
    year: b.year == null ? null : Number(b.year),
    // Category is an IDENTITY (Option A strict): do not normalize beyond trim
    cat: typeof b?.cat === "string" ? b.cat.trim() : String(b?.cat ?? "").trim(),
    type: getType(b),
    kosten: Number(b.kosten),
    menge: Number(b.menge),
  }));

  // ---------------------------------------------------------------------------
  // Kategorie-Filter
  // ---------------------------------------------------------------------------
  // Option A strict: categories come from the global universe (data.cats)
  // We still union with bar categories only to detect contract violations early.
  const catsFromData = (Array.isArray(data?.cats) ? data.cats : [])
    .map((c) => (typeof c === "string" ? c.trim() : String(c ?? "").trim()))
    .filter((c) => typeof c === "string" && c.length > 0);

  const catsFromBars = barsRaw
    .map((b) => b.cat)
    .map((c) => (typeof c === "string" ? c.trim() : String(c ?? "").trim()))
    .filter((c) => typeof c === "string" && c.length > 0);

  const catsUniverse = Array.from(new Set(catsFromData.concat(catsFromBars)));

  // Strict: every category from data.cats must have a color (shared legend/chart contract)
  const missingColors = catsFromData.filter((c) => !colorByCat.has(c));
  if (missingColors.length) {
    throw new Error(
      `chart.js: colorByCat missing category keys (Option A strict). Missing: ${missingColors.join(", ")}`
    );
  }

  const enabledCats = catsUniverse.filter((c) => !state.disabledCats.has(c));
  const enabledCatSet = new Set(enabledCats);

  // ---------------------------------------------------------------------------
  // Aggregate yearKey × type × cat
  // ---------------------------------------------------------------------------
  const acc = new Map();

  function addToAgg(key, b) {
    const prev = acc.get(key);
    if (!prev) {
      acc.set(key, {
        yearKey: b.yearKey,
        year: b.year,
        type: b.type,
        cat: b.cat,
        kosten: b.kosten,
        menge: b.menge,
      });
    } else {
      prev.kosten += b.kosten;
      prev.menge += b.menge;
    }
  }

  for (const b of barsRaw) {
    if (!b.yearKey || !b.cat) continue;
    if (!enabledCatSet.has(b.cat)) continue;
    addToAgg(`${b.yearKey}||${b.type}||${b.cat}`, b);
  }

  const aggRows = Array.from(acc.values()).filter((r) => {
    const v = valueOf(r);
    return Number.isFinite(v) && v !== 0;
  });

  if (!aggRows.length) {
    drawEmpty(svg, "Keine Werte im aktuellen Filter.", w, h);
    return { colorByCat };
  }

  // Group by yearKey
  const rowsByYearKey = new Map(yearStrings.map((k) => [k, []]));
  for (const r of aggRows) {
    rowsByYearKey.get(r.yearKey)?.push(r);
  }

  // ---------------------------------------------------------------------------
  // Scales
  // ---------------------------------------------------------------------------
  const margin = { top: 24, right: 12, bottom: 78, left: 80 };
  const innerW = w - margin.left - margin.right;

  const xYear = d3.scaleBand().domain(yearStrings).range([0, innerW]).paddingInner(0.08);

  const y = d3
    .scaleLinear()
    .domain(d3.extent(aggRows.map(valueOf)).map((v) => v * 1.15))
    .nice()
    .range([h - margin.bottom, margin.top]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},0)`);

  g.append("g").attr("class", "axis axis-y").call(d3.axisLeft(y).ticks(5));

  g.append("g")
    .attr("class", "axis axis-x")
    .attr("transform", `translate(0,${h - margin.bottom})`)
    .call(d3.axisBottom(xYear));

  // ---------------------------------------------------------------------------
  // Render bars
  // ---------------------------------------------------------------------------
  const gBarsRoot = g.append("g").attr("class", "bars");

  function emitHover(event, d) {
    if (!emitBarHover) return;
    const v = valueOf(d);
    if (!Number.isFinite(v)) return;

    emitBarHover({
      event,
      yearKey: String(d.yearKey),
      type: String(d.type || ""),
      cat: String(d.cat || ""),
      mode,
      value: v,
      unit: unitFor(d.cat),
      // nice-to-have for controllers:
      color: colorByCat.get(d.cat) || "",
    });
  }

  for (const yearKey of yearStrings) {
    const xYearPos = xYear(yearKey);
    if (xYearPos == null) continue;

    const rows = rowsByYearKey.get(yearKey) || [];
    if (!rows.length) continue;

    const types = Array.from(new Set(rows.map((r) => r.type)));

    const xType = d3
      .scaleBand()
      .domain(types)
      .range([0, xYear.bandwidth()])
      .paddingInner(0.12);

    const gYear = gBarsRoot.append("g").attr("transform", `translate(${xYearPos},0)`);

    for (const t of types) {
      const rowsT = rows.filter((r) => r.type === t);
      const xT = xType(t);
      if (xT == null) continue;

      const xCat = d3
        .scaleBand()
        .domain(rowsT.map((r) => r.cat))
        .range([0, xType.bandwidth()])
        .paddingInner(0.08);

      const gType = gYear.append("g").attr("transform", `translate(${xT},0)`);

      const rects = gType
        .selectAll("rect")
        .data(rowsT, (d) => `${d.yearKey}||${d.type}||${d.cat}`)
        .join(
          (enter) =>
            enter
              .append("rect")
              .attr("x", (d) => xCat(d.cat))
              .attr("width", xCat.bandwidth())
              // start collapsed at baseline
              .attr("y", y(0))
              .attr("height", 0)
              .attr("fill", (d) => colorByCat.get(d.cat) || "#111")
              .attr("class", (d) => (valueOf(d) < 0 ? "bar is-neg" : "bar is-pos"))
              // animate to final geometry
              .call((sel) => {
                sel
                  .sort((a, b) => {
                    const av = valueOf(a);
                    const bv = valueOf(b);
                    const ag = av >= 0 ? 0 : 1;
                    const bg = bv >= 0 ? 0 : 1;
                    if (ag !== bg) return ag - bg;
                    return String(a.cat).localeCompare(String(b.cat));
                  })
                  .transition()
                  .duration(ANIM_MS_SAFE)
                  .ease(ANIM_EASE)
                  .attr("y", (d) => y(Math.max(0, valueOf(d))))
                  .attr("height", (d) => Math.abs(y(valueOf(d)) - y(0)));
              }),
          (update) =>
            update
              .attr("x", (d) => xCat(d.cat))
              .attr("width", xCat.bandwidth())
              .attr("fill", (d) => colorByCat.get(d.cat) || "#111")
              .attr("class", (d) => (valueOf(d) < 0 ? "bar is-neg" : "bar is-pos"))
              .call((sel) => {
                sel
                  .transition()
                  .duration(ANIM_MS_SAFE)
                  .ease(ANIM_EASE)
                  .attr("y", (d) => y(Math.max(0, valueOf(d))))
                  .attr("height", (d) => Math.abs(y(valueOf(d)) - y(0)));
              }),
          (exit) =>
            exit
              .transition()
              .duration(180)
              .ease(d3.easeCubicIn)
              .attr("y", y(0))
              .attr("height", 0)
              .remove()
        );

      // IMPORTANT: emit hover on enter + move so controller always has a fresh event
      rects
        .on("pointerenter", (event, d) => emitHover(event, d))
        .on("pointermove", (event, d) => emitHover(event, d))
        .on("pointerleave", () => emitBarHover?.(null));
    }
  }

  return { colorByCat };
}