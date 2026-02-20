// legend-render.js
// =============================================================================
// Legend DOM renderer (skeleton + SVG edges + HTML nodes)
// =============================================================================
// CONTRACT (strict, CSS-first):
//
// 1) Layering / DOM structure (mountSkeleton)
//    - Creates exactly:
//        <div class="legend-graph">
//          <svg class="legend-graph__edges"></svg>
//          <div class="legend-graph__nodes"></div>
//        </div>
//    - The CSS owns stacking order (z-index, pointer-events) and clipping.
//    - This module NEVER sets z-index or positioning offsets to “fix” stacking.
//
// 2) SVG edges (renderSvgEdges)
//    - Renders one <line> per link with classes:
//        "legend-link legend-link--{kind}" and optional "is-planned".
//    - Stroke color is CSS-driven via `currentColor`.
//      JS sets `style.color` to either:
//        - edgeConf[kind].stroke (default)
//        - category color (when highlighted)
//    - Adds attribute `data-highlight="true|false"` for CSS glow.
//    - Edges are non-interactive: pointer-events is set to none.
//
// 3) HTML nodes (renderHtmlNodes)
//    - Source nodes: <div class="legend-node legend-node--source ...">
//    - Type nodes:   <div class="legend-node legend-node--type">
//    - Cat nodes:    <button class="legend-chip legend-node legend-node--cat">
//      Required datasets for interop:
//        - dataset.cat = <cat identity>
//        - dataset.active = "true|false" (toggle state)
//        - dataset.highlight = "true|false" (glow)
//        - dataset.hidden = "true" (optional; higher-level may hide/remove)
//    - Cat colors are exposed via CSS variables on the button:
//        --cat-bg (background), --cat-fg (text), --legend-glow (optional highlight)
//
// 4) Non-goals
//    - No force simulation, no node positioning.
//    - No filtering logic; callers decide what nodes/links to provide.
//    - No key normalization for categories (Option A identity semantics).
// =============================================================================

import { toneOfValue, applyToneFromValue } from "./moneytone.js";

// Micro DOM helper
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function formatTotal(n, mode) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  const fmt = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return mode === "menge" ? fmt.format(v) : `${fmt.format(v)} €`;
}

/**
 * Best-effort text color based on background.
 */
export function textColorForBg(bg) {
  const s = String(bg || "").trim().toLowerCase();

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    let r, g, b;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else return "#0A0A0A";
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.62 ? "#0A0A0A" : "#FFFFFF";
  }

  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((p) => Number(String(p).trim()));
    const r = parts[0] ?? 0, g = parts[1] ?? 0, b = parts[2] ?? 0;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.62 ? "#0A0A0A" : "#FFFFFF";
  }

  return "#0A0A0A";
}

/**
 * Mount skeleton per CSS contract:
 * - legend-graph__edges (SVG)
 * - legend-graph__nodes (HTML)
 */
export function mountSkeleton(mountEl) {
  mountEl.innerHTML = "";

  const wrap = el("div", "legend-graph");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("legend-graph__edges");
  const nodesHost = el("div", "legend-graph__nodes");

  wrap.appendChild(svg);
  wrap.appendChild(nodesHost);
  mountEl.appendChild(wrap);

  return { wrap, svg, nodesHost };
}

/**
 * Render SVG edges as <line>. Styling is CSS-driven via .legend-link classes.
 *
 * edge styling strategy:
 * - stroke uses currentColor
 * - JS sets `style.color` (default or cat color when highlighted)
 * - CSS can apply drop-shadow glow when data-highlight="true"
 */
export function renderSvgEdges(d3, svg, links, { edgeConf, highlightedCat, colorByCat }) {
  const selSvg = d3.select(svg);

  const maxW = Math.max(1, ...links.map((l) => Number(l.weight) || 0));
  const strokeWidth = (w) => 1 + 3 * Math.min(1, (Number(w) || 0) / maxW);

  const shouldHighlightLink = (d) => {
    if (!(typeof highlightedCat === "string" && highlightedCat.length)) return false;
    const catId = `cat:${highlightedCat}`;
    const sId = d?.source?.id || d?.source;
    const tId = d?.target?.id || d?.target;
    return sId === catId || tId === catId;
  };

  const defaultColor = (d) => edgeConf?.[d.kind]?.stroke || "rgba(16,24,40,0.18)";

  const linkSel = selSvg
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("stroke", "currentColor")
    .attr("class", (d) => `legend-link legend-link--${d.kind}${d.planned ? " is-planned" : ""}`)
    .attr("stroke-width", (d) => strokeWidth(d.weight))
    .attr("stroke-dasharray", (d) => (d.planned ? "6 6" : null))
    .attr("pointer-events", "none")
    .style("color", (d) => {
      if (shouldHighlightLink(d)) return colorByCat?.get?.(highlightedCat) || defaultColor(d);
      return defaultColor(d);
    })
    .attr("data-highlight", (d) => (shouldHighlightLink(d) ? "true" : "false"));

  return linkSel;
}

/**
 * Render HTML nodes. Returns Map<nodeId, HTMLElement>.
 *
 * - Source nodes: div.legend-node--source
 * - Type nodes:   div.legend-node--type
 * - Cat nodes:    button.legend-chip.legend-node--cat
 */
export function renderHtmlNodes({
  d3,
  nodesHost,
  sourceNodes,
  typeNodes,
  catNodes,
  enabledCats,
  colorByCat,
  catTotals,
  typeTotals,
  sourceTotals,
  mode,
  onToggle,
  usedNodeIds,
  highlightedCat,
  // OPTIONAL: category -> year span (Map or plain object). Value: [min,max] or {min,max}
  catYearSpan,
  // OPTIONAL: currently highlighted year from the bar chart (hover/selection)
  highlightedYear,
}) {
  const nodeElById = new Map();

  const bindDatum = (domEl, nodeObj) => {
    d3.select(domEl).datum(nodeObj);
    domEl.style.touchAction = "none";
  };

  const mountNode = (domEl, nodeObj) => {
    nodesHost.appendChild(domEl);
    nodeElById.set(nodeObj.id, domEl);
    bindDatum(domEl, nodeObj);
  };

  const catBg = (catKey) => colorByCat?.get?.(catKey) || "rgba(16,24,40,0.10)";

  const getFirstMapHit = (mapLike, keys, fallback = 0) => {
    if (!mapLike || typeof mapLike.get !== "function") return fallback;
    for (const k of keys) {
      if (k == null) continue;
      const kk = String(k);
      if (!kk) continue;
      if (mapLike.has?.(kk)) return mapLike.get(kk);
      const v = mapLike.get(kk);
      if (v != null) return v;
    }
    return fallback;
  };

  const stripPrefix = (id, prefix) => {
    const s = String(id ?? "");
    return s.startsWith(prefix) ? s.slice(prefix.length) : s;
  };

  // SOURCE
  for (const node of sourceNodes) {
    // NOTE: `sourceTotals` keys vary across versions (sid, id, label).
    // Use the first key that matches to avoid showing `0 €` by accident.
    const sourceKeyCandidates = [
      node.sid,
      node.sourceId,
      node.source,
      stripPrefix(node.id, "source:"),
      stripPrefix(node.id, "src:"),
      node.id,
      node.label,
    ];
    const total = getFirstMapHit(sourceTotals, sourceKeyCandidates, 0);
    const totalStr = formatTotal(total, mode);

    const circle = el("div", "legend-node legend-node--source legend-node--type");
    circle.title = `${node.label}${totalStr ? " · " + totalStr : ""}`;

    // Money tone (shared system)
    // - We keep legacy `data-sign="pos|neg|zero"` for source nodes, because
    //   legend-network.css maps it to global moneyTone.css tokens.
    // - The semantic decision comes from moneytone.js (single source of truth).
    circle.dataset.sign = toneOfValue(total);

    const lab = el("div", "legend-type__label", node.label);
    const val = el("div", "legend-type__value", totalStr);
    circle.append(lab, val);

    // hide unrelated nodes if required (usedNodeIds computed from links)
    if (usedNodeIds && !usedNodeIds.has(node.id)) circle.dataset.hidden = "true";

    mountNode(circle, node);
  }

  // TYPE
  for (const node of typeNodes) {
    const total = typeTotals?.get?.(String(node.type));
    const totalStr = total == null ? "" : formatTotal(total, mode);

    const circle = el("div", "legend-node legend-node--type");
    circle.title = `${node.label}${totalStr ? " · " + totalStr : ""}`;

    const lab = el("div", "legend-type__label", node.label);
    circle.appendChild(lab);

    if (totalStr) {
      const val = el("div", "legend-type__value", totalStr);
      circle.appendChild(val);
    }

    if (usedNodeIds && !usedNodeIds.has(node.id)) circle.dataset.hidden = "true";

    mountNode(circle, node);
  }

  // CAT
  for (const node of catNodes) {
    const isOn = enabledCats instanceof Set ? enabledCats.has(node.cat) : true;

    const btn = document.createElement("button");
    btn.className = "legend-chip legend-node legend-node--cat";
    btn.type = "button";
    btn.title = node.label;

    // Interop with hover/halo controllers (must be stable)
    btn.dataset.cat = node.cat;

    btn.dataset.active = isOn ? "true" : "false";
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");

    const bg = catBg(node.cat);
    btn.style.setProperty("--cat-bg", bg);
    btn.style.setProperty("--cat-fg", textColorForBg(bg));

    // highlight for glow
    const isHi = typeof highlightedCat === "string" && highlightedCat === node.cat;
    btn.dataset.highlight = isHi ? "true" : "false";
    if (isHi) btn.style.setProperty("--legend-glow", bg);
    else btn.style.removeProperty("--legend-glow");

    // Label is a container so we can optionally show year metadata for the highlighted chip.
    const label = el("span", "legend-chip__label");
    const titleEl = el("span", "legend-chip__title", node.label);
    label.appendChild(titleEl);

    // Only the highlighted chip shows year range + current year.
    const isActiveChip = typeof highlightedCat === "string" && highlightedCat === node.cat;

    // Resolve category year span (from caller or embedded node meta).
    const spanRaw =
      (catYearSpan && (catYearSpan.get?.(node.cat) ?? catYearSpan[node.cat])) ??
      (node.yearSpan || node.years || node.meta?.yearSpan || null);

    const normSpan = (v) => {
      if (!v) return null;
      if (Array.isArray(v) && v.length >= 2) return { min: Number(v[0]), max: Number(v[1]) };
      if (typeof v === "object" && v != null && ("min" in v || "max" in v)) {
        return { min: Number(v.min), max: Number(v.max) };
      }
      return null;
    };

    const span = normSpan(spanRaw);
    const y = highlightedYear != null && String(highlightedYear).trim() !== "" ? String(highlightedYear) : null;

    if (isActiveChip && span) {
      // Title meta: show the full existence range of the category: `min - max`.
      // The current year is shown on the amount line (`YYYY: amount`).
      const min = Number.isFinite(span.min) ? span.min : null;
      const max = Number.isFinite(span.max) ? span.max : null;

      let text = "";
      if (min != null && max != null) text = min === max ? String(min) : `${min} - ${max}`;
      else if (min != null) text = String(min);
      else if (max != null) text = String(max);

      if (text) {
        // Ensure visible separation even if CSS gap is missing.
        label.appendChild(document.createTextNode(" "));
        const metaEl = el("span", "legend-chip__meta", text);
        label.appendChild(metaEl);
      }
    }

    const total = catTotals?.get?.(node.cat);

    // Value text: for the highlighted chip prepend the current year: `YYYY: amount`.
    const valueText = (() => {
      if (total == null) return "";
      const amount = formatTotal(total, mode);
      const yStr = y || "";
      return isActiveChip && yStr ? `${yStr}: ${amount}` : amount;
    })();

    const valueEl = el("span", "legend-chip__value", valueText);

    // Money tone for the amount line ONLY
    // - Keep chip background bound to category color (--cat-bg).
    // - Apply tone to the value element so only the number changes color.
    if (total == null) {
      valueEl.style.display = "none";
      // Ensure no stale tone when value disappears
      valueEl.removeAttribute("data-tone");
      valueEl.classList.remove("tone-pos", "tone-neg", "tone-zero");
    } else {
      valueEl.style.display = "";
      applyToneFromValue(valueEl, total, { mode: "data" });
    }

    btn.append(label, valueEl);

    btn.addEventListener("click", (ev) => {
      if (btn.dataset.drag === "true") {
        btn.dataset.drag = "false";
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      const next = btn.dataset.active !== "true";
      btn.dataset.active = next ? "true" : "false";
      btn.setAttribute("aria-pressed", next ? "true" : "false");

      onToggle?.(node.cat, next);
    });

    if (usedNodeIds && !usedNodeIds.has(node.id)) btn.dataset.hidden = "true";

    mountNode(btn, node);
  }

  return nodeElById;
}