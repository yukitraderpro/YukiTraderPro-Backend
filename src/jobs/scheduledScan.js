/* ==========================================================================
   Scan planifié côté serveur (optionnel, désactivé par défaut) — pour des
   notifications qui fonctionnent même application fermée, indépendamment
   de la présence de l'utilisateur (contrairement au scan client V1.1/V2 qui
   ne tourne que quand l'onglet est ouvert).
   --------------------------------------------------------------------------
   ⚠️ LIMITE ASSUMÉE ET DOCUMENTÉE (voir Difficultes_YukiTraderPro_V3.md) :
   Ce job ne réimplémente PAS et NE DUPLIQUE PAS la logique de décision
   (`analyseSeries`, calcul du score de base, seuils ACHETER/VENDRE/ATTENDRE).
   Cette logique vit aujourd'hui dans `app.js`, mélangée à du code d'interface
   (DOM, `fetch` vers Twelve Data avec la clé de l'utilisateur, rendu HTML),
   ce qui empêche de la réutiliser telle quelle côté serveur sans une
   extraction de code — une extraction qui, même sans changer une seule
   ligne de logique, reste une modification de structure du moteur que le
   cahier des charges V3 interdit sans validation explicite (« Toute
   modification de la logique d'analyse [...] est interdite, sauf pour
   corriger un bug démontré »). Ce module a donc été laissé au stade de
   squelette fonctionnel, gardé désactivé par défaut
   (`SCHEDULED_SCAN_ENABLED=false`), en attendant cette validation.

   Ce qui EST fonctionnel et testé dans cette livraison V3 :
   - `analysisEngine/analysis.js` est une copie strictement identique
     (voir test/engineIntegrity.test.js, comparaison octet par octet) du
     moteur pur du client, prête à être appelée ici dès que la fonction
     d'orchestration (`analyseSeries`) sera elle aussi exposée en module
     pur côté client — un changement mécanique proposé mais non appliqué
     (voir README_BACKEND.md « Prochaine étape recommandée »).
   - La chaîne d'envoi de notification (FCM) fonctionne de bout en bout et
     est testable indépendamment via `POST /api/notifications/send-test`,
     qui prouve que la partie « livraison app fermée » de l'infrastructure
     est opérationnelle, même si le déclenchement automatique par analyse
     ne l'est pas encore dans cette livraison.
   ========================================================================== */
const db = require("../db");
const fcmService = require("../services/fcmService");
const logger = require("../logger");
const config = require("../config");

async function runScanOnce() {
  if (!config.scheduledScan.enabled) {
    logger.debug("Scan planifié désactivé (SCHEDULED_SCAN_ENABLED=false) — aucune action.");
    return { skipped: true };
  }
  const conn = db.get();
  const rows = conn.prepare("SELECT user_id, payload FROM sync_state").all();
  let scanned = 0, notified = 0;
  for (const row of rows) {
    let state;
    try { state = JSON.parse(row.payload); } catch { continue; }
    if (!state || !state.apiKey || !Array.isArray(state.favorites) || !state.favorites.length) continue;

    // TODO (bloqué, voir en-tête de ce fichier) : appeler ici l'équivalent
    // serveur de `analyseSeries(values, weights)` pour chaque favori, avec
    // `state.indicatorWeights` déjà synchronisé, puis appliquer les mêmes
    // seuils de notification que le client (`state.prefs.notifyThreshold`,
    // `state.prefs.minQualityGrade`) avant d'appeler `sendPushToUser`.
    scanned++;
  }
  logger.info("Scan planifié terminé", { scanned, notified });
  return { scanned, notified };
}

async function sendPushToUser(userId, notification) {
  const conn = db.get();
  const tokens = conn.prepare("SELECT fcm_token FROM notification_tokens WHERE user_id = ?").all(userId);
  const results = [];
  for (const t of tokens) {
    try { results.push(await fcmService.sendPush(t.fcm_token, notification)); }
    catch (e) { logger.error("Échec push planifié", { userId, error: e.message }); }
  }
  return results;
}

function schedule(intervalMinutes = config.scheduledScan.intervalMinutes) {
  return setInterval(() => { runScanOnce().catch(e => logger.error("Erreur scan planifié", { error: e.message })); }, intervalMinutes * 60 * 1000);
}

module.exports = { runScanOnce, sendPushToUser, schedule };
