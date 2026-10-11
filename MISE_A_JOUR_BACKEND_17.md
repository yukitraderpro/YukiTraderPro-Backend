# BACKEND_11 — la mesure des signaux était biaisée (13/09/2026)

À déployer avant NAV_33. Suite backend : 0 échec (3 nouveaux tests).

## Constat (Simon, 13/09)
Carte « Précision mesurée » : 41 signaux, **0 % d'objectif 1, 41,5 % de stop**. Un zéro absolu sur 41 est impossible par hasard : c'est l'instrument de mesure qui était faux, pas le moteur.

## Deux causes, cumulées
1. **Bougies d'une heure.** Au-delà de 30 h, la mesure relisait l'historique en 1 h. Or la géométrie day trading pose le stop à 0,5 % et l'objectif à 0,75 % du prix : une bougie horaire d'amplitude 1 % touche les deux, et le code tranchait « stop » par prudence. Les objectifs n'avaient jamais leur chance.
2. **Fenêtre non couverte** (signal émis en fin de séance, validité débordant sur la clôture ou le week-end) : verdict impossible, signal laissé en attente — les 58,5 % restants.

## Corrigé
- **Toujours des bougies de 15 minutes** pour juger, en remontant plus loin en nombre de bougies (jusqu'à 1 200, soit plus de 30 séances).
- **Nouveau résultat « indéterminé »** quand une même bougie touche stop et objectif : exclu des pourcentages, compté et affiché à part. Un résultat qu'on ne peut pas établir n'est pas un échec.
- **Remise à zéro unique** des verdicts rendus avant ce correctif : les 41 signaux repassent en attente et sont rejugés en 15 min au premier passage (toutes les 15 minutes).

## Vérifié
La géométrie NAV_19 elle-même est saine : testée sur des marchés fabriqués, elle touche l'objectif en hausse nette comme en hausse lente, le stop en baisse, et expire à plat.


# BACKEND_12 (13/09/2026)
Observations du suivi (`POST /api/signals/observed`), signal miroir jugé avec chaque signal, rapprochement suivi ↔ mesure, `validated` (≥ 10 rapprochements, ≥ 80 % d'accord), vue brute admin `GET /api/signals/recent`. Contient BACKEND_11. Suite verte.


# BACKEND_13 (13/09/2026)
Un signal en attente dit pourquoi (`measure_error` : panne amont ou fenêtre non couverte, visible dans la vue admin) ; les verdicts rendus sans miroir sont rejugés une fois pour le calculer. Contient 11 et 12. Suite verte.


# BACKEND_14 (16/09/2026)
`GET /api/market/earnings` accepte `start_date` / `end_date` (résultats passés pour le banc de recherche), clé de cache par fenêtre. Contient 11 à 13. Suite verte.


# BACKEND_15 (18/09/2026)
Les statistiques comptent des SITUATIONS (actif + sens + séance New York) et non des signaux répétés : regroupement, verdict le plus favorable de la situation, seuil de publication à 20 situations, `rawSignals` et `situations` exposés. Contient 11 à 14. Suite verte (2 nouveaux tests).


# BACKEND_16 (11/10/2026)
Niveaux du défi : `stats.progress` (points, niveau, palier nommé, prochain seuil, dernier gain) calculé sur tout l'historique — 1 point par bonne réponse, 2 à partir du 3e jour juste d'affilée ; `progression()` et `levelFor()` exportés. Contient 11 à 15. Suite verte.


# BACKEND_17 (11/10/2026) — retours des comptes

Deux questionnaires, chacun posé **une seule fois par compte**, dans l'application et par courrier :

| Qui | Quand | Quoi |
|---|---|---|
| Compte créé, **pas abonné** | carte dès 7 jours, courrier à 8 jours | pourquoi pas d'abonnement (cases à cocher), note sur 5, commentaire |
| **Abonné** | carte et courrier à 14 jours | note + commentaire, invitation à les déposer sur Google Play |

- Routes : `GET /api/feedback/eligibility` → `{ask, kind}` ; `POST /api/feedback` (`{reasons, rating, comment, openedPlay}` ou `{action:"later"|"never"}`) ; `GET /api/feedback/summary` (admin : compteurs par raison, note moyenne, liste e-mails + commentaires).
- Table `trial_feedback` (une ligne par compte et par questionnaire) créée automatiquement.
- « Plus tard » repose la question 7 jours après, deux fois au plus. « Ne plus demander » clôt.
- Les réponses restent privées. L'invitation Google Play est proposée à **tous** les répondants, quelle que soit la note (pas de « review gating », interdit par Google). L'application ne peut pas publier l'avis à la place de l'utilisateur : lien vers la fiche Play + commentaire copié dans le presse-papiers.

## Courriers (désactivés par défaut)
Rien ne part tant que la variable n'est pas posée sur Render :

| Variable | Défaut | Rôle |
|---|---|---|
| `FEEDBACK_EMAIL_ENABLED` | `false` | `true` pour activer les deux courriers (un par compte et par questionnaire) |
| `FEEDBACK_EMAIL_AFTER_DAYS` | `8` | courrier « ton essai » après N jours |
| `FEEDBACK_INAPP_AFTER_DAYS` | `7` | carte d'essai dans l'application après N jours |
| `FEEDBACK_SUBSCRIBER_AFTER_DAYS` | `14` | carte et courrier « note sur Google Play » après N jours d'abonnement |
| `PLAY_STORE_URL` | fiche YukiTraderPro | lien Google Play dans le courrier aux abonnés |

Vérification toutes les 6 h (première au démarrage + 60 s). Utilise `RESEND_API_KEY` / `MAIL_FROM` / `APP_PUBLIC_URL` déjà en place ; sans clé Resend, rien n'est marqué envoyé.

Contient 11 à 16. Suite verte (2 nouvelles suites : 7 tests unitaires + 4 d'intégration).
