// /assets/js/keys.js
export function cleanKey(s) {
  // Must match normalization across app.
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

