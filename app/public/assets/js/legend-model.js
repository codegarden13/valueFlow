// legend-model.js
// =============================================================================
// Legend model builder (pure data)
// - builds deterministic node/link arrays from graph + categories
// - no DOM, no D3
// =============================================================================

import { cleanKey } from "./keys.js";

// Split key "a::b" (strict)
function split2(key) {
  const s = String(key);
  const i = s.indexOf("::");
  if (i <= 0) return [null, null];
  return [s.slice(0, i), s.slice(i + 2)];
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** De-duplicate categories by normalized key and preserve first display label. */
export function dedupeCats(cats) {
  const byKey = new Map(); // key -> display
  for (const raw of cats || []) {
    const key = cleanKey(raw);
    if (!key || byKey.has(key)) continue;
    const display = String(raw ?? "").trim() || key;
    byKey.set(key, display);
  }
  return byKey;
}

/**
 * Build deterministic node sets from graph + byKey.
 * graph contract:
 *  - sources: Array<{id,label}>
 *  - types:   Array<string>
 */
export function buildNodes(graph, byKey) {
  const sources = Array.isArray(graph?.sources) ? graph.sources : [];
  const types = Array.isArray(graph?.types) ? graph.types : [];

  const sourceNodes = sources.map((s) => ({
    id: `src:${s.id}`,
    kind: "source",
    sid: s.id,
    label: s.label || s.id,
  }));

  const typeNodes = types.map((t) => ({
    id: `typ:${t}`,
    kind: "type",
    type: String(t),
    label: String(t),
  }));

  const catNodes = Array.from(byKey.entries()).map(([key, display]) => ({
    id: `cat:${key}`,
    kind: "cat",
    cat: key,
    label: display,
  }));

  return {
    nodes: [...sourceNodes, ...typeNodes, ...catNodes],
    sourceNodes,
    typeNodes,
    catNodes,
  };
}

/**
 * Build deterministic links from graph weight maps.
 * Supports:
 *  - sourceTypeWeight (Map "sid::type" -> weight)
 *  - typeCatWeight    (Map "type::cat" -> weight)
 *  - sourceCatWeight  (Map "sid::cat" -> weight)
 *
 * Also supports planned maps (optional) but keeps them separate
 * so renderer can style dashed etc. without affecting weights:
 *  - sourceTypePlanned / typeCatPlanned / sourceCatPlanned (Map -> count)
 */
export function buildLinks(graph, catNodes) {
  const links = [];

  const catIdByKey = new Map(catNodes.map((c) => [c.cat, c.id]));

  const pushWeighted = (source, target, weight, kind) => {
    const w = toNum(weight);
    if (!w) return;
    links.push({ source, target, weight: w, kind });
  };

  const pushPlanned = (source, target, kind) => {
    links.push({ source, target, weight: 1, kind, planned: true });
  };

  // --- ACTUAL
  const st = graph?.sourceTypeWeight;
  if (st?.get) {
    for (const [k, w] of st.entries()) {
      const [sid, t] = split2(k);
      if (!sid || !t) continue;
      pushWeighted(`src:${sid}`, `typ:${t}`, w, "srcTyp");
    }
  }

  const tc = graph?.typeCatWeight;
  if (tc?.get) {
    for (const [k, w] of tc.entries()) {
      const [t, cat] = split2(k);
      if (!t || !cat) continue;
      const cid = catIdByKey.get(cat);
      if (!cid) continue;
      pushWeighted(`typ:${t}`, cid, w, "typCat");
    }
  }

  const sc = graph?.sourceCatWeight;
  if (sc?.get) {
    for (const [k, w] of sc.entries()) {
      const [sid, cat] = split2(k);
      if (!sid || !cat) continue;
      const cid = catIdByKey.get(cat);
      if (!cid) continue;
      pushWeighted(`src:${sid}`, cid, w, "srcCat");
      // mirror if you want it visually explicit:
      pushWeighted(cid, `src:${sid}`, w, "catSrc");
    }
  }

  // --- PLANNED (legend-only, dashed in CSS via class)
  const stp = graph?.sourceTypePlanned;
  if (stp?.get) {
    for (const [k] of stp.entries()) {
      const [sid, t] = split2(k);
      if (!sid || !t) continue;
      pushPlanned(`src:${sid}`, `typ:${t}`, "srcTypPlanned");
    }
  }

  const tcp = graph?.typeCatPlanned;
  if (tcp?.get) {
    for (const [k] of tcp.entries()) {
      const [t, cat] = split2(k);
      if (!t || !cat) continue;
      const cid = catIdByKey.get(cat);
      if (!cid) continue;
      pushPlanned(`typ:${t}`, cid, "typCatPlanned");
    }
  }

  const scp = graph?.sourceCatPlanned;
  if (scp?.get) {
    for (const [k] of scp.entries()) {
      const [sid, cat] = split2(k);
      if (!sid || !cat) continue;
      const cid = catIdByKey.get(cat);
      if (!cid) continue;
      pushPlanned(`src:${sid}`, cid, "srcCatPlanned");
      pushPlanned(cid, `src:${sid}`, "catSrcPlanned");
    }
  }

  return links;
}

/** Filter links to existing node ids and non-zero weights. */
export function filterLinksToNodes(nodes, links) {
  const ids = new Set(nodes.map((n) => n.id));
  return (links || []).filter((l) => ids.has(l.source) && ids.has(l.target) && toNum(l.weight) !== 0);
}

/** Used node ids for “unrelated nodes” behavior. */
export function computeUsedNodeIds(links) {
  const used = new Set();
  for (const l of links || []) {
    used.add(String(l.source));
    used.add(String(l.target));
  }
  return used;
}