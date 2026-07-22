/* ==========================================================================
   Sauvegardes automatiques — copie horodatée du fichier SQLite avec
   rotation (rétention configurable). Répond à l'exigence « Sauvegardes
   automatiques » du cahier des charges V3.
   --------------------------------------------------------------------------
   En production avec un vrai SGBD serveur (PostgreSQL, recommandé dans
   README_BACKEND.md pour un déploiement multi-instance), remplacer ce
   module par `pg_dump` planifié + envoi vers un stockage objet
   (S3/GCS) — la logique de rotation/rétention ci-dessous reste valable.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function runBackupOnce(dbPath = config.dbPath, backupDir = config.backupDir, retentionCount = config.backupRetentionCount) {
  if (!fs.existsSync(dbPath)) {
    logger.warn("Sauvegarde ignorée : fichier de base de données introuvable", { dbPath });
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `yuki-${timestamp()}.sqlite`);
  fs.copyFileSync(dbPath, dest);
  logger.info("Sauvegarde effectuée", { dest });
  pruneOldBackups(backupDir, retentionCount);
  return dest;
}

function pruneOldBackups(backupDir, retentionCount) {
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith("yuki-") && f.endsWith(".sqlite"))
    .map(f => ({ f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files.slice(retentionCount)) {
    fs.unlinkSync(path.join(backupDir, f));
    logger.info("Ancienne sauvegarde supprimée (rétention)", { file: f });
  }
}

/* Planifie une sauvegarde toutes les `intervalHours` heures. Retourne le
   handle de `setInterval` pour permettre l'arrêt propre (tests, arrêt du
   serveur). Pour un vrai déploiement, un cron système appelant
   `scripts/backup-cron.js` est recommandé (plus robuste qu'un setInterval
   qui s'arrête avec le process) — voir README_BACKEND.md. */
function schedule(intervalHours = config.backupIntervalHours) {
  const ms = intervalHours * 60 * 60 * 1000;
  return setInterval(() => {
    try { runBackupOnce(); } catch (e) { logger.error("Échec de la sauvegarde planifiée", { error: e.message }); }
  }, ms);
}

module.exports = { runBackupOnce, pruneOldBackups, schedule };
