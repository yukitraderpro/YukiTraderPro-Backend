# Yuki Trader Pro — Backend V3

Backend REST pour Yuki Trader Pro, développé pour répondre au *Cahier des
charges Yuki Trader Pro V3* : **renforcer la sécurité, la fiabilité et
l'infrastructure sans modifier le moteur d'analyse V2.**

## Principe fondamental (rappel du cahier des charges)

> Le moteur d'analyse V2 reste inchangé. Seules les corrections de bugs sont
> autorisées. Aucune modification des pondérations ou des règles métier sans
> validation.

Ce backend ne contient **aucune** logique d'analyse, de pondération ou de
génération de signal. `src/analysisEngine/analysis.js` est une copie
**strictement identique, octet par octet**, du fichier livré au client — cette
identité est vérifiée automatiquement par `test/engineIntegrity.test.js` à
chaque exécution des tests, pour qu'aucune divergence ne puisse passer
inaperçue. Ce fichier n'est actuellement utilisé nulle part côté serveur (le
job optionnel `src/jobs/scheduledScan.js` est un squelette désactivé par
défaut — voir `Difficultes_YukiTraderPro_V3.md` pour l'explication complète).

## Pourquoi aucune dépendance npm (`package.json` vide)

L'environnement de développement utilisé pour produire cette livraison n'a
pas d'accès sortant au registre npm (`registry.npmjs.org` renvoie 403). Plutôt
que de livrer un projet qui ne s'installe pas, **tout a été écrit avec les
modules natifs de Node.js 22** :

| Besoin | Solution utilisée ici | Équivalent npm habituel |
|---|---|---|
| Serveur HTTP + routage | `http` natif + petit routeur maison (`src/http/`) | Express / Fastify |
| Base de données | `node:sqlite` (natif, expérimental à partir de Node 22) | `better-sqlite3` / `pg` |
| Hachage de mot de passe | `crypto.scrypt` (natif, recommandé OWASP) | `bcrypt` |
| JWT | implémentation HS256 maison (`src/crypto/jwt.js`), format standard | `jsonwebtoken` |
| Appels HTTPS sortants (Google) | `https` natif | `googleapis` / `node-fetch` |
| Tests | scripts `assert` + petit client HTTP maison | Jest / Mocha + `supertest` |

**Ce choix n'est pas cosmétique : le format produit est standard.** Les JWT
émis sont des JWT HS256 conformes, vérifiables par n'importe quelle librairie
tierce. Le schéma SQL est du SQL standard. Migrer vers Express/PostgreSQL/
`jsonwebtoken`/`bcrypt` dès qu'un accès npm sera disponible est donc un
remplacement mécanique, documenté ci-dessous (§"Migration recommandée").

## Démarrage rapide

```bash
cd backend
cp .env.example .env      # puis éditer .env avec de vraies valeurs
npm test                  # 47 tests, aucune dépendance à installer
npm start                 # démarre sur http://localhost:4000
```

Aucun `npm install` n'est nécessaire (zéro dépendance). C'est un avantage
temporaire de cet environnement contraint, pas un objectif à long terme —
voir §"Migration recommandée".

## Architecture

```
backend/
  server.js                     Point d'entrée (charge .env, ouvre la DB, démarre le serveur)
  src/
    config.js                   Configuration (variables d'environnement)
    logger.js                   Journalisation structurée JSON (console + fichier journalier)
    db.js                       Schéma SQLite + migrations
    loadEnv.js                  Chargeur .env minimal
    app.js                      Assemble les routes sous /api/*
    http/
      server.js                 Serveur HTTP (parsing JSON, CORS, logging, métriques)
      router.js                 Routeur avec paramètres de chemin
    middleware/
      authenticate.js           Vérification JWT (Authorization: Bearer ...)
    crypto/
      password.js               Hachage scrypt
      jwt.js                    JWT HS256 maison
    services/
      authService.js            Inscription, connexion, rotation des refresh tokens
      googlePlayService.js      Vérification serveur des achats Google Play
      fcmService.js             Envoi de notifications push (Firebase Cloud Messaging)
      backupService.js          Sauvegardes automatiques avec rétention
    routes/
      auth.js, sync.js, billing.js, notifications.js, health.js
    jobs/
      scheduledScan.js          Squelette de scan planifié (désactivé par défaut, voir Difficultés)
    analysisEngine/
      analysis.js                Copie strictement identique du moteur client (intégrité testée)
  test/                          47 tests (unitaires + intégration), `npm test`
  scripts/
    backup-cron.js               Script de sauvegarde appelable par un vrai cron système
  openapi.yaml                   Documentation de l'API REST
  .env.example
```

## Réponse point par point au cahier des charges V3

| Exigence | Implémentation |
|---|---|
| Backend sécurisé | Serveur HTTP avec authentification JWT obligatoire sur toutes les routes sensibles, CORS configurable, limite de taille de requête, hachage scrypt des mots de passe, logs structurés |
| Base de données utilisateurs | SQLite (`users`, `devices`, `refresh_tokens`, `subscriptions`, `notification_tokens`, `sync_state`, `audit_log`) — schéma SQL standard, migrable vers PostgreSQL |
| Authentification JWT | Access token courte durée (15 min) + refresh token longue durée (30 j) **à rotation** : chaque refresh consomme l'ancien token et en émet un nouveau, ce qui détecte un vol/rejeu de refresh token |
| Synchronisation cloud | `GET/PUT /api/sync/state` — stocke et restitue l'état applicatif du client (journal, positions, signaux, préférences, poids adaptatifs) de façon opaque, sans le modifier ni l'interpréter |
| Google Play Billing sécurisé | `POST /api/billing/verify-purchase` interroge directement les serveurs Google (Play Developer API) — voir limite ci-dessous |
| Validation serveur des abonnements | Le statut `pro`/`free` de l'utilisateur en base est mis à jour **uniquement** après vérification réussie auprès de Google, jamais sur simple déclaration du client |
| Firebase Cloud Messaging | `fcmService.js` (API HTTP v1) + routes d'enregistrement de token et d'envoi de test ; `service-worker.js` côté client gère la réception en arrière-plan (voir README racine) |
| API REST documentée | `openapi.yaml` (OpenAPI 3.0), toutes les routes |
| Journalisation et monitoring | Logs JSON structurés (fichier journalier + stdout), `GET /api/health` (liveness), `GET /api/metrics` (compteurs de requêtes/erreurs/mémoire) |
| Sauvegardes automatiques | `backupService.js` (copie horodatée + rétention configurable), planifiable en interne (`schedule()`) ou via `scripts/backup-cron.js` par un vrai cron système (recommandé en production) |
| Abonnements dynamiques, sans tarif codé en dur (V3.1) | `subscription_offers` / `user_offer_assignments` (compteur de places atomique, tarif verrouillé par abonné), `GET /api/billing/offers` (public), `/api/admin/offers` (CRUD admin) — voir `subscriptionOffersService.js` |
| Conserver les mêmes analyses que la V2 | Moteur non touché, intégrité vérifiée automatiquement par test (`engineIntegrity.test.js`) |
| Architecture modulaire | Un module = une responsabilité (voir arborescence ci-dessus), aucune dépendance circulaire |
| Code documenté | Chaque fichier commence par un bloc expliquant son rôle et ses choix |
| Tests unitaires et d'intégration | 47 tests, `npm test` — voir détail plus bas |

## Tests (47 au total)

```bash
npm test
```

- **Unitaires** : `password.test.js` (scrypt), `jwt.test.js` (JWT maison),
  `backup.unit.test.js` (sauvegarde + rétention), `billing.unit.test.js` et
  `notifications.unit.test.js` (logique métier Google Play / FCM, avec un
  client HTTP **injecté** pour rester exécutables hors-ligne).
- **Intégration** : `auth.integration.test.js` et `sync.integration.test.js`
  démarrent un vrai serveur HTTP sur un port éphémère et l'appellent comme le
  ferait un client réel (inscription, connexion multi-appareils, rotation de
  refresh token, synchronisation, isolation entre utilisateurs).
- **Intégrité du moteur** : `engineIntegrity.test.js` compare le hash SHA-256
  de la copie serveur du moteur avec le fichier client — échoue si l'un des
  deux a été modifié sans que l'autre le soit.

## Limites assumées — voir `Difficultes_YukiTraderPro_V3.md`

En particulier :
- **Google Play Billing ne peut pas être "complet" dans une PWA seule.** La
  Play Billing Library (achat en lui-même) n'existe que côté Android natif ou
  via une TWA (Trusted Web Activity). Ce backend fournit la **vérification
  serveur**, indispensable et fonctionnelle ; le déclenchement de l'achat
  nécessite un enrobage Android — voir `twa/` à la racine du projet pour le
  point de départ de cet enrobage.
- **Le scan planifié pour notifications "application fermée"** est livré en
  squelette désactivé, faute de pouvoir réutiliser `analyseSeries` (qui vit
  aujourd'hui dans `app.js`, côté client, mélangé à du code DOM) sans une
  extraction de code — une extraction qui, même neutre en comportement,
  reste une modification de structure du moteur nécessitant validation
  explicite d'après le principe fondamental du cahier des charges V3.

## Migration recommandée pour une mise en production réelle

Dès qu'un accès npm est disponible :

1. Remplacer `src/http/server.js` + `src/http/router.js` par Express ou
   Fastify (le contrat des routes ne change pas, seul le branchement change).
2. Remplacer `src/crypto/jwt.js` par `jsonwebtoken` (format déjà compatible).
3. Remplacer `src/crypto/password.js` par `bcrypt`/`argon2` (prévoir une
   migration progressive des hachages scrypt existants au premier login).
4. Remplacer `node:sqlite` par PostgreSQL (`pg`) pour un déploiement
   multi-instance (le SQL du schéma est déjà standard, `db.js` est le seul
   fichier à réécrire).
5. Remplacer les appels `https` maison vers Google par le SDK officiel
   `googleapis` (androidpublisher) et `firebase-admin` (FCM) — la logique
   métier (`interpretSubscriptionResponse`, etc.) reste valable telle quelle.
6. Ajouter un vrai orchestrateur de sauvegardes (ex. `pg_dump` + envoi vers
   S3/GCS) à la place de la copie de fichier SQLite.

## Docker (optionnel)

Un `Dockerfile` minimal est fourni (`backend/Dockerfile`) — il ne nécessite
aucune dépendance à télécharger à la construction de l'image, pour les mêmes
raisons que ci-dessus.
