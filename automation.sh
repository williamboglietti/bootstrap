#!/usr/bin/env bash
# Donne à l'automatisation (Ansible, agents IA) l'accès à cette machine Debian ou
# Ubuntu : compte dédié, connexion par clé seule, sudo sans mot de passe.
#
#   curl -fsSL https://raw.githubusercontent.com/williamboglietti/bootstrap/<commit>/automation.sh | sudo bash
#
# Relançable : les clés sont réécrites entre deux délimiteurs, le reste du fichier
# authorized_keys (clés techniques posées à la main) est conservé.
set -euo pipefail

AUTOMATION_USER="${AUTOMATION_USER:-ansible}"

# Une clé par poste qui pilote (décision V131 d'ansible-infra).
AUTOMATION_KEYS=(
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE1TGPtNf2FvZ4HwR3qNigg/vy3IEjC3pANRBAuQ+Uh3 ansible-automation"
)

BEGIN_MARK="# BEGIN automation"
END_MARK="# END automation"

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

  local home group ssh_dir auth_file
  home="$(getent passwd "$AUTOMATION_USER" | cut -d: -f6)"
  group="$(id -gn "$AUTOMATION_USER")"
  ssh_dir="$home/.ssh"
  auth_file="$ssh_dir/authorized_keys"
  install -d -m 700 -o "$AUTOMATION_USER" -g "$group" "$ssh_dir"

  keys_file="$(mktemp)"
  new_auth="$(mktemp)"
  sudoers_tmp="$(mktemp)"
  trap 'rm -f "$keys_file" "$new_auth" "$sudoers_tmp"' EXIT

  printf '%s\n' "${AUTOMATION_KEYS[@]}" > "$keys_file"
  ssh-keygen -lf "$keys_file" >/dev/null || die "clé publique invalide dans le script."

  {
    if [ -f "$auth_file" ]; then
      sed "/^${BEGIN_MARK}\$/,/^${END_MARK}\$/d" "$auth_file" | grep -vxFf "$keys_file" || true
    fi
    echo "$BEGIN_MARK"
    cat "$keys_file"
    echo "$END_MARK"
  } > "$new_auth"
  install -m 600 -o "$AUTOMATION_USER" -g "$group" "$new_auth" "$auth_file"

  echo "$AUTOMATION_USER ALL=(ALL) NOPASSWD:ALL" > "$sudoers_tmp"
  visudo -cqf "$sudoers_tmp" || die "règle sudo refusée par visudo."
  install -m 440 -o root -g root "$sudoers_tmp" "/etc/sudoers.d/90-$AUTOMATION_USER"

  echo "Compte $AUTOMATION_USER prêt sur $(hostname) :"
  ssh-keygen -lf "$keys_file" | sed 's/^/  clé : /'
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
}

main "$@"
