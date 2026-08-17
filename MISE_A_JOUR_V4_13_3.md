# Mise à jour V4.13.3 — acquittement des achats Google Play

## Pourquoi c'était urgent

Constaté en test réel le 17/08/2026 : après un achat, Google Play affichait
« **Confirmez le forfait — Ouvrez cette appli pour confirmer votre forfait
avant…** », et la fiche Play « Connectez-vous dans les trois jours suivant
l'achat pour éviter l'annulation de l'abonnement ».

Cause : le mot `acknowledge` n'existait **nulle part** dans le projet — ni
côté application, ni côté serveur. L'achat était bien vérifié auprès de
Google, mais jamais confirmé.

Conséquence en production : **Google rembourse et révoque automatiquement
tout abonnement non acquitté au bout de 3 jours.** Chaque client aurait payé,
obtenu son accès, puis été remboursé quelques jours plus tard — sans le
moindre message d'erreur, et sans revenu pour toi.

## Ce qui change

Trois fichiers.

**`src/services/googlePlayService.js`** — nouvelle fonction
`acknowledgeSubscription(purchaseToken, subscriptionId)` qui appelle
l'endpoint `:acknowledge` de l'API Play Developer, avec le même compte de
service que la vérification. Un achat déjà acquitté (400/409) est traité
comme un succès : l'appel est sans danger s'il est rejoué.

**`src/routes/billing.js`** — l'acquittement est appelé dans
`/verify-purchase`, **dès que l'abonnement est actif ou en attente**, et
**avant** l'octroi de l'accès. S'il échoue, la requête n'est pas
interrompue : l'utilisateur a payé, il doit obtenir son accès. L'échec est
journalisé en `error` avec le message « ACQUITTEMENT NON CONFIRMÉ — risque
de remboursement automatique sous 3 jours », de quoi le repérer dans les
logs Render.

**`src/analysisEngine/analysis.js`** — resynchronisé sur la copie du
frontend (hash `fa0e2c69…`). La copie de ton zip était restée à la version
de juillet (`694aa4f7…`), ce qui aurait fait échouer le test d'intégrité.

**`test/googlePlayAcknowledge.test.js`** — 7 tests avec un client HTTP
simulé, aucun appel réseau réel.

## Vérification

    node test/run-all.js

Toutes les suites passent lorsque le dossier `backend/` est placé à
l'intérieur du projet frontend (le test d'intégrité cherche le moteur client
à `../../analysis.js`).

## Après déploiement

Refais un achat de test et regarde la page « Abonnements » de Google Play :
la mention « Confirmez le forfait » ne doit plus apparaître.
