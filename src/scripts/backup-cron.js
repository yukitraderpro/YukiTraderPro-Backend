#!/usr/bin/env node
/* Exécute une sauvegarde unique, prévu pour être appelé par un cron système
   ou un timer systemd (plus robuste en production qu'un setInterval interne
   au process serveur, qui s'arrête si le process redémarre).

   Exemple de crontab (sauvegarde toutes les nuits à 3h10) :
     10 3 * * * cd /opt/yuki-backend && node scripts/backup-cron.js >> /var/log/yuki-backup.log 2>&1
*/
require("../src/loadEnv")();
const backupService = require("../src/services/backupService");

const dest = backupService.runBackupOnce();
if (dest) {
  console.log("Sauvegarde créée :", dest);
  process.exit(0);
} else {
  console.error("Sauvegarde non créée (voir logs).");
  process.exit(1);
}
