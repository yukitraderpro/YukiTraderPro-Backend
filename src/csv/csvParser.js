/* ==========================================================================
   Import CSV — utilitaires purs (addendum V3.2 « Module d'import CSV »)
   --------------------------------------------------------------------------
   Aucune dépendance à la base de données ni au réseau : ce module ne fait
   que du texte → structures de données, entièrement testable en isolation
   (voir backend/test/csv-parser.test.js). C'est délibérément un module
   indépendant du moteur d'analyse — voir la contrainte du cahier des
   charges V3.2 (« Ne modifier aucune ligne du moteur d'analyse »).
   ========================================================================== */
const crypto = require("crypto");

/* ---- Détection du délimiteur ---------------------------------------------
   Comma, point-virgule ou tabulation, comme demandé. On compte les
   occurrences de chaque candidat sur les premières lignes et on retient le
   plus fréquent — plus robuste qu'un simple `includes()`. */
function detectDelimiter(sampleText) {
  const candidates = [",", ";", "\t"];
  const lines = sampleText.split(/\r?\n/).slice(0, 5).filter(Boolean);
  if (!lines.length) return ",";
  let best = ",", bestCount = -1;
  for (const c of candidates) {
    const count = lines.reduce((sum, line) => sum + (line.split(c).length - 1), 0);
    if (count > bestCount) { bestCount = count; best = c; }
  }
  return best;
}

/* ---- Parseur CSV minimal mais correct (gère les champs entre guillemets,
   les guillemets échappés "" et les retours à la ligne dans un champ). */
function parseCsv(text, delimiter) {
  if (!text) return [];
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === d) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

/* ---- Détection d'en-têtes -------------------------------------------------
   Heuristique simple : si la première ligne contient majoritairement du
   texte non numérique et que la deuxième ligne contient au moins une valeur
   numérique, on considère la première ligne comme des en-têtes. */
function looksLikeHeaderRow(row, nextRow) {
  if (!row || !row.length) return false;
  const numericInRow = row.filter(c => c !== "" && !isNaN(Number(String(c).replace(",", ".")))).length;
  const textRatio = 1 - numericInRow / row.length;
  if (!nextRow) return textRatio > 0.5;
  const numericInNext = nextRow.filter(c => c !== "" && !isNaN(Number(String(c).replace(",", ".")))).length;
  // >= plutôt que > : si aucune des deux lignes n'a de colonne numérique
  // (ex. CSV entièrement textuel), on suppose que la première ligne est un
  // en-tête plutôt que de la traiter comme une ligne de données — c'est le
  // cas le plus courant en pratique pour des exports de trading.
  return textRatio > 0.5 && numericInNext >= numericInRow;
}

/* ---- Suggestion de mapping automatique ------------------------------------
   Associe chaque en-tête détecté au champ Yuki le plus probable, à partir
   d'un dictionnaire de synonymes couvrant les exports TradingView et les
   intitulés courants de courtiers. Ne devine jamais au hasard : une colonne
   non reconnue reste `null` et devra être associée manuellement. */
const FIELD_SYNONYMS = {
  symbol: ["symbol", "ticker", "symbole", "code"],
  name: ["name", "nom", "instrument", "description", "asset"],
  market: ["market", "exchange", "marché", "marche", "bourse"],
  assetType: ["type", "asset type", "type d'actif", "category", "catégorie"],
  isin: ["isin"],
  quantity: ["quantity", "qty", "quantité", "quantite", "size", "shares"],
  entryPrice: ["entry price", "avg price", "prix d'entrée", "prix d'entree", "price", "open price", "entry"],
  entryAt: ["entry date", "date", "date d'entrée", "date d'entree", "opened", "open time", "time"],
  currency: ["currency", "devise", "ccy"],
  stopLoss: ["stop loss", "stop-loss", "stop", "sl"],
  target: ["target", "objectif", "take profit", "tp"],
  timeframe: ["timeframe", "unité de temps", "unite de temps", "interval"],
  strategy: ["strategy", "stratégie", "strategie", "setup"],
  statusField: ["status", "statut", "state", "open/closed"],
  notes: ["notes", "note", "comment", "commentaire"],
  tags: ["tags", "tag", "labels"]
};
function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function suggestMappingForHeaders(headers) {
  const mapping = {};
  headers.forEach((h, idx) => {
    const nh = normalizeHeader(h);
    let matchedField = null;
    for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
      if (synonyms.some(s => normalizeHeader(s) === nh)) { matchedField = field; break; }
    }
    mapping[idx] = matchedField; // index de colonne -> champ Yuki (ou null)
  });
  return mapping;
}

/* ---- Normalisation d'une ligne --------------------------------------------
   Applique le mapping {colonneIndex: champYuki} à une ligne brute pour
   produire un enregistrement dans le vocabulaire Yuki. */
function parseNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
/* Neutralise une amorce de formule (=, +, -, @) en tête de champ — défense
   contre l'injection CSV/formule si la donnée est un jour réexportée vers un
   tableur (Excel/Sheets exécuterait sinon la formule à l'ouverture). */
function sanitizeCell(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}
function normalizeRow(rawRow, mapping) {
  const record = {};
  Object.entries(mapping).forEach(([colIdx, field]) => {
    if (!field) return;
    const raw = sanitizeCell(rawRow[+colIdx]);
    if (["quantity", "entryPrice", "stopLoss", "target"].includes(field)) record[field] = parseNumber(raw);
    else record[field] = raw === "" ? null : raw;
  });
  return record;
}

/* ---- Validation ------------------------------------------------------------
   Le symbole est le seul champ strictement requis (c'est la clé de tout le
   reste : sans lui, une ligne ne peut être rattachée à aucun instrument). */
function validateNormalizedRow(record) {
  const errors = [];
  if (!record.symbol) errors.push("Symbole manquant.");
  if (record.quantity !== undefined && record.quantity !== null && !(record.quantity > 0)) errors.push("Quantité invalide.");
  if (record.entryPrice !== undefined && record.entryPrice !== null && !(record.entryPrice > 0)) errors.push("Prix d'entrée invalide.");
  return { valid: errors.length === 0, errors };
}

/* ---- Hash de déduplication -------------------------------------------------
   Basé sur utilisateur + source + symbole + date + identifiant externe s'il
   existe — comme demandé. Stable (même entrée = même hash), pour détecter
   un doublon même si l'utilisateur réimporte le même fichier. */
function computeDedupHash(userId, source, record) {
  const key = [userId, source, (record.symbol || "").toUpperCase(), record.entryAt || "", record.externalId || ""].join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

/* ---- Sécurité : contenu suspect -------------------------------------------- */
const SUSPICIOUS_PATTERNS = [/^MZ/, /<script/i, /powershell/i, /cmd\.exe/i, /base64,/i, /\x00/];
function looksSuspicious(rawText) {
  return SUSPICIOUS_PATTERNS.some(re => re.test(rawText.slice(0, 4096)));
}
const ALLOWED_MIME_TYPES = ["text/csv", "text/plain", "application/vnd.ms-excel", "application/csv"];
const ALLOWED_EXTENSIONS = [".csv", ".tsv", ".txt"];
function isAllowedFile(filename, mimeType) {
  const ext = ("." + String(filename || "").split(".").pop()).toLowerCase();
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  const mimeOk = !mimeType || ALLOWED_MIME_TYPES.includes(mimeType);
  return extOk && mimeOk;
}

module.exports = {
  detectDelimiter, parseCsv, looksLikeHeaderRow, suggestMappingForHeaders,
  normalizeRow, validateNormalizedRow, computeDedupHash, parseNumber, sanitizeCell,
  looksSuspicious, isAllowedFile, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, FIELD_SYNONYMS
};
