# bootstrap

Une commande pour donner à l'automatisation (agents IA, playbooks) l'accès à une
machine Debian ou Ubuntu fraîchement installée.

## Utilisation

Connecté avec son compte personnel (sudo avec mot de passe) :

```bash
curl -fsSL https://raw.githubusercontent.com/williamboglietti/bootstrap/<commit>/automation.sh | sudo bash
```

Remplacer `<commit>` par le SHA complet du commit voulu : l'URL désigne alors un
contenu figé, que personne ne peut modifier après coup. Une URL en `main`
exécuterait en root la dernière version, quelle qu'elle soit.

Pour lire le script avant de l'exécuter :

```bash
curl -fsSLo automation.sh https://raw.githubusercontent.com/williamboglietti/bootstrap/<commit>/automation.sh
less automation.sh
sudo bash automation.sh
```

## Ce que fait le script

- installe `sudo` et `openssh-server` s'ils manquent ;
- crée le compte `automation` (autre nom : `AUTOMATION_USER=<nom>`, à passer
  après `sudo`) sans mot de passe utilisable : connexion par clé seule ;
- écrit les clés publiques ci-dessous entre `# BEGIN automation` et
  `# END automation` dans son `authorized_keys`, en conservant les autres lignes ;
- donne `sudo` sans mot de passe à ce seul compte (`/etc/sudoers.d/90-<compte>`,
  vérifié par `visudo`).
- met à jour les clés SSH.id (`https://sshid.io/williamboglietti`) du compte
  personnel qui a lancé `sudo`, entre `# BEGIN sshid.io` et `# END sshid.io`,
  exactement comme le snippet Termius. Si SSH.id ne répond pas, ce fichier reste
  inchangé ; lancé directement en root, cette étape est ignorée.

Il peut être relancé : il réécrit le bloc de clés et la règle sudo, sans doublon,
comme le snippet Termius le fait pour le bloc `sshid.io`.
Du compte personnel, il ne touche que le bloc `sshid.io` ; il ne modifie pas la
configuration de `sshd`. Le snippet Termius reste utile là où l'on n'a pas `sudo`
ou hors Debian/Ubuntu (routeur OPNsense par exemple).

## Clés autorisées

| Clé | Empreinte | Poste |
| --- | --- | --- |
| `automation@macbook-air` (`~/.ssh/automation`) | `SHA256:FwhmgH6EW1xnvXtgn5R8cw5U4mQrCIeKYRCWTJLRw70` | MacBook Air |
| `automation-secours` | `SHA256:gNx9hmbZERronatWwX6TUwVfaSvW/AtvqvFq9TpLLdc` | clé de secours, clé privée dans le Vault d'ansible-infra |

Ces clés sont publiques par nature. **Rotation** : modifier `AUTOMATION_KEYS`
dans `automation.sh`, publier, puis relancer le script sur chaque machine, avec
l'ancienne clé encore valide. Le bloc délimité est remplacé en entier : une clé
retirée de la liste disparaît, les autres lignes du fichier restent.

## Demander un accès depuis une VM d'agent : `enroll.sh`

Pour une VM d'agent (ou un nouveau poste), sans `sudo` : le script génère
`~/.ssh/automation` s'il manque, ajoute sa clé publique à
`group_vars/all/ssh_access.yml` d'ansible-infra et ouvre la PR.

```bash
curl -fsSLo enroll.sh https://raw.githubusercontent.com/williamboglietti/bootstrap/<commit>/enroll.sh
bash enroll.sh --hosts docker9,dokploy --days 30
```

- `--hosts` est obligatoire : machines ou groupes de l'inventaire, jamais `all`.
- `--days` : validité de la clé, 30 jours par défaut, 90 au plus
  (`expiry-time=` : une clé à expiration n'est jamais posée sur les NAS Debian 10).
- `--name` : nom de l'entrée, par défaut le nom court de la machine.
- `--dry-run` : affiche la modification sans rien pousser.

Prérequis : `git`, `ssh-keygen` et `gh` connecté avec le compte des agents
(`williamboglietti-bot`, jeton classique de portée `repo`). La clé est acceptée
depuis les réseaux internes et Tailscale (`from=` par défaut) : pas d'IP fixe à
réserver.

La clé ne vaut rien avant que William approuve et fusionne la PR, puis applique
`playbooks/ssh-access.yml`. Un commit poussé après l'approbation l'annule.
