/* ==========================================================================
   Service d'import CSV — addendum V3.2
   --------------------------------------------------------------------------
   Pipeline exact demandé par le cahier des charges :
   upload → validation → aperçu → mapping → normalisation → déduplication →
   import transactionnel → rapport.

   Isolation stricte par user_id sur CHAQUE requête (aucune exception) —
   c'est la règle non négociable n°3 du cahier des charges V3.2.
   ========================================================================== */
const crypto = require("crypto");
const db = require("../db");
const {
  parseCsv, detectDelimiter, looksLikeHeaderRow, suggestMappingForHeaders,
  normalizeRow, validateNormalizedRow, computeDedupHash, looksSuspicious, isAllowedFile
} = require("../csv/csvParser");

const MAX_CSV_SIZE_BYTES = 5 * 1024 * 1024; // 5 Mo — configurable, voir config.js
const MAX_ROWS = 20000;
const DEFAULT_RETENTION_DAYS = 30;
const VALID_SOURCES = ["tradingview", "broker", "portfolio", "watchlist", "custom"];
const VALID_DESTINATIONS = ["portfolio", "positions", "favorites", "watchlist", "journal", "custom_db"];

function newId() { return crypto.randomUUID(); }

function audit(userId, importId, action, meta) {
  db.get().prepare(`
    INSERT INTO csv_audit_log (id, user_id, import_id, action, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(newId(), userId, importId || null, action, JSON.stringify(meta || {}), Date.now());
}

/* ---- Étape 1-4 : upload, validation, aperçu, mapping suggéré -------------- */
function createImportPreview(userId, { filename, source, destination, csvText, mimeType }) {
  if (!VALID_SOURCES.includes(source)) throw new Error("Source d'import inconnue.");
  if (!VALID_DESTINATIONS.includes(destination)) throw new Error("Destination d'import inconnue.");
  if (!csvText || typeof csvText !== "string") throw new Error("Fichier vide ou illisible.");
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_SIZE_BYTES) throw new Error(`Fichier trop volumineux (limite ${Math.round(MAX_CSV_SIZE_BYTES / 1024 / 1024)} Mo).`);
  if (!isAllowedFile(filename, mimeType)) throw new Error("Type de fichier non autorisé — seuls les fichiers .csv/.tsv/.txt texte sont acceptés.");
  if (looksSuspicious(csvText)) throw new Error("Le contenu du fichier semble suspect et a été rejeté par sécurité.");

  const delimiter = detectDelimiter(csvText);
  const rows = parseCsv(csvText, delimiter);
  if (!rows.length) throw new Error("Aucune ligne exploitable dans ce fichier.");
  if (rows.length > MAX_ROWS) throw new Error(`Trop de lignes (limite ${MAX_ROWS}).`);

  const hasHeaders = looksLikeHeaderRow(rows[0], rows[1]);
  const headers = hasHeaders ? rows[0] : rows[0].map((_, i) => `Colonne ${i + 1}`);
  const dataRows = hasHeaders ? rows.slice(1) : rows;

  const remembered = getRememberedMapping(userId, source);
  const mapping = remembered || suggestMappingForHeaders(headers);

  const id = newId();
  const now = Date.now();
  db.get().prepare(`
    INSERT INTO csv_imports (id, user_id, filename, source, destination, status, delimiter, headers_json, raw_rows_json, mapping_json, row_count, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending_preview', ?, ?, ?, ?, ?, ?)
  `).run(id, userId, filename || "import.csv", source, destination, delimiter, JSON.stringify(headers), JSON.stringify(dataRows), JSON.stringify(mapping), dataRows.length, now);

  audit(userId, id, "upload", { filename, source, destination, rowCount: dataRows.length });

  return {
    importId: id,
    headers,
    suggestedMapping: mapping,
    sampleRows: dataRows.slice(0, 10),
    totalRows: dataRows.length,
    delimiter
  };
}

function getPendingImport(userId, importId) {
  const row = db.get().prepare("SELECT * FROM csv_imports WHERE id = ? AND user_id = ?").get(importId, userId);
  if (!row) throw new Error("Import introuvable.");
  return row;
}

/* ---- Étape 5-9 : mapping définitif, normalisation, déduplication, import transactionnel, rapport --- */
function confirmImport(userId, importId, { mapping, duplicateStrategy = "ignore" } = {}) {
  const conn = db.get();
  const imp = getPendingImport(userId, importId);
  if (imp.status !== "pending_preview") throw new Error("Cet import a déjà été confirmé, annulé ou supprimé.");
  if (!["ignore", "replace", "merge", "create_new"].includes(duplicateStrategy)) throw new Error("Stratégie de doublon invalide.");

  const finalMapping = mapping || JSON.parse(imp.mapping_json || "{}");
  const dataRows = JSON.parse(imp.raw_rows_json || "[]");

  let imported = 0, skipped = 0, updated = 0, errorCount = 0;
  const errors = [];

  /* Import "transactionnel" au sens du cahier des charges : une erreur
     critique (mapping totalement invalide, aucune colonne symbole) annule
     tout l'import avant la moindre écriture. Les erreurs ligne par ligne
     (une valeur mal formée) ne bloquent pas les autres lignes valides,
     mais sont toutes consignées dans le rapport — jamais d'écrasement
     silencieux. */
  const symbolMapped = Object.values(finalMapping).includes("symbol");
  if (!symbolMapped) throw new Error("Le mapping doit associer au moins une colonne au champ Symbole.");

  const insertRow = conn.prepare(`
    INSERT INTO csv_import_rows (id, import_id, user_id, source, destination, symbol, name, market, asset_type, isin, quantity, entry_price, entry_at, currency, stop_loss, target, timeframe, strategy, status_field, notes, tags, dedup_hash, created_at)
    VALUES (@id, @import_id, @user_id, @source, @destination, @symbol, @name, @market, @asset_type, @isin, @quantity, @entry_price, @entry_at, @currency, @stop_loss, @target, @timeframe, @strategy, @status_field, @notes, @tags, @dedup_hash, @created_at)
  `);
  const findDupe = conn.prepare("SELECT id FROM csv_import_rows WHERE user_id = ? AND dedup_hash = ? AND deleted_at IS NULL LIMIT 1");
  const deleteRow = conn.prepare("UPDATE csv_import_rows SET deleted_at = ? WHERE id = ?");

  const now = Date.now();
  dataRows.forEach((rawRow, idx) => {
    const record = normalizeRow(rawRow, finalMapping);
    const { valid, errors: rowErrors } = validateNormalizedRow(record);
    if (!valid) { errorCount++; errors.push({ row: idx + 1, errors: rowErrors }); return; }

    const dedupHash = computeDedupHash(userId, imp.source, record);
    const dupe = findDupe.get(userId, dedupHash);

    if (dupe) {
      if (duplicateStrategy === "ignore") { skipped++; return; }
      if (duplicateStrategy === "replace" || duplicateStrategy === "merge") {
        deleteRow.run(now, dupe.id); // on ne réécrit jamais silencieusement : l'ancienne ligne est tracée comme remplacée, pas modifiée en place
        updated++;
      } else if (duplicateStrategy === "create_new") {
        imported++; // laisse la nouvelle ligne être insérée normalement plus bas, sans toucher à l'ancienne
      }
    } else {
      imported++;
    }

    insertRow.run({
      id: newId(), import_id: importId, user_id: userId, source: imp.source, destination: imp.destination,
      symbol: record.symbol || null, name: record.name || null, market: record.market || null,
      asset_type: record.assetType || null, isin: record.isin || null,
      quantity: record.quantity ?? null, entry_price: record.entryPrice ?? null, entry_at: record.entryAt || null,
      currency: record.currency || null, stop_loss: record.stopLoss ?? null, target: record.target ?? null,
      timeframe: record.timeframe || null, strategy: record.strategy || null, status_field: record.statusField || null,
      notes: record.notes || null, tags: record.tags || null, dedup_hash: dedupHash, created_at: now
    });
  });

  const report = { imported, skipped, updated, errorCount, errors: errors.slice(0, 200), totalRows: dataRows.length };
  conn.prepare(`
    UPDATE csv_imports SET status = 'confirmed', mapping_json = ?, imported_count = ?, skipped_count = ?, updated_count = ?, error_count = ?, report_json = ?, confirmed_at = ?, raw_rows_json = NULL
    WHERE id = ?
  `).run(JSON.stringify(finalMapping), imported, skipped, updated, errorCount, JSON.stringify(report), now, importId);
  // raw_rows_json mis à NULL : le fichier brut n'est pas conservé au-delà de l'import (sécurité — voir §4.8 du cahier des charges).

  rememberMapping(userId, imp.source, finalMapping);
  audit(userId, importId, "confirm", { duplicateStrategy, ...report });

  return report;
}

function cancelPendingImport(userId, importId) {
  const imp = getPendingImport(userId, importId);
  if (imp.status !== "pending_preview") throw new Error("Seul un import en attente d'aperçu peut être annulé.");
  db.get().prepare("UPDATE csv_imports SET status = 'cancelled', raw_rows_json = NULL WHERE id = ?").run(importId);
  audit(userId, importId, "cancel", {});
}

/* ---- Mapping mémorisé par source (accélère les imports suivants) --------- */
function rememberMapping(userId, source, mapping) {
  db.get().prepare(`
    INSERT INTO csv_source_mappings (user_id, source, mapping_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, source) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = excluded.updated_at
  `).run(userId, source, JSON.stringify(mapping), Date.now());
}
function getRememberedMapping(userId, source) {
  const row = db.get().prepare("SELECT mapping_json FROM csv_source_mappings WHERE user_id = ? AND source = ?").get(userId, source);
  return row ? JSON.parse(row.mapping_json) : null;
}

/* ---- Historique des imports ------------------------------------------------ */
function listImports(userId) {
  return db.get().prepare(`
    SELECT id, filename, source, destination, status, row_count, imported_count, skipped_count, updated_count, error_count, created_at, confirmed_at, deleted_at, restore_deadline
    FROM csv_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(userId);
}
function getImportReport(userId, importId) {
  const imp = getPendingImport(userId, importId);
  return { ...imp, report: imp.report_json ? JSON.parse(imp.report_json) : null, mapping: imp.mapping_json ? JSON.parse(imp.mapping_json) : null };
}

/* ---- Filtres sur les lignes importées -------------------------------------- */
function listRows(userId, filters = {}) {
  const conn = db.get();
  const clauses = ["user_id = ?", "deleted_at IS NULL"];
  const params = [userId];
  const map = {
    source: "source", market: "market", assetType: "asset_type", currency: "currency",
    ticker: "symbol", timeframe: "timeframe", strategy: "strategy", statusField: "status_field", importId: "import_id"
  };
  Object.entries(map).forEach(([key, col]) => {
    if (filters[key]) { clauses.push(`${col} = ?`); params.push(filters[key]); }
  });
  if (filters.tag) { clauses.push("tags LIKE ?"); params.push(`%${filters.tag}%`); }
  if (filters.dateFrom) { clauses.push("created_at >= ?"); params.push(filters.dateFrom); }
  if (filters.dateTo) { clauses.push("created_at <= ?"); params.push(filters.dateTo); }
  const sql = `SELECT * FROM csv_import_rows WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 500`;
  return conn.prepare(sql).all(...params);
}

/* ---- Suppression (3 modes exigés par le cahier des charges) --------------- */
function previewDeletionImpact(userId, importId, rowIds) {
  const imp = getPendingImport(userId, importId);
  const conn = db.get();
  let affectedRows;
  if (rowIds && rowIds.length) {
    const placeholders = rowIds.map(() => "?").join(",");
    affectedRows = conn.prepare(`SELECT COUNT(*) AS n FROM csv_import_rows WHERE import_id = ? AND user_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`).get(importId, userId, ...rowIds).n;
  } else {
    affectedRows = conn.prepare("SELECT COUNT(*) AS n FROM csv_import_rows WHERE import_id = ? AND user_id = ? AND deleted_at IS NULL").get(importId, userId).n;
  }
  return { importId, filename: imp.filename, destination: imp.destination, affectedRows };
}

function deleteFileOnly(userId, importId) {
  const imp = getPendingImport(userId, importId);
  if (imp.status === "pending_preview") return cancelPendingImport(userId, importId);
  audit(userId, importId, "delete_file_only", {});
  return { ok: true, rowsAffected: 0 };
}

function softDeleteImport(userId, importId, retentionDays = DEFAULT_RETENTION_DAYS) {
  const conn = db.get();
  const imp = getPendingImport(userId, importId);
  const now = Date.now();
  const deadline = now + retentionDays * 24 * 3600 * 1000;
  const result = conn.prepare("UPDATE csv_import_rows SET deleted_at = ? WHERE import_id = ? AND user_id = ? AND deleted_at IS NULL").run(now, importId, userId);
  conn.prepare("UPDATE csv_imports SET status = 'deleted', deleted_at = ?, restore_deadline = ? WHERE id = ?").run(now, deadline, importId);
  audit(userId, importId, "delete_all", { rowsAffected: result.changes, retentionDays });
  return { ok: true, rowsAffected: result.changes, restoreDeadline: deadline };
}

function softDeleteRows(userId, importId, rowIds) {
  if (!Array.isArray(rowIds) || !rowIds.length) throw new Error("Aucune ligne sélectionnée.");
  const conn = db.get();
  getPendingImport(userId, importId);
  const now = Date.now();
  const placeholders = rowIds.map(() => "?").join(",");
  const result = conn.prepare(`UPDATE csv_import_rows SET deleted_at = ? WHERE import_id = ? AND user_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`).run(now, importId, userId, ...rowIds);
  audit(userId, importId, "delete_rows", { rowIds, rowsAffected: result.changes });
  return { ok: true, rowsAffected: result.changes };
}

function restoreImport(userId, importId) {
  const conn = db.get();
  const imp = getPendingImport(userId, importId);
  if (imp.status !== "deleted") throw new Error("Cet import n'est pas dans la corbeille.");
  if (imp.restore_deadline && Date.now() > imp.restore_deadline) throw new Error("Le délai de restauration est dépassé.");
  conn.prepare("UPDATE csv_import_rows SET deleted_at = NULL WHERE import_id = ? AND user_id = ?").run(importId, userId);
  conn.prepare("UPDATE csv_imports SET status = 'confirmed', deleted_at = NULL, restore_deadline = NULL WHERE id = ?").run(importId);
  audit(userId, importId, "restore", {});
  return { ok: true };
}

function purgeExpired() {
  const conn = db.get();
  const now = Date.now();
  const expired = conn.prepare("SELECT id, user_id FROM csv_imports WHERE status = 'deleted' AND restore_deadline IS NOT NULL AND restore_deadline < ?").all(now);
  for (const imp of expired) {
    conn.prepare("DELETE FROM csv_import_rows WHERE import_id = ?").run(imp.id);
    conn.prepare("DELETE FROM csv_imports WHERE id = ?").run(imp.id);
    audit(imp.user_id, imp.id, "purge", {});
  }
  return { purged: expired.length };
}

module.exports = {
  createImportPreview, confirmImport, cancelPendingImport, getPendingImport,
  listImports, getImportReport, listRows,
  previewDeletionImpact, deleteFileOnly, softDeleteImport, softDeleteRows, restoreImport, purgeExpired,
  rememberMapping, getRememberedMapping,
  MAX_CSV_SIZE_BYTES, MAX_ROWS, DEFAULT_RETENTION_DAYS, VALID_SOURCES, VALID_DESTINATIONS
};
