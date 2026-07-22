/* ==========================================================================
   Synchronisation cloud — critère d'acceptation « Connexion multi-appareils »
   --------------------------------------------------------------------------
   Le client envoie ici l'état applicatif qu'il gère déjà localement
   (journal de trading, positions, signaux, favoris, préférences, poids
   adaptatifs des indicateurs) tel quel — cette route ne lit ni n'interprète
   son contenu, elle le stocke et le restitue en JSON opaque. Le moteur
   d'analyse et le format de `state` restent donc strictement ceux de la V2,
   inchangés : ce module ne fait qu'ajouter une persistance serveur en plus
   du `localStorage` déjà existant.

   Stratégie de conflit : "dernier écrit gagne" avec un numéro de version
   simple, suffisant pour un usage mono-utilisateur multi-appareils typique
   de cette application (pas d'édition collaborative concurrente). Le champ
   `version` renvoyé permet au client de détecter un écrasement inattendu
   s'il le souhaite (non exploité par le client V2 fourni, prêt pour une
   future évolution).
   ========================================================================== */
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const { HttpError } = require("../http/server");

const router = new Router();
const MAX_PAYLOAD_CHARS = 1_500_000; // ~1.5 Mo de JSON, large marge pour un historique de plusieurs années

router.get("/state", authenticate, async ctx => {
  const row = db.get().prepare("SELECT payload, updated_at, version FROM sync_state WHERE user_id = ?").get(ctx.userId);
  if (!row) { ctx.res.json(200, { state: null, updatedAt: null, version: 0 }); return; }
  ctx.res.json(200, { state: JSON.parse(row.payload), updatedAt: row.updated_at, version: row.version });
});

router.put("/state", authenticate, async ctx => {
  const { state } = ctx.body || {};
  if (state === undefined) throw new HttpError(400, "Champ `state` requis.");
  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_PAYLOAD_CHARS) throw new HttpError(413, "État trop volumineux pour la synchronisation.");
  const conn = db.get();
  const now = Date.now();
  const existing = conn.prepare("SELECT version FROM sync_state WHERE user_id = ?").get(ctx.userId);
  const nextVersion = existing ? existing.version + 1 : 1;
  conn.prepare(`
    INSERT INTO sync_state (user_id, payload, updated_at, version) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, version = excluded.version
  `).run(ctx.userId, serialized, now, nextVersion);
  ctx.res.json(200, { ok: true, updatedAt: now, version: nextVersion });
});

router.get("/devices", authenticate, async ctx => {
  const rows = db.get().prepare("SELECT id, label, platform, first_seen_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC").all(ctx.userId);
  ctx.res.json(200, { devices: rows });
});

router.delete("/devices/:id", authenticate, async ctx => {
  const conn = db.get();
  const device = conn.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(ctx.params.id, ctx.userId);
  if (!device) throw new HttpError(404, "Appareil introuvable.");
  conn.prepare("DELETE FROM devices WHERE id = ?").run(ctx.params.id);
  conn.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(Date.now(), ctx.params.id);
  ctx.res.json(200, { ok: true });
});

module.exports = router;
