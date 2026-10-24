#!/usr/bin/env bash
# Demande un accès automation pour cette machine (VM d'agent, poste) : génère
# ~/.ssh/automation si besoin, ajoute sa clé publique à
# group_vars/all/ssh_access.yml d'ansible-infra et ouvre la PR. La clé ne vaut
# qu'après l'approbation de William, la fusion et l'application de
# playbooks/ssh-access.yml.
#
#   bash enroll.sh --hosts docker9,dokploy [--name vm-agent-x] [--days 30] [--dry-run]
#
# Prérequis : git, ssh-keygen et gh connecté avec le compte des agents
# (williamboglietti-bot), jeton classique de portée repo.
set -euo pipefail

REPO="${ENROLL_REPO:-williamboglietti/ansible-infra}"
BASE="${ENROLL_BASE:-main}"
KEYS_FILE="group_vars/all/ssh_access.yml"
KEY_PATH="$HOME/.ssh/automation"
MAX_DAYS=90

die() { echo "enroll.sh : $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage : bash enroll.sh --hosts h1,h2 [--name nom] [--days N] [--dry-run]

  --hosts    machines ou groupes de l'inventaire d'ansible-infra (obligatoire)
  --name     nom de l'entrée, unique (défaut : nom court de la machine)
  --days     durée de validité de la clé, 1 à 90 jours (défaut : 30)
  --dry-run  affiche la modification sans pousser ni ouvrir de PR
EOF
}

name="$(hostname -s | tr '[:upper:]' '[:lower:]')"
hosts=""
days=30
dry_run=false
while (($#)); do
  case "$1" in
    --hosts) hosts="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --days) days="${2:-}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "option inconnue : $1" ;;
  esac
done

[[ -n "$hosts" ]] || { usage >&2; die "--hosts est obligatoire : une clé d'agent ne vise jamais toutes les machines."; }
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "nom invalide : $name (minuscules, chiffres, tirets)."
if ! [[ "$days" =~ ^[0-9]+$ ]] || ((days < 1 || days > MAX_DAYS)); then
  die "--days doit être entre 1 et $MAX_DAYS."
fi
IFS=',' read -r -a host_list <<<"$hosts"
for host in "${host_list[@]}"; do
  [[ "$host" =~ ^[A-Za-z0-9_.-]+$ ]] || die "nom de machine ou de groupe invalide : $host"
  [[ "$host" != all ]] || die "« all » est refusé : lister les machines du projet."
done

for tool in git ssh-keygen gh; do
  command -v "$tool" >/dev/null || die "$tool est introuvable."
done
login="$(gh api user --jq .login 2>/dev/null)" || die "gh n'est pas connecté : gh auth login --with-token < jeton.txt"
if [[ "$login" == williamboglietti ]]; then
  echo "Attention : gh utilise le compte de William, qui contourne la règle de revue de main. Le compte des agents est williamboglietti-bot." >&2
fi

# Linux (GNU date) ou macOS (BSD date).
expires="$(date -d "+$days days" +%Y%m%d 2>/dev/null || date -v+"$days"d +%Y%m%d)"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
gh repo clone "$REPO" "$workdir/repo" -- --quiet --depth 1 --branch "$BASE"
cd "$workdir/repo"
[[ -f "$KEYS_FILE" ]] || die "$KEYS_FILE est absent de $REPO@$BASE."

# Noms acceptés par la liste hosts : machines et groupes de l'inventaire.
known="$(awk '
  /^[[:space:]]*(#|;|$)/ { next }
  /^\[/ { section = $0; gsub(/^\[|\]$/, "", section); split(section, part, ":"); print part[1]; vars = (part[2] == "vars"); next }
  !vars { print $1 }
' inventory.ini | sort -u)"
for host in "${host_list[@]}"; do
  grep -qxF "$host" <<<"$known" || die "inconnu dans inventory.ini : $host"
done

grep -qE "^  - name: ${name}\$" "$KEYS_FILE" && die "l'entrée « $name » existe déjà dans $KEYS_FILE : choisir un autre --name."

if [[ ! -f "$KEY_PATH" ]]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -q -t ed25519 -N '' -C "automation@$name" -f "$KEY_PATH"
  echo "Clé générée : $KEY_PATH"
fi
pubkey="$(cat "$KEY_PATH.pub")"
fingerprint="$(ssh-keygen -lf "$KEY_PATH.pub" | awk '{print $2}')"
grep -qF "$(awk '{print $2}' <<<"$pubkey")" "$KEYS_FILE" && die "cette clé est déjà dans $KEYS_FILE."
# L'entrée est ajoutée en fin de fichier : automation_keys doit en être la dernière variable.
[[ "$(grep -E '^[a-z_]+:' "$KEYS_FILE" | tail -1)" == "automation_keys:" ]] || die "automation_keys n'est plus la dernière variable de $KEYS_FILE ; ajout manuel nécessaire."

hosts_yaml="$(printf '%s, ' "${host_list[@]}")"
cat >>"$KEYS_FILE" <<EOF
  - name: $name
    key: "$pubkey"
    expires: "$expires"
    hosts: [${hosts_yaml%, }]
EOF

expires_human="${expires:6:2}/${expires:4:2}/${expires:0:4}"
title="accès automation : $name sur $hosts jusqu'au $expires_human"
branch="acces/$name-$(date +%Y%m%d%H%M)"
body="Demande d'accès ouverte par \`enroll.sh\` depuis \`$(hostname)\` (compte GitHub \`$login\`).

| | |
| --- | --- |
| Entrée | \`$name\` |
| Empreinte | \`$fingerprint\` |
| Machines | \`$hosts\` |
| Expire | $expires_human (\`expiry-time=\`, OpenSSH 8.2 ou plus : jamais posée sur les NAS Debian 10) |
| Origine | réseaux internes et Tailscale (\`from=\` par défaut) |

Après fusion, la clé est posée par \`playbooks/ssh-access.yml\`."

git switch -q -c "$branch"
git -c user.name="$login" -c user.email="$login@users.noreply.github.com" \
  commit -q -m "$title" -- "$KEYS_FILE"

if $dry_run; then
  git show --stat --patch HEAD
  echo "--dry-run : rien n'a été poussé."
  exit 0
fi

git push -q -u origin "$branch"
gh pr create --repo "$REPO" --base "$BASE" --head "$branch" --title "$title" --body "$body"
