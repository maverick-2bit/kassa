#!/usr/bin/env bash
#
# Kassa POS — Tests für den Linux-Fernwartungs-Schritt (ops/fernwartung.sh, ops/install.sh).
#
# Läuft OHNE etwas zu installieren: teamviewer, apt-get, docker, sudo, systemctl, curl,
# dpkg und uname werden durch Attrappen im Test-PATH ersetzt, die nur Aufrufe mitschreiben.
# Geprüft werden u. a.: Konfiguration, Gerätename, Statusdatei (ohne Geheimnisse),
# Idempotenz, Fehlerfälle — und dass die Assignment-ID in KEINER Ausgabe vorkommt.
#
# Aufruf:  bash ops/test-fernwartung.sh        (Exit-Code 0 = alles bestanden)
# Braucht python3 oder jq (wie der Fernwartungs-Schritt selbst).

set -u
export PYTHONUTF8=1   # python3 unter Windows soll UTF-8 schreiben (Linux: ohnehin Standard)
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSID='0001DUMMYASSIGNMENTIDabcdefghijklmnopqrstuvwxyz0123456789-ZZZZ'
URLQ='?sig=DUMMYQUERYKEY123456'

ANZAHL=0; FEHL=0
pruefe() { # $1 = Beschreibung, Rest = Befehl (Exit 0 = bestanden)
  local text="$1"; shift
  ANZAHL=$((ANZAHL + 1))
  if "$@"; then printf '  [ok]   %s\n' "$text"
  else printf '  [FAIL] %s\n' "$text"; FEHL=$((FEHL + 1)); fi
}
gruppe() { printf '\n%s\n' "$1"; }
enthaelt()      { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
enthaelt_nicht(){ case "$1" in *"$2"*) return 1 ;; *) return 0 ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
LOG="$TMP/aufrufe.log"; : > "$LOG"

# ── Attrappen ────────────────────────────────────────────────────────────────
# python3 vorhanden? Sonst (Windows/Git Bash) auf python zurückgreifen
if ! python3 -c 'import json' >/dev/null 2>&1; then
  for p in python /c/Python314/python.exe; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import json' >/dev/null 2>&1; then
      printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v "$p")" > "$BIN/python3"; chmod +x "$BIN/python3"; break
    fi
  done
fi

cat > "$BIN/uname" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-s" ]; then echo Linux; else exec /usr/bin/uname "$@"; fi
EOF
cat > "$BIN/sudo" <<'EOF'
#!/bin/sh
exec "$@"
EOF
cat > "$BIN/id" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi
EOF
cat > "$BIN/dpkg" <<'EOF'
#!/bin/sh
[ "${1:-}" = "--print-architecture" ] && { echo amd64; exit 0; }
exit 0
EOF
cat > "$BIN/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >> "$LOG"
exit 0
EOF
cat > "$BIN/curl" <<EOF
#!/bin/sh
echo "curl \$*" >> "$LOG"
# -o <Datei>: Attrappe schreiben
while [ \$# -gt 0 ]; do [ "\$1" = "-o" ] && { echo "dummy-paket" > "\$2"; }; shift; done
exit 0
EOF
# docker: schreibt Aufruf und (bei exec) den Inhalt von stdin mit
cat > "$BIN/docker" <<EOF
#!/bin/sh
echo "docker \$*" >> "$LOG"
case "\$*" in *exec*) cat > "$TMP/veroeffentlicht.json" ;; esac
exit \${FAKE_DOCKER_RC:-0}
EOF
# apt-get "installiert" teamviewer: legt die Attrappe an
cat > "$BIN/apt-get" <<EOF
#!/bin/sh
echo "apt-get \$*" >> "$LOG"
[ "\${FAKE_APT_RC:-0}" -ne 0 ] && exit \${FAKE_APT_RC}
cp "$TMP/teamviewer.vorlage" "$BIN/teamviewer"; chmod +x "$BIN/teamviewer"
exit 0
EOF
cat > "$TMP/teamviewer.vorlage" <<EOF
#!/bin/sh
echo "teamviewer \$*" >> "$LOG"
case "\$1" in
  info) [ -n "\${FAKE_TV_ID:-}" ] && printf 'TeamViewer ID:    %s\n' "\${FAKE_TV_ID}"; exit 0 ;;
  assignment)
    case "\$*" in *--offline*) exit \${FAKE_TV_RC_OFFLINE:-0} ;; esac
    exit \${FAKE_TV_RC:-0} ;;
esac
exit 0
EOF
chmod +x "$BIN/uname" "$BIN/sudo" "$BIN/id" "$BIN/dpkg" "$BIN/systemctl" "$BIN/curl" "$BIN/docker" "$BIN/apt-get"
export PATH="$BIN:$PATH"
export FAKE_TV_ID=123456789
FW_STATUS_DATEI_STANDARD_TEST="$TMP/status/fernwartung-status.json"

# Bibliothek laden (ohne Wartezeiten zwischen den Versuchen)
export FW_TAKT=0
# shellcheck disable=SC1091
. "$HIER/fernwartung.sh"

setze_szenario() { # entfernt die Attrappe "teamviewer" (= nicht installiert) und leert das Log
  rm -f "$BIN/teamviewer" "$TMP/veroeffentlicht.json"; rm -rf "$TMP/status"; : > "$LOG"
  unset FAKE_TV_RC FAKE_TV_RC_OFFLINE FAKE_APT_RC FAKE_DOCKER_RC; export FAKE_TV_ID=123456789
}
konfig_schreiben() { # $1 = Dateiname, $2 = Inhalt
  printf '%s' "$2" > "$TMP/$1"
}
log_zeilen() { grep -c "$1" "$LOG" || true; }

JSON_OK="{ \"anbieter\": \"teamviewer\", \"msiPfad\": \"teamviewer-host_amd64.deb\", \"assignmentId\": \"$ASSID\", \"gruppe\": \"Mietkassen\", \"aliasVorlage\": \"Kassa {Name}\" }"

# ═════════════════════════════════════════════════════════════════════════════
gruppe "1. Kleine reine Funktionen"
# ═════════════════════════════════════════════════════════════════════════════
pruefe "Alias: Vorlage + Name"                 test "$(fw_alias 'Kassa {Name}' 'Gasthof Mayr' PC01)" = "Kassa Gasthof Mayr"
pruefe "Alias: ohne Name gilt der Hostname"    test "$(fw_alias '{Name}' '' KASSA-PC)" = "KASSA-PC"
pruefe "Alias: {Computername}"                 test "$(fw_alias '{Name} ({Computername})' Cafe PC7)" = "Cafe (PC7)"
pruefe "Alias: Anführungszeichen, %, &, | werden entfernt" test "$(fw_alias '{Name}' 'A"B%C&D|E' X)" = "A B C D E"
LANG_ALIAS="$(fw_alias '{Name}' "$(printf 'x%.0s' $(seq 1 200))" X)"
pruefe "Alias: höchstens 64 Zeichen"           test "${#LANG_ALIAS}" -le 64
pruefe "ID-Format: 9 Stellen"                  test "$(fw_id_format 123456789)" = "123 456 789"
pruefe "ID-Format: 10 Stellen"                 test "$(fw_id_format 1234567890)" = "1 234 567 890"
FW_GEHEIMNISSE=("$ASSID")
pruefe "Maskierung: bekanntes Geheimnis"       test "$(fw_maskiere "x $ASSID y")" = "x *** y"
FW_GEHEIMNISSE=()

# ═════════════════════════════════════════════════════════════════════════════
gruppe "2. Konfiguration"
# ═════════════════════════════════════════════════════════════════════════════
konfig_schreiben ok.json "$JSON_OK"
fw_konfig_lesen "$TMP/ok.json"; rc=$?
pruefe "Gültige Rollout-Konfiguration"            test "$rc" -eq 0 -a "$FW_MODUS" = "assignmentId"
pruefe "Assignment-ID steht in der Geheimnisliste" test "${FW_GEHEIMNISSE[0]:-}" = "$ASSID"
pruefe "Relativer Pfad wird zum Konfig-Ordner aufgelöst" test "$FW_INSTALLER_PFAD" = "$FW_KONFIG_DIR/teamviewer-host_amd64.deb"

konfig_schreiben tok.json '{ "msiPfad": "x.deb", "apiToken": "1234567-DUMMYTOKENabcdefghijkl" }'
fw_konfig_lesen "$TMP/tok.json"; rc=$?
pruefe "apiToken unter Linux: nur Warnung (nicht unterstützt), keine Zuordnung" test "$rc" -eq 0 -a "$FW_MODUS" = "keine" -a "${#FW_WARNUNGEN[@]}" -ge 2
konfig_schreiben kaputt.json "{ \"assignmentId\": \"$ASSID\" \"gruppe\": \"x\" }"
fw_konfig_lesen "$TMP/kaputt.json"; rc=$?
pruefe "Kaputtes JSON: Fehler OHNE Inhalt der Datei" test "$rc" -ne 0 -a "$(enthaelt_nicht "${FW_FEHLER[*]}" "$ASSID" && echo ja)" = ja
konfig_schreiben ph.json '{ "msiPfad": "x.deb", "assignmentId": "ERSETZEN-DURCH-DIE-ASSIGNMENT-ID" }'
fw_konfig_lesen "$TMP/ph.json"; rc=$?
pruefe "Nicht ersetzter Platzhalter → Fehler" test "$rc" -ne 0 -a "$(enthaelt "${FW_FEHLER[*]}" Platzhalter && echo ja)" = ja
konfig_schreiben fmt.json '{ "assignmentId": "kurz" }'
fw_konfig_lesen "$TMP/fmt.json"; rc=$?
pruefe "Assignment-ID mit unerwartetem Format → Fehler ohne den Wert" test "$rc" -ne 0 -a "$(enthaelt_nicht "${FW_FEHLER[*]}" kurz && echo ja)" = ja
konfig_schreiben url.json "{ \"hostInstallerUrl\": \"http://example.com/a.deb\", \"assignmentId\": \"$ASSID\" }"
fw_konfig_lesen "$TMP/url.json"; rc=$?
pruefe "http:// als Installer-URL → Fehler" test "$rc" -ne 0
konfig_schreiben q.json "{ \"hostInstallerUrl\": \"https://example.com/a.deb$URLQ\", \"assignmentId\": \"$ASSID\" }"
fw_konfig_lesen "$TMP/q.json"; rc=$?
pruefe "Installer-URL: Query-Teil gilt als Geheimnis" test "$rc" -eq 0 -a "${FW_GEHEIMNISSE[0]:-}" = "$URLQ" -a "${FW_GEHEIMNISSE[1]:-}" = "$ASSID"
konfig_schreiben typo.json "{ \"assignmentIdd\": \"x\", \"_kommentar\": \"egal\", \"assignmentId\": \"$ASSID\" }"
fw_konfig_lesen "$TMP/typo.json"; rc=$?
pruefe "Tippfehler im Feldnamen → Warnung; _Kommentar ohne Warnung" test "$rc" -eq 0 -a "${#FW_WARNUNGEN[@]}" -eq 1 -a "$(enthaelt "${FW_WARNUNGEN[0]}" assignmentIdd && echo ja)" = ja
pruefe "Konfiguration fehlt → Fehler, kein Absturz" test "$(fw_konfig_lesen "$TMP/gibt-es-nicht.json" || echo nein)" = nein

# ═════════════════════════════════════════════════════════════════════════════
gruppe "3. Statusdatei (ohne Geheimnisse, reines ASCII)"
# ═════════════════════════════════════════════════════════════════════════════
J="$(fw_status_json 123456789 'Café "Müller"' Mietkassen 2026-10-06T20:15:00Z)"
pruefe "Status: Felder vorhanden"    test "$(enthaelt "$J" '"id":"123456789"' && enthaelt "$J" '"anbieter":"teamviewer"' && echo ja)" = ja
pruefe "Status: reines ASCII"        test -z "$(printf '%s' "$J" | LC_ALL=C grep -P '[^\x20-\x7E]' 2>/dev/null || printf '%s' "$J" | LC_ALL=C tr -d '\040-\176')"
pruefe "Status: Rücklesen des Namens (JSON-Escapes → Text)" test "$(fw_json_text "$(printf '%s' "$J" | sed -nE 's/.*"alias":"(([^"\\]|\\.)*)".*/\1/p')")" = 'Café "Müller"'

# ═════════════════════════════════════════════════════════════════════════════
gruppe "4. Ablauf mit Attrappen (Trockenlauf, Installation, Wiederholung, Fehler)"
# ═════════════════════════════════════════════════════════════════════════════
export PATH="$BIN:$PATH"
cp /dev/null "$TMP/teamviewer-host_amd64.deb"; echo dummy > "$TMP/teamviewer-host_amd64.deb"
konfig_schreiben fw.json "$JSON_OK"
STATUS="$TMP/status/fernwartung-status.json"

setze_szenario
OUT="$(fw_ausfuehren "$TMP/fw.json" Mayr 0 1 "$STATUS" 2>&1)"
pruefe "Trockenlauf: zeigt den assignment-Aufruf mit maskierter ID" test "$(enthaelt "$OUT" 'assignment --id ***' && enthaelt "$OUT" 'Kassa Mayr' && echo ja)" = ja
pruefe "Trockenlauf: die Assignment-ID steht in KEINER Ausgabe"   test "$(enthaelt_nicht "$OUT" "$ASSID" && echo ja)" = ja
pruefe "Trockenlauf: führt nichts aus und schreibt nichts"        test ! -s "$LOG" -a ! -e "$STATUS"

setze_szenario
OUT="$(fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"; RC=$?
pruefe "Voller Lauf: liefert immer 0 und meldet die ID"          test "$RC" -eq 0 -a "$(enthaelt "$OUT" '123 456 789' && echo ja)" = ja
pruefe "Voller Lauf: installiert das Paket, aktiviert den Dienst, ordnet zu" test "$(log_zeilen '^apt-get install')" -eq 1 -a "$(log_zeilen '^systemctl enable --now teamviewerd')" -eq 1 -a "$(log_zeilen '^teamviewer assignment --id')" -eq 1
pruefe "Voller Lauf: assignment mit --device-alias, --retries, --timeout" test "$(grep '^teamviewer assignment' "$LOG" | grep -c -- '--device-alias=Kassa Mayr --retries=20 --timeout=120')" -eq 1
pruefe "Voller Lauf: die Assignment-ID steht in KEINER Ausgabe"   test "$(enthaelt_nicht "$OUT" "$ASSID" && echo ja)" = ja
pruefe "Voller Lauf: Statusdatei ohne Geheimnis"                  test "$(grep -c '"id":"123456789"' "$STATUS")" -eq 1 -a "$(grep -c "$ASSID" "$STATUS")" -eq 0
ERSTE_ZEIT="$(sed -nE 's/.*"installiertAm":"([^"]*)".*/\1/p' "$STATUS")"

: > "$LOG"
OUT="$(fw_ausfuehren "$TMP/fw.json" "" 0 0 "$STATUS" 2>&1)"
pruefe "Zweiter Lauf: installiert und ordnet NICHT erneut zu"     test "$(log_zeilen '^apt-get')" -eq 0 -a "$(log_zeilen '^teamviewer assignment')" -eq 0
pruefe "Zweiter Lauf: behält Gerätename und Installationszeitpunkt" test "$(grep -c '"alias":"Kassa Mayr"' "$STATUS")" -eq 1 -a "$(sed -nE 's/.*"installiertAm":"([^"]*)".*/\1/p' "$STATUS")" = "$ERSTE_ZEIT"
: > "$LOG"
OUT="$(fw_ausfuehren "$TMP/fw.json" "" 1 0 "$STATUS" 2>&1)"
pruefe "Mit KASSA_FERNWARTUNG_NEU=1: ein assignment mit --reassign"  test "$(grep '^teamviewer assignment' "$LOG" | grep -c -- '--reassign')" -eq 1

setze_szenario
OUT="$(FAKE_APT_RC=100 fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"; RC=$?
pruefe "Installation scheitert: Rückgabe 0, Fehler + Nachhol-Hinweis, keine Statusdatei" test "$RC" -eq 0 -a "$(enthaelt "$OUT" 'fehlgeschlagen' && enthaelt "$OUT" 'Nachholen' && echo ja)" = ja -a ! -e "$STATUS"

setze_szenario
OUT="$(FAKE_TV_RC=5 fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"; RC=$?
pruefe "Zuordnung scheitert: Warnung + Hinweis auf KASSA_FERNWARTUNG_NEU, keine Statusdatei" test "$RC" -eq 0 -a "$(enthaelt "$OUT" 'Zuordnung nicht gelungen' && enthaelt "$OUT" KASSA_FERNWARTUNG_NEU && echo ja)" = ja -a ! -e "$STATUS"
pruefe "Zuordnung scheitert: ID nicht in der Ausgabe"          test "$(enthaelt_nicht "$OUT" "$ASSID" && echo ja)" = ja

setze_szenario
OUT="$(FAKE_TV_RC=49 fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"
pruefe "Schon zugeordnet (Exit 49 = 409): gilt als Erfolg, Status geschrieben" test -s "$STATUS" -a "$(enthaelt "$OUT" 'bereits' && echo ja)" = ja

setze_szenario
OUT="$(FAKE_TV_RC=1 fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"
pruefe "Ungültige Argumente (1): zweiter Versuch mit --device_alias (Doku-Variante)" test "$(log_zeilen '^teamviewer assignment')" -eq 2 -a "$(grep -c -- '--device_alias Kassa Mayr' "$LOG")" -eq 1

setze_szenario
unset FAKE_TV_ID
OUT="$(fw_ausfuehren "$TMP/fw.json" Mayr 0 0 "$STATUS" 2>&1)"
pruefe "Offline (keine ID): Zuordnung mit --offline vorgemerkt, keine Statusdatei" test "$(grep '^teamviewer assignment' "$LOG" | grep -c -- '--offline')" -ge 1 -a "$(enthaelt "$OUT" vorgemerkt && echo ja)" = ja -a ! -e "$STATUS"
export FAKE_TV_ID=123456789

setze_szenario
konfig_schreiben leer.json '{ }'
OUT="$(fw_ausfuehren "$TMP/leer.json" Mayr 0 0 "$STATUS" 2>&1)"
pruefe "Konfiguration ohne Zuordnung: installiert, zeigt NICHT 'eingerichtet'" test ! -e "$STATUS" -a "$(enthaelt "$OUT" 'NICHT als eingerichtet' && echo ja)" = ja

test_veroeffentlichen() {
  mkdir -p "$TMP/kassa"; echo '{"id":"123456789"}' > "$TMP/st.json"
  : > "$LOG"; rm -f "$TMP/veroeffentlicht.json"
  fw_veroeffentlichen "$TMP/st.json" "$TMP/kassa"     && grep -q "compose exec -T updater" "$LOG"     && grep -q "123456789" "$TMP/veroeffentlicht.json"
}
pruefe "Veröffentlichen: schreibt die Statusdatei per docker compose exec in /control" test_veroeffentlichen

# ═════════════════════════════════════════════════════════════════════════════
gruppe "5. install.sh (Trockenlauf als eigener Prozess)"
# ═════════════════════════════════════════════════════════════════════════════
setze_szenario
mkdir -p "$TMP/lauf"; cp "$TMP/fw.json" "$TMP/lauf/fernwartung.json"; cp "$TMP/teamviewer-host_amd64.deb" "$TMP/lauf/"
OUT="$(cd "$TMP/lauf" && KASSA_TROCKENLAUF=1 KASSA_FERNWARTUNG_NAME=Testkasse bash "$HIER/install.sh" 2>&1)"; RC=$?
pruefe "install.sh KASSA_TROCKENLAUF=1: Exit-Code 0"                  test "$RC" -eq 0
pruefe "install.sh Trockenlauf: Plan sichtbar (Gerätename, assignment)" test "$(enthaelt "$OUT" Testkasse && enthaelt "$OUT" 'assignment --id ***' && echo ja)" = ja
pruefe "install.sh Trockenlauf: die Assignment-ID steht in KEINER Ausgabe" test "$(enthaelt_nicht "$OUT" "$ASSID" && echo ja)" = ja
pruefe "install.sh Trockenlauf: tut nichts (kein Docker, keine Installation)" test "$(enthaelt_nicht "$OUT" 'Docker installieren' && enthaelt_nicht "$OUT" 'Lade aktuellen Quellcode' && echo ja)" = ja -a ! -s "$LOG"
OUT="$(cd "$TMP" && KASSA_TROCKENLAUF=1 KASSA_FERNWARTUNG_KONFIG="$TMP/gibt-es-nicht.json" bash "$HIER/install.sh" 2>&1)"; RC=$?
pruefe "install.sh Trockenlauf ohne Konfiguration: Exit-Code 0 mit Fehlermeldung (Konfig nicht gefunden)" test "$(enthaelt "$OUT" 'nicht gefunden' && echo ja)" = ja

printf '\n'
if [ "$FEHL" -eq 0 ]; then printf 'ALLE %d TESTS BESTANDEN\n' "$ANZAHL"; exit 0; fi
printf '%d von %d TESTS FEHLGESCHLAGEN\n' "$FEHL" "$ANZAHL"; exit 1
