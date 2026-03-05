// -----------------------------------------------------------------------------
// renderGenTables.js
// - Debug/Transparenz: zeigt ALLE aktuell sichtbaren Detail-Zeilen als Tabelle
// - Quelle ist ctx.derived nach Anwendung von Quelle/Typ/Kategorie/Jahr-Filtern
// - Sortierbar nach allen Spalten (Header-Klick: asc/desc)
// - Ohne Dependencies, ohne Inline-Styles
// -----------------------------------------------------------------------------

// NOTE: UI-only enrichment. We keep all financial formulas in a dedicated module.
// This file is just a renderer/formatter that may call calculators to add columns.
import { berechneRente, calcSozialabgaben } from "./taxEngineDE.js";

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
// Bruttolohn enrichment helpers
// -----------------------------------------------------------------------------
// Goal: derive (amount, unit, monthsWorked, year) from heterogeneous row schemas.
// We intentionally support multiple field names so the renderer remains resilient
// across different upstream data sources / adapters.

function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // Support both German and EN number formats:
    // - "1.234,56" -> 1234.56
    // - "1234.56"  -> 1234.56
    const s = v.trim().replace(/\s+/g, "");
    const de = s.replace(/\./g, "").replace(",", ".");
    const n = Number(de);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function yearFromDateLike(v) {
  if (!v) return NaN;
  if (v instanceof Date) return v.getFullYear();
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).getFullYear();
    // Fallback: find first 4-digit year.
    const m = v.match(/(19\d{2}|20\d{2})/);
    return m ? Number(m[1]) : NaN;
  }
  if (typeof v === "number") {
    // Epoch ms
    if (v > 1e11) return new Date(v).getFullYear();
    // Direct year
    if (v >= 1900 && v <= 2100) return Math.floor(v);
  }
  return NaN;
}

function roundMaybe(x, digits = 2) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round((x + Number.EPSILON) * p) / p;
}

function normalizeUnit(raw) {
  const s = String(raw ?? "year").toLowerCase();
  // Accept: month, monat, m
  if (s.startsWith("m")) return "month";
  return "year";
}

function normalizeRegion(raw) {
  return String(raw ?? "WEST").toUpperCase() === "OST" ? "OST" : "WEST";
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
    const c = r?.cat ?? r?.category ?? r?.Kategorie;
    return c === activeCat;
  });

  // ---------------------------------------------------------------------------
  // Special view: Bruttolohn
  // ---------------------------------------------------------------------------
  // When the user hovers the category "Bruttolohn" we want to show derived metrics
  // (earned pension, social contributions, later: taxes) instead of only raw fields.
  //
  // This is intentionally a *presentation* concern:
  // - We do NOT mutate ctx.derived.
  // - We derive additional columns for the table renderer only.
  const isBruttolohn = activeCat === "Bruttolohn";

  const enrichedRows = !isBruttolohn
    ? rows
    : rows.map((r) => {
        // 1) Amount (EUR)
        // Try common field names used across adapters.
        const amount = toNumber(
          r?.betrag ?? r?.amount ?? r?.value ?? r?.brutto ?? r?.bruttolohn ?? r?.val
        );

        // 2) Unit & monthsWorked
        const unit = normalizeUnit(r?.unit ?? r?.einheit ?? r?.periode);

        // monthsWorked:
        // - If the row says "7 Monate gearbeitet", it can come in as monthsWorked/monate/anzahl.
        // - Default to 12 for annual values.
        const monthsWorked = Math.max(
          1,
          Math.min(12, Math.floor(toNumber(r?.monthsWorked ?? r?.monate ?? r?.anzahl) || 12))
        );

        // 3) Year (calendar year) – from explicit fields or from a date-like field.
        const y =
          Math.floor(toNumber(r?.jahr ?? r?.year) || 0) ||
          yearFromDateLike(r?.date ?? r?.datum ?? r?.bookingDate ?? r?.time);
        const calcYear = Number.isFinite(y) && y >= 1900 ? y : new Date().getFullYear();

        // Region (currently only relevant for rent calc West/Ost; SV is mostly meta)
        const region = normalizeRegion(r?.region);

        // If amount missing, keep the row but annotate.
        if (!Number.isFinite(amount)) {
          return {
            ...r,
            __hint: "Bruttolohn enrichment: no numeric amount found (expected betrag/amount/value/brutto).",
          };
        }

        // --- Calculations ------------------------------------------------------
        // Pension: monthly pension amount generated by this income.
        let rente;
        try {
          rente = berechneRente(amount, {
            jahr: calcYear,
            region,
            unit,
            monthsWorked,
          });
        } catch (e) {
          rente = { error: e?.message ?? String(e) };
        }

        // Social contributions: returns month + period.
        let sv;
        try {
          sv = calcSozialabgaben(amount, {
            year: calcYear,
            region,
            unit,
            monthsWorked,
            // Optional per-row overrides if present:
            kvZusatzbeitrag: r?.kvZusatzbeitrag,
            kinderUnter25: r?.kinderUnter25,
            kinderlos: r?.kinderlos,
            sachsen: r?.sachsen,
          });
        } catch (e) {
          sv = { error: e?.message ?? String(e) };
        }

        // --- Derived columns ---------------------------------------------------
        // Convention:
        // - *_monat_EUR: monthly view (month)
        // - *_periode_EUR: totals for the period (period)
        const svMonthAN = sv?.month?.arbeitnehmer?.summe;
        const svMonthAG = sv?.month?.arbeitgeber?.summe;
        const svMonthTotal = sv?.month?.gesamt?.summe;

        const svPeriodAN = sv?.period?.arbeitnehmer?.summe;
        const svPeriodAG = sv?.period?.arbeitgeber?.summe;
        const svPeriodTotal = sv?.period?.gesamt?.summe;

        return {
          ...r,
          // Inputs (normalized)
          jahr: calcYear,
          input_unit: unit,
          input_monthsWorked: monthsWorked,
          input_region: region,

          // Pension
          erarbeiteteRenteMonat_EUR: Number.isFinite(rente?.renteMonat) ? rente.renteMonat : "",
          entgeltpunkte: Number.isFinite(rente?.entgeltpunkte)
            ? roundMaybe(rente.entgeltpunkte, 6)
            : "",

          // Social contributions (month)
          sv_AN_monat_EUR: Number.isFinite(svMonthAN) ? svMonthAN : "",
          sv_AG_monat_EUR: Number.isFinite(svMonthAG) ? svMonthAG : "",
          sv_gesamt_monat_EUR: Number.isFinite(svMonthTotal) ? svMonthTotal : "",

          // Social contributions (period)
          sv_AN_periode_EUR: Number.isFinite(svPeriodAN) ? svPeriodAN : "",
          sv_AG_periode_EUR: Number.isFinite(svPeriodAG) ? svPeriodAG : "",
          sv_gesamt_periode_EUR: Number.isFinite(svPeriodTotal) ? svPeriodTotal : "",

          // Diagnostics (keep separate so users can spot issues)
          __rente_err: rente?.error ?? "",
          __sv_err: sv?.error ?? "",
        };
      });

  const st = (root.__tableState ||= {
    sortKey: null,
    sortDir: "asc",
  });

  renderTable(root, enrichedRows, {
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