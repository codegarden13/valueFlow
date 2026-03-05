/**
 * taxEngineDE.js (ESM)
 *
 * Enthält aktuell:
 * - berechneRente(...): Modellrechnung „Entgeltpunkte aus Brutto“ → Monatsrente (brutto)
 * - calcSozialabgaben(...): Modellrechnung Sozialabgaben (KV/PV/RV/AV) aus Brutto
 *
 * Wichtige Design-Entscheidungen (refaktoriert):
 * 1) Eingabe-Währung ist IMMER EUR – auch für historische Jahre vor 2002.
 *    - Tabellenwerte vor 2002 (DM) werden intern mit dem festen Umrechnungskurs
 *      1 EUR = 1,95583 DM nach EUR konvertiert.
 *    - Ergebnis ist immer in EUR.
 *
 * 2) Jahresbetrag kann Teiljahresverdienst sein (z.B. „7 Monate gearbeitet“).
 *    - Für die Entgeltpunkte zählt der Gesamtverdienst im Kalenderjahr (egal ob 7 oder 12 Monate).
 *    - Optional kannst du `monthsWorked` übergeben, wenn du statt eines Jahresbetrags
 *      einen Monatsbetrag liefern willst (unit="month").
 *
 * 3) Rentenwert-Stichtag-Regel:
 *    - Der Rentenwert wird über einen festen Stichtag bestimmt: 30.06. des Folgejahres.
 *      Beispiel: Verdienstjahr 2024 => Rentenwert-Stichtag 2025-06-30.
 * 
 * 
 * // Jahresverdienst (auch Teiljahr ok)
berechneRente(35000, { jahr: 2010 }) // 35.000 EUR im Jahr 2010, egal ob 7/12 Monate

// Monatswert + gearbeitete Monate
berechneRente(5000, { jahr: 2010, unit: "month", monthsWorked: 7 }) // 5.000 EUR/Monat * 7
 * 
 * 
 * Was die Funktion zurückgibt
 * 
	•	renteMonat (EUR)
	•	entgeltpunkte
	•	rentenwert (EUR)
	•	durchschnittsentgelt (EUR)
	•	meta inkl. jahresVerdienst, unit, monthsWorked (wenn relevant), Stichtag etc.

 * 
 * 
 * 
 */

export const REGION = Object.freeze({
  WEST: "WEST",
  OST: "OST",
});

// Fester Umrechnungskurs (Euro-Einführung): 1 EUR = 1,95583 DM
// -> DM nach EUR: dm / 1.95583
const DM_PER_EUR = 1.95583;

/**
 * Durchschnittsentgelt (Anlage 1 SGB VI) ab 1985.
 * Werte sind historisch:
 * - bis 2001: DM
 * - ab 2002: EUR
 *
 * Wir konvertieren bei Bedarf nach EUR.
 */
const DURCHSCHNITTSENTGELT_RAW = Object.freeze({
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
 * Werte sind historisch:
 * - bis 2001: DM
 * - ab 2002: EUR
 * Ost-Werte existieren erst ab 01.07.1990; seit 2023/2024 faktisch einheitlich.
 *
 * Wir konvertieren bei Bedarf nach EUR.
 */
const RENTENWERT_SCHEDULE_RAW = Object.freeze([
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
  { from: "2009-07-01", west: 27.2 },
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
  { from: "2023-07-01", west: 37.6 },
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
  { from: "2002-07-01", ost: 22.7 },
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
  { from: "2023-07-01", ost: 37.6 }, // ab 01.07.2023 praktisch gleich
]);

// --- Helpers ---

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function dmToEur(dm) {
  return dm / DM_PER_EUR;
}

function isPreEuroYear(jahr) {
  return jahr <= 2001;
}

function isPreEuroDate(date) {
  // Euro-Umstellung: 2002-01-01
  return toDate(date).getTime() < new Date("2002-01-01T00:00:00.000Z").getTime();
}

function getDurchschnittsentgeltEUR(jahr) {
  const raw = DURCHSCHNITTSENTGELT_RAW[jahr];
  if (!raw) return null;
  return isPreEuroYear(jahr) ? dmToEur(raw) : raw;
}

function getLatestRowOnOrBefore(date) {
  const ts = toDate(date).getTime();
  let best = null;
  for (const row of RENTENWERT_SCHEDULE_RAW) {
    const eff = new Date(row.from).getTime();
    if (eff <= ts && (!best || eff > new Date(best.from).getTime())) best = row;
  }
  if (!best) throw new Error("Kein Rentenwert gefunden (Mapping startet 1985-07-01).");
  return best;
}

function getRentenwertEUR(region, stichtag) {
  const row = getLatestRowOnOrBefore(stichtag);
  const preEuro = isPreEuroDate(stichtag);

  // Hilfsfunktion: Wert nehmen und ggf. DM->EUR konvertieren
  const conv = (x) => (preEuro ? dmToEur(x) : x);

  if (region === REGION.WEST) {
    if (typeof row.west === "number") return conv(row.west);

    // row kann eine OST-Zeile sein; dann rückwärts WEST suchen
    const ts = toDate(stichtag).getTime();
    for (let i = RENTENWERT_SCHEDULE_RAW.length - 1; i >= 0; i--) {
      const r = RENTENWERT_SCHEDULE_RAW[i];
      if (new Date(r.from).getTime() <= ts && typeof r.west === "number") return conv(r.west);
    }
    throw new Error("Kein WEST-Rentenwert für den Stichtag gefunden.");
  }

  if (region === REGION.OST) {
    // Ost existiert erst ab 1990-07-01 (historisch)
    const ts = toDate(stichtag).getTime();
    const firstOst = new Date("1990-07-01T00:00:00.000Z").getTime();
    if (ts < firstOst) {
      throw new Error("OST ist vor 1990-07-01 nicht anwendbar (kein Ost-Rentenwert im Mapping).");
    }

    // Ab 2023/2024 faktisch einheitlich. Wenn keine ost-Spalte, nimm west.
    if (typeof row.ost === "number") return conv(row.ost);
    if (typeof row.west === "number") return conv(row.west);

    // sonst rückwärts suchen
    for (let i = RENTENWERT_SCHEDULE_RAW.length - 1; i >= 0; i--) {
      const r = RENTENWERT_SCHEDULE_RAW[i];
      if (new Date(r.from).getTime() <= ts) {
        if (typeof r.ost === "number") return conv(r.ost);
        if (typeof r.west === "number") return conv(r.west);
      }
    }
    throw new Error("Kein OST-Rentenwert für den Stichtag gefunden.");
  }

  throw new Error(`Unbekannte Region: ${region}`);
}

/**
 * berechneRente(betrag, regionOrOptions?)
 *
 * Input (EUR):
 * - `betrag`: Zahl in EUR
 * - options:
 *   - region: "WEST" | "OST" (default WEST)
 *   - jahr: Verdienstjahr (default aktuelles Jahr)
 *   - unit: "year" | "month" (default "year")
 *   - monthsWorked: Anzahl Monate im Jahr, für die der Monatsbetrag gilt (default 12)
 *
 * Interpretation:
 * - unit="year": `betrag` ist der Gesamtverdienst im Kalenderjahr (kann auch 7 Monate Arbeit sein).
 * - unit="month": `betrag` ist Monatsbrutto; dann wird `jahresVerdienst = betrag * monthsWorked`.
 *
 * Output:
 * - renteMonat: Monatsrente (brutto) in EUR
 * - entgeltpunkte: EP aus Kalenderjahresverdienst / Durchschnittsentgelt
 */
export function berechneRente(betrag, regionOrOptions) {
  if (!Number.isFinite(betrag) || betrag < 0) {
    throw new Error("betrag muss eine nicht-negative Zahl sein.");
  }

  const now = new Date();
  const options =
    typeof regionOrOptions === "string"
      ? { region: regionOrOptions }
      : (regionOrOptions ?? {});

  const region = options.region ?? REGION.WEST;
  const jahr = options.jahr ?? now.getFullYear();
  const unit = options.unit ?? "year";
  const monthsWorkedRaw = options.monthsWorked ?? 12;
  const monthsWorked = Math.max(0, Math.min(12, Math.floor(monthsWorkedRaw)));

  if (unit !== "year" && unit !== "month") {
    throw new Error('unit muss "year" oder "month" sein.');
  }

  if (unit === "month" && monthsWorked === 0) {
    throw new Error("monthsWorked muss > 0 sein, wenn unit=\"month\".");
  }

  // Jahresverdienst bestimmen
  // - year: Betrag ist schon der Gesamtverdienst im Kalenderjahr (Teiljahr ok)
  // - month: Betrag ist Monatsbrutto; multipliziere mit gearbeiteten Monaten
  const jahresVerdienstEUR = unit === "year" ? betrag : betrag * monthsWorked;

  // Stichtag ist fest: 30.06. des Folgejahres
  const stichtag = new Date(`${jahr + 1}-06-30T00:00:00.000Z`);

  // Durchschnittsentgelt in EUR (DM-Werte werden konvertiert)
  const durchschnittsentgeltEUR = getDurchschnittsentgeltEUR(jahr);
  if (!durchschnittsentgeltEUR) {
    throw new Error(`Kein Durchschnittsentgelt für Jahr ${jahr} im Mapping (Start: 1985).`);
  }

  // Entgeltpunkte: Kalenderjahresverdienst / Durchschnittsentgelt
  const entgeltpunkte = jahresVerdienstEUR / durchschnittsentgeltEUR;

  // Rentenwert in EUR passend zum Stichtag (DM-Werte werden konvertiert)
  const rentenwertEUR = getRentenwertEUR(region, stichtag);

  // Monatsrente (brutto)
  const renteMonatEUR = entgeltpunkte * rentenwertEUR;

  return {
    renteMonat: round2(renteMonatEUR),
    entgeltpunkte,
    rentenwert: rentenwertEUR,
    durchschnittsentgelt: durchschnittsentgeltEUR,
    meta: {
      region,
      jahr,
      unit,
      monthsWorked: unit === "month" ? monthsWorked : undefined,
      jahresVerdienst: round2(jahresVerdienstEUR),
      stichtag: toDate(stichtag).toISOString().slice(0, 10),
      rentenwertStichtagRegel: "30.06. des Folgejahres",
      rentenwertWechseltypischZum: "01.07.",
      waehrung: "EUR",
      umrechnungHinweis: "Für Tabellenwerte vor 2002 werden DM-Werte intern mit 1 EUR = 1,95583 DM in EUR umgerechnet.",
    },
  };
}

// ---------------------------------------------------------------------------
// Sozialabgaben (GKV/PV/RV/AV) – Modellrechnung
// ---------------------------------------------------------------------------
// Kernidee:
// - In der Praxis greifen BBG/Beiträge i.d.R. pro Abrechnungsmonat.
// - Deshalb rechnen wir immer auf Monatsbasis und deckeln pro Monat.
// - Jahres-/Teiljahreswerte werden dafür zu einem Monatsäquivalent normalisiert.
//
// Beispiel (Teiljahr):
// - unit="year", betrag=35.000 EUR, monthsWorked=7
//   => bruttoMonat = 35.000 / 7 = 5.000 EUR
//   => Abgaben pro Monat (mit BBG-Deckel) werden berechnet
//   => periodTotal = monat * 7

/**
 * Beitragssätze & BBG (monatlich) – Stand: 2026.
 * Hinweis: Wenn du andere Jahre brauchst, ergänze hier neue Einträge.
 */
const SV_TABLES = Object.freeze({
  2026: {
    bbg: {
      // Beitragsbemessungsgrenze KV/PV (monatlich)
      kvPv: 5812.5,
      // Beitragsbemessungsgrenze RV/AV (monatlich)
      rvAv: 8450.0,
    },
    rates: {
      rv: 0.186, // Rentenversicherung gesamt
      av: 0.026, // Arbeitslosenversicherung gesamt
      kv: 0.146, // Krankenversicherung gesamt (ohne Zusatzbeitrag)
      pv: 0.036, // Pflegeversicherung gesamt (Grundsatz)
      pvChildlessSurcharge: 0.006, // Kinderlosenzuschlag (AN-only), i.d.R. ab 23
    },
  },
});

function normalizeRatePercentOrDecimal(x, { max = 0.05, name = "rate" } = {}) {
  if (x === undefined || x === null || x === "") return 0;
  if (!Number.isFinite(x)) throw new Error(`${name} muss eine Zahl sein.`);

  // Akzeptiere 2.9 (=2,9%) ODER 0.029.
  // Achtung: 0.9 wäre 90% und fast sicher ein Eingabefehler -> Plausibilitätscheck.
  const r = x > 1 ? x / 100 : x;
  if (r < 0 || r > max) {
    throw new Error(`${name} wirkt unplausibel (${x}). Erwarte z.B. 2.9 oder 0.029 (max ${(max * 100).toFixed(1)}%).`);
  }
  return r;
}

function getSvYearRow(year) {
  const row = SV_TABLES[year];
  if (row) return row;

  // Fallback: nimm letztes verfügbares Jahr <= year
  const years = Object.keys(SV_TABLES).map(Number).sort((a, b) => a - b);
  const fallbackYear = years.filter((y) => y <= year).pop();
  if (fallbackYear) return SV_TABLES[fallbackYear];

  throw new Error(`Keine SV-Tabelle für Jahr ${year} hinterlegt.`);
}

/**
 * calcSozialabgaben(betrag, ctx)
 *
 * Input (EUR):
 * - `betrag`: Zahl in EUR
 * - ctx:
 *   - year: Beitragsjahr (default aktuelles Jahr)
 *   - unit: "year" | "month" (default "year")
 *   - monthsWorked: Anzahl Monate, auf die sich der Betrag verteilt (default 12)
 *     - unit="year": betrag ist Jahres-/Teiljahresverdienst (z.B. 7 Monate gearbeitet)
 *     - unit="month": betrag ist Monatsbrutto; monthsWorked steuert dann nur die Periodensumme
 *   - region: "WEST" | "OST" (aktuell nur Meta; BBG 2026 bundeseinheitlich)
 *   - kvZusatzbeitrag: z.B. 2.9 oder 0.029 (default 0)
 *   - kinderUnter25: Anzahl Kinder < 25 (default 0)
 *   - kinderlos: boolean (default false)
 *   - sachsen: boolean (default false) -> PV-Split: AG 1,3% statt 1,8% (Rest AN)
 *
 * Output:
 * - `month`: Beiträge für einen Monat (auf Monatsäquivalent-Basis, inkl. BBG-Deckel)
 * - `period`: Beiträge für die gesamte Periode (month * monthsWorked)
 */
export function calcSozialabgaben(betrag, ctx = {}) {
  if (!Number.isFinite(betrag) || betrag < 0) {
    throw new Error("betrag muss eine nicht-negative Zahl sein.");
  }

  const now = new Date();
  const year = ctx.year ?? now.getFullYear();
  const unit = ctx.unit ?? "year";
  const region = ctx.region ?? REGION.WEST;

  const monthsWorkedRaw = ctx.monthsWorked ?? 12;
  const monthsWorked = Math.max(1, Math.min(12, Math.floor(monthsWorkedRaw)));

  if (unit !== "year" && unit !== "month") {
    throw new Error('unit muss "year" oder "month" sein.');
  }

  const kvZusatz = normalizeRatePercentOrDecimal(ctx.kvZusatzbeitrag ?? 0, {
    max: 0.06,
    name: "kvZusatzbeitrag",
  });

  const kinderUnter25 = Math.max(0, Math.floor(ctx.kinderUnter25 ?? 0));
  const kinderlos = Boolean(ctx.kinderlos ?? false);
  const sachsen = Boolean(ctx.sachsen ?? false);

  const sv = getSvYearRow(year);
  const { bbg, rates } = sv;

  // Monatsäquivalent bestimmen:
  // - unit="month": betrag IST bereits Monatsbrutto
  // - unit="year":  betrag ist Jahres-/Teiljahresverdienst -> betrag / monthsWorked
  const bruttoMonat = unit === "month" ? betrag : betrag / monthsWorked;

  // Beitragspflichtige Entgelte (monatlich, gedeckelt)
  const entgeltKvPv = Math.min(bruttoMonat, bbg.kvPv);
  const entgeltRvAv = Math.min(bruttoMonat, bbg.rvAv);

  // KV (hälftig AN/AG), Zusatzbeitrag ebenfalls hälftig
  const kvGesamtRate = rates.kv + kvZusatz;
  const kvAN = entgeltKvPv * (kvGesamtRate / 2);
  const kvAG = entgeltKvPv * (kvGesamtRate / 2);

  // RV (hälftig)
  const rvAN = entgeltRvAv * (rates.rv / 2);
  const rvAG = entgeltRvAv * (rates.rv / 2);

  // AV (hälftig)
  const avAN = entgeltRvAv * (rates.av / 2);
  const avAG = entgeltRvAv * (rates.av / 2);

  // PV (Split; Sachsen-Sonderregel; Kinderlos-Zuschlag AN-only; Kinder-Abschläge AN-only)
  // Grundsplit:
  // - Normal: 3,6% => 1,8% AG + 1,8% AN
  // - Sachsen: AG 1,3%, AN 2,3% (ohne Kinderlos-Zuschlag)
  const pvAGRateBase = sachsen ? 0.013 : 0.018;
  const pvANRateBase = rates.pv - pvAGRateBase;

  // Abschlag ab 2. Kind bis max 5. Kind: 0,25 %-Punkte je Kind (max 1,0 %-Punkt)
  const abschlagKinder = kinderUnter25 >= 2 ? Math.min(kinderUnter25 - 1, 4) * 0.0025 : 0;

  // Kinderlos-Zuschlag 0,6 %-Punkte (AN-only)
  const zuschlagKinderlos = kinderlos ? rates.pvChildlessSurcharge : 0;

  const pvANRate = Math.max(0, pvANRateBase - abschlagKinder) + zuschlagKinderlos;
  const pvAGRate = pvAGRateBase;

  const pvAN = entgeltKvPv * pvANRate;
  const pvAG = entgeltKvPv * pvAGRate;

  const month = {
    beitragspflichtig: {
      kvPv: round2(entgeltKvPv),
      rvAv: round2(entgeltRvAv),
    },
    arbeitnehmer: {
      kv: round2(kvAN),
      pv: round2(pvAN),
      rv: round2(rvAN),
      av: round2(avAN),
    },
    arbeitgeber: {
      kv: round2(kvAG),
      pv: round2(pvAG),
      rv: round2(rvAG),
      av: round2(avAG),
    },
  };
  month.arbeitnehmer.summe = round2(month.arbeitnehmer.kv + month.arbeitnehmer.pv + month.arbeitnehmer.rv + month.arbeitnehmer.av);
  month.arbeitgeber.summe = round2(month.arbeitgeber.kv + month.arbeitgeber.pv + month.arbeitgeber.rv + month.arbeitgeber.av);
  month.gesamt = {
    kv: round2(month.arbeitnehmer.kv + month.arbeitgeber.kv),
    pv: round2(month.arbeitnehmer.pv + month.arbeitgeber.pv),
    rv: round2(month.arbeitnehmer.rv + month.arbeitgeber.rv),
    av: round2(month.arbeitnehmer.av + month.arbeitgeber.av),
  };
  month.gesamt.summe = round2(month.gesamt.kv + month.gesamt.pv + month.gesamt.rv + month.gesamt.av);

  // Periodensumme: month * monthsWorked
  const period = {
    monthsWorked,
    arbeitnehmer: {
      kv: round2(month.arbeitnehmer.kv * monthsWorked),
      pv: round2(month.arbeitnehmer.pv * monthsWorked),
      rv: round2(month.arbeitnehmer.rv * monthsWorked),
      av: round2(month.arbeitnehmer.av * monthsWorked),
    },
    arbeitgeber: {
      kv: round2(month.arbeitgeber.kv * monthsWorked),
      pv: round2(month.arbeitgeber.pv * monthsWorked),
      rv: round2(month.arbeitgeber.rv * monthsWorked),
      av: round2(month.arbeitgeber.av * monthsWorked),
    },
    gesamt: {
      kv: round2(month.gesamt.kv * monthsWorked),
      pv: round2(month.gesamt.pv * monthsWorked),
      rv: round2(month.gesamt.rv * monthsWorked),
      av: round2(month.gesamt.av * monthsWorked),
    },
  };
  period.arbeitnehmer.summe = round2(period.arbeitnehmer.kv + period.arbeitnehmer.pv + period.arbeitnehmer.rv + period.arbeitnehmer.av);
  period.arbeitgeber.summe = round2(period.arbeitgeber.kv + period.arbeitgeber.pv + period.arbeitgeber.rv + period.arbeitgeber.av);
  period.gesamt.summe = round2(period.gesamt.kv + period.gesamt.pv + period.gesamt.rv + period.gesamt.av);

  return {
    month,
    period,
    meta: {
      year,
      unit,
      monthsWorked,
      region,
      bruttoMonat: round2(bruttoMonat),
      kvZusatzbeitragRate: kvZusatz,
      kinderUnter25,
      kinderlos,
      sachsen,
      waehrung: "EUR",
      note: "BBG/Deckelung wird pro Monat angewandt; period-Werte sind month * monthsWorked.",
    },
  };
}

export const svTables = SV_TABLES;

// Optional: Tabellen exportieren (RAW) + Hinweis zur Umrechnung
export const tables = Object.freeze({
  durchschnittsentgeltRaw: DURCHSCHNITTSENTGELT_RAW,
  rentenwertScheduleRaw: RENTENWERT_SCHEDULE_RAW,
  dmPerEur: DM_PER_EUR,
  svTables,
});