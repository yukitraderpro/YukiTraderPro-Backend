#!/usr/bin/env node
require("./src/loadEnv")();
const config = require("./src/config");
const db = require("./src/db");
const logger = require("./src/logger");
const buildApp = require("./src/app");
const backupService = require("./src/services/backupService");
const scheduledScan = require("./src/jobs/scheduledScan");
const csvImportService = require("./src/services/csvImportService");

db.open();
const app = buildApp();

const server = app.listen(config.port, config.host, () => {
  logger.info("Serveur Yuki Trader Pro (backend) démarré", { port: config.port, env: config.nodeEnv });
});

const backupTimer = backupService.schedule();
const scanTimer = config.scheduledScan.enabled ? scheduledScan.schedule() : null;
const csvPurgeTimer = setInterval(() => {
  try { const r = csvImportService.purgeExpired(); if (r.purged) logger.info("Purge CSV expirés", r); }
  catch (e) { logger.error("Erreur purge CSV", { error: e.message }); }
}, 6 * 60 * 60 * 1000); // toutes les 6h

function shutdown(signal) {
  logger.info("Arrêt du serveur", { signal });
  clearInterval(backupTimer);
  if (scanTimer) clearInterval(scanTimer);
  clearInterval(csvPurgeTimer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app, server };
