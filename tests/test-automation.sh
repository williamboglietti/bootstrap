#!/usr/bin/env bash
# Exécute automation.sh en root dans un conteneur Debian ou Ubuntu jetable (CI) et
# vérifie ce que le README promet. Ne jamais lancer sur une vraie machine.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "à lancer en root, dans un conteneur jetable" >&2; exit 1; }
[ -f /.dockerenv ] || [ -n "${CI:-}" ] || { echo "refusé hors conteneur de CI" >&2; exit 1; }

cd "$(dirname "$0")/.."
SCRIPT="$PWD/automation.sh"
AUTH=/home/automation/.ssh/authorized_keys

fail() { echo "ÉCHEC : $*" >&2; exit 1; }
ok() { echo "ok : $*"; }
block() { sed -n "/^# BEGIN $2\$/,/^# END $2\$/p" "$1"; }

# curl ne sert qu'à SSH.id ; le script installe lui-même sudo et openssh-server.
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null

expected=$(grep -cE '^  "[$]INTERNAL ssh-' "$SCRIPT")
[ "$expected" -ge 1 ] || fail "aucune clé trouvée dans AUTOMATION_KEYS"

echo "== premier passage, lancé directement en root"
bash "$SCRIPT"
id automation >/dev/null || fail "compte automation absent"
[ "$(getent shadow automation | cut -d: -f2)" = "*" ] || fail "mot de passe utilisable sur automation"
[ "$(stat -c %a /home/automation/.ssh)" = 700 ] || fail "droits de ~/.ssh"
[ "$(stat -c '%a %U' "$AUTH")" = "600 automation" ] || fail "droits ou propriétaire d'authorized_keys"
keys=$(block "$AUTH" automation | grep -c ' ssh-')
[ "$keys" -eq "$expected" ] || fail "$keys clés dans le bloc, $expected attendues"
block "$AUTH" automation | grep ' ssh-' | grep -qv '^from="' && fail "une clé sans from="
[ "$(stat -c %a /etc/sudoers.d/90-automation)" = 440 ] || fail "droits de la règle sudo"
sudo -n -l -U automation | grep -q 'NOPASSWD: ALL' || fail "sudo sans mot de passe absent"
ok "compte, $keys clés limitées par from=, sudo"

echo "== relance : ligne étrangère gardée, doublon hors bloc retiré"
dup=$(block "$AUTH" automation | grep -m1 ' ssh-' | sed 's/^from="[^"]*" //')
body=$(awk '{print $2}' <<<"$dup")
printf '%s\n%s\n' "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtrangereCleDeTestPourLaCIxxxxxxxxxxxxxxxx test@ci" "$dup" >> "$AUTH"
bash "$SCRIPT" >/dev/null
grep -q 'test@ci$' "$AUTH" || fail "ligne étrangère au bloc supprimée"
[ "$(grep -c "$body" "$AUTH")" -eq 1 ] || fail "doublon hors bloc conservé"
ok "ligne étrangère gardée, doublon retiré"

echo "== un passage de plus ne change rien"
before=$(sha256sum "$AUTH" /etc/sudoers.d/90-automation)
bash "$SCRIPT" >/dev/null
[ "$before" = "$(sha256sum "$AUTH" /etc/sudoers.d/90-automation)" ] || fail "le script n'est pas idempotent"
ok "idempotent"

echo "== curl | bash"
bash < "$SCRIPT" >/dev/null || fail "lancement par l'entrée standard"
ok "lancement par l'entrée standard"

echo "== SSH.id pour le compte qui lance sudo"
id tester >/dev/null 2>&1 || useradd --create-home --shell /bin/bash tester
ssh-keygen -q -t ed25519 -N '' -C sshid@ci -f /tmp/sshid
SUDO_USER=tester SSHID_URL=file:///tmp/sshid.pub bash "$SCRIPT" >/dev/null
block /home/tester/.ssh/authorized_keys sshid.io | grep -qF "$(cut -d' ' -f2 /tmp/sshid.pub)" \
  || fail "bloc sshid.io absent pour tester"
ok "bloc sshid.io écrit"

before=$(sha256sum /home/tester/.ssh/authorized_keys)
SUDO_USER=tester SSHID_URL=file:///introuvable bash "$SCRIPT" >/dev/null || fail "échec de SSH.id fatal"
[ "$before" = "$(sha256sum /home/tester/.ssh/authorized_keys)" ] || fail "fichier modifié malgré l'échec de SSH.id"
ok "échec de SSH.id sans effet"

echo "Toutes les vérifications sont passées."
