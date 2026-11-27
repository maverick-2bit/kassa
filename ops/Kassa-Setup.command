#!/bin/bash
# ============================================================
#  Kassa POS — Setup / Update  (macOS, Doppelklick im Finder)
#
#  Diese Datei auf den Mac kopieren und per DOPPELKLICK starten.
#  Öffnet ein Terminal, lädt den aktuellen Installer von GitHub
#  und richtet alles ein (installiert bei Bedarf Docker Desktop).
#
#  Erneut ausführen = Update (Daten bleiben erhalten).
#  Voraussetzung: Internetverbindung.
#
#  Hinweis: Beim ersten Mal blockiert macOS geladene Dateien evtl.
#  („nicht verifizierter Entwickler"). Dann einmal RECHTSKLICK →
#  „Öffnen" → „Öffnen" wählen (statt Doppelklick).
# ============================================================
cd "$(dirname "$0")" || exit 1
clear
echo "  Kassa POS — Setup / Update (macOS)"
echo "  =================================="
echo

# Liegt install.sh daneben (z. B. Repo-Checkout / Offline-Kopie)? Dann diese nutzen,
# sonst den Installer des NEUESTEN RELEASES (Git-Tag vX.Y.Z, nicht die master-Spitze) von GitHub laden.
if [ -f "./install.sh" ]; then
  bash ./install.sh
else
  echo "Suche das neueste Release auf GitHub ..."
  TAG="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/maverick-2bit/kassa/git/matching-refs/tags/v" 2>/dev/null \
    | grep -Eo '"refs/tags/v[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sed 's|refs/tags/||' \
    | awk -F'[v.]' '{ printf "%09d%09d%09d %s\n", $2, $3, $4, $0 }' | sort | tail -n 1 | awk '{ print $2 }')"
  if [ -z "$TAG" ]; then
    echo "FEHLER: Kein Release auf GitHub gefunden - bitte die Internetverbindung pruefen."
    exit 1
  fi
  echo "Neuestes Release: $TAG"
  curl -fsSL "https://raw.githubusercontent.com/maverick-2bit/kassa/${TAG}/ops/install.sh" | bash
fi

echo
echo "Fertig. Dieses Fenster kann geschlossen werden."
