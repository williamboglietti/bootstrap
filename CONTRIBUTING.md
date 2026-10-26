# Contribuer

Les changements passent par une pull request vers `main`. La branche doit être
à jour et les trois contrôles GitHub Actions doivent réussir : ShellCheck et
les tests d'`automation.sh` sur Debian 13 et Ubuntu 24.04.

Les modifications d'`automation.sh`, d'`enroll.sh`, des tests et de `.github/`
nécessitent une revue de @williamboglietti, selon
[CODEOWNERS](.github/CODEOWNERS). Une modification après approbation annule
l'avis reçu. Les scripts gèrent des accès privilégiés : ne jamais inclure de
clé privée, de jeton ou de donnée personnelle dans une contribution.

Les changements ordinaires peuvent être fusionnés après validation de la CI
et résolution des commentaires bloquants. La protection native de `main`
interdit les poussées directes, les réécritures d'historique et sa suppression.
La définition versionnée des règles est dans
[`.github/rulesets/main.json`](.github/rulesets/main.json) ; sa présence seule
ne suffit pas, elle doit correspondre au ruleset actif dans les paramètres GitHub.

La CI publique s'exécute sur les runners isolés de GitHub avec un jeton en
lecture seule. Les contributions externes demandent une approbation avant
exécution des workflows. Aucun test CI ne doit demander l'accès à une machine
réelle ni utiliser un runner du réseau d'administration.

Pour vérifier localement la syntaxe, sans exécuter les scripts d'installation :

```bash
bash -n automation.sh enroll.sh tests/test-automation.sh
shellcheck -- *.sh tests/*.sh
```

Les tests fonctionnels modifient le système du conteneur : exécuter
`tests/test-automation.sh` uniquement dans un conteneur Debian/Ubuntu jetable.
