#!/bin/sh
#
# Kassa POS — Release-Tag prüfen. Wird VOR dem Push eines Releases von Hand gestartet und läuft nach jedem Tag-Push
# im GitHub-Workflow „Release-Tag prüfen" (.github/workflows/release-pruefung.yml).
#
# Aufruf (im Repo):   sh ops/release/pruefe-release.sh vX.Y.Z [--master]
#   --master          das getaggte Commit muss auf origin/master (sonst master) liegen
#
# Geprüft wird, worauf sich der In-App-Updater (ops/updater/updater.sh) verlässt — ein Release, das hier durchfällt,
# wird auf den Kassen NICHT installiert (der Updater übergeht es still, die Kasse zeigt weiter das alte Release):
#   1. annotiertes Tag; der Name im Tag-Objekt ist das Tag; es zeigt auf ein Commit
#   2. gültige SSH-Signatur eines Schlüssels aus ops/updater/allowed_signers — sowohl nach der Datei des VORGÄNGER-
#      Releases (so sieht es eine installierte Kasse) als auch nach der Datei dieses Releases (Signierer nicht ausgesperrt)
#   3. Version in ALLEN package.json (Versions-Lockstep) = Tag ohne „v"
#   4. docker-compose.yml, ops/updater/updater.sh und ops/updater/allowed_signers gehören zum Release
#   5. mit --master: das Commit liegt auf master
#
# Exit-Code 0 = alles in Ordnung, sonst die Anzahl der Fehlschläge.
#
set -u

TAG="${1:-}"
MASTER=0
if [ "${2:-}" = "--master" ]; then MASTER=1; fi
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Aufruf: sh ops/release/pruefe-release.sh vX.Y.Z [--master]"; exit 2 ;;
esac
if ! printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then echo "Kein Release-Tag (vX.Y.Z): $TAG"; exit 2; fi
VERSION="${TAG#v}"

FEHL=0
ok()   { printf '  [ok]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FEHL=$((FEHL + 1)); }
hinweis() { printf '  [--]   %s\n' "$1"; }

TMP="$(mktemp -d)" || { echo "kein Arbeitsordner"; exit 2; }
trap 'rm -rf "$TMP"' EXIT

echo "Release $TAG prüfen"

# ── 1. Tag-Objekt ────────────────────────────────────────────────────────────
ART="$(git cat-file -t "refs/tags/$TAG" 2>/dev/null || true)"
if [ "$ART" != "tag" ]; then
  fail "$TAG ist kein annotiertes Tag (git tag -s -m \"…\" $TAG) — der Updater nimmt nur signierte, annotierte Tags"
  echo; echo "$FEHL Fehlschlag/Fehlschläge"; exit "$FEHL"
fi
OBJ="$(git cat-file tag "refs/tags/$TAG")"
INNEN="$(printf '%s\n' "$OBJ" | sed -n 's/^tag //p' | head -n 1)"
TYP="$(printf '%s\n' "$OBJ" | sed -n 's/^type //p' | head -n 1)"
if [ "$INNEN" = "$TAG" ] && [ "$TYP" = "commit" ]; then ok "annotiertes Tag, zeigt auf ein Commit"; else fail "Tag-Objekt trägt den Namen '$INNEN' (Typ '$TYP') statt '$TAG' auf ein Commit"; fi
COMMIT="$(git rev-parse "refs/tags/$TAG^{commit}")"

# ── 2. Signatur ──────────────────────────────────────────────────────────────
# Vorgänger-Release: das höchste vX.Y.Z-Tag unterhalb dieses Tags
SCHLUESSEL="$(printf '%s' "$VERSION" | awk -F. '{ printf "%09d%09d%09d", $1, $2, $3 }')"
VORGAENGER="$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | awk -F'[v.]' -v self="$SCHLUESSEL" '{ k = sprintf("%09d%09d%09d", $2, $3, $4); if (k < self) print k, $0 }' \
  | sort | tail -n 1 | awk '{ print $2 }')"

git show "$COMMIT:ops/updater/allowed_signers" > "$TMP/signers-dieses" 2>/dev/null || : > "$TMP/signers-dieses"
if [ ! -s "$TMP/signers-dieses" ]; then
  fail "ops/updater/allowed_signers fehlt im Release (ohne diese Datei kann keine Kasse das nächste Update prüfen)"
elif git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$TMP/signers-dieses" verify-tag "$TAG" >/dev/null 2>&1; then # M:signatur-dieses
  ok "Signatur gültig nach der allowed_signers dieses Releases (der Signierer bleibt vertrauenswürdig)"
else
  fail "Signatur fehlt oder ungültig (nach der allowed_signers dieses Releases) — Tag mit dem Signaturschlüssel neu setzen: git tag -d $TAG; git tag -s -m \"…\" $TAG"
fi

if [ -n "$VORGAENGER" ]; then
  if git show "$VORGAENGER:ops/updater/allowed_signers" > "$TMP/signers-vorgaenger" 2>/dev/null && [ -s "$TMP/signers-vorgaenger" ]; then
    if git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$TMP/signers-vorgaenger" verify-tag "$TAG" >/dev/null 2>&1; then # M:vorgaenger
      ok "Signatur gültig nach der allowed_signers des Vorgängers $VORGAENGER (so sieht es eine installierte Kasse)"
    else
      fail "Eine Kasse mit $VORGAENGER würde dieses Release ABLEHNEN: der Signierer steht nicht in der allowed_signers von $VORGAENGER (neuer Schlüssel erst in einem Release einführen, das noch mit einem alten signiert ist)"
    fi
  else
    hinweis "Vorgänger $VORGAENGER hat keine allowed_signers (Übergang: es wird auf den Kassen ungeprüft durch den alten Updater geliefert)"
  fi
else
  hinweis "kein Vorgänger-Release gefunden"
fi

# ── 3. Versions-Lockstep ─────────────────────────────────────────────────────
PJ="$(git ls-tree -r --name-only "$COMMIT" | grep -E '(^|/)package\.json$' | grep -v node_modules)"
SCHLECHT=0; ANZ=0
for f in $PJ; do
  ANZ=$((ANZ + 1))
  V="$(git show "$COMMIT:$f" | grep -m1 '"version"' | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  if [ "$V" != "$VERSION" ]; then fail "$f hat Version '${V:-?}' statt $VERSION"; SCHLECHT=$((SCHLECHT + 1)); fi # M:lockstep
done
if [ "$ANZ" -eq 0 ]; then fail "keine package.json im Release gefunden"
elif [ "$SCHLECHT" -eq 0 ]; then ok "alle $ANZ package.json tragen Version $VERSION"; fi

# ── 4. Pflichtdateien ────────────────────────────────────────────────────────
for f in docker-compose.yml ops/updater/updater.sh ops/updater/allowed_signers; do
  if git cat-file -e "$COMMIT:$f" 2>/dev/null; then :; else fail "$f fehlt im Release"; fi
done

# ── 5. Auf master? ───────────────────────────────────────────────────────────
if [ "$MASTER" -eq 1 ]; then
  BASIS="origin/master"; git rev-parse --verify -q "$BASIS" >/dev/null || BASIS="master"
  if git merge-base --is-ancestor "$COMMIT" "$BASIS" 2>/dev/null; then ok "das Commit liegt auf $BASIS"; else fail "das Commit liegt NICHT auf $BASIS (erst master pushen, dann das Tag)"; fi
fi

echo
if [ "$FEHL" -eq 0 ]; then echo "Release $TAG ist in Ordnung."; exit 0; fi
echo "$FEHL Fehlschlag/Fehlschläge — Release $TAG würde auf den Kassen nicht installiert."
exit "$FEHL"
