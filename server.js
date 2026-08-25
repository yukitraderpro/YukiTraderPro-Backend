#!/usr/bin/env node
require("./src/loadEnv")();
const config = require("./src/config");
const db = require("./src/db");
const logger = require("./src/logger");
const buildApp = require("./src/app");
const backupService = require("./src/services/backupService");
const scheduledScan = require("./src/jobs/scheduledScan");
const csvImportService = require("./src/services/csvImportService");
const adminBootstrap = require("./src/services/adminBootstrap");

db.open();

/* Promotion des administrateurs désignés — après l'ouverture de la base,
   avant que le serveur n'accepte des requêtes. Un échec ici ne doit jamais
   empêcher le démarrage : mieux vaut une application debout sans admin
   qu'une application à terre. */
try {
  /* Toujours journaliser : un silence ne doit plus pouvoir signifier
     « code non déployé » aussi bien que « tout va bien ». */
  logger.info("Amorçage administrateurs", adminBootstrap.bootstrapAdmins());
} catch (e) {
  logger.error("Amorçage administrateurs impossible", { error: e.message });
}

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
