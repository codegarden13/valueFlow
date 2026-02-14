// legend.js
// =============================================================================
// Legend renderer – STRICT NETWORK MODE (Option A)
// =============================================================================
// Responsibilities:
// - Validate strict contracts (Option A identities)
// - Build deterministic model (nodes/links)
// - Render DOM layers (SVG edges + HTML nodes)
// - Run D3 simulation + drag + edge-end trimming
// - Apply highlight (chip + link glow) + isolate/hide unrelated Source/Type nodes
//
// CSS Contract (must be honored externally):
// - .legend-graph
// - .legend-graph__edges
// - .legend-graph__nodes
// - .legend-node (positioned via translate(x,y))
// TODO:highligt js auslagern
// =============================================================================

import { legendStopMs } from "./timing.js";
import {
  buildNodes,
  buildLinks,
  filterLinksToNodes,
  computeUsedNodeIds,
} from "./legend-model.js";
import {
  mountSkeleton,
  renderSvgEdges,
  renderHtmlNodes,
} from "./legend-render.js";
import {
  computeSize,
  runSimulation,
} from "./legend-simulation.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIN_W = 320;
const MIN_H = 220;

const BAND_X = { source: 0.18, type: 0.50, cat: 0.82 };
const COLLIDE_R = { source: 78, type: 78, cat: 92 };

const EDGE_CONF = {
  srcTyp: { stroke: "rgba(16,24,40,0.18)", dist: 120 },
  typCat: { stroke: "rgba(16,24,40,0.34)", dist: 140 },
  srcCat: { stroke: "rgba(16,24,40,0.22)", dist: 180 },
  catSrc: { stroke: "rgba(16,24,40,0.22)", dist: 180 },

  srcTypPlanned: { stroke: "rgba(16,24,40,0.14)", dist: 120, dash: "4 4", opacity: 0.40 },
  typCatPlanned: { stroke: "rgba(16,24,40,0.18)", dist: 140, dash: "4 4", opacity: 0.40 },
  srcCatPlanned: { stroke: "rgba(16,24,40,0.14)", dist: 180, dash: "4 4", opacity: 0.35 },
  catSrcPlanned: { stroke: "rgba(16,24,40,0.14)", dist: 180, dash: "4 4", opacity: 0.35 },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function assertMap(name, value, optional = false) {
  if (optional && value == null) return;
  if (!(value instanceof Map)) {
    throw new Error(`renderLegend: ${name} missing/invalid (Map expected)`);
  }
}

function uniqueCatsPreserveOrder(cats) {
  const seen = new Set();
  const out = [];

  for (const c of cats || []) {
    if (typeof c !== "string" || !c.length) {
      throw new Error("renderLegend: invalid category string (Option A strict)");
    }
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }

  return out;
}

function getHighlightCat(state) {
  const v =
    state?.legendHighlightCat ??
    state?.highlightedCategory ??
    state?.hoverCat ??
    state?.haloCat;

  return typeof v === "string" && v.length ? v : null;
}

function ensureArrowMarkers(svg) {
  const ns = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");

  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  const ensure = (id, refX, pathD) => {
    if (svg.querySelector(`#${id}`)) return;

    const m = document.createElementNS(ns, "marker");
    m.setAttribute("id", id);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", refX);
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "6");
    m.setAttribute("markerHeight", "6");
    m.setAttribute("markerUnits", "strokeWidth");
    m.setAttribute("orient", "auto");

    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", pathD);
    p.setAttribute("fill", "currentColor");
    p.setAttribute("stroke", "none");

    m.appendChild(p);
    defs.appendChild(m);
  };

  ensure("legend-arrow-end", "10", "M 0 0 L 10 5 L 0 10 z");
  ensure("legend-arrow-start", "0", "M 10 0 L 0 5 L 10 10 z");

  ensure("legend-arrow-end-hi", "10", "M 0 0 L 10 5 L 0 10 z");
  ensure("legend-arrow-start-hi", "0", "M 10 0 L 0 5 L 10 10 z");
}

function arrowPlacementForKind(kind) {
  // This is no longer used for the default/non-highlight arrows, but kept for potential future use.
  const k = String(kind || "");
  if (k.startsWith("typCat")) return { start: true, end: false };
  if (k.startsWith("srcCat")) return { start: true, end: false };
  if (k.startsWith("catSrc")) return { start: false, end: true };
  return { start: false, end: false };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function renderLegend({
  mountEl,
  cats,
  state,
  onToggle,
  colorByCat,
  catTotals,
  typeTotals,
  sourceTotals,
  graph,
} = {}) {
  if (!mountEl) throw new Error("renderLegend: mountEl missing");

  assertMap("colorByCat", colorByCat);
  assertMap("catTotals", catTotals);
  assertMap("typeTotals", typeTotals, true);
  assertMap("sourceTotals", sourceTotals);

  if (!graph || typeof graph !== "object") {
    throw new Error("renderLegend: graph missing/invalid");
  }

  const {
    sources,
    types,
    sourceTypeWeight,
    typeCatWeight,
    sourceCatWeight,
    sourceTypePlanned,
    typeCatPlanned,
    sourceCatPlanned,
  } = graph;

  if (!Array.isArray(sources) || !sources.length) {
    throw new Error("renderLegend: graph.sources missing/empty");
  }

  if (!Array.isArray(types) || !types.length) {
    throw new Error("renderLegend: graph.types missing/empty");
  }

  assertMap("sourceTypeWeight", sourceTypeWeight);
  assertMap("typeCatWeight", typeCatWeight);
  assertMap("sourceCatWeight", sourceCatWeight);
  assertMap("sourceTypePlanned", sourceTypePlanned, true);
  assertMap("typeCatPlanned", typeCatPlanned, true);
  assertMap("sourceCatPlanned", sourceCatPlanned, true);

  const catList = uniqueCatsPreserveOrder(cats);

  const missingColors = catList.filter((c) => !colorByCat.has(c));
  if (missingColors.length) {
    throw new Error(
      `renderLegend: colorByCat missing keys (Option A strict): ${missingColors.join(", ")}`
    );
  }

  const disabledCats = state?.disabledCats instanceof Set ? state.disabledCats : new Set();
  const enabledCats = new Set(catList.filter((c) => !disabledCats.has(c)));

  const highlightedCat = getHighlightCat(state);
  const mode = state?.mode === "menge" ? "menge" : "kosten";

  const d3 = window.d3;
  if (!d3) throw new Error("renderLegend: D3 missing (window.d3)");

  const { svg, nodesHost } = mountSkeleton(mountEl);

  const { width, height } = computeSize(mountEl, { minW: MIN_W, minH: MIN_H });
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const byKey = new Map(catList.map((c) => [c, c]));
  const { nodes, sourceNodes, typeNodes, catNodes } =
    buildNodes(graph, byKey, width, height, BAND_X);

  const rawLinks = buildLinks(graph, catNodes);
  const links = filterLinksToNodes(nodes, rawLinks);
  const usedNodeIds = computeUsedNodeIds(links);

  const linkSel = renderSvgEdges(d3, svg, links, {
    edgeConf: EDGE_CONF,
    highlightedCat,
    colorByCat,
  });

  ensureArrowMarkers(svg);

  const nodeElById = renderHtmlNodes({
    d3,
    nodesHost,
    sourceNodes,
    typeNodes,
    catNodes,
    enabledCats,
    colorByCat,
    catTotals,
    typeTotals: typeTotals ?? new Map(),
    sourceTotals,
    mode,
    onToggle,
    usedNodeIds,
    highlightedCat,
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // ---------------------------------------------------------------------------
  // Highlight / Halo interop (event-driven)
  // ---------------------------------------------------------------------------

  let currentHighlightCat = highlightedCat;

  const applyHighlight = (cat) => {
    const next = typeof cat === "string" && cat.length ? cat : null;
    currentHighlightCat = next;

    const catId = next ? `cat:${next}` : null;
    const glowColor = next ? (colorByCat.get(next) || "") : "";

    // Marker coloring strategy:
    // - Neutral arrows (non-highlight links) stay neutral.
    // - Highlight arrows (only for highlighted-category links) are colored with the category glow.
    const neutralColor = "rgba(16,24,40,0.34)";
    const hiColor = glowColor || neutralColor;

    const endPath = svg.querySelector("#legend-arrow-end path");
    const startPath = svg.querySelector("#legend-arrow-start path");
    const endHiPath = svg.querySelector("#legend-arrow-end-hi path");
    const startHiPath = svg.querySelector("#legend-arrow-start-hi path");

    if (endPath) {
      endPath.setAttribute("fill", neutralColor);
      endPath.setAttribute("stroke", "none");
    }
    if (startPath) {
      startPath.setAttribute("fill", neutralColor);
      startPath.setAttribute("stroke", "none");
    }

    if (endHiPath) {
      endHiPath.setAttribute("fill", hiColor);
      endHiPath.setAttribute("stroke", "none");
    }
    if (startHiPath) {
      startHiPath.setAttribute("fill", hiColor);
      startHiPath.setAttribute("stroke", "none");
    }

    // 1) Chips: dataset.highlight + glow variable
    for (const el of nodeElById.values()) {
      if (!el.classList.contains("legend-node--cat")) continue;
      const c = el.dataset.cat || el.dataset.category || "";
      const isHi = !!next && c === next;
      el.dataset.highlight = isHi ? "true" : "false";
      if (isHi && glowColor) el.style.setProperty("--legend-glow", glowColor);
      else el.style.removeProperty("--legend-glow");
    }

    // 2) Links: set data-highlight + color
    linkSel
      .attr("data-highlight", (d) => {
        if (!catId) return "false";
        const sId = d?.source?.id || d?.source;
        const tId = d?.target?.id || d?.target;
        return sId === catId || tId === catId ? "true" : "false";
      })
      .style("color", (d) => {
        const base = EDGE_CONF[d?.kind]?.stroke || "rgba(16,24,40,0.18)";
        if (!catId) return base;
        const sId = d?.source?.id || d?.source;
        const tId = d?.target?.id || d?.target;
        const isHi = sId === catId || tId === catId;
        return isHi ? (glowColor || base) : base;
      });

    // 3) Arrow markers:
    // - NON-highlighted links: show a single neutral arrow tip at the Source/Type end (the non-cat end).
    // - Highlighted-category links: show a single COLORED arrow tip at the non-cat end.
    linkSel.each(function (d) {
      const isHi = this.getAttribute("data-highlight") === "true";

      // Clear first
      this.removeAttribute("marker-start");
      this.removeAttribute("marker-end");

      const sId = d?.source?.id || d?.source;
      const tId = d?.target?.id || d?.target;
      const sIsCat = typeof sId === "string" && sId.startsWith("cat:");
      const tIsCat = typeof tId === "string" && tId.startsWith("cat:");

      // Only place arrows on links that connect exactly one category node.
      if (sIsCat === tIsCat) return;

      const endMarker = isHi ? "url(#legend-arrow-end-hi)" : "url(#legend-arrow-end)";
      const startMarker = isHi ? "url(#legend-arrow-start-hi)" : "url(#legend-arrow-start)";

      // Arrow at the non-cat end:
      // - if target is non-cat, marker-end puts the arrow at that end
      // - if source is non-cat, marker-start puts the arrow at that end
      if (!tIsCat) this.setAttribute("marker-end", endMarker);
      else if (!sIsCat) this.setAttribute("marker-start", startMarker);
    });
  };

  applyHighlight(currentHighlightCat);

  if (!mountEl.__legendHighlightBound) {
    const onHi = (ev) => applyHighlight(ev?.detail?.cat ?? null);

    mountEl.addEventListener("legend:highlight", onHi);
    mountEl.addEventListener("legend:clearHighlight", () => applyHighlight(null));
    document.addEventListener("legend:highlight", onHi);

    mountEl.__legendHighlightBound = true;
  }

  for (const [id, el] of nodeElById.entries()) {
    const n = nodeById.get(id);
    if (!n) continue;

    const used = usedNodeIds.has(id);

    if (!used && (n.kind === "source" || n.kind === "type")) {
      el.style.display = "none";
      continue;
    }

    if (n.kind === "cat") {
      el.dataset.isolated = used ? "false" : "true";
    }
  }

  runSimulation({
    d3,
    nodes,
    links,
    linkSel,
    nodeElById,
    nodesHost,
    width,
    height,
    state,
    edgeConf: EDGE_CONF,
    collideR: COLLIDE_R,
    band: BAND_X,
    legendStopMs,
  });
}
