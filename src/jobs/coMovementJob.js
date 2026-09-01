/* Tâche nocturne « Ondes de choc » : recalcul du co-mouvement mesuré.
   Activée si une clé de données serveur est fournie (CONTEXT_DATA_KEY).
   Une passe au démarrage (après une minute), puis toutes les 24 h. */
const config = require("../config");
const logger = require("../logger");
const coMovement = require("../services/coMovement");

let running = false;
async function runOnce() {
  if (running || !config.context.enabled || !config.context.apiKey) return null;
  running = true;
  try { return await coMovement.computeAll({ apiKey: config.context.apiKey, delayMs: config.context.delayMs }); }
  catch (e) { logger.warn("[ondes] recalcul impossible", { erreur: e.message }); return null; }
  finally { running = false; }
}
function schedule() {
  if (!config.context.enabled || !config.context.apiKey) { logger.info("[ondes] désactivé (pas de CONTEXT_DATA_KEY)"); return null; }
  setTimeout(() => { runOnce(); }, 60 * 1000);
  return setInterval(() => { runOnce(); }, 24 * 60 * 60 * 1000);
}
module.exports = { schedule, runOnce };
