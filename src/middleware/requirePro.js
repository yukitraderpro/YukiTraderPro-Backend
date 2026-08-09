/* ==========================================================================
   Middleware : exige un accès Pro *effectif*, vérifié côté serveur.
   --------------------------------------------------------------------------
   Pourquoi ce fichier existe
   --------------------------
   Le client décide déjà de ce qu'il affiche (voir auth.js, isTrialActive).
   Mais ce contrôle vit dans le navigateur : n'importe qui peut se donner le
   rôle "pro" depuis la console de développement. Un verrou client protège
   contre l'oubli, pas contre la volonté.

   Ce middleware place la décision là où l'utilisateur n'a pas la main : sur
   le serveur, à partir de la base. Il ne fait confiance à AUCUNE valeur
   transmise par le client — ni le rôle porté par le JWT, ni un quelconque
   en-tête. Il relit systématiquement l'utilisateur en base.

   Ce qu'il protège, et ce qu'il ne protège pas
   -------------------------------------------
   Il protège tout ce qui transite par le serveur : synchronisation, import
   CSV, notifications. En revanche, le moteur d'analyse de Yuki s'exécute
   dans le navigateur avec la clé Twelve Data de l'utilisateur : le serveur
   n'y participe pas et ne peut donc pas le verrouiller. C'est une limite
   assumée de l'architecture, pas un oubli.

   Droits reconnus, par ordre de vérification :
     1. rôle "admin"        → accès complet
     2. subscribed = 1      → abonnement Google Play vérifié
     3. trial_until > now   → période d'essai encore ouverte
   ========================================================================== */
const db = require("../db");
const { HttpError } = require("../http/server");

/* Renvoie l'état d'accès d'un utilisateur, relu en base à chaque appel.
   Exporté séparément pour être réutilisable (route /status, tests). */
function getAccessState(userId) {
  const row = db.get()
    .prepare("SELECT role, subscribed, trial_until FROM users WHERE id = ?")
    .get(userId);

  if (!row) return { allowed: false, reason: "unknown_user" };

  if (row.role === "admin") return { allowed: true, reason: "admin" };
  if (row.subscribed === 1) return { allowed: true, reason: "subscribed" };

  const now = Date.now();
  if (row.trial_until && row.trial_until > now) {
    return {
      allowed: true,
      reason: "trial",
      trialUntil: row.trial_until,
      /* Arrondi au jour supérieur : un essai qui finit dans 2 h reste
         "1 jour restant" pour l'utilisateur, pas "0". */
      trialDaysLeft: Math.ceil((row.trial_until - now) / 86400000)
    };
  }

  return { allowed: false, reason: "trial_expired", trialUntil: row.trial_until || null };
}

/* Middleware à chaîner APRÈS authenticate (il a besoin de ctx.userId). */
async function requirePro(ctx, next) {
  if (!ctx.userId) throw new HttpError(401, "Authentification requise.");

  const access = getAccessState(ctx.userId);
  if (access.allowed) {
    ctx.access = access;
    await next();
    return;
  }

  /* 402 Payment Required : le client est bien authentifié, mais son droit
     d'usage a expiré. On distingue volontairement du 403 pour que le
     frontend puisse afficher l'écran d'abonnement plutôt qu'une erreur
     d'autorisation générique. */
  throw new HttpError(402, "Votre période d'essai est terminée. Un abonnement est nécessaire pour utiliser cette fonctionnalité.");
}

module.exports = requirePro;
module.exports.getAccessState = getAccessState;
