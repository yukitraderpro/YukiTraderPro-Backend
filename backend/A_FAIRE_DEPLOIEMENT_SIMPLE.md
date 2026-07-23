# Déployer la landing + l'API en UNE SEULE fois (GitHub + Render)

Le backend sert maintenant lui-même la landing page (dossier `public/`).
Il n'y a donc qu'UN service à créer. 6 petites étapes :

1. Mets ce dossier `backend/` dans ton dépôt GitHub (en remplaçant l'ancien),
   puis pousse : `git add . && git commit -m "landing + waitlist" && git push`
   (ou glisse-dépose le dossier sur github.com → "Add file" → "Upload files").

2. Sur render.com → bouton "New +" → "Web Service" → choisis ton dépôt.

3. Remplis exactement :
   - Root Directory : backend
   - Start Command : node server.js
   - Instance : au choix (Free pour tester)

4. Onglet "Environment" → ajoute :
   - NODE_ENV = production
   - JWT_ACCESS_SECRET = (une longue chaîne aléatoire, ex. 64 caractères)
   - JWT_REFRESH_SECRET = (une AUTRE longue chaîne aléatoire)
   - DB_PATH = /data/yuki.sqlite
   Astuce : Render → "Generate" génère des valeurs aléatoires pour toi.

5. Onglet "Disks" → "Add Disk" → Mount Path : /data → taille 1 GB.
   ⚠️ Sans ce disque, ta liste d'emails est effacée à chaque déploiement.

6. Clique "Create Web Service" et attends la fin du déploiement.

C'est fini. Ouvre l'URL que Render te donne :
- la landing s'affiche à la racine,
- inscris ton email → message vert "C'est noté !",
- vérifie sur TON-URL/api/waitlist/count → {"count":1}.

Ton domaine yukitraderpro.com : Settings → Custom Domains → suis les
2 lignes DNS que Render affiche.

Pour récupérer les emails plus tard (admin) :
GET TON-URL/api/waitlist/export avec ton token admin.
