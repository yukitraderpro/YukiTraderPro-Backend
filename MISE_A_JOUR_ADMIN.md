# Amorçage des comptes administrateurs

## Le problème

Le rôle `admin` ne pouvait s'obtenir que par la route
`PUT /api/admin/users/:id/role` — laquelle exige d'être **déjà**
administrateur. Le système était circulaire : aucun moyen de créer le premier
administrateur, ni de retrouver l'accès après une restauration de sauvegarde.

## Ce qui change

Une variable d'environnement désigne les comptes administrateurs. À chaque
démarrage, le serveur leur applique le rôle.

**Sur Render : service backend → Environment → Add Environment Variable**

    ADMIN_EMAIL = renaissance45.ls@gmail.com

Plusieurs adresses possibles, séparées par des virgules.

## Ce que le serveur fait, et ne fait pas

- Il **promeut** un compte existant au rôle `admin`.
- Il ne **crée jamais** de compte. Si l'adresse n'existe pas encore, il le
  journalise et s'arrête : fabriquer un accès depuis une variable
  d'environnement reviendrait à créer un compte sans mot de passe choisi par
  son propriétaire. Crée-le normalement dans l'application, puis redémarre.
- Il ne **rétrograde personne**. Retirer la variable ne retire pas le rôle :
  une faute de frappe lors d'un déploiement ne doit pas te priver de ton
  application.
- Il n'écrit en base **que si le rôle change réellement**.
- Un échec d'amorçage **n'empêche jamais le démarrage** : mieux vaut une
  application debout sans administrateur qu'une application à terre.

## Vérification

Au démarrage, le serveur écrit **toujours** l'état réel — un silence ne peut
plus vouloir dire à la fois « code non déployé », « variable vide » et « tout
va bien ».

Cas normal :

    ADMIN_EMAIL renseignée { adresses: ["ton@adresse.fr"] }
    Administrateurs en base { nombre: 1, adresses: ["ton@adresse.fr"] }
    Amorçage administrateurs { promus: 1, deja: 0, introuvables: [] }

Variable absente ou vide :

    ADMIN_EMAIL non renseignée — aucune promotion automatique.
    Administrateurs en base { nombre: 0, adresses: [] }

Adresse qui ne correspond à aucun compte :

    ADMIN_EMAIL désigne des comptes inexistants — crée-les dans
    l'application, puis redémarre le service

La ligne « Administrateurs en base » répond aussi à la question « quelle
adresse avais-je promue ? », à laquelle rien ne permettait de répondre
auparavant.

Dans l'app, l'onglet **Admin** apparaît alors dans la barre du bas.

## Tests

    node test/adminBootstrap.test.js

Neuf tests, exécutés sur une base temporaire réelle.
