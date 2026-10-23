# bootstrap

Une commande pour donner à l'automatisation (Ansible, agents IA) l'accès à une
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
- crée le compte `ansible` (ou `AUTOMATION_USER=automation`, à passer après
  `sudo`) sans mot de passe utilisable : connexion par clé seule ;
- écrit les clés publiques ci-dessous entre `# BEGIN automation` et
  `# END automation` dans son `authorized_keys`, en conservant les autres lignes ;
- donne `sudo` sans mot de passe à ce seul compte (`/etc/sudoers.d/90-<compte>`,
  vérifié par `visudo`).

Il peut être relancé : il réécrit le bloc de clés et la règle sudo, sans doublon.
Il ne touche ni au compte personnel ni à la configuration de `sshd`.

## Clés autorisées

| Clé | Empreinte | Poste |
| --- | --- | --- |
| `ansible-automation` | `SHA256:dEzb+l2x1YwGkXUpGQzEwZdeQA9U3477GqVNiz4c4p0` | MacBook Air |

Ces clés sont publiques par nature. Ajouter ou retirer un poste : modifier
`AUTOMATION_KEYS` dans `automation.sh`, puis relancer le script (ou le rôle Ansible
équivalent) sur chaque machine.
