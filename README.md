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

Il peut être relancé : il réécrit le bloc de clés et la règle sudo, sans doublon,
comme le snippet Termius le fait pour le bloc `sshid.io`.
Il ne touche ni au compte personnel ni à la configuration de `sshd`.

## Clés autorisées

| Clé | Empreinte | Poste |
| --- | --- | --- |
| `automation@macbook-air` (`~/.ssh/automation`) | `SHA256:FwhmgH6EW1xnvXtgn5R8cw5U4mQrCIeKYRCWTJLRw70` | MacBook Air |

Ces clés sont publiques par nature. **Rotation** : modifier `AUTOMATION_KEYS`
dans `automation.sh`, publier, puis relancer le script sur chaque machine, avec
l'ancienne clé encore valide. Le bloc délimité est remplacé en entier : une clé
retirée de la liste disparaît, les autres lignes du fichier restent.
