// -----------------------------------------------------------------------------
// renderGenTables.js
// - Debug/Transparenz: zeigt ALLE aktuell sichtbaren Detail-Zeilen als Tabelle
// - Quelle ist ctx.derived nach Anwendung von Quelle/Typ/Kategorie/Jahr-Filtern
// - Sortierbar nach allen Spalten (Header-Klick: asc/desc)
// - Ohne Dependencies, ohne Inline-Styles
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * renderDerivedIntoDom(ctx, opts)
 * - Rendert eine sortierbare Tabelle in #derivedTable (oder opts.root)
 * - Tabelle zeigt die "rohesten" sichtbaren Zeilen, die verfügbar sind:
 *   1) ctx.derived.aggregates.visibleRows / rows / filteredRows (falls vorhanden)
 *   2) ctx.derived.view.detailsByKey (Arrays werden zusammengeführt)
 *   3) ctx.derived.view.rows (falls vorhanden)
 *   4) Fallback: ctx.derived.view.bars
 *
 * Sort-Status wird am Root gespeichert (persistiert über Re-Renders).
 */
export function renderDerivedIntoDom(ctx, opts = {}) {
  const root = resolveRoot(opts.root || "derivedTable");
  if (!root) return;

  const rows = extractVisibleRows(ctx);

  const st = (root.__tableState ||= {
    sortKey: null,
    sortDir: "asc",
  });

  ensureMount(root);

  renderTable(root, rows, {
    sortKey: st.sortKey,
    sortDir: st.sortDir,
    onSort: (key) => {
      if (st.sortKey === key) {
        st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
      } else {
        st.sortKey = key;
        st.sortDir = "asc";
      }
      renderDerivedIntoDom(ctx, opts);
    },
  });
}

// -----------------------------------------------------------------------------
// 1) Root + Mount
// -----------------------------------------------------------------------------

function resolveRoot(rootOrId) {
  if (!rootOrId) return null;
  if (typeof rootOrId === "string") return document.getElementById(rootOrId);
  if (rootOrId instanceof HTMLElement) return rootOrId;
  return null;
}

function ensureMount(root) {
  let mount = root.querySelector("[data-derived-mount]");
  if (!mount) {
    mount = document.createElement("div");
    mount.setAttribute("data-derived-mount", "1");
    root.appendChild(mount);
  }
}

// -----------------------------------------------------------------------------
// 2) Data Extraction (visible rows)
// -----------------------------------------------------------------------------

function extractVisibleRows(ctx) {
  const d = ctx?.derived;
  if (!d) return [];

  // 1) Aggregates (preferred): some implementations keep the visible raw rows here
  const a = d.aggregates;
  if (a) {
    const candidates = [a.visibleRows, a.rows, a.filteredRows, a.visible, a.data];
    for (const c of candidates) {
      const rows = normalizeRows(c);
      if (rows.length) return rows;
    }

    // common pattern: a.detailsByKey or a.details
    const byKey = a.detailsByKey || a.details;
    const merged = mergeDetailsByKey(byKey);
    if (merged.length) return merged;
  }

  // 2) View detailsByKey (very common in this codebase)
  const v = d.view;
  if (v) {
    const merged = mergeDetailsByKey(v.detailsByKey);
    if (merged.length) return merged;

    // 3) explicit rows
    const rows = normalizeRows(v.rows);
    if (rows.length) return rows;

    // 4) fallback to bars
    const bars = normalizeRows(v.bars);
    if (bars.length) return bars;
  }

  return [];
}

function mergeDetailsByKey(detailsByKey) {
  if (!detailsByKey) return [];

  // Map<string, Array<object>>
  if (detailsByKey instanceof Map) {
    const out = [];
    for (const [key, arr] of detailsByKey.entries()) {
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        if (row && typeof row === "object") out.push({ __key: key, ...row });
        else out.push({ __key: key, value: row });
      }
    }
    return out;
  }

  // Plain object { key: [...] }
  if (typeof detailsByKey === "object" && !Array.isArray(detailsByKey)) {
    const out = [];
    for (const [key, arr] of Object.entries(detailsByKey)) {
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        if (row && typeof row === "object") out.push({ __key: key, ...row });
        else out.push({ __key: key, value: row });
      }
    }
    return out;
  }

  return [];
}

function normalizeRows(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .filter((x) => x != null)
      .map((x) => (typeof x === "object" ? x : { value: x }));
  }
  return [];
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

  const st = sort || {};
  const sortKey = st.sortKey && columns.includes(st.sortKey) ? st.sortKey : null;
  const sortDir = st.sortDir === "desc" ? "desc" : "asc";

  let list = rows.slice();
  if (sortKey) {
    const cmp = inferComparator(list.map((r) => r?.[sortKey]));
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

  // __key (aus detailsByKey) nach vorne, wenn vorhanden
  const cols = Array.from(set);
  cols.sort((a, b) => a.localeCompare(b, "de"));
  if (cols.includes("__key")) {
    return ["__key", ...cols.filter((c) => c !== "__key")];
  }
  return cols;
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

// -----------------------------------------------------------------------------
// Kategorie-Tab: Detail-Tabelle für die aktuell hervorgehobene Kategorie
// - Erwartet ctx.state.activeCat als Option-A Identity String (whitespace-sensitiv)
// - Datengrundlage: ctx.derived.view.detailsByKey (bereits gefiltert durch View)
// - Sortierbar nach allen Spalten (nutzt dieselbe renderTable-Engine)
// -----------------------------------------------------------------------------

export function renderCategoryDetailsIntoDom(ctx, opts = {}) {
  const root = resolveRoot(opts.root || "categoryDetailsTable");
  if (!root) return;

  ensureMount(root);

  const mount = root.querySelector("[data-derived-mount]");
  const activeCat = typeof ctx?.state?.activeCat === "string" ? ctx.state.activeCat : "";

  if (!activeCat) {
    if (mount) mount.innerHTML = "<div>(Kategorie auswählen / hover)</div>";
    return;
  }

  const byKey = ctx?.derived?.view?.detailsByKey;
  if (!byKey) {
    if (mount) mount.innerHTML = "<div>(keine Details)</div>";
    return;
  }

  const all = mergeDetailsByKey(byKey);
  if (!all.length) {
    if (mount) mount.innerHTML = "<div>(keine Zeilen)</div>";
    return;
  }

  // Option A: Kategorie ist Identität → KEIN trim/cleanKey.
  const rows = all.filter((r) => {
    const c = r?.cat ?? r?.category ?? r?.kategorie;
    return c === activeCat;
  });

  const st = (root.__tableState ||= {
    sortKey: null,
    sortDir: "asc",
  });

  renderTable(root, rows, {
    sortKey: st.sortKey,
    sortDir: st.sortDir,
    onSort: (key) => {
      if (st.sortKey === key) {
        st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
      } else {
        st.sortKey = key;
        st.sortDir = "asc";
      }
      renderCategoryDetailsIntoDom(ctx, opts);
    },
  });
}