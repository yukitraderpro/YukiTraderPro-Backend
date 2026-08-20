# Mise à jour V4.14 — backend

Deux corrections d'hygiène. Le code applicatif et le moteur sont **inchangés**
depuis la V4.13.3 (acquittement des achats Google Play).

## 1. `.env.example` — nom de package corrigé

    avant : GOOGLE_PLAY_PACKAGE_NAME=com.yukitrader.pro
    après : GOOGLE_PLAY_PACKAGE_NAME=com.yukitraderpro.app

L'ancienne valeur était fausse. Recopiée telle quelle sur Render, elle aurait
fait échouer **toutes** les vérifications d'achat : Google aurait répondu que
le produit n'existe pas pour ce package, et aucun abonné n'aurait obtenu son
accès Pro. La valeur en service sur Render est déjà la bonne — c'est le
fichier d'exemple qui était piégeux pour une future réinstallation.

## 2. `.gitignore` — ajouté

Le dépôt backend n'en avait aucun. Il protège désormais `.env`, les clés
(`*.pem`, `*.keystore`, `*.jks`), `node_modules/`, la base de données et les
journaux.

## Rien à faire côté courtier

La purge des références au courtier ne concernait que le frontend : c'est lui
qui portait le catalogue et ses codes propriétaires. Vérifié ici — aucun nom
de marque dans le backend. Les mots « courtier » et « broker » qui subsistent
sont génériques et légitimes : une catégorie de source d'import CSV, et la
phrase de la page d'accueil qui rappelle que l'exécution reste chez le
courtier de l'utilisateur.

## Vérification

    node test/run-all.js

Le test d'intégrité du moteur ne passe que si le dossier `backend/` est placé
**à l'intérieur** du projet frontend : il compare la copie serveur au moteur
client, qu'il cherche à `../../analysis.js`. Empreinte attendue des deux
copies : `fa0e2c69…`
