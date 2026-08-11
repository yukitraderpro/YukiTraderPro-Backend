/* ==========================================================================
   Limitation de débit par IP (V4.11)
   --------------------------------------------------------------------------
   Pourquoi ce fichier existe
   --------------------------
   Seule la route waitlist était protégée. Les routes d'authentification ne
   l'étaient pas, ce qui laissait deux portes ouvertes :

     • /login          — essais de mots de passe illimités (force brute).
     • /forgot-password — un tiers pouvait déclencher autant d'e-mails qu'il
                          voulait vers l'adresse d'une victime, et au passage
                          épuiser le quota Resend (3 000 e-mails/mois) en
                          quelques minutes.

   Le compteur vit en mémoire du processus. C'est volontairement simple et
   suffisant ici : un seul processus Render, et un redémarrage qui remet les
   compteurs à zéro n'est pas un problème de sécurité (il faudrait le
   provoquer à chaque fenêtre pour en tirer parti). Si le service passe un
   jour sur plusieurs instances, il faudra déplacer ce compteur dans un
   stockage partagé.
   ========================================================================== */
const { HttpError } = require("../http/server");
const logger = require("../logger");

/* Un seau par nom de limiteur, pour que /login et /forgot-password aient des
   compteurs indépendants : épuiser l'un ne doit pas bloquer l'autre. */
const buckets = new Map();

function clientIp(ctx) {
  /* Render place le vrai client en tête de x-forwarded-for. */
  return (ctx.req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || ctx.req.socket.remoteAddress
    || "?";
}

/**
 * Fabrique un middleware de limitation.
 * @param {string} name    identifiant du seau (ex. "login")
 * @param {number} max     nombre d'appels autorisés par fenêtre
 * @param {number} windowMs durée de la fenêtre en millisecondes
 */
function rateLimit(name, max, windowMs) {
  if (!buckets.has(name)) buckets.set(name, new Map());
  const hits = buckets.get(name);

  return async function rateLimitMiddleware(ctx, next) {
    const ip = clientIp(ctx);
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);

    if (recent.length >= max) {
      hits.set(ip, recent);
      /* On journalise sans l'IP complète : le but est de repérer une attaque,
         pas de constituer un fichier d'adresses. */
      logger.warn("[rateLimit] Seuil atteint", { limiter: name });
      throw new HttpError(429, "Trop de tentatives. Réessaie dans quelques minutes.");
    }

    recent.push(now);
    hits.set(ip, recent);

    /* Borne mémoire : sans cette purge, une attaque distribuée ferait croître
       la Map indéfiniment jusqu'à saturer le processus. */
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (!v.some(t => now - t < windowMs)) hits.delete(k);
      }
    }

    await next();
  };
}

module.exports = rateLimit;
