

// -----------------------------------------------------------------------------
// renderGenTables.js
// - Generische Debug/Transparenz-Tabellen (z.B. ctx.derived)
// - Ohne Dependencies, ohne Inline-Styles
// - Sortierbare Tabellen (Header-Klick: asc/desc)
// - Optional: View-Selector für top-level Teilbäume (aggregates/view/options/graph/...)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * renderDerivedIntoDom(ctx, opts)
 * - Rendert ctx.derived in den Container #derivedTable (oder opts.root)
 * - Erstellt (einmalig) eine minimale Control-Bar (View-Auswahl + Search)
 * - Sortierung wird am Root-Element gespeichert (persistiert über Re-Renders)
 */
export function renderDerivedIntoDom(ctx, opts = {}) {
  const root = resolveRoot(opts.root || "derivedTable");
  if (!root) return;

  const derived = ctx?.derived;

  // State für UI/Sort/Pfad am Root speichern (kein globaler Singleton)
  const st = (root.__derivedTableState ||= {
    viewKey: null,
    q: "",
    sortKey: null,
    sortDir: "asc",
  });

  ensureControls(root, st, derived);

  const slice = pickSlice(derived, st.viewKey);
  const rows = normalizeToRows(slice);

  const filtered = st.q ? filterRows(rows, st.q) : rows;

  renderTable(root, filtered, {
    sortKey: st.sortKey,
    sortDir: st.sortDir,
    onSort: (key) => {
      if (st.sortKey === key) {
        st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
      } else {
        st.sortKey = key;
        st.sortDir = "asc";
      }
      // Re-render only table (controls bleiben)
      renderDerivedIntoDom(ctx, opts);
    },
  });
}

// -----------------------------------------------------------------------------
// 1) Root + Controls
// -----------------------------------------------------------------------------

function resolveRoot(rootOrId) {
  if (!rootOrId) return null;
  if (typeof rootOrId === "string") return document.getElementById(rootOrId);
  if (rootOrId instanceof HTMLElement) return rootOrId;
  return null;
}

function ensureControls(root, st, derived) {
  // Wenn schon initialisiert, nur Options ggf. aktualisieren
  let host = root.querySelector("[data-derived-controls]");
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("data-derived-controls", "1");
    root.appendChild(host);

    const bar = document.createElement("div");
    bar.setAttribute("data-derived-bar", "1");
    host.appendChild(bar);

    // View selector
    const sel = document.createElement("select");
    sel.setAttribute("data-derived-view", "1");
    sel.setAttribute("aria-label", "CTX Slice Auswahl");
    sel.addEventListener("change", () => {
      st.viewKey = sel.value || null;
      renderDerivedIntoDom({ derived }, { root });
    });
    bar.appendChild(sel);

    // Search
    const inp = document.createElement("input");
    inp.setAttribute("data-derived-search", "1");
    inp.setAttribute("type", "search");
    inp.setAttribute("placeholder", "Filtern… (Text enthält)");
    inp.setAttribute("aria-label", "Tabelle filtern");
    inp.addEventListener("input", () => {
      st.q = String(inp.value || "").trim();
      renderDerivedIntoDom({ derived }, { root });
    });
    bar.appendChild(inp);

    // Meta
    const meta = document.createElement("div");
    meta.setAttribute("data-derived-meta", "1");
    host.appendChild(meta);

    // Table mount
    const mount = document.createElement("div");
    mount.setAttribute("data-derived-mount", "1");
    root.appendChild(mount);
  }

  const sel = root.querySelector("select[data-derived-view]");
  const inp = root.querySelector("input[data-derived-search]");
  const meta = root.querySelector("[data-derived-meta]");

  if (inp && inp.value !== st.q) inp.value = st.q;

  const keys = getTopLevelKeys(derived);
  const defaultKey = pickDefaultViewKey(keys);
  if (!st.viewKey) st.viewKey = defaultKey;

  if (sel) {
    // Options aktualisieren (stabil, ohne unnötige DOM churn)
    const cur = Array.from(sel.options).map((o) => o.value);
    const wanted = ["__SELF__", ...keys];
    if (cur.join("|") !== wanted.join("|")) {
      sel.innerHTML = "";
      sel.appendChild(opt("__SELF__", "derived (root)"));
      for (const k of keys) sel.appendChild(opt(k, k));
    }
    sel.value = st.viewKey || "__SELF__";
  }

  if (meta) {
    const slice = pickSlice(derived, st.viewKey);
    const info = describeValue(slice);
    meta.textContent = info;
  }
}

function opt(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function getTopLevelKeys(v) {
  if (!v || typeof v !== "object") return [];
  if (Array.isArray(v)) return [];
  if (v instanceof Map) return [];
  return Object.keys(v).filter(Boolean).sort((a, b) => a.localeCompare(b, "de"));
}

function pickDefaultViewKey(keys) {
  // Default: wenn vorhanden, die typischen "großen" Slices zuerst
  const preferred = ["aggregates", "view", "options", "graph", "colorByCat"];
  for (const p of preferred) if (keys.includes(p)) return p;
  return keys[0] || "__SELF__";
}

function pickSlice(derived, viewKey) {
  if (!derived) return null;
  if (!viewKey || viewKey === "__SELF__") return derived;
  if (derived && typeof derived === "object" && !(derived instanceof Map) && !Array.isArray(derived)) {
    return derived[viewKey];
  }
  return derived;
}

function describeValue(v) {
  if (v == null) return "(leer)";
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (typeof v === "object") return `Object(${Object.keys(v).length})`;
  return typeof v;
}

// -----------------------------------------------------------------------------
// 2) Normalization: Value -> Rows
// -----------------------------------------------------------------------------

function normalizeToRows(v) {
  if (v == null) return [];

  // Array von Objekten => direkt tabellierbar
  if (Array.isArray(v)) {
    return v
      .filter((x) => x != null)
      .map((x) => (typeof x === "object" ? x : { value: x }));
  }

  // Map => key/value
  if (v instanceof Map) {
    return Array.from(v.entries()).map(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) return { key, ...value };
      return { key, value };
    });
  }

  // Plain object => key/value; wenn value ein flaches Objekt ist: 1 level flatten
  if (typeof v === "object") {
    const rows = [];
    for (const [key, value] of Object.entries(v)) {
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map)) {
        // 1-level flatten
        rows.push({ key, ...value });
      } else {
        rows.push({ key, value });
      }
    }
    return rows;
  }

  // Primitive
  return [{ value: v }];
}

function filterRows(rows, q) {
  const needle = String(q || "").toLowerCase();
  if (!needle) return rows;

  return rows.filter((r) => {
    try {
      const s = JSON.stringify(r);
      return String(s || "").toLowerCase().includes(needle);
    } catch {
      return false;
    }
  });
}

// -----------------------------------------------------------------------------
// 3) Table Rendering + Sorting
// -----------------------------------------------------------------------------

function renderTable(root, rows, sort) {
  const mount = root.querySelector("[data-derived-mount]");
  if (!mount) return;

  if (!rows || !rows.length) {
    mount.innerHTML = "<div>(keine Zeilen)</div>";
    return;
  }

  const columns = collectColumns(rows);

  // Sortierung
  const st = sort || {};
  const sortKey = st.sortKey && columns.includes(st.sortKey) ? st.sortKey : null;
  const sortDir = st.sortDir === "desc" ? "desc" : "asc";

  let list = rows.slice();
  if (sortKey) {
    const values = list.map((r) => r?.[sortKey]);
    const cmp = inferComparator(values);
    const mul = sortDir === "desc" ? -1 : 1;

    list.sort((ra, rb) => {
      const a = ra?.[sortKey];
      const b = rb?.[sortKey];
      const aNil = a == null || a === "";
      const bNil = b == null || b === "";
      if (aNil && bNil) return 0;
      if (aNil) return 1;
      if (bNil) return -1;
      return cmp(a, b) * mul;
    });
  }

  // HTML
  const thead = `
    <thead>
      <tr>
        ${columns
          .map((c) => {
            const active = sortKey === c;
            const arrow = !active ? "" : sortDir === "asc" ? "▲" : "▼";
            return `<th data-col="${escapeHtml(c)}">${escapeHtml(c)}${arrow ? ` <span aria-hidden="true">${arrow}</span>` : ""}</th>`;
          })
          .join("")}
      </tr>
    </thead>
  `;

  const tbody = `
    <tbody>
      ${list
        .map((r) => {
          return `<tr>${columns.map((c) => `<td>${escapeHtml(formatCell(r?.[c]))}</td>`).join("")}</tr>`;
        })
        .join("")}
    </tbody>
  `;

  mount.innerHTML = `<table>${thead}${tbody}</table>`;

  // Header Click => sort
  mount.querySelectorAll("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-col");
      if (typeof st.onSort === "function") st.onSort(key);
    });
  });
}

function collectColumns(rows) {
  const set = new Set();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    for (const k of Object.keys(r)) set.add(k);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
}

function formatCell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) return `Map(${v.size})`;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === "object") {
    // Kurzform, um die Tabelle nicht zu sprengen
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    if (keys.length <= 3) {
      const frag = keys.map((k) => `${k}:${String(v[k])}`).join(", ");
      return `{${frag}}`;
    }
    return `Object(${keys.length})`;
  }
  return String(v);
}

function inferComparator(values) {
  // Heuristik: Zahl vs. Datum vs. String
  const sample = values.find((v) => v != null && v !== "");
  if (sample == null) return () => 0;

  const toNum = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.trim().replace(/\s+/g, "");
      const de = s.replace(/\./g, "").replace(",", ".");
      const n = Number(de);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  const toDate = (v) => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : NaN;
    }
    return NaN;
  };

  const head = values.slice(0, 50);
  const numCount = head.filter((v) => Number.isFinite(toNum(v))).length;
  const dateCount = head.filter((v) => Number.isFinite(toDate(v))).length;

  if (numCount >= Math.max(3, Math.floor(head.length * 0.6))) {
    return (a, b) => toNum(a) - toNum(b);
  }

  if (dateCount >= Math.max(3, Math.floor(head.length * 0.6))) {
    return (a, b) => toDate(a) - toDate(b);
  }

  return (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "de");
}

function escapeHtml(v) {
  const s = v == null ? "" : String(v);
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}