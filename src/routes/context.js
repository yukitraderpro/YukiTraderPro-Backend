/* Contexte de marché servi à l'application : co-mouvement mesuré (« Ondes de
   choc »). Public et sans donnée personnelle : on ne renvoie que des mesures
   de marché et la carte de relations, jamais une direction. */
const Router = require("../http/router");
const { HttpError } = require("../http/server");
const coMovement = require("../services/coMovement");

const router = new Router();

router.get("/links", async ctx => {
  const symbol = String((ctx.query && ctx.query.symbol) || "").trim();
  if (!symbol) throw new HttpError(400, "Paramètre symbol manquant.");
  ctx.res.json(200, coMovement.linksFor(symbol));
});

router.get("/relations", async ctx => {
  const R = coMovement.RELATIONS;
  ctx.res.json(200, { version: R.version, seuil: R.seuil_affichage_correlation, fenetre: R.fenetre_jours, societes: R.societes.map(s => ({ symbol: s.symbol, nom: s.nom, secteur: s.secteur, lies: coMovement.linkedSymbols(s) })), note: R.note_methodologie });
});

module.exports = router;
