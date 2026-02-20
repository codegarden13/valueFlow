/**
 * ui.js
 * =============================================================================
 * UI-Schicht (Industrial Style)
 * ----------------------------------------------------------------------------
 * Verantwortung (streng):
 * - DOM finden, Events verdrahten
 * - ctx.state NUR durch User-Interaktion ändern
 * - Anzeige NUR aus ctx.derived lesen
 * - KEINE Persistenz
 * - KEINE Datenaggregation
 *
 * Leitprinzip:
 *   state  = User-Intent
 *   derived = Anzeigegrundlage (vom Renderer berechnet)
 * =============================================================================
 */

// =============================================================================
// 1) Mini-Helper
// =============================================================================

export function htmlEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.appendChild(c);
  return el;
}

// =============================================================================
// 2) DOM Lookup (fail fast, alles required)
// =============================================================================

export function initUI(ctx) {
  if (!ctx) throw new Error("initUI(ctx): ctx missing");
  if (!ctx.dom) ctx.dom = {};

  const MAP = {
    app: "mountEl",
    panel: "panel",
    subtitle: "subtitleEl",

    srcBtn: "srcBtn",
    srcAllBtn: "srcAllBtn",
    srcList: "srcList",

    typeBtn: "typeBtn",
    typeAllBtn: "typeAllBtn",
    typeResetBtn: "typeResetBtn",
    typeList: "typeList",

    catBtn: "catBtn",
    catAllBtn: "catAllBtn",
    catResetBtn: "catResetBtn",
    catList: "catList",

    modeSelect: "modeSelect",
    legend: "legendEl",
    chartSvg: "svgEl",

    yearFrom: "yearFromInput",
    yearTo: "yearToInput",
   
  };

  for (const [id, key] of Object.entries(MAP)) {
    const el = document.getElementById(id);

    // Reset buttons are optional (not every layout has them)
    const isOptional = id.endsWith("ResetBtn");
    if (!el) {
      if (isOptional) {
        ctx.dom[key] = null;
        continue;
      }
      throw new Error(`initUI: missing DOM element #${id}`);
    }

    ctx.dom[key] = el;
  }
}

// =============================================================================
// 3) Dropdown Renderer (rein visuell, KEIN State-Wissen)
// =============================================================================

function renderMultiCheckboxDropdown({
  btn,
  list,
  label,
  values,
  isChecked,
  onToggle,
  formatValue,
}) {
  const fmt = typeof formatValue === "function" ? formatValue : (v) => String(v);

  // Button-Text: wie bei Kategorien -> "x von y" (oder "alle")
  const checkedCount = values.filter((v) => isChecked(v)).length;
  btn.textContent =
    values.length === 0
      ? `${label}: –`
      : checkedCount === values.length
        ? `${label}: alle`
        : `${label}: ${checkedCount} von ${values.length}`;

  // Liste
  list.innerHTML = "";
  for (const v of values) {
    const row = document.createElement("label");
    row.className = "dropdown-item d-flex align-items-center gap-2";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "form-check-input m-0";
    cb.checked = isChecked(v);

    cb.addEventListener("change", () => {
      onToggle(v, cb.checked);
    });

    row.appendChild(cb);
    row.appendChild(document.createTextNode(fmt(v)));
    list.appendChild(row);
  }
}

// =============================================================================
// 4) Filter-Dropdowns (State-Wiring)
// =============================================================================

export function wireFilterDropdowns(ctx) {
  if (!ctx?.state) throw new Error("wireFilterDropdowns: ctx.state missing");
  if (!ctx?.dom) throw new Error("wireFilterDropdowns: ctx.dom missing");

  // Idempotenz: UI-Wiring darf NICHT mehrfach passieren (sonst Redraw-/Transition-Stürme).
  // Falls initUI / wire* versehentlich mehrfach aufgerufen wird, verhindern wir doppelte Listener.
  if (ctx.__uiWiredFilterDropdowns_v1) {
    return ctx.__uiWiringApiFilterDropdowns_v1;
  }
  ctx.__uiWiredFilterDropdowns_v1 = true;

  const rr = typeof ctx.requestRedraw === "function" ? ctx.requestRedraw : null;

  // ---------------------------------------------------------------------------
  // Semantik (konsistent, ohne Persistenz)
  // - enabled* ist ein Set
  // - leeres Set => ALLE (kompakt)
  // ---------------------------------------------------------------------------

  const ensureSet = (v) => (v instanceof Set ? v : new Set());

  // Quellen (data rebuild)
  const setAllSources = () => {
    ctx.state.enabledSourceIds = new Set(); // empty => ALL
    ctx.flags.dataDirty = true;
    rr?.(ctx);
  };
  ctx.dom.srcAllBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAllSources();
  });

  // Typen (view-only; wenn du Types als rebuild nutzt, setze dataDirty=true)
  const setAllTypes = () => {
    ctx.state.enabledTypes = new Set(); // empty => ALL
    rr?.(ctx);
  };
  ctx.dom.typeAllBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAllTypes();
  });
  ctx.dom.typeResetBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAllTypes();
  });

  // Kategorien (view-only, gesteuert über disabledCats)
  if (!(ctx.state.disabledCats instanceof Set)) ctx.state.disabledCats = new Set();
  const setAllCats = () => {
    ctx.state.disabledCats = new Set(); // NONE disabled => ALL enabled
    rr?.(ctx);
  };
  ctx.dom.catAllBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAllCats();
  });
  ctx.dom.catResetBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setAllCats();
  });

  // API für Renderer (wird auf ctx gecached, damit Re-Wiring stabil bleibt)
  const api = {
    renderOptions(options) {
      if (!options) throw new Error("UI: renderOptions without options");
      const { sources, types, cats } = options;

      if (!Array.isArray(sources)) throw new Error("UI: options.sources invalid");
      if (!Array.isArray(types)) throw new Error("UI: options.types invalid");
      if (!Array.isArray(cats)) throw new Error("UI: options.cats invalid");

      // Quellen: IMMER voller Universe aus Config (sonst verschwinden abgewählte Quellen)
      const cfgSources = Array.isArray(ctx.config?.sources) ? ctx.config.sources : [];
      const srcValues = cfgSources
        .map((s) => String(s?.id ?? "").trim())
        .filter(Boolean);

      const labelById = new Map(
        cfgSources
          .map((s) => [String(s?.id ?? "").trim(), String(s?.label || s?.name || s?.caption || s?.id || "").trim()])
          .filter(([id]) => !!id)
      );

      const srcEnabled = ensureSet(ctx.state.enabledSourceIds);

      renderMultiCheckboxDropdown({
        btn: ctx.dom.srcBtn,
        list: ctx.dom.srcList,
        label: "Quellen",
        values: srcValues,
        formatValue: (id) => labelById.get(String(id)) || String(id),

        // Semantik: enabledSourceIds: empty Set => ALL
        isChecked: (id) => (srcEnabled.size === 0 ? true : srcEnabled.has(String(id))),

        onToggle: (id, checked) => {
          const idStr = String(id);
          // Current enabled set (empty => ALL)
          const cur = srcEnabled.size === 0 ? new Set(srcValues) : new Set(srcEnabled);
          // Apply the intended toggle
          if (checked) cur.add(idStr);
          else cur.delete(idStr);
          // Invariant: mindestens 1 Quelle muss aktiv bleiben
          if (cur.size === 0) {
            ctx.requestRedraw?.(ctx);
            return;
          }
          // Compress: if effectively ALL selected => store empty
          ctx.state.enabledSourceIds = cur.size === srcValues.length ? new Set() : cur;
          ctx.flags.dataDirty = true;
          ctx.requestRedraw?.(ctx);
        },
      });

      // Typen: Universe NUR aus options.types
      const typeEnabled = ensureSet(ctx.state.enabledTypes);
      // Universe: strikt aus options.types
      const typeValues = Array.from(
        new Set((types || []).map((t) => String(t ?? "").trim()).filter(Boolean))
      );
      renderMultiCheckboxDropdown({
        btn: ctx.dom.typeBtn,
        list: ctx.dom.typeList,
        label: "Typen",
        values: typeValues,
        // Semantik: enabledTypes: empty Set => ALL
        isChecked: (t) => (typeEnabled.size === 0 ? true : typeEnabled.has(String(t))),
        onToggle: (t, checked) => {
          const tStr = String(t);
          const cur = typeEnabled.size === 0 ? new Set(typeValues) : new Set(typeEnabled);
          if (checked) cur.add(tStr);
          else cur.delete(tStr);
          ctx.state.enabledTypes = cur.size === typeValues.length ? new Set() : cur;
          ctx.requestRedraw?.(ctx);
        },
      });

      // Kategorien: Steuerung über disabledCats
      if (!(ctx.state.disabledCats instanceof Set)) ctx.state.disabledCats = new Set();
      const disabledCats = ctx.state.disabledCats;
      const catValues = Array.from(new Set((cats || []).map((c) => String(c))));
      renderMultiCheckboxDropdown({
        btn: ctx.dom.catBtn,
        list: ctx.dom.catList,
        label: "Kategorien",
        values: catValues,
        // disabledCats: empty => NONE disabled (ALL enabled)
        isChecked: (c) => !disabledCats.has(String(c)),
        onToggle: (c, checked) => {
          const cStr = String(c);
          if (checked) disabledCats.delete(cStr);
          else disabledCats.add(cStr);
          ctx.requestRedraw(ctx);
        },
      });
    },
  };

  ctx.__uiWiringApiFilterDropdowns_v1 = api;
  return api;
}

// =============================================================================
// 5) Year Range + Mode
// =============================================================================

export function wireModeAndYears(ctx) {
  if (!ctx?.state) throw new Error("wireModeAndYears: ctx.state missing");
  if (!ctx?.dom) throw new Error("wireModeAndYears: ctx.dom missing");

  // Idempotenz: verhindert mehrfach registrierte Listener (führt sonst zu Zittern/Redraw-Loops).
  if (ctx.__uiWiredModeAndYears_v1) return;
  ctx.__uiWiredModeAndYears_v1 = true;

  const rr = typeof ctx.requestRedraw === "function" ? ctx.requestRedraw : null;

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------
  const modeEl = ctx.dom.modeSelect;
  if (modeEl) {
    modeEl.addEventListener("change", () => {
      // State = User-Intent (Renderer entscheidet über Darstellung)
      ctx.state.mode = modeEl.value === "menge" ? "menge" : "kosten";
      rr?.(ctx);
    });
  }

  // ---------------------------------------------------------------------------
  // Year range
  // Contract:
  // - input  : live state update (scrubbing), KEIN redraw hier
  // - commit : einmal redraw (on release / commit)
  // - invariant: yearFrom <= yearTo
  // ---------------------------------------------------------------------------
  const fromEl = ctx.dom.yearFromInput;
  const toEl = ctx.dom.yearToInput;
  if (!fromEl || !toEl) return;

  // Helper: clamp to current DOM min/max if present
  const clampToDom = (v, el) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return n;
    const min = Number(el.min);
    const max = Number(el.max);
    let out = n;
    if (Number.isFinite(min)) out = Math.max(min, out);
    if (Number.isFinite(max)) out = Math.min(max, out);
    return out;
  };

  const normalizeYears = () => {
    let yf = clampToDom(fromEl.value, fromEl);
    let yt = clampToDom(toEl.value, toEl);

    if (!Number.isFinite(yf)) yf = Number(ctx.state.yearFrom);
    if (!Number.isFinite(yt)) yt = Number(ctx.state.yearTo);

    // Swap if crossed
    if (Number.isFinite(yf) && Number.isFinite(yt) && yf > yt) {
      const tmp = yf;
      yf = yt;
      yt = tmp;
    }

    if (Number.isFinite(yf)) ctx.state.yearFrom = Math.trunc(yf);
    if (Number.isFinite(yt)) ctx.state.yearTo = Math.trunc(yt);
  };

  const markScrubbing = () => {
    // Renderer/Timing können dies nutzen, um Animation während Drag zu deaktivieren.
    ctx.state.isScrubbingYears = true;
  };

  const commit = () => {
    ctx.state.isScrubbingYears = false;
    normalizeYears();
    rr?.(ctx);
  };

  // Live state update while dragging (no redraw storm)
  fromEl.addEventListener("input", () => {
    markScrubbing();
    ctx.state.yearFrom = Math.trunc(clampToDom(fromEl.value, fromEl));
  });

  toEl.addEventListener("input", () => {
    markScrubbing();
    ctx.state.yearTo = Math.trunc(clampToDom(toEl.value, toEl));
  });

  // Commit on release / commit
  // Note: bei type=range feuert change i.d.R. beim Loslassen;
  // bei type=number eher bei Blur/Enter (immer noch ok).
  fromEl.addEventListener("change", commit);
  toEl.addEventListener("change", commit);

  // Zusätzliche Commit-Signale für "release" (robust gegen unterschiedliche Input-Typen)
  fromEl.addEventListener("pointerup", commit);
  toEl.addEventListener("pointerup", commit);
  fromEl.addEventListener("keyup", (e) => {
    if (e.key === "Enter") commit();
  });
  toEl.addEventListener("keyup", (e) => {
    if (e.key === "Enter") commit();
  });
}

// =============================================================================
// 6) UI Sync (State -> DOM, KEIN Render)
// =============================================================================

export function syncUIFromState(ctx) {
  if (!ctx?.state || !ctx?.dom) return;

  ctx.dom.modeSelect.value =
    ctx.state.mode === "menge" ? "menge" : "kosten";

  // KEIN slider min/max hier
}


// -----------------------------------------------------------------------------
// Derived -> DOM sync (Domains, slider min/max)
// -----------------------------------------------------------------------------
// Contract:
// - Called AFTER computeDerived (options is required)
// - Uses ONLY options.yearDomain for slider min/max
// - Mirrors slider values from ctx.state.yearFrom/yearTo (state is source of truth)
export function syncUIFromDerived(ctx, options) {
  const fromEl = ctx?.dom?.yearFromInput;
  const toEl = ctx?.dom?.yearToInput;
  const dom = options?.yearDomain;

  if (!fromEl || !toEl || !dom) return;

  const minY = Number(dom.minY);
  const maxY = Number(dom.maxY);
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY) return;

  // Domain (min/max)
  fromEl.min = String(minY);
  fromEl.max = String(maxY);
  toEl.min = String(minY);
  toEl.max = String(maxY);

  // State defaults + clamp
  const s = ctx.state;
  if (!Number.isFinite(s.yearFrom)) s.yearFrom = minY;
  if (!Number.isFinite(s.yearTo)) s.yearTo = maxY;

  s.yearFrom = Math.max(minY, Math.min(maxY, Number(s.yearFrom)));
  s.yearTo = Math.max(minY, Math.min(maxY, Number(s.yearTo)));
  if (s.yearFrom > s.yearTo) [s.yearFrom, s.yearTo] = [s.yearTo, s.yearFrom];

  // Values mirror from state
  fromEl.value = String(s.yearFrom);
  toEl.value = String(s.yearTo);
}

// =============================================================================
// 7) Subtitle
// =============================================================================

/**
 * renderSubtitle(ctx)
 * -----------------------------------------------------------------------------
 * Renders a compact status line that ALWAYS reflects the current filtered view
 * (incl. type/source/category filters), not just the year-range sliders.
 *
 * Contract:
 * - Uses ctx.derived.aggregates.bars as source of truth for visible years.
 * - Uses ctx.derived.aggregates.visibleCats (and ctx.state.disabledCats) for cats.
 * - Uses ctx.derived.aggregates.totalsByYear or totalsByCat for net.
 */
export function renderSubtitle(ctx) {
  const el = ctx?.dom?.subtitleEl;
  const ag = ctx?.derived?.aggregates;

  if (!el || !ag) {
    if (el) el.textContent = "";
    return;
  }

  const parts = [];

  // ---------------------------------------------------------------------------
  // 1) Visible years (from filtered aggregates)
  // ---------------------------------------------------------------------------
  const years = getVisibleYearsFromAggregates(ag);

  // Prefer "visible years" over slider range, but keep slider range as fallback
  const yf = toFiniteInt(ctx?.state?.yearFrom);
  const yt = toFiniteInt(ctx?.state?.yearTo);

  if (years.length) {
    const minY = years[0];
    const maxY = years[years.length - 1];
    parts.push(minY === maxY ? `Jahr: ${minY}` : `Jahre: ${minY}–${maxY}`);
  } else if (yf != null && yt != null) {
    parts.push(yf === yt ? `Jahr: ${yf}` : `Jahre: ${yf}–${yt}`);
  }

  // ---------------------------------------------------------------------------
  // 2) Enabled categories (visibleCats minus disabledCats)
  // ---------------------------------------------------------------------------
  const visCats = Array.isArray(ag?.visibleCats) ? ag.visibleCats : [];
  const disabledCats = ctx?.state?.disabledCats instanceof Set ? ctx.state.disabledCats : new Set();

  const enabledCats = visCats
    .filter((c) => typeof c === "string" && c.length)
    .filter((c) => !disabledCats.has(c));

  const MAX_CATS = 6;
  if (enabledCats.length) {
    const head = enabledCats.slice(0, MAX_CATS);
    const more = enabledCats.length - head.length;
    const catsLabel = more > 0 ? `${head.join(", ")} +${more}` : head.join(", ");
    parts.push(`Kategorien: ${catsLabel}`);
  }

  // ---------------------------------------------------------------------------
  // 3) Net total (signed, current mode)
  // ---------------------------------------------------------------------------
  const mode = ctx?.state?.mode === "menge" ? "menge" : "kosten";
  const net = sumMapValues(ag?.totalsByYear ?? ag?.totalsByCat);

  if (mode === "kosten") {
    parts.push(`Netto: ${formatEUR(net)}`);
  } else {
    parts.push(`Netto: ${formatNumber(net)}`);
  }

  el.textContent = parts.filter(Boolean).join(" · ");
}

/* =============================================================================
   Helpers
============================================================================= */

function getVisibleYearsFromAggregates(ag) {
  const bars = Array.isArray(ag?.bars) ? ag.bars : [];
  if (!bars.length) return [];

  const set = new Set();
  for (const b of bars) {
    // canonical: bar.year is number|null (undated => null)
    const y = b?.year;
    if (Number.isFinite(y)) set.add(Number(y));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function toFiniteInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function sumMapValues(m) {
  if (!(m instanceof Map)) return 0;
  let s = 0;
  for (const v of m.values()) {
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

function formatEUR(n) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

function formatNumber(n) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

/*setCtxTabUI(ctx) macht DOM-Queries (getElementById) und beschriftet ein Tab-UI-Element*/

export function setCtxTabUI(ctx) {
  const btn = document.getElementById("ctxTab");
  if (!btn) return;

  const mode = ctx?.state?.mode === "menge" ? "Menge" : "Kosten";

  // Prefer the effective visible year range from state (already clamped in computeDerived)
  const yf = Number(ctx?.state?.yearFrom);
  const yt = Number(ctx?.state?.yearTo);

  // Fallback: keep template label if we don't have a sane range
  if (!Number.isFinite(yf) || !Number.isFinite(yt)) {
    btn.textContent = "CTX - Kontext";
    return;
  }

  const y0 = Math.min(yf, yt);
  const y1 = Math.max(yf, yt);
  const range = y0 === y1 ? String(y0) : `${y0}–${y1}`;

  btn.textContent = `CTX (${range}, ${mode})`;
  try {
    btn.title = `Kontext-Tabelle: ${range} / ${mode}`;
  } catch {
    // ignore
  }
}
