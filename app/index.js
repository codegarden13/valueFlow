import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// -----------------------------------------------------------------------------
// index.js – Minimaler Express-Server für das Dashboard
// -----------------------------------------------------------------------------
// Aufgaben:
// - Statisches Frontend aus /public ausliefern
// - Konfiguration aus config.json bereitstellen (/api/config)
// - CSV-Daten pro Quelle liefern (/api/data?sourceId=...)
//
// Hinweis zur Performance/Logs:
// - loadConfig() wird oft aufgerufen (pro Request). Daher:
//   * Cache mit mtime-Check (lädt nur neu, wenn config.json sich geändert hat)
//   * optionales Request-Logging für /api/*
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Achtung: Datei liegt im selben Verzeichnis wie index.js
const configPath = path.join(__dirname, "config.json");

// -----------------------------------------------------------------------------
// 1) Config Normalisierung
// -----------------------------------------------------------------------------
function normalizeConfig(cfgRaw) {
  const port = Number(cfgRaw?.port) || 3044;
  const delimiter = String(cfgRaw?.delimiter || ";");

  // Neues Format: sources[]
  let sources = Array.isArray(cfgRaw?.sources) ? cfgRaw.sources : [];

  sources = sources
    .map((s, i) => ({
      id: String(s?.id ?? `src${i}`).trim(),
      label: String(s?.label ?? s?.id ?? `Source ${i + 1}`).trim(),
      path: String(s?.path ?? "").trim(),
    }))
    .filter((s) => s.id && s.path);

  // Abwärtskompatibilität: altes Format csvPath
  const legacyPath = String(cfgRaw?.csvPath || "").trim();
  if (sources.length === 0 && legacyPath) {
    sources = [{ id: "default", label: "Default", path: legacyPath }];
  }

  return { port, delimiter, sources };
}

// -----------------------------------------------------------------------------
// 2) Config-Lader mit Cache (nur neu lesen, wenn Datei geändert wurde)
// -----------------------------------------------------------------------------
let _cachedCfg = null;
let _cachedMtimeMs = 0;

function loadConfigUncached() {
  const raw = fs.readFileSync(configPath, "utf8");
  const cfgRaw = JSON.parse(raw);
  return normalizeConfig(cfgRaw);
}

function loadConfig() {
  // Die Funktion wird pro Request aufgerufen; wir halten sie daher billig.
  try {
    const st = fs.statSync(configPath);

    // Wenn sich die Datei nicht geändert hat: Cache verwenden
    if (_cachedCfg && st.mtimeMs === _cachedMtimeMs) {
      return _cachedCfg;
    }

    // Sonst neu laden
    const cfg = loadConfigUncached();
    _cachedCfg = cfg;
    _cachedMtimeMs = st.mtimeMs;

    console.log("index - [loadConfig] reloaded (config changed)");
    return cfg;
  } catch (_e) {
    // Defensiver Fallback (Server läuft weiter)
    if (!_cachedCfg) {
      _cachedCfg = { port: 3044, delimiter: ";", sources: [] };
      _cachedMtimeMs = 0;
    }
    return _cachedCfg;
  }
}

// -----------------------------------------------------------------------------
// 3) Hilfsfunktionen
// -----------------------------------------------------------------------------
function resolveSource(cfg, sourceId) {
  if (!cfg.sources.length) return null;
  if (!sourceId) return cfg.sources[0];
  return cfg.sources.find((s) => s.id === sourceId) || cfg.sources[0];
}

function pickSourceId(query) {
  // Neu: ?sourceId=...   Alt: ?source=...
  if (typeof query?.sourceId === "string") return query.sourceId;
  if (typeof query?.source === "string") return query.source;
  return "";
}

// -----------------------------------------------------------------------------
// 4) Express Setup
// -----------------------------------------------------------------------------
const app = express();
const publicDir = path.join(__dirname, "public");

// Statisches Frontend
app.use(express.static(publicDir));

// Optional: sehr knappes Request-Logging für API-Routen
app.use("/api", (req, _res, next) => {
  console.log("[REQ]", req.method, req.originalUrl);
  next();
});

// -----------------------------------------------------------------------------
// 5) API Endpoints
// -----------------------------------------------------------------------------

// Health
app.get("/api/health", (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    port: cfg.port,
    delimiter: cfg.delimiter,
    sources: cfg.sources.map((s) => ({ id: s.id, label: s.label })),
    defaultSource: cfg.sources[0]?.id ?? null,
    configPath,
  });
});

// Config fürs Frontend
app.get("/api/config", (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    port: cfg.port,
    delimiter: cfg.delimiter,
    sources: cfg.sources.map((s) => ({ id: s.id, label: s.label })),
    defaultSource: cfg.sources[0]?.id ?? null,
  });
});

// Daten-Endpunkt (Quelle selektierbar)
app.get("/api/data", (req, res) => {
  const cfg = loadConfig();

  if (!cfg.sources.length) {
    return res.status(400).json({
      ok: false,
      error: "No sources configured. Add sources[] (or legacy csvPath) in app/config.json.",
    });
  }

  const sourceId = pickSourceId(req.query);
  const src = resolveSource(cfg, sourceId);

  if (!src?.path) {
    return res.status(400).json({
      ok: false,
      error: "No valid source path configured.",
    });
  }

  if (!fs.existsSync(src.path)) {
    return res.status(404).json({
      ok: false,
      error: `CSV not found: ${src.path}`,
      source: { id: src.id, label: src.label },
    });
  }

  const text = fs.readFileSync(src.path, "utf8");

  res.json({
    ok: true,
    delimiter: cfg.delimiter,
    source: { id: src.id, label: src.label },
    csvPath: src.path,
    text,
  });
});

// -----------------------------------------------------------------------------
// 6) Server Start
// -----------------------------------------------------------------------------
const cfg = loadConfig();
app.listen(cfg.port, () => {
  console.log(`[server] listening on http://localhost:${cfg.port}`);
  console.log(`[server] serving static from ${publicDir}`);
  console.log(`[server] config: ${configPath}`);
  console.log(
    `[server] sources: ${
      cfg.sources.length ? cfg.sources.map((s) => s.id).join(", ") : "(none)"
    }`
  );
});