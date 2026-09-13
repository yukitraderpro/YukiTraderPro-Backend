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
