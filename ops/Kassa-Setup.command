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
# sonst den aktuellen Installer von GitHub laden.
if [ -f "./install.sh" ]; then
  bash ./install.sh
else
  curl -fsSL "https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.sh" | bash
fi

echo
echo "Fertig. Dieses Fenster kann geschlossen werden."
