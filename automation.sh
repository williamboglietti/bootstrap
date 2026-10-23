#!/usr/bin/env bash
# Donne à l'automatisation (agents IA, playbooks) l'accès à cette machine Debian ou
# Ubuntu : compte dédié, connexion par clé seule, sudo sans mot de passe. Met aussi
# à jour les clés SSH.id du compte personnel qui lance la commande.
#
#   curl -fsSL https://raw.githubusercontent.com/williamboglietti/bootstrap/<commit>/automation.sh | sudo bash
#
# Relançable : les clés sont réécrites entre deux délimiteurs, le reste des fichiers
# authorized_keys (clés techniques posées à la main) est conservé.
set -euo pipefail

AUTOMATION_USER="${AUTOMATION_USER:-automation}"

# Une clé par poste qui pilote, ~/.ssh/automation sur chacun. Changer cette liste
# puis relancer le script fait la rotation : seul le bloc délimité est réécrit.
AUTOMATION_KEYS=(
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPA8//IhYycs45VDwyKSAFk1kcngJv/cB6NVdc0klzn6 automation@macbook-air"
)

SSHID_URL="${SSHID_URL:-https://sshid.io/williamboglietti}"

die() { echo "automation.sh : $*" >&2; exit 1; }

# Tout le travail est dans main, appelée à la dernière ligne : avec « curl | bash »,
# bash a ainsi lu le script entier avant qu'une commande puisse lire l'entrée standard.
main() {
  [ "$(id -u)" -eq 0 ] || die "à lancer en root (… | sudo bash)."
  [[ "$AUTOMATION_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "nom de compte invalide : $AUTOMATION_USER"
  command -v apt-get >/dev/null || die "Debian ou Ubuntu attendu (apt-get absent)."

  local missing=()
  command -v sudo >/dev/null || missing+=(sudo)
  [ -x /usr/sbin/sshd ] || missing+=(openssh-server)
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update -qq </dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" </dev/null >/dev/null
  fi

  id "$AUTOMATION_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$AUTOMATION_USER"
  # « * » : aucun mot de passe possible, sans verrouiller le compte (un compte
  # verrouillé « ! » est refusé par sshd quand PAM est désactivé).
  usermod --password '*' "$AUTOMATION_USER"

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  printf '%s\n' "${AUTOMATION_KEYS[@]}" > "$work/automation.keys"
  ssh-keygen -lf "$work/automation.keys" >/dev/null || die "clé publique invalide dans le script."
  write_key_block "$AUTOMATION_USER" "$work/automation.keys" automation

  echo "$AUTOMATION_USER ALL=(ALL) NOPASSWD:ALL" > "$work/sudoers"
  visudo -cqf "$work/sudoers" || die "règle sudo refusée par visudo."
  install -m 440 -o root -g root "$work/sudoers" "/etc/sudoers.d/90-$AUTOMATION_USER"

  echo "Compte $AUTOMATION_USER prêt sur $(hostname) :"
  ssh-keygen -lf "$work/automation.keys" | sed 's/^/  clé : /'
  if sudo -n -l -U "$AUTOMATION_USER" | grep -q 'NOPASSWD: ALL'; then
    echo "  sudo sans mot de passe : oui"
  else
    die "sudo sans mot de passe non effectif pour $AUTOMATION_USER."
  fi
  local allow
  allow="$(/usr/sbin/sshd -T 2>/dev/null | awk '$1 == "allowusers" {print $2}' || true)"
  if [ -n "$allow" ] && ! grep -qx "$AUTOMATION_USER" <<<"$allow"; then
    echo "  attention : AllowUsers de sshd n'inclut pas $AUTOMATION_USER, la connexion sera refusée."
  fi
  if command -v ip >/dev/null; then
    ip -brief -4 address show scope global | awk '{print "  adresse : " $3 " (" $1 ")"}'
  fi

  update_personal_keys
}

# Remplace, dans authorized_keys du compte, le bloc « # BEGIN <nom> … # END <nom> »
# par les clés données, retire leurs doublons hors bloc et garde toutes les autres lignes.
write_key_block() {
  local user="$1" keys="$2" name="$3"
  local home group auth
  home="$(getent passwd "$user" | cut -d: -f6)"
  group="$(id -gn "$user")"
  auth="$home/.ssh/authorized_keys"
  install -d -m 700 -o "$user" -g "$group" "$home/.ssh"
  {
    if [ -f "$auth" ]; then
      sed "/^# BEGIN ${name}\$/,/^# END ${name}\$/d" "$auth" | grep -vxFf "$keys" || true
    fi
    echo "# BEGIN $name"
    cat "$keys"
    echo "# END $name"
  } > "$work/$name.new"
  install -m 600 -o "$user" -g "$group" "$work/$name.new" "$auth"
}

# Même effet que le snippet Termius, pour le compte qui a lancé sudo : ses clés
# SSH.id entre « # BEGIN sshid.io » et « # END sshid.io ». En cas d'échec du
# téléchargement, son fichier reste inchangé et le script se termine quand même.
update_personal_keys() {
  local user="${SUDO_USER:-}"
  if [ -z "$user" ] || [ "$user" = root ] || [ "$user" = "$AUTOMATION_USER" ]; then
    echo "sshid.io : ignoré (lancer avec sudo depuis son compte personnel)."
    return
  fi
  if curl -fsS "$SSHID_URL" > "$work/sshid.keys" </dev/null && [ -s "$work/sshid.keys" ] \
    && ssh-keygen -lf "$work/sshid.keys" >/dev/null 2>&1; then
    write_key_block "$user" "$work/sshid.keys" sshid.io
    echo "sshid.io : $(grep -c . "$work/sshid.keys") clés à jour pour $user"
  else
    echo "sshid.io : échec, authorized_keys de $user inchangé"
  fi
}

main "$@"
