// rente.js (ESM) — Node.js importierbar

export const REGION = Object.freeze({
  WEST: "WEST",
  OST: "OST",
});

/**
 * Durchschnittsentgelt (Anlage 1 SGB VI) ab 1985.
 * Hinweis Währung:
 * - bis 2001: DM
 * - ab 2002: EUR
 * bruttoeinkommen muss in derselben Währung wie das Jahr des Durchschnittsentgelts übergeben werden.
 */
const DURCHSCHNITTSENTGELT = Object.freeze({
  1985: 35286,
  1986: 36627,
  1987: 37726,
  1988: 38896,
  1989: 40063,
  1990: 41946,
  1991: 44421,
  1992: 46820,
  1993: 48178,
  1994: 49142,
  1995: 50665,
  1996: 51678,
  1997: 52143,
  1998: 52925,
  1999: 53507,
  2000: 54256,
  2001: 55216,
  2002: 28626,
  2003: 28938,
  2004: 29060,
  2005: 29202,
  2006: 29494,
  2007: 29951,
  2008: 30625,
  2009: 30506,
  2010: 31144,
  2011: 32100,
  2012: 33002,
  2013: 33659,
  2014: 34514,
  2015: 35363,
  2016: 36187,
  2017: 37077,
  2018: 38212,
  2019: 39301,
  2020: 39167,
  2021: 40463,
  2022: 42053,
  2023: 44732,
  2024: 47085,
  2025: 50493,
  2026: 51944,
});

/**
 * Rentenwert-Zeitreihe (Auswahl nach Stichtag; ab 01.07.1985).
 * Werte:
 * - bis 2001: DM
 * - ab 2002: EUR
 * Ost-Werte existieren erst ab 01.07.1990; ab 01.07.2024 ist der Rentenwert faktisch einheitlich.
 */
const RENTENWERT_SCHEDULE = Object.freeze([
  // WEST
  { from: "1985-07-01", west: 33.87 },
  { from: "1986-07-01", west: 34.86 },
  { from: "1987-01-01", west: 34.86 },
  { from: "1987-07-01", west: 36.18 },
  { from: "1988-01-01", west: 36.18 },
  { from: "1988-07-01", west: 37.27 },
  { from: "1989-01-01", west: 37.27 },
  { from: "1989-07-01", west: 38.39 },
  { from: "1990-01-01", west: 38.39 },
  { from: "1990-07-01", west: 39.58 },
  { from: "1991-01-01", west: 39.58 },
  { from: "1991-07-01", west: 41.44 },
  { from: "1992-01-01", west: 41.44 },
  { from: "1992-07-01", west: 42.63 },
  { from: "1993-07-01", west: 44.49 },
  { from: "1994-01-01", west: 44.49 },
  { from: "1994-07-01", west: 46.0 },
  { from: "1995-01-01", west: 46.0 },
  { from: "1995-07-01", west: 46.23 },
  { from: "1996-01-01", west: 46.23 },
  { from: "1996-07-01", west: 46.67 },
  { from: "1997-07-01", west: 47.44 },
  { from: "1998-07-01", west: 47.65 },
  { from: "1999-07-01", west: 48.29 },
  { from: "2000-07-01", west: 48.58 },
  { from: "2001-07-01", west: 49.51 },

  // EUR-Umstellung + fortlaufend (WEST)
  { from: "2002-01-01", west: 25.31406 },
  { from: "2002-07-01", west: 25.86 },
  { from: "2003-07-01", west: 26.13 },
  { from: "2007-07-01", west: 26.27 },
  { from: "2008-07-01", west: 26.56 },
  { from: "2009-07-01", west: 27.20 },
  { from: "2011-07-01", west: 27.47 },
  { from: "2012-07-01", west: 28.07 },
  { from: "2013-07-01", west: 28.14 },
  { from: "2014-07-01", west: 28.61 },
  { from: "2015-07-01", west: 29.21 },
  { from: "2016-07-01", west: 30.45 },
  { from: "2017-07-01", west: 31.03 },
  { from: "2018-07-01", west: 32.03 },
  { from: "2019-07-01", west: 33.05 },
  { from: "2020-07-01", west: 34.19 },
  { from: "2021-07-01", west: 34.19 },
  { from: "2022-07-01", west: 36.02 },
  { from: "2023-07-01", west: 37.60 },
  { from: "2024-07-01", west: 39.32 },
  { from: "2025-07-01", west: 40.79 },

  // OST (ab 1990)
  { from: "1990-07-01", ost: 15.95 },
  { from: "1991-01-01", ost: 18.35 },
  { from: "1991-07-01", ost: 21.11 },
  { from: "1992-01-01", ost: 23.57 },
  { from: "1992-07-01", ost: 26.57 },
  { from: "1993-01-01", ost: 28.19 },
  { from: "1993-07-01", ost: 32.17 },
  { from: "1994-01-01", ost: 33.34 },
  { from: "1994-07-01", ost: 34.49 },
  { from: "1995-01-01", ost: 35.45 },
  { from: "1995-07-01", ost: 36.33 },
  { from: "1996-01-01", ost: 37.92 },
  { from: "1996-07-01", ost: 38.38 },
  { from: "1997-07-01", ost: 40.51 },
  { from: "1998-07-01", ost: 40.87 },
  { from: "1999-07-01", ost: 42.01 },
  { from: "2000-07-01", ost: 42.26 },
  { from: "2001-07-01", ost: 43.15 },

  { from: "2002-01-01", ost: 22.06224 },
  { from: "2002-07-01", ost: 22.70 },
  { from: "2003-07-01", ost: 22.97 },
  { from: "2007-07-01", ost: 23.09 },
  { from: "2008-07-01", ost: 23.34 },
  { from: "2009-07-01", ost: 24.13 },
  { from: "2011-07-01", ost: 24.37 },
  { from: "2012-07-01", ost: 24.92 },
  { from: "2013-07-01", ost: 25.74 },
  { from: "2014-07-01", ost: 26.39 },
  { from: "2015-07-01", ost: 27.05 },
  { from: "2016-07-01", ost: 28.66 },
  { from: "2017-07-01", ost: 29.69 },
  { from: "2018-07-01", ost: 30.69 },
  { from: "2019-07-01", ost: 31.89 },
  { from: "2020-07-01", ost: 33.23 },
  { from: "2021-07-01", ost: 33.47 },
  { from: "2022-07-01", ost: 35.52 },
  { from: "2023-07-01", ost: 37.60 }, // ab 01.07.2023 praktisch gleich
]);

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function getLatestRowOnOrBefore(date) {
  const ts = toDate(date).getTime();
  let best = null;
  for (const row of RENTENWERT_SCHEDULE) {
    const eff = new Date(row.from).getTime();
    if (eff <= ts && (!best || eff > new Date(best.from).getTime())) best = row;
  }
  if (!best) throw new Error("Kein Rentenwert gefunden (Mapping startet 1985-07-01).");
  return best;
}

function getRentenwert(region, stichtag) {
  const row = getLatestRowOnOrBefore(stichtag);

  if (region === REGION.WEST) {
    // row kann eine OST-Zeile sein; dann rückwärts WEST suchen
    if (typeof row.west === "number") return row.west;
    const ts = toDate(stichtag).getTime();
    for (let i = RENTENWERT_SCHEDULE.length - 1; i >= 0; i--) {
      const r = RENTENWERT_SCHEDULE[i];
      if (new Date(r.from).getTime() <= ts && typeof r.west === "number") return r.west;
    }
    throw new Error("Kein WEST-Rentenwert für den Stichtag gefunden.");
  }

  if (region === REGION.OST) {
    // Ab 01.07.2024 gibt es faktisch einen einheitlichen Rentenwert (wir würden dann WEST-Wert nutzen)
    if (typeof row.ost === "number") return row.ost;
    if (typeof row.west === "number") return row.west;

    const ts = toDate(stichtag).getTime();
    const firstOst = new Date("1990-07-01").getTime();
    if (ts < firstOst) {
      throw new Error("OST ist vor 1990-07-01 nicht anwendbar (kein Ost-Rentenwert im Mapping).");
    }

    for (let i = RENTENWERT_SCHEDULE.length - 1; i >= 0; i--) {
      const r = RENTENWERT_SCHEDULE[i];
      if (new Date(r.from).getTime() <= ts) {
        if (typeof r.ost === "number") return r.ost;
        if (typeof r.west === "number") return r.west;
      }
    }
    throw new Error("Kein OST-Rentenwert für den Stichtag gefunden.");
  }

  throw new Error(`Unbekannte Region: ${region}`);
}

/**
 * berechneRente(bruttoeinkommen, regionOrOptions?)
 *
 * Stichtag-Regel (refaktoriert):
 * - Der Rentenwert wird über einen festen Stichtag bestimmt: **30.06. des Folgejahres**.
 *   Beispiel: Verdienstjahr `2024` => Rentenwert-Stichtag `2025-06-30`.
 * - Damit ist `stichtag` kein Input mehr, sondern wird aus `jahr` abgeleitet.
 *
 * Minimal:
 *   berechneRente(50000)                      // default WEST, jahr = aktuelles Jahr
 *   berechneRente(50000, "OST")
 *
 * Mit Verdienstjahr (empfohlen):
 *   berechneRente(50000, { jahr: 2024 })
 *   berechneRente(50000, { region: "OST", jahr: 2020 })
 */
export function berechneRente(bruttoeinkommen, regionOrOptions) {
  if (!Number.isFinite(bruttoeinkommen) || bruttoeinkommen < 0) {
    throw new Error("bruttoeinkommen muss eine nicht-negative Zahl sein.");
  }

  const now = new Date();
  const options =
    typeof regionOrOptions === "string"
      ? { region: regionOrOptions }
      : (regionOrOptions ?? {});

  const region = options.region ?? REGION.WEST;
  const jahr = options.jahr ?? now.getFullYear();

  // Stichtag ist fest: 30.06. des Folgejahres
  const stichtag = new Date(`${jahr + 1}-06-30T00:00:00.000Z`);

  const durchschnittsentgelt = DURCHSCHNITTSENTGELT[jahr];
  if (!durchschnittsentgelt) {
    throw new Error(`Kein Durchschnittsentgelt für Jahr ${jahr} im Mapping (Start: 1985).`);
  }

  const entgeltpunkte = bruttoeinkommen / durchschnittsentgelt;
  const rentenwert = getRentenwert(region, stichtag);

  return {
    renteMonat: round2(entgeltpunkte * rentenwert),
    entgeltpunkte,
    rentenwert,
    durchschnittsentgelt,
    meta: {
      region,
      jahr,
      stichtag: toDate(stichtag).toISOString().slice(0, 10),
      rentenwertStichtagRegel: "30.06. des Folgejahres",
      rentenwertWechseltypischZum: "01.07.",
      waehrungHinweis:
        jahr <= 2001
          ? "Für Jahre bis 2001 sind die Tabellenwerte in DM. Brutto bitte in DM übergeben."
          : "Ab 2002 sind die Tabellenwerte in EUR. Brutto bitte in EUR übergeben.",
    },
  };
}

// Optional: Tabellen exportieren, wenn du sie extern brauchst
export const tables = Object.freeze({
  durchschnittsentgelt: DURCHSCHNITTSENTGELT,
  rentenwertSchedule: RENTENWERT_SCHEDULE,
});