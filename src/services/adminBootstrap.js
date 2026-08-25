/* ==========================================================================
   Amorçage des comptes administrateurs
   --------------------------------------------------------------------------
   Exécuté à chaque démarrage. Promeut au rôle « admin » les comptes dont
   l'adresse figure dans ADMIN_EMAIL.

   Trois précautions volontaires :

   1) On ne CRÉE aucun compte. Si l'adresse n'existe pas encore, on le
      journalise et on s'arrête. Créer un compte depuis une variable
      d'environnement reviendrait à fabriquer un accès sans mot de passe
      choisi par son propriétaire.

   2) On ne RÉTROGRADE personne. Retirer la variable ne retire pas le rôle :
      une faute de frappe lors d'un déploiement ne doit pas priver le
      propriétaire de son application.

   3) On n'écrit QUE si le rôle change réellement, pour ne pas toucher la
      base à chaque redémarrage sans raison.
   ========================================================================== */
const db = require("../db");
const config = require("../config");
const logger = require("../logger");

/* Journalise l'état réel, systématiquement. Sans cela, un silence au
   démarrage pouvait vouloir dire trois choses très différentes : le code
   n'est pas déployé, la variable est vide, ou tout va bien. On dit donc
   toujours QUI est administrateur en base — ce qui répond aussi à la
   question « quelle adresse avais-je promue ? », à laquelle rien ne
   permettait de répondre. */
function journaliserEtat(conn) {
  const admins = conn.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY email").all();
  logger.info("Administrateurs en base", {
    nombre: admins.length,
    adresses: admins.map(a => a.email)
  });
  return admins;
}

function bootstrapAdmins() {
  const emails = config.adminEmails || [];
  const conn = db.get();

  if (!emails.length) {
    /* Silence trompeur corrigé : on dit explicitement que la variable est
       absente, et on liste quand même les administrateurs existants. */
    logger.warn("ADMIN_EMAIL non renseignée — aucune promotion automatique. " +
                "Pour désigner un administrateur, ajoute cette variable dans l'environnement du service.");
    journaliserEtat(conn);
    return { promus: 0, deja: 0, introuvables: [], variableAbsente: true };
  }
  logger.info("ADMIN_EMAIL renseignée", { adresses: emails });

  const bilan = { promus: 0, deja: 0, introuvables: [] };

  for (const email of emails) {
    const row = conn.prepare("SELECT id, email, role FROM users WHERE lower(email) = ?").get(email);
    if (!row) { bilan.introuvables.push(email); continue; }
    if (row.role === "admin") { bilan.deja++; continue; }
    conn.prepare("UPDATE users SET role = ? WHERE id = ?").run("admin", row.id);
    bilan.promus++;
    logger.info("Compte promu administrateur au démarrage", { email: row.email, ancienRole: row.role });
  }

  journaliserEtat(conn);

  if (bilan.introuvables.length) {
    /* Cas normal au premier déploiement : le compte n'est pas encore créé.
       Le message dit quoi faire plutôt que de laisser deviner. */
    logger.warn("ADMIN_EMAIL désigne des comptes inexistants — crée-les dans l'application, puis redémarre le service", {
      adresses: bilan.introuvables
    });
  }
  return bilan;
}

module.exports = { bootstrapAdmins };
