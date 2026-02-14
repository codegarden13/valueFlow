/**
 * categoryInspector.js
 * =============================================================================
 * Renders the Category Inspector (details table) into a host element.
 *
 * Public API:
 *   const insp = createCategoryInspector(ctx, { hostId });
 *   insp.update(payload)   // payload from chart hover (expects payload.cat)
 *   insp.clear()
 *
 * Notes:
 * - This module is UI-only and must not mutate derived data.
 * - It is tolerant to host/title elements missing (no-throw), but is strict about ctx.
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// 1) Small utils
// -----------------------------------------------------------------------------
const HTML_ESCAPES = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#039;"],
];

function escapeHtml(v) {
  let s = String(v ?? "");
  for (const [a, b] of HTML_ESCAPES) s = s.replaceAll(a, b);
  return s;
}

function elById(id) {
  const k = String(id || "").trim();
  return k ? document.getElementById(k) : null;
}

function coerceDetailsByKey(detailsByKey) {
  if (detailsByKey instanceof Map) return detailsByKey;
  if (detailsByKey && typeof detailsByKey === "object") {
    const m = new Map();
    for (const k of Object.keys(detailsByKey)) m.set(k, detailsByKey[k]);
    return m;
  }
  return new Map();
}

/**
 * Normalizes yearKey, cat, typ to a detailsByKey key: `${y}||${c}||${t}`.
 * All parts to String, fallback "?" for empty/undefined.
 */
function makeDetailsKey(yearKey, cat, typ) {
  const y = yearKey == null || yearKey === "" ? "?" : String(yearKey);
  const c = cat == null || cat === "" ? "?" : String(cat);
  const t = typ == null || typ === "" ? "?" : String(typ);
  return `${y}||${c}||${t}`;
}

function getSourceLabel(ctx, sourceId) {
  const id = String(sourceId ?? "").trim();
  if (!id) return "";

  const sources = Array.isArray(ctx?.config?.sources) ? ctx.config.sources : null;
  const cfg = sources ? sources.find((s) => s?.id === id) : null;
  return String(cfg?.label || cfg?.name || id);
}

// -----------------------------------------------------------------------------
// 2) Title / legacy hooks
// -----------------------------------------------------------------------------
// Older layouts used a Bootstrap accordion title element. New layouts may not.
// Keep this tolerant: set if present, otherwise ignore.
function setInspectorTitle(category, hint = "", titleElId = "tooltipAccTitle") {
  const titleEl = elById(titleElId);
  if (!titleEl) return;
  const base = String(category || "Kategorie");
  titleEl.textContent = hint ? `${base} ${hint}` : base;
}


// -----------------------------------------------------------------------------
// 3) Rendering
// -----------------------------------------------------------------------------
const HIDDEN_KEYS = new Set(["_cat", "_typ", "_isUndated"]);

function renderInspectorTable({ category, columns, rows, meta = {} }) {
  const safeCat = escapeHtml(category || "");

  if (!rows || !rows.length) {
    return `<div class="inspector__empty">Keine Daten für ${safeCat}</div>`;
  }

  const thead = `
    <thead>
      <tr>
        ${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}
      </tr>
    </thead>
  `;

  // data attributes for future click-selection wiring
  const tbody = `
    <tbody>
      ${rows
        .map((row, i) => {
          const key = row?._key != null ? String(row._key) : "";
          const detailId = row?._detailId != null ? String(row._detailId) : "";
          const attrs = [
            `data-row-index="${i}"`,
            key ? `data-key="${escapeHtml(key)}"` : "",
            detailId ? `data-detail-id="${escapeHtml(detailId)}"` : "",
          ]
            .filter(Boolean)
            .join(" ");

          return `
            <tr ${attrs}>
              ${columns.map((c) => `<td>${escapeHtml(row?.[c] ?? "")}</td>`).join("")}
            </tr>
          `;
        })
        .join("")}
    </tbody>
  `;

  const hint = meta?.hint ? `<div class="category-inspector__hint">${escapeHtml(meta.hint)}</div>` : "";

  return `
    <div class="category-inspector" data-category="${safeCat}">
      ${hint}
      <div class="category-inspector__tableWrap">
        <table class="table table-sm mb-0 table--as400">
          ${thead}
          ${tbody}
        </table>
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// 4) Data collection
// -----------------------------------------------------------------------------
function collectCategoryRows(ctx, payload) {
  const cat = String(payload?.cat || "");
  const yearKeyPayload = payload?.yearKey ?? payload?.year ?? payload?.Jahr;
  const typPayloadRaw = payload?.typ ?? payload?.type;
  const typPayload = typPayloadRaw == null || typPayloadRaw === "" ? null : String(typPayloadRaw);
  const includePrevYears = payload?.includePrevYears !== false;

  const enabledSources =
    ctx?.state?.enabledSourceIds instanceof Set && ctx.state.enabledSourceIds.size
      ? ctx.state.enabledSourceIds
      : null;

  const enabledTypes =
    ctx?.state?.enabledTypes instanceof Set && ctx.state.enabledTypes.size
      ? ctx.state.enabledTypes
      : null;

  const yf = Number(ctx?.state?.yearFrom);
  const yt = Number(ctx?.state?.yearTo);

  const view = ctx?.derived?.view;
  const undatedLabel = String(view?.undatedLabel || "Undatiert");
  const details = coerceDetailsByKey(view?.detailsByKey);

  const out = [];

  // --- Fast-path: chart hover provides a yearKey. We only collect rows for that slice.
  const hasYearKey = yearKeyPayload != null && String(yearKeyPayload) !== "";
  if (hasYearKey) {
    const yKey = String(yearKeyPayload);
    const isUndatedHover = yKey === undatedLabel;
    const targetYearNum = !isUndatedHover ? Number(yKey) : NaN;

    // Guard: if hovered year itself is outside global range, return empty
    if (!isUndatedHover) {
      const y = targetYearNum;
      if (Number.isFinite(yf) && Number.isFinite(y) && y < yf) {
        return { category: cat, columns: [], rows: [], total: 0, yearKey: yKey, typ: typPayload };
      }
      if (Number.isFinite(yt) && Number.isFinite(y) && y > yt) {
        return { category: cat, columns: [], rows: [], total: 0, yearKey: yKey, typ: typPayload };
      }
    }

    // -----------------------------------------------------------------
    // Enriched timeline: current year + all previous years (default)
    // -----------------------------------------------------------------
    if (includePrevYears) {
      for (const [key, arr] of details.entries()) {
        const [kYearKey, kCat, kTyp] = String(key).split("||");
        if (kCat !== cat) continue;

        if (typPayload && kTyp !== typPayload) continue;
        if (enabledTypes && !enabledTypes.has(kTyp)) continue;

        const isUndatedRow = kYearKey === undatedLabel;

        if (!isUndatedRow) {
          const y = Number(kYearKey);

          if (!Number.isFinite(targetYearNum) || !Number.isFinite(y)) {
            if (kYearKey !== yKey) continue;
          } else {
            if (y > targetYearNum) continue;
          }

          if (Number.isFinite(yf) && Number.isFinite(y) && y < yf) continue;
          if (Number.isFinite(yt) && Number.isFinite(y) && y > yt) continue;
        }

        const rows = Array.isArray(arr) ? arr : [];
        for (const r of rows) {
          const sourceId = String(r?.Quelle ?? r?.sourceId ?? "");
          if (enabledSources && sourceId && !enabledSources.has(sourceId)) continue;

          const QuelleName = getSourceLabel(ctx, sourceId);

          out.push({
            ...r,
            QuelleName,
            _key: key,
            _sliceYearKey: kYearKey,
            _isCurrentYear: kYearKey === yKey,
          });
        }
      }

    } else {
      // Strict slice: only hovered year
      if (typPayload) {
        if (enabledTypes && !enabledTypes.has(typPayload)) {
          return { category: cat, columns: [], rows: [], total: 0, yearKey: yKey, typ: typPayload };
        }

        const key = makeDetailsKey(yKey, cat, typPayload);
        const arr = details.get(key);
        const rows = Array.isArray(arr) ? arr : [];

        for (const r of rows) {
          const sourceId = String(r?.Quelle ?? r?.sourceId ?? "");
          if (enabledSources && sourceId && !enabledSources.has(sourceId)) continue;

          const QuelleName = getSourceLabel(ctx, sourceId);
          out.push({
            ...r,
            QuelleName,
            _key: key,
            _sliceYearKey: yKey,
            _isCurrentYear: true,
          });
        }
      } else {
        const prefix = `${yKey}||${cat}||`;
        for (const [key, arr] of details.entries()) {
          if (!String(key).startsWith(prefix)) continue;

          const parts = String(key).split("||");
          const kTyp = parts[2] ?? "?";
          if (enabledTypes && !enabledTypes.has(kTyp)) continue;

          const rows = Array.isArray(arr) ? arr : [];
          for (const r of rows) {
            const sourceId = String(r?.Quelle ?? r?.sourceId ?? "");
            if (enabledSources && sourceId && !enabledSources.has(sourceId)) continue;

            const QuelleName = getSourceLabel(ctx, sourceId);
            out.push({
              ...r,
              QuelleName,
              _key: key,
              _sliceYearKey: yKey,
              _isCurrentYear: true,
            });
          }
        }
      }
    }

  } else {
    // --- Fallback: legacy callers only provide cat (and optionally typ). Preserve old behavior.
    for (const [key, arr] of details.entries()) {
      const [yearKey, kCat, kTyp] = String(key).split("||");
      if (kCat !== cat) continue;
      if (typPayload && kTyp !== typPayload) continue;
      if (enabledTypes && !enabledTypes.has(kTyp)) continue;

      const isUndated = yearKey === undatedLabel;
      if (!isUndated) {
        const y = Number(yearKey);
        if (Number.isFinite(yf) && Number.isFinite(y) && y < yf) continue;
        if (Number.isFinite(yt) && Number.isFinite(y) && y > yt) continue;
      }

      const rows = Array.isArray(arr) ? arr : [];
      for (const r of rows) {
        const sourceId = String(r?.Quelle ?? r?.sourceId ?? "");
        if (enabledSources && sourceId && !enabledSources.has(sourceId)) continue;

        const QuelleName = getSourceLabel(ctx, sourceId);
        out.push({ ...r, QuelleName, _key: key });
      }
    }
  }

  // Column order: prefer Quelle, QuelleName, then stable remaining keys of first row.
  const first = out[0] || null;
  const baseKeys = first ? Object.keys(first).filter((k) => !HIDDEN_KEYS.has(k) && !k.startsWith("_")) : [];

  const cols = [];
  if (baseKeys.includes("Quelle")) cols.push("Quelle");
  if (!cols.includes("QuelleName")) cols.push("QuelleName");
  for (const k of baseKeys) {
    if (k === "Quelle" || k === "QuelleName") continue;
    cols.push(k);
  }

  // Stable sort by source label, then by year key (if present), then by Betrag (if present)
  out.sort((a, b) => {
    const sa = String(a?.QuelleName || a?.Quelle || "");
    const sb = String(b?.QuelleName || b?.Quelle || "");
    const c = sa.localeCompare(sb, "de");
    if (c) return c;

    const ya = String(a?.Jahr ?? a?.year ?? "");
    const yb = String(b?.Jahr ?? b?.year ?? "");
    const cy = ya.localeCompare(yb, "de");
    if (cy) return cy;

    const ba = Number(a?.Betrag ?? a?.amount ?? NaN);
    const bb = Number(b?.Betrag ?? b?.amount ?? NaN);
    if (Number.isFinite(ba) && Number.isFinite(bb)) return bb - ba;
    return 0;
  });

  const LIMIT = 500;
  const limited = out.length > LIMIT ? out.slice(0, LIMIT) : out;

  return { category: cat, columns: cols, rows: limited, total: out.length, yearKey: hasYearKey ? String(yearKeyPayload) : null, typ: typPayload };
}

// -----------------------------------------------------------------------------
// 5) Public API
// -----------------------------------------------------------------------------
export function createCategoryInspector(
  ctx,
  {
    hostId = "categoryInspector",
    titleElId = "tooltipAccTitle",
  } = {}
) {
  if (!ctx) throw new Error("createCategoryInspector: ctx missing");

  const host = () => elById(hostId);

  function clear() {
    const el = host();
    if (!el) return;
    el.innerHTML = "";
    setInspectorTitle("Kategorie", "", titleElId);
  }

  function update(payload) {
    const el = host();
    if (!el) return;

    if (!payload || typeof payload !== "object" || !payload.cat) {
      clear();
      return;
    }

    const { category, columns, rows, total, yearKey, typ } = collectCategoryRows(ctx, payload);

    const includePrevYears = payload?.includePrevYears !== false;

    const limitHint = total > rows.length ? `${rows.length}/${total}` : "";
    const sliceHintParts = [];
    if (yearKey) sliceHintParts.push(includePrevYears ? `≤ ${yearKey}` : String(yearKey));
    if (typ) sliceHintParts.push(String(typ));

    const sliceHint = sliceHintParts.length ? sliceHintParts.join(" · ") : "";
    const hint = [sliceHint, limitHint].filter(Boolean).join(" — ");

    el.innerHTML = renderInspectorTable({ category, columns, rows, meta: { hint } });

    setInspectorTitle(category, hint, titleElId);
  }

  return { update, clear };
}