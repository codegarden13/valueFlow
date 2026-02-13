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
export function requestRedraw(ctx) {
  console.log("main.js - [requestRedraw] called");

  if (!ctx?.flags) throw new Error("requestRedraw(ctx): ctx.flags missing");

  const flags = ctx.flags;

  // Init Flags (idempotent)
  if (typeof flags.redrawScheduled !== "boolean") flags.redrawScheduled = false;
  if (typeof flags.redrawInFlight !== "boolean") flags.redrawInFlight = false;
  if (typeof flags.redrawNeeded !== "boolean") flags.redrawNeeded = false;

  // Immer: wir brauchen (mindestens) ein Redraw
  flags.redrawNeeded = true;

  // Während Boot nicht rendern – nur merken
  if (flags.ready === false) return;

  // Wenn bereits ein Frame geplant ist, reicht das
  if (flags.redrawScheduled) return;

  flags.redrawScheduled = true;

  requestAnimationFrame(() => {
    // rAF-Planung ist "verbraucht"
    flags.redrawScheduled = false;

    // Wenn Boot zwischenzeitlich wieder gesperrt wurde (sehr selten, aber robust)
    if (flags.ready === false) return;

    // Wenn gerade gerendert wird: wir lassen redrawNeeded=true stehen.
    // Der laufende Render wird am Ende einen neuen Frame anstoßen.
    if (flags.redrawInFlight) return;

    // Snapshot: wir erfüllen jetzt das aktuell bekannte "needed"
    flags.redrawNeeded = false;
    flags.redrawInFlight = true;

    let phase = "init";

    (async () => {
      try {
        phase = "redraw:start";
        await redraw(ctx);
      } catch (err) {
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
      } finally {
        flags.redrawInFlight = false;

        // Falls während des redraw neue Requests kamen:
        // -> im nächsten Frame erneut rendern (coalesced)
        if (flags.redrawNeeded && flags.ready !== false) {
          requestRedraw(ctx);
        }
      }
    })();
  });
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
    initUI(ctx);                  // DOM-Vertrag prüfen
    ctx.ui = wireFilterDropdowns(ctx); // Filter-Events + Render-API
    wireModeAndYears(ctx);        // Mode + Year-Events

    // -------------------------------------------------------------------------
    // Initialer Render
    // -------------------------------------------------------------------------
    ctx.flags.dataDirty = true;   // erzwingt initialen Datenaufbau
    requestRedraw(ctx);
  } catch (e) {
    console.error(e);
    const mountEl = document.getElementById("app");
    if (mountEl) {
      mountEl.innerHTML = `<pre style=\"color:#fff;white-space:pre-wrap\">${String(
        e?.stack || e
      )}</pre>`;
    }
  }
})();