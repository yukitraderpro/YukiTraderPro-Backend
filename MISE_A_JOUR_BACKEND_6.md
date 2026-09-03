# BACKEND_6 — données de marché servies par le serveur (03/09/2026)

Décision Simon : une seule clé Twelve Data (plan Business **Venture**) sur le serveur ; les utilisateurs n'ont plus de clé à créer ni à coller.

## Nouveau
- `src/services/marketData.js` — cache **par instrument** (jamais par utilisateur), durée de vie selon l'intervalle (1 min : 15 s · 15 min : 60 s · 1 h : 2 min · jour : 10 min · prix : 20 s), **regroupement des demandes en vol** (200 demandes simultanées sur un cache vide = 1 appel), copie périmée servie et **marquée** en cas de 429 amont (jamais au-delà de 15 min), quotas par utilisateur derrière une interface prête pour Redis (SQLite aujourd'hui).
- `src/routes/market.js` — `GET /api/market/status` (public : configuré ou non), `GET /api/market/series?symbol=&interval=&outputsize=` et `GET /api/market/price?symbol=` (compte requis). Réponse = charge utile Twelve Data telle quelle + `meta_yuki { fetchedAt, ageMs, source: live|cache|stale }` + `quota_yuki { tier, remainingDay }`.
- Quotas : gratuit 200 demandes/jour (message qui nomme l'abonnement Fondateur), abonné et essai 5 000/jour, admin illimité ; plafond par minute (30 / 120 / 240) pour protéger le serveur.
- Table `market_quota` créée à la première demande.

## Chiffres vérifiés par test
1 000 demandes de NVDA dans la minute → **1 appel** · 40 instruments et 10 000 demandes → **40 crédits** · 200 demandes simultanées → **1 appel en vol**.

## ACTION SIMON (avant de déployer NAV_20)
1. Souscrire **Twelve Data Business Venture** (610 crédits/min, ~149 $/mois ; remise startup possible).
2. Poser la clé sur Render : variable **`MARKET_DATA_KEY`** (à défaut, `CONTEXT_DATA_KEY` est réutilisée — la même clé Venture peut servir aux deux).
3. Vérifier que l'instance Render **ne s'endort pas** (formule payante) : un serveur qui dort ajoute plusieurs secondes au premier appel.
4. Après déploiement : `https://<ton-backend>/api/market/status` doit répondre `{"configured":true,...}`.

Sans clé : la route répond 503 « non configurée » et l'app (NAV_20) se replie sur les clés personnelles. Rien ne casse.

## Inchangé
Moteur `analysisEngine/analysis.js` (fa0e2c69), toutes les autres routes. Suite backend : toutes vertes (10 nouveaux tests).
