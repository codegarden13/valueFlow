
/**
 * moneytone.js
 * -----------------------------------------------------------------------------
 * Semantische Rot/Grün-Farblogik ("money tone") für Beträge / Deltas.
 *
 * Designziele
 * - Single Source of Truth: eine Logik für Source-Nodes, Pills/Chips, Tabellen etc.
 * - Framework-agnostisch: liefert Klassen- und Tone-Strings; DOM-Helfer optional.
 * - Stabil & defensiv: NaN/Infinity/"0" => neutral.
 *
 * CSS-Contract (moneyTone.css)
 * - Tone tokens:
 *   --money-tone-pos-bg, --money-tone-pos-bd, --money-tone-pos-sh
 *   --money-tone-neg-bg, --money-tone-neg-bd, --money-tone-neg-sh
 *   --money-tone-zero-bg, --money-tone-zero-bd
 * - Utilities:
 *   .tone-pos / .tone-neg / .tone-zero  (optional)
 *   [data-tone="pos|neg|zero"]          (optional)
 * - Components lesen:
 *   --tone-bg / --tone-bd / --tone-sh
 *
 * Hinweis: Diese Datei definiert *keine* CSS-Variablen. Sie liefert nur die
 * semantische Einstufung und optionale DOM-Helpers.
 */

/** @typedef {"pos" | "neg" | "zero"} MoneyTone */

/**
 * Standard-Toleranz für "zero".
 * Werte mit |n| <= EPS werden als neutral/zero behandelt.
 */
export const EPS = 1e-9;

/**
 * Map von Tone -> CSS-Klasse.
 * (Achtung: bewusst getrennt von data-tone, damit du flexibel bist.)
 */
export const TONE_CLASS = Object.freeze({
  pos: "tone-pos",
  neg: "tone-neg",
  zero: "tone-zero",
});

/**
 * Normalisiert einen numerischen Input.
 * @param {unknown} value
 * @returns {number | null} finite number or null
 */
function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bestimmt die semantische MoneyTone-Einstufung für einen Wert.
 *
 * Default:
 * - n > 0  => "pos" (grün)
 * - n < 0  => "neg" (rot)
 * - |n|<=eps oder nicht-finite => "zero" (neutral)
 *
 * invert:
 * - invertiert pos/neg (für Fälle, wo "gut" = negativ wäre)
 *
 * @param {unknown} value
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {MoneyTone}
 */
export function toneOfValue(value, opts = {}) {
  const { invert = false, eps = EPS } = opts;
  const n = toFiniteNumber(value);
  if (n === null || Math.abs(n) <= eps) return "zero";

  const positive = n > 0;
  const isPos = invert ? !positive : positive;
  return isPos ? "pos" : "neg";
}

/**
 * Bestimmt die semantische MoneyTone-Einstufung aus einem Delta.
 * (typisch: actual - planned)
 *
 * @param {unknown} actual
 * @param {unknown} planned
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {MoneyTone}
 */
export function toneOfDelta(actual, planned, opts = {}) {
  const a = toFiniteNumber(actual);
  const p = toFiniteNumber(planned);
  if (a === null || p === null) return "zero";
  return toneOfValue(a - p, opts);
}

/**
 * Liefert die CSS-Klasse für eine MoneyTone.
 * @param {MoneyTone} tone
 * @returns {string}
 */
export function classOfTone(tone) {
  return TONE_CLASS[tone] || TONE_CLASS.zero;
}

/**
 * Liefert die CSS-Klasse für einen Wert.
 * @param {unknown} value
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {string}
 */
export function classOfValue(value, opts = {}) {
  return classOfTone(toneOfValue(value, opts));
}

/**
 * Liefert das data-tone Attribut ("pos|neg|zero") für einen Wert.
 * @param {unknown} value
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {MoneyTone}
 */
export function dataToneOfValue(value, opts = {}) {
  return toneOfValue(value, opts);
}

/**
 * DOM Helper: setzt entweder data-tone oder eine tone-klasse auf einem Element.
 *
 * Warum: Manche Komponenten lesen --tone-* via [data-tone], andere via .tone-*
 * oder legacy via data-sign. Du kannst hier konsistent steuern.
 *
 * @param {Element} el
 * @param {MoneyTone} tone
 * @param {{
 *   mode?: "data" | "class" | "both",
 *   clear?: boolean,
 * }} [opts]
 */
export function applyTone(el, tone, opts = {}) {
  if (!el) return;
  const { mode = "data", clear = true } = opts;

  if (clear) {
    // Klassenräumung nur für tone-classes
    el.classList.remove(TONE_CLASS.pos, TONE_CLASS.neg, TONE_CLASS.zero);
    // data-tone nur, wenn wir es nutzen
    if (el.hasAttribute("data-tone")) el.removeAttribute("data-tone");
  }

  if (mode === "class" || mode === "both") {
    el.classList.add(classOfTone(tone));
  }

  if (mode === "data" || mode === "both") {
    el.setAttribute("data-tone", tone);
  }
}

/**
 * DOM Helper: setzt Tone aus einem Wert.
 * @param {Element} el
 * @param {unknown} value
 * @param {{
 *   invert?: boolean,
 *   eps?: number,
 *   mode?: "data" | "class" | "both",
 *   clear?: boolean,
 * }} [opts]
 */
export function applyToneFromValue(el, value, opts = {}) {
  const { invert = false, eps = EPS, mode = "data", clear = true } = opts;
  const tone = toneOfValue(value, { invert, eps });
  applyTone(el, tone, { mode, clear });
}

/**
 * -----------------------------------------------------------------------------
 * Backward compatibility exports
 * -----------------------------------------------------------------------------
 * Bestehender Code in der App nutzt bereits:
 * - moneyToneClass(value)           -> "tone-pos" | "tone-neg" | "tone-neutral"
 * - moneyToneClassFromDelta(a, p)   -> dito
 *
 * Wir mappen das jetzt auf das neue "zero"-Konzept.
 */

/**
 * @deprecated Prefer classOfValue() + toneOfValue() + applyToneFromValue().
 * @param {unknown} value
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {"tone-pos" | "tone-neg" | "tone-neutral"}
 */
export function moneyToneClass(value, opts = {}) {
  const tone = toneOfValue(value, opts);
  if (tone === "pos") return "tone-pos";
  if (tone === "neg") return "tone-neg";
  return "tone-neutral";
}

/**
 * @deprecated Prefer toneOfDelta() + applyTone().
 * @param {unknown} actual
 * @param {unknown} planned
 * @param {{ invert?: boolean, eps?: number }} [opts]
 * @returns {"tone-pos" | "tone-neg" | "tone-neutral"}
 */
export function moneyToneClassFromDelta(actual, planned, opts = {}) {
  const tone = toneOfDelta(actual, planned, opts);
  if (tone === "pos") return "tone-pos";
  if (tone === "neg") return "tone-neg";
  return "tone-neutral";
}