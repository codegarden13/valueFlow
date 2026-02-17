// timing.js
// -----------------------------------------------------------------------------
// BPM + musical grid timing utilities (browser-side)
// Goal: drive ALL UI animations/transitions from a single musical clock.
// - Supports BPM, timeSignature (e.g. "4/4"), note values (e.g. "1/4", "1/8T"),
//   swing/shuffle, quantization, and pattern scheduling.
// - Designed to be used by chart.js + legend.js (and any other renderer).
//
// Assumptions:
// - config is available as: state.config or window.__APP_CONFIG__
// - config.timing can look like:
//   {
//     bpm: 120,
//     timeSignature: "4/4",
//     chart: { length: "1/1" },          // 1 bar (whole note) or "1/4" etc
//     legend: { factor: 4 },             // x chart duration
//     quantize: "1/8",                   // default grid
//     swing: 0.0                         // 0..0.5 typical
//   }
//
// NOTE VALUE SYNTAX
// - "1/4"  = quarter note
// - "1/8"  = eighth note
// - "1/16" = sixteenth note
// - "1/8T" = eighth-note triplet (÷3/2)  (T suffix)
// - "1/8D" = dotted eighth (×1.5)        (D suffix)
// - "2" or "2/1" also works (whole-number notes) as "2/1"
//
// PATTERN SYNTAX (for scheduling state changes)
// - Array of steps: [{ at:"1/8", do: fn }, ...] relative to pattern start
// - Or simple strings: ["tick","-","-","accent"] with grid = "1/8"
//   where mapping decides what to do per token.
// -----------------------------------------------------------------------------


// =============================================================================
// 1) Config access (single source)
// =============================================================================

export function timingOf(state) {
  return state?.config?.timing || window.__APP_CONFIG__?.timing || {};
}

// =============================================================================
// 2) Parsing helpers
// =============================================================================

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseTimeSignature(ts) {
  // "4/4" -> { beatsPerBar:4, beatUnit:4 }
  const s = String(ts || "4/4").trim();
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { beatsPerBar: 4, beatUnit: 4 };
  const beatsPerBar = Math.max(1, parseInt(m[1], 10));
  const beatUnit = Math.max(1, parseInt(m[2], 10));
  return { beatsPerBar, beatUnit };
}

function parseNoteValue(note) {
  // Returns a rational multiplier in "whole notes".
  // whole note = 1.0
  // "1/4" -> 0.25
  // "1/8T" -> (1/8) * (2/3)
  // "1/8D" -> (1/8) * (3/2)
  if (note == null) return { whole: 0.25, ok: true, raw: "1/4" };

  let s = String(note).trim().toUpperCase();
  let triplet = false;
  let dotted = false;

  if (s.endsWith("T")) { triplet = true; s = s.slice(0, -1).trim(); }
  if (s.endsWith("D")) { dotted = true; s = s.slice(0, -1).trim(); }

  // allow "2" meaning "2/1"
  if (/^\d+$/.test(s)) s = `${s}/1`;

  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return { whole: 0.25, ok: false, raw: String(note) };

  const num = parseFloat(m[1]);
  const den = parseFloat(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
    return { whole: 0.25, ok: false, raw: String(note) };
  }

  let whole = num / den;

  // Triplet: 2/3 of the base duration (e.g. 1/8T)
  if (triplet) whole *= (2 / 3);

  // Dotted: 1.5 × base duration
  if (dotted) whole *= 1.5;

  return { whole, ok: true, raw: String(note) };
}

// =============================================================================
// 3) Core conversions (BPM -> ms)
// =============================================================================

export function bpm(state) {
  const t = timingOf(state);
  const v = Number(t.bpm ?? 60);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

export function msPerQuarter(state) {
  // BPM convention: beats per minute = quarter-notes per minute (common in UI).
  return 60000 / bpm(state);
}

export function msPerWhole(state) {
  return msPerQuarter(state) * 4;
}

export function noteMs(state, noteValue) {
  // noteValue is in whole-notes, so multiply by msPerWhole
  const nv = parseNoteValue(noteValue);
  return Math.round(msPerWhole(state) * nv.whole);
}

export function beatsPerBar(state) {
  const t = timingOf(state);
  const sig = parseTimeSignature(t.timeSignature);
  return sig.beatsPerBar; // in "beatUnit" notes
}

export function barMs(state) {
  // bar length depends on time signature: beatsPerBar * (beatUnit note duration)
  // beatUnit 4 -> quarter note, 8 -> eighth note, etc.
  const t = timingOf(state);
  const { beatsPerBar, beatUnit } = parseTimeSignature(t.timeSignature);

  // beatUnit note value in whole-notes is 1/beatUnit
  const beatWhole = 1 / Math.max(1, beatUnit);
  const beatMs = Math.round(msPerWhole(state) * beatWhole);

  return beatsPerBar * beatMs;
}

// =============================================================================
// 4) Chart + Legend derived durations (what you already use)
// =============================================================================

export function chartAnimMs(state) {
  const t = timingOf(state);

  // Preferred: explicit musical length, e.g. "1/4" or "1/1" or "2/1"
  const length = t?.chart?.length ?? t?.chartLength ?? t?.chartBeats; // legacy
  if (typeof length === "string" || typeof length === "number") {
    // If number and <= 16, interpret as "beats" (quarters). If string, parse note value.
    if (typeof length === "number") {
      const beats = Math.max(0.1, length);
      return Math.round(msPerQuarter(state) * beats);
    }
    return noteMs(state, length);
  }

  // Fallback to 1 beat (quarter note)
  return Math.round(msPerQuarter(state) * 1);
}

export function legendStopMs(state, nodeCount = null) {
  const t = timingOf(state);

  // Base: chart duration × factor (musical ratio)
  const factor = Number(t?.legend?.factor ?? t.legendFactor ?? 4);
  const baseMs = Math.round(
    chartAnimMs(state) * (Number.isFinite(factor) ? Math.max(1, factor) : 4)
  );

  // Optional adaptive extension for dense graphs.
  // Idea: for each additional "bucket" of nodes beyond a reference size, add
  // a fixed musical duration (e.g. 1/8 note). All derived from BPM.
  if (!Number.isFinite(nodeCount)) return baseMs;

  const legendCfg = t?.legend || {};
  const refNodes = Number(legendCfg.refNodes ?? 40);        // nodes "baseline"
  const everyNodes = Number(legendCfg.everyNodes ?? 25);    // bucket size
  const per = legendCfg.per ?? "1/8";                       // musical unit added per bucket
  const maxExtra = legendCfg.maxExtra ?? "2/1";             // cap (musical), e.g. 2 whole notes

  const over = Math.max(0, Math.floor(nodeCount) - Math.max(0, Math.floor(refNodes)));
  const buckets = Math.ceil(over / Math.max(1, Math.floor(everyNodes)));

  const perMs = noteMs(state, per);
  const extraMsRaw = buckets * perMs;

  const maxExtraMs = typeof maxExtra === "number" ? Math.max(0, maxExtra) : noteMs(state, maxExtra);
  const extraMs = Math.min(extraMsRaw, Math.max(0, maxExtraMs));

  return baseMs + extraMs;
}

// ---------------------------------------------------------------------------
// Rhythmische Envelope für Legend-Simulation (klassischer Puls)
// ---------------------------------------------------------------------------
// Exposed as a property on legendStopMs so callers don't need a new API.
// legend-simulation.js will use it if present.
legendStopMs.rhythm = function legendRhythm(state, totalMs) {
  const t = timingOf(state);
  const l = t?.legend || {};

  // Grid for pulses: prefer timing.legend.per, fall back to global quantize, then 1/8.
  const grid = String(l.per ?? t.quantize ?? "1/8");

  // Musical constants
  const beatMs = msPerQuarter(state); // quarter-note beat
  const stepMs = Math.max(20, noteMs(state, grid));
  const beatsBar = beatsPerBar(state); // from timeSignature (default 4)

  // How many steps make one beat (rounded; assumes "classic" grids like 1/8, 1/16)
  const stepsPerBeat = Math.max(1, Math.round(beatMs / stepMs));

  // Optional swing (0..0.5), reusing existing helper
  const useSwing = swingAmount(state) > 0;

  // Duration
  const total = Math.max(800, Number(totalMs) || 0);

  // Envelope parameters (optional; your current config does NOT need changes)
  // You can override them in config.timing.legend.{kickAlpha,beatAlpha,offAlpha,kickDecay,beatDecay,offDecay}
  const kickAlpha = Number(l.kickAlpha ?? t.legendKickAlpha) || 0.26;
  const beatAlpha = Number(l.beatAlpha ?? t.legendBeatAlpha) || 0.12;
  const offAlpha  = Number(l.offAlpha  ?? t.legendOffAlpha)  || 0.04;

  const kickDecay = Number(l.kickDecay ?? t.legendKickDecay) || 0.54;
  const beatDecay = Number(l.beatDecay ?? t.legendBeatDecay) || 0.66;
  const offDecay  = Number(l.offDecay  ?? t.legendOffDecay)  || 0.72;

  const events = [];

  // Downbeat kick ("1")
  events.push({ t: 0, alphaTarget: kickAlpha, velocityDecay: kickDecay, alphaBoost: 0.45 });

  // Quantized pulse grid
  const steps = Math.floor(total / stepMs);
  for (let i = 1; i <= steps; i++) {
    const swingOffset = useSwing ? applySwingToStepMs(state, i, stepMs) : 0;
    const at = Math.min(total, Math.round(i * stepMs + swingOffset));

    const isBeat = (i % stepsPerBeat) === 0;
    if (isBeat) {
      const beatIndex = Math.floor(i / stepsPerBeat); // 1..n
      const isDownbeat = beatsBar > 0 && (beatIndex % beatsBar === 0);

      if (isDownbeat) {
        events.push({ t: at, alphaTarget: beatAlpha + 0.04, velocityDecay: beatDecay, alphaBoost: 0.24 });
      } else {
        events.push({ t: at, alphaTarget: beatAlpha, velocityDecay: beatDecay, alphaBoost: 0.16 });
      }
    } else {
      events.push({ t: at, alphaTarget: offAlpha, velocityDecay: offDecay, alphaBoost: 0.0 });
    }
  }

  // End: settle completely
  events.push({ t: total, alphaTarget: 0, velocityDecay: offDecay, alphaBoost: 0.0 });

  // Sort + dedupe by t
  events.sort((a, b) => a.t - b.t);
  const out = [];
  let lastT = -1;
  for (const e of events) {
    const tt = e.t | 0;
    if (tt === lastT) continue;
    out.push({ ...e, t: tt });
    lastT = tt;
  }
  return out;
};

// =============================================================================
// 5) Musical grid + quantization + swing/shuffle
// =============================================================================

export function quantizeValue(state) {
  const t = timingOf(state);
  return String(t.quantize ?? "1/8");
}

export function swingAmount(state) {
  // 0..0.5 typical. 0.0 = straight.
  const t = timingOf(state);
  const v = Number(t.swing ?? 0);
  return clamp(Number.isFinite(v) ? v : 0, 0, 0.5);
}

export function createClock({ state, now = () => performance.now(), startAt = null } = {}) {
  // A simple musical clock that maps real time -> musical position.
  // startAt: real-time origin in ms. Default: now().
  const t0 = startAt == null ? now() : startAt;
  const mpq = msPerQuarter(state);

  return {
    t0,
    now,
    msPerQuarter: () => msPerQuarter(state),
    // elapsed real time since clock start
    elapsedMs: () => now() - t0,
    // musical quarters elapsed (can be fractional)
    quarters: () => (now() - t0) / mpq,
    // bars elapsed (based on timeSignature)
    bars: () => (now() - t0) / barMs(state),
  };
}

export function nextGridTimeMs(state, clock, grid = null) {
  // Returns absolute real-time (ms) for the next grid boundary.
  const q = clock.quarters(); // quarters elapsed
  const gridWhole = parseNoteValue(grid || quantizeValue(state)).whole; // whole-notes
  const gridQuarters = gridWhole * 4; // since 1 whole = 4 quarters
  const idx = Math.floor(q / gridQuarters) + 1;
  const nextQ = idx * gridQuarters;
  const dtMs = (nextQ - q) * clock.msPerQuarter();
  return clock.now() + dtMs;
}

export function applySwingToStepMs(state, stepIndex, stepMs) {
  // Classic swing: delay every 2nd step (odd index) by swing * stepMs, and pull the next step back.
  // This is a simplified "shuffle" feel.
  const s = swingAmount(state);
  if (s <= 0) return 0;

  // Apply to odd steps (1,3,5...) within pairs
  // delay = s * stepMs for odd; advance = -s * stepMs for even (except 0)
  if (stepIndex % 2 === 1) return Math.round(s * stepMs);
  if (stepIndex % 2 === 0 && stepIndex > 0) return Math.round(-s * stepMs);
  return 0;
}

// =============================================================================
// 6) Scheduling: transition state on musical boundaries
// =============================================================================

export function scheduleOnGrid({
  state,
  clock,
  grid = null,
  callback,
  align = "next",   // "next" or "now"
  swing = true,
} = {}) {
  if (!clock) clock = createClock({ state });
  const g = grid || quantizeValue(state);
  const stepMs = noteMs(state, g);

  const fireAt = (align === "now") ? clock.now() : nextGridTimeMs(state, clock, g);
  const delay = Math.max(0, fireAt - clock.now());

  const id = setTimeout(() => {
    if (typeof callback === "function") callback({ at: fireAt, grid: g });
  }, delay);

  return () => clearTimeout(id);
}

export function schedulePattern({
  state,
  clock,
  grid = "1/8",
  steps = [],
  onStep,
  swing = true,
  loop = false,
  maxLoops = Infinity,
} = {}) {
  // Two accepted step formats:
  // A) [{ at:"1/8", do: fn }, ...]  (at is relative offset, can be any note value)
  // B) ["A","-","-","B"] with implicit grid spacing; handled by onStep(token,...)
  if (!clock) clock = createClock({ state });

  const startAt = nextGridTimeMs(state, clock, grid);
  const startNow = clock.now();
  const baseDelay = Math.max(0, startAt - startNow);

  const isTokenArray = Array.isArray(steps) && steps.length && (typeof steps[0] === "string");
  const stepMs = noteMs(state, grid);

  let timeouts = [];
  let loops = 0;

  function scheduleOnce(originAtMs) {
    if (isTokenArray) {
      for (let i = 0; i < steps.length; i++) {
        const token = steps[i];
        const swingOffset = (swing ? applySwingToStepMs(state, i, stepMs) : 0);
        const atMs = originAtMs + (i * stepMs) + swingOffset;

        const id = setTimeout(() => {
          if (typeof onStep === "function") onStep({ i, token, atMs, grid });
        }, Math.max(0, atMs - clock.now()));
        timeouts.push(id);
      }
      return originAtMs + steps.length * stepMs;
    }

    // Object steps with explicit offsets
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i] || {};
      const offMs = noteMs(state, st.at ?? grid);
      const atMs = originAtMs + offMs;

      const id = setTimeout(() => {
        if (typeof st.do === "function") st.do({ i, atMs, grid });
        if (typeof onStep === "function") onStep({ i, step: st, atMs, grid });
      }, Math.max(0, atMs - clock.now()));
      timeouts.push(id);
    }

    // Duration = max offset among steps (approx)
    const maxOff = Math.max(0, ...steps.map((st) => noteMs(state, st?.at ?? grid)));
    return originAtMs + maxOff + stepMs;
  }

  function scheduleLoop(nextOrigin) {
    const nextEnd = scheduleOnce(nextOrigin);
    loops += 1;

    if (loop && loops < maxLoops) {
      const id = setTimeout(() => scheduleLoop(nextEnd), Math.max(0, nextEnd - clock.now()));
      timeouts.push(id);
    }
  }

  const origin = startAt;
  const starter = setTimeout(() => scheduleLoop(origin), baseDelay);
  timeouts.push(starter);

  return function cancel() {
    for (const id of timeouts) clearTimeout(id);
    timeouts = [];
  };
}

// =============================================================================
// 7) Convenience: build transition durations for D3 / CSS
// =============================================================================

export function d3Duration(state, role = "chart") {
  if (role === "legend") return legendStopMs(state);
  return chartAnimMs(state);
}

export function cssVarsFromTiming(state) {
  // Useful if you want CSS transitions in sync with BPM.
  // Returns a string map for setting on a root element: el.style.setProperty(...)
  const chartMs = chartAnimMs(state);
  const legendMs = legendStopMs(state);
  const stepMs = noteMs(state, quantizeValue(state));
  return {
    "--anim-chart-ms": String(chartMs),
    "--anim-legend-ms": String(legendMs),
    "--anim-step-ms": String(stepMs),
    "--anim-bpm": String(bpm(state)),
  };
}