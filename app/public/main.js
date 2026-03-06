// main.js
// =============================================================================
// Orchestrierung (Industrial Style)
// =============================================================================
// Verantwortung:
// - Boot der Applikation
// - Initialisierung von UI und Renderer
// - Zentrale Redraw-Koordination (Coalescing)
//
// Architektur:
// - Renderer ist der EINZIGE Ort, der rendert
// - UI liefert nur Events + Render-API
// - Keine Persistenz, kein impliziter State
// =============================================================================

console.log("[BOOT] main.js loaded");

import { boot } from "/assets/js/app-boot.js";
import { initUI, wireFilterDropdowns, wireModeAndYears } from "/assets/js/ui.js";
import { createRenderer } from "/assets/js/renderer.js";

// -----------------------------------------------------------------------------
// Renderer initialisieren
// -----------------------------------------------------------------------------
const { redraw } = createRenderer();

// -----------------------------------------------------------------------------
// Redraw-Coalescing (UI-Event-Stürme vermeiden)
// -----------------------------------------------------------------------------
// Regeln:
// - Während Boot/Wiring wird nur "needed" markiert, nicht gerendert
// - Parallele Redraws werden zusammengefasst
// - Render immer im nächsten Animation-Frame
function getFlags(ctx) {
  if (!ctx || !ctx.flags) {
    throw new Error("requestRedraw(ctx): ctx.flags missing");
  }
  return ctx.flags;
}

function initRedrawFlags(flags) {
  if (typeof flags.redrawScheduled !== "boolean") flags.redrawScheduled = false;
  if (typeof flags.redrawInFlight !== "boolean") flags.redrawInFlight = false;
  if (typeof flags.redrawNeeded !== "boolean") flags.redrawNeeded = false;
}

function logRedrawError(ctx, phase, err) {
  console.groupCollapsed(
    `%credraw(ctx) failed in phase: ${phase}`,
    "color:#d92d20;font-weight:700"
  );
  console.error(err);
  console.error("stack:", err?.stack || "(no stack)");
  console.log("phase:", phase);
  console.log("ctx.flags:", ctx.flags);
  console.log("ctx.state:", ctx.state);
  console.log("ctx.data:", ctx.data);
  console.log("ctx.dataAll:", ctx.dataAll);
  console.log("ctx.derived:", ctx.derived);
  console.groupEnd();
}

async function runRedraw(ctx, flags) {
  const phase = "redraw:start";

  try {
    await redraw(ctx);
  } catch (err) {
    logRedrawError(ctx, phase, err);
  } finally {
    flags.redrawInFlight = false;

    if (flags.redrawNeeded && flags.ready !== false) {
      requestRedraw(ctx);
    }
  }
}

function scheduleRedraw(ctx, flags) {
  flags.redrawScheduled = true;

  requestAnimationFrame(() => {
    flags.redrawScheduled = false;

    if (flags.ready === false) return;
    if (flags.redrawInFlight) return;

    flags.redrawNeeded = false;
    flags.redrawInFlight = true;

    runRedraw(ctx, flags);
  });
}

export function requestRedraw(ctx) {
  console.log("main.js - [requestRedraw] called");

  const flags = getFlags(ctx);
  initRedrawFlags(flags);

  flags.redrawNeeded = true;

  if (flags.ready === false) return;
  if (flags.redrawScheduled) return;

  scheduleRedraw(ctx, flags);
}

// -----------------------------------------------------------------------------
// Boot-Sequenz
// -----------------------------------------------------------------------------
(async () => {
  try {
    // Boot erstellt ctx inkl. flags/state/config
    // ctx.flags.ready wird intern von boot gesteuert
    const ctx = await boot({ requestRedraw });

    // Redraw-Funktion explizit im Context ablegen
    ctx.requestRedraw = requestRedraw;

    // -------------------------------------------------------------------------
    // UI initialisieren (fail fast)
    // -------------------------------------------------------------------------
    initUI(ctx); // DOM-Vertrag prüfen
    ctx.ui = wireFilterDropdowns(ctx); // Filter-Events + Render-API
    wireModeAndYears(ctx); // Mode + Year-Events

    // -------------------------------------------------------------------------
    // Initialer Render
    // -------------------------------------------------------------------------
    ctx.flags.dataDirty = true; // erzwingt initialen Datenaufbau
    requestRedraw(ctx);
  } catch (e) {
    console.error(e);
    const mountEl = document.getElementById("app");
    if (mountEl) {
      mountEl.innerHTML = `<pre style="color:#fff;white-space:pre-wrap">${String(
        e?.stack || e
      )}</pre>`;
    }
  }
})();