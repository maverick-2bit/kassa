#!/usr/bin/env bash
#
# Kassa POS — Fernwartung (Linux): TeamViewer Host einrichten — BEST EFFORT.
#
# Bibliothek: nur Funktionen, KEINE Nebenwirkung beim Laden. Wird von install.sh
# geladen ("source") und kann für Tests direkt gesourct werden.
#
# Pendant zu ops/fernwartung.ps1 (Windows), aber bewusst schmaler:
#   - Zuordnung NUR per Rollout-Konfiguration (assignmentId):
#       sudo teamviewer assignment --id <ID> [--device-alias=<Name>] [--reassign]
#     Die TeamViewer-Doku kennt unter Linux keine tokenbasierte Zuordnung ("teamviewer
#     setup" ist interaktiv und braucht Konto + Passwort — dafür ungeeignet).
#   - Host-Paket (.deb/.rpm) aus der Konfiguration oder von download.teamviewer.com.
#   - macOS wird nicht unterstützt.
#
# Geheimnisse (assignmentId, Query-Teil der Installer-URL) erscheinen in KEINER Ausgabe.
# Fehler in diesem Schritt dürfen die Kassa-Installation nie abbrechen — fw_ausfuehren
# liefert immer 0 zurück und meldet Probleme als Warnung.
#
# Bedingungen: bash; für die Konfiguration python3 oder jq.

# Geheimnisse, die in keiner Ausgabe vorkommen dürfen
FW_GEHEIMNISSE=()
# Statusdatei auf dem Host (Quelle der Wahrheit; wird in das Kontroll-Volume der Kassa kopiert)
FW_STATUS_DATEI_STANDARD="${KASSA_STATE_DIR:-/var/lib/kassa-pos}/fernwartung-status.json"
# Wartezeit zwischen zwei Versuchen in Sekunden (Tests setzen FW_TAKT=0)
FW_TAKT="${FW_TAKT:-3}"
FW_BEKANNTE_FELDER=" anbieter hostInstallerUrl msiPfad signaturPruefen exeArgumente customConfigId einstellungsDatei assignmentId apiToken zuordnungsweg gruppe gruppeId aliasVorlage assignmentRetries assignmentTimeout "

# ── Ausgabe (immer maskiert) ────────────────────────────────────────────────
fw_maskiere() {
  local t="$*" g
  for g in ${FW_GEHEIMNISSE[@]+"${FW_GEHEIMNISSE[@]}"}; do
    [ "${#g}" -ge 4 ] && t="${t//"$g"/***}"
  done
  printf '%s' "$t"
}
fw_ausgabe() { # $1 = Farbe, $2... = Text
  local farbe="$1"; shift
  printf '%s%s%s\n' "${farbe}" "$(fw_maskiere "$*")" "${C_0:-}"
}
fw_schritt()  { printf '\n%s▶ %s%s\n' "${C_C:-}" "$(fw_maskiere "$*")" "${C_0:-}"; }
fw_ok()       { fw_ausgabe "${C_G:-}" "✓ $*"; }
fw_hinweis()  { fw_ausgabe "${C_Y:-}" "… $*"; }
fw_warnung()  { fw_ausgabe "${C_Y:-}" "! WARNUNG: $*"; }
fw_fehler()   { fw_ausgabe "${C_R:-}" "✗ $*" 1>&2; }
fw_zeile()    { printf '   %s\n' "$(fw_maskiere "$*")"; }

# ── Kleine reine Funktionen ───────────────────────────────────────────────────
# Gerätename: Vorlage + Name zusammensetzen, Kommandozeilen-Ärger entfernen
fw_alias() { # $1 = Vorlage, $2 = Name, $3 = Hostname
  local vorlage="${1:-\{Name\}}" name="${2:-}" host="${3:-}" t
  [ -n "$name" ] || name="$host"
  # Ersatztext in Anführungszeichen: sonst ersetzt bash ab 5.2 ein „&" im Namen durch den Treffer
  t="${vorlage//\{Name\}/"$name"}"; t="${t//\{name\}/"$name"}"
  t="${t//\{Computername\}/"$host"}"; t="${t//\{computername\}/"$host"}"
  # Erlaubt: Buchstaben (auch Umlaute), Ziffern, Leerzeichen und . _ - ( ) # +
  t="$(printf '%s' "$t" | LC_ALL=C.UTF-8 sed -E 's/[^[:alnum:] ._()#+-]/ /g' 2>/dev/null || printf '%s' "$t")"
  t="$(printf '%s' "$t" | tr -s ' ' | sed -E 's/^ +//; s/ +$//')"
  t="${t:0:64}"
  [ -n "$t" ] || t="$(printf '%s' "$host" | tr -c '[:alnum:]._-' ' ' | tr -s ' ' | sed -E 's/^ +//; s/ +$//')"
  [ -n "$t" ] || t="Kassa"
  printf '%s' "$t"
}

# '123456789' → '123 456 789'; 10-stellig → '1 234 567 890' (von rechts in Dreiergruppen)
fw_id_format() {
  local z out=""
  z="$(printf '%s' "$1" | tr -dc '0-9')"
  while [ "${#z}" -gt 3 ]; do out=" ${z: -3}${out}"; z="${z:0:$((${#z} - 3))}"; done
  printf '%s%s' "$z" "$out"
}

# JSON-Text, rein ASCII (python3 oder jq) — Statusdatei ohne Geheimnisse
fw_status_json() { # $1=id $2=alias $3=gruppe $4=installiertAm
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
id_, alias, gruppe, seit = sys.argv[1:5]
print(json.dumps({"anbieter": "teamviewer", "id": id_, "alias": alias or None,
                  "gruppe": gruppe or None, "installiertAm": seit},
                 ensure_ascii=True, separators=(",", ":")))
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -acn --arg id "$1" --arg alias "$2" --arg gruppe "$3" --arg seit "$4" \
      '{anbieter:"teamviewer", id:$id, alias:(if $alias=="" then null else $alias end), gruppe:(if $gruppe=="" then null else $gruppe end), installiertAm:$seit}'
  else
    return 1
  fi
}

# ── Konfiguration ────────────────────────────────────────────────────────────
FW_FEHLER=(); FW_WARNUNGEN=()
FW_INSTALLER_PFAD=""; FW_INSTALLER_URL=""; FW_ASSIGNMENT_ID=""; FW_GRUPPE=""
FW_ALIAS_VORLAGE="{Name}"; FW_RETRIES=20; FW_TIMEOUT=120; FW_MODUS="keine"; FW_KONFIG_DIR="."

# Liest fernwartung.json (python3 oder jq) als Zeilen "feld<TAB>wert"
fw_json_zeilen() { # $1 = Datei
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    if not isinstance(d, dict): raise ValueError
except Exception:
    sys.exit(2)
for k, v in d.items():
    if isinstance(v, bool): v = "true" if v else "false"
    elif isinstance(v, (dict, list)): v = "<komplex>"
    elif v is None: v = ""
    print("%s\t%s" % (k, str(v).replace("\t", " ").replace("\n", " ").replace("\r", " ")))
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -r 'if type=="object" then to_entries[] | "\(.key)\t\(.value|if type=="object" or type=="array" then "<komplex>" else tostring end|gsub("[\t\r\n]";" "))" else error("kein Objekt") end' "$1"
  else
    return 3
  fi
}

# Prüft + übernimmt die Konfiguration in FW_*-Variablen. Meldungen nennen nie Werte.
fw_konfig_lesen() { # $1 = Pfad
  FW_FEHLER=(); FW_WARNUNGEN=(); FW_GEHEIMNISSE=()
  local pfad="$1" zeilen rc=0 k v v_klein apitoken=""
  local re_gruppe='^[[:alnum:] ._()#+-]{1,64}$'
  FW_INSTALLER_PFAD=""; FW_INSTALLER_URL=""; FW_ASSIGNMENT_ID=""; FW_GRUPPE=""
  FW_ALIAS_VORLAGE="{Name}"; FW_RETRIES=20; FW_TIMEOUT=120; FW_MODUS="keine"
  FW_KONFIG_DIR="$(cd "$(dirname "$pfad")" 2>/dev/null && pwd || echo .)"
  if [ ! -f "$pfad" ]; then FW_FEHLER+=("Konfigurationsdatei nicht gefunden: $pfad"); return 1; fi
  zeilen="$(fw_json_zeilen "$pfad")" || rc=$?
  if [ "$rc" -eq 3 ]; then FW_FEHLER+=("Zum Lesen der fernwartung.json wird python3 oder jq gebraucht (sudo apt-get install -y python3)."); return 1; fi
  if [ "$rc" -ne 0 ]; then FW_FEHLER+=("fernwartung.json ist kein gültiges JSON-Objekt (Komma, Anführungszeichen, Klammer prüfen)."); return 1; fi

  while IFS=$'\t' read -r k v; do
    v="${v%$'\r'}"   # Python unter Windows schreibt CRLF
    [ -n "$k" ] || continue
    case "$k" in _*) continue ;; esac
    case "$FW_BEKANNTE_FELDER" in
      *" $k "*) ;;
      *) FW_WARNUNGEN+=("Unbekanntes Feld '$k' wird ignoriert (Tippfehler?).") ;;
    esac
    # Platzhalter aus fernwartung.example.json, die niemand ersetzt hat
    v_klein="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
    case "$v_klein" in
      *ersetzen*|*beispiel-*)
        FW_FEHLER+=("Feld '$k' enthält noch den Platzhalter aus der Beispieldatei — durch den echten Wert ersetzen oder das Feld löschen."); continue ;;
    esac
    case "$k" in
      anbieter)
        [ "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" = "teamviewer" ] || FW_FEHLER+=("Anbieter wird nicht unterstützt (nur 'teamviewer').") ;;
      msiPfad)
        if [[ "$v" == *'"'* ]]; then FW_FEHLER+=("Pfadangaben dürfen kein Anführungszeichen enthalten.")
        elif [ -n "$v" ]; then case "$v" in /*) FW_INSTALLER_PFAD="$v" ;; *) FW_INSTALLER_PFAD="$FW_KONFIG_DIR/$v" ;; esac; fi ;;
      hostInstallerUrl)
        if [ -n "$v" ]; then
          if [[ "$v" =~ ^https://[^[:space:]\"]+$ ]]; then
            FW_INSTALLER_URL="$v"
            [[ "$v" == *\?* ]] && FW_GEHEIMNISSE+=("?${v#*\?}")
          else FW_FEHLER+=("Feld 'hostInstallerUrl' muss eine https://-Adresse sein."); fi
        fi ;;
      assignmentId)
        if [ -n "$v" ]; then
          # (Länge getrennt prüfen: ERE-Intervalle über 255 lehnen manche regex-Bibliotheken ab)
          if [[ "$v" =~ ^[A-Za-z0-9_=+/-]+$ ]] && [ "${#v}" -ge 16 ] && [ "${#v}" -le 512 ]; then FW_ASSIGNMENT_ID="$v"; FW_GEHEIMNISSE+=("$v")
          else FW_FEHLER+=("Feld 'assignmentId' hat ein unerwartetes Format."); fi
        fi ;;
      apiToken)
        if [ -n "$v" ]; then
          if [[ "$v" =~ ^[A-Za-z0-9_.-]{8,200}$ ]]; then apitoken="$v"; FW_GEHEIMNISSE+=("$v")
          else FW_FEHLER+=("Feld 'apiToken' hat ein unerwartetes Format."); fi
        fi ;;
      gruppe)
        if [ -n "$v" ]; then
          if [[ "$v" =~ $re_gruppe ]]; then FW_GRUPPE="$v"
          else FW_FEHLER+=("Feld 'gruppe' enthält unzulässige Zeichen."); fi
        fi ;;
      aliasVorlage) [ -n "$v" ] && FW_ALIAS_VORLAGE="$v" ;;
      assignmentRetries)
        if [[ "$v" =~ ^[0-9]{1,3}$ ]] && [ "$v" -le 600 ]; then FW_RETRIES="$v"; else FW_FEHLER+=("Feld 'assignmentRetries' muss eine Zahl von 0 bis 600 sein."); fi ;;
      assignmentTimeout)
        if [[ "$v" =~ ^[0-9]{2,4}$ ]] && [ "$v" -ge 10 ] && [ "$v" -le 3600 ]; then FW_TIMEOUT="$v"; else FW_FEHLER+=("Feld 'assignmentTimeout' muss zwischen 10 und 3600 Sekunden liegen."); fi ;;
    esac
  done <<EOF
$zeilen
EOF

  if [ -n "$FW_ASSIGNMENT_ID" ]; then
    FW_MODUS="assignmentId"
    [ -n "$apitoken" ] && FW_WARNUNGEN+=("Sowohl 'assignmentId' als auch 'apiToken' gesetzt — unter Linux gilt nur die Rollout-Konfiguration (assignmentId).")
  elif [ -n "$apitoken" ]; then
    FW_WARNUNGEN+=("Ein apiToken wird unter Linux nicht unterstützt (die TeamViewer-Doku kennt dort nur 'teamviewer assignment --id') — bitte assignmentId (Rollout-Konfiguration) verwenden.")
  fi
  if [ "$FW_MODUS" = "keine" ]; then
    FW_WARNUNGEN+=("Keine assignmentId gesetzt — TeamViewer wird nur installiert und muss danach von Hand dem Konto zugeordnet werden.")
  fi
  [ "${#FW_FEHLER[@]}" -eq 0 ]
}

# ── System ──────────────────────────────────────────────────────────────────
fw_sudo() { # führt einen Befehl als root aus (sudo nur, wenn nötig)
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

fw_installiert() { command -v teamviewer >/dev/null 2>&1; }

# Standard-Download-URL des Host-Pakets (offizielle Download-Seite von TeamViewer)
fw_standard_url() {
  local basis="https://download.teamviewer.com/download/linux" arch
  if command -v dpkg >/dev/null 2>&1; then
    arch="$(dpkg --print-architecture 2>/dev/null)"
    case "$arch" in amd64|arm64|armhf) printf '%s/teamviewer-host_%s.deb' "$basis" "$arch"; return 0 ;; esac
  else
    arch="$(uname -m)"
    local suse=""; grep -qi 'suse' /etc/os-release 2>/dev/null && suse="-suse"
    case "$arch" in
      x86_64)  printf '%s/teamviewer-host%s.x86_64.rpm' "$basis" "$suse"; return 0 ;;
      aarch64) printf '%s/teamviewer-host%s.aarch64.rpm' "$basis" "$suse"; return 0 ;;
      armv7l)  printf '%s/teamviewer-host%s.armv7hl.rpm' "$basis" "$suse"; return 0 ;;
    esac
  fi
  return 1
}

# Lokale Paketdatei suchen: Pfad aus der Konfiguration, gleichnamig neben der Konfiguration,
# sonst teamviewer-host*.deb/.rpm neben der Konfiguration
fw_finde_paket() {
  local f
  if [ -n "$FW_INSTALLER_PFAD" ]; then
    [ -f "$FW_INSTALLER_PFAD" ] && { printf '%s' "$FW_INSTALLER_PFAD"; return 0; }
    f="$FW_KONFIG_DIR/$(basename "$FW_INSTALLER_PFAD")"
    [ -f "$f" ] && { printf '%s' "$f"; return 0; }
    return 1
  fi
  for f in "$FW_KONFIG_DIR"/teamviewer-host*.deb "$FW_KONFIG_DIR"/teamviewer-host*.rpm; do
    [ -f "$f" ] && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# Paket installieren (apt-get für .deb, dnf/yum/zypper für .rpm)
fw_paket_installieren() { # $1 = Datei
  case "$1" in
    *.deb) command -v apt-get >/dev/null 2>&1 || return 1
           fw_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$1" >/dev/null 2>&1 ;;
    *.rpm) if command -v dnf >/dev/null 2>&1; then fw_sudo dnf install -y "$1" >/dev/null 2>&1
           elif command -v zypper >/dev/null 2>&1; then fw_sudo zypper --non-interactive install "$1" >/dev/null 2>&1
           elif command -v yum >/dev/null 2>&1; then fw_sudo yum install -y "$1" >/dev/null 2>&1
           else return 1; fi ;;
    *) return 1 ;;
  esac
}

fw_dienst_sichern() { # TeamViewer-Dienst läuft und startet mit dem System
  command -v systemctl >/dev/null 2>&1 || return 1
  fw_sudo systemctl enable --now teamviewerd >/dev/null 2>&1 || fw_sudo teamviewer daemon enable >/dev/null 2>&1 || return 1
  local i=0
  while [ "$i" -lt 30 ]; do
    systemctl is-active --quiet teamviewerd 2>/dev/null && return 0
    sleep "$FW_TAKT"; i=$((i + 1))
  done
  return 1
}

# TeamViewer-ID aus "teamviewer info" (offizieller Befehl: zeigt die ID an)
fw_id_lesen() {
  local z
  z="$(fw_sudo teamviewer info 2>/dev/null | grep -i 'TeamViewer ID' | head -1 | tr -dc '0-9')"
  [[ "$z" =~ ^[0-9]{8,12}$ ]] && ! [[ "$z" =~ ^0+$ ]] && printf '%s' "$z"
}

# Text aus dem Inhalt eines JSON-Strings zurückgewinnen (ä, \", \\) — python3 bevorzugt
fw_json_text() { # $1 = Inhalt ohne umgebende Anführungszeichen
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.loads(chr(34) + sys.argv[1] + chr(34)))' "$1" 2>/dev/null && return 0
  fi
  printf '%b' "$1"
}

# Statusdatei früher geschrieben? → Feld lesen (id, alias, installiertAm)
fw_status_feld() { # $1 = Datei, $2 = Feld
  [ -f "$1" ] || return 1
  sed -nE 's/.*"'"$2"'":"(([^"\\]|\\.)*)".*/\1/p' "$1" | head -1
}

# Statusdatei in das Kontroll-Volume der Kassa legen (der Updater-Container ist root und hat
# /control gemountet). Braucht laufende Container; nie fatal.
fw_veroeffentlichen() { # $1 = Statusdatei, $2 = Kassa-Verzeichnis
  local datei="$1" ziel="$2" docker="${DOCKER:-docker}" i=0 json
  [ -f "$datei" ] || return 1
  json="$(cat "$datei")"
  [[ "$json" =~ ^[[:print:]]+$ ]] || return 1
  while [ "$i" -lt 8 ]; do
    # shellcheck disable=SC2086 — $docker darf aus mehreren Wörtern bestehen ("sudo docker")
    if ( cd "$ziel" && printf '%s' "$json" | $docker compose exec -T updater sh -c \
        'cat > /control/fernwartung-status.json.tmp && chmod 644 /control/fernwartung-status.json.tmp && (chown 1000:1000 /control/fernwartung-status.json.tmp 2>/dev/null || true) && mv /control/fernwartung-status.json.tmp /control/fernwartung-status.json' \
        >/dev/null 2>&1 ); then
      return 0
    fi
    sleep "$FW_TAKT"; i=$((i + 1))
  done
  return 1
}

# ── Einstieg ────────────────────────────────────────────────────────────────
# fw_ausfuehren <konfig> <name> <neu 0|1> <trockenlauf 0|1> [statusdatei]
# Liefert IMMER 0 — der Kassa-Installer darf daran nie scheitern.
fw_ausfuehren() {
  local konfig="$1" name="${2:-}" neu="${3:-0}" trocken="${4:-0}" status="${5:-$FW_STATUS_DATEI_STANDARD}"
  local nachholen="Nachholen: Installer erneut ausführen (siehe ops/DEPLOYMENT.md, Abschnitt Fernwartung)."
  local host alias frueher_id frueher_alias frueher_seit url paketdatei id seit json rc w f
  fw_schritt "Fernwartung (TeamViewer Host)$([ "$trocken" = "1" ] && printf ' — TROCKENLAUF, es wird nichts verändert')"

  if [ "$(uname -s)" != "Linux" ]; then
    fw_warnung "Fernwartung wird nur unter Linux unterstützt (macOS: TeamViewer Host manuell installieren)."; return 0
  fi
  if ! fw_konfig_lesen "$konfig"; then
    for f in ${FW_FEHLER[@]+"${FW_FEHLER[@]}"}; do fw_fehler "$f"; done
    fw_hinweis "Die Kassa wird trotzdem installiert. $nachholen"; return 0
  fi
  for w in ${FW_WARNUNGEN[@]+"${FW_WARNUNGEN[@]}"}; do fw_warnung "$w"; done

  host="$(hostname 2>/dev/null || echo kassa)"
  frueher_id="$(fw_status_feld "$status" id || true)"
  frueher_alias="$(fw_status_feld "$status" alias || true)"
  # in der Datei steht der Name JSON-escaped (ä …) — zurück in Text
  [ -n "$frueher_alias" ] && frueher_alias="$(fw_json_text "$frueher_alias")"
  frueher_seit="$(fw_status_feld "$status" installiertAm || true)"
  if [ -n "$name" ]; then alias="$(fw_alias "$FW_ALIAS_VORLAGE" "$name" "$host")"
  elif [ -n "$frueher_alias" ]; then alias="$(fw_alias '{Name}' "$frueher_alias" "$host")"
  else alias="$(fw_alias "$FW_ALIAS_VORLAGE" "" "$host")"; fi

  # --- Bestandsaufnahme (nur lesend) -------------------------------------------
  paketdatei=""; url=""
  if ! fw_installiert; then
    paketdatei="$(fw_finde_paket || true)"
    if [ -z "$paketdatei" ]; then url="${FW_INSTALLER_URL:-$(fw_standard_url || true)}"; fi
  fi
  local id_jetzt="" erledigt=0
  if fw_installiert; then id_jetzt="$(fw_id_lesen || true)"; fi
  if [ -n "$frueher_id" ] && [ "$frueher_id" = "$id_jetzt" ] && [ "$neu" != "1" ] && [ "$FW_MODUS" != "keine" ]; then erledigt=1; fi

  fw_zeile "Konfiguration:  $FW_KONFIG_DIR  (Geheimnisse werden nie angezeigt)"
  fw_zeile "Zuordnung:      $([ "$FW_MODUS" = "assignmentId" ] && echo 'Rollout-Konfiguration (Assignment-ID)' || echo 'keine automatische Zuordnung')"
  fw_zeile "Gerätename:     $alias"
  [ -n "$FW_GRUPPE" ] && fw_zeile "Gruppe:         $FW_GRUPPE"
  if fw_installiert; then
    fw_zeile "TeamViewer:     bereits installiert — wird nicht neu installiert"
    [ "$erledigt" = "1" ] && fw_zeile "Zuordnung:      laut Statusdatei bereits erledigt — wird nicht wiederholt (erneut: KASSA_FERNWARTUNG_NEU=1)"
  else
    fw_zeile "TeamViewer:     nicht installiert — Paket: ${paketdatei:-$(printf '%s' "${url%%\?*}")}"
  fi

  local zuordnen_cmd
  zuordnen_cmd="sudo teamviewer assignment --id $FW_ASSIGNMENT_ID --device-alias=\"$alias\" --retries=$FW_RETRIES --timeout=$FW_TIMEOUT$([ "$neu" = "1" ] && printf ' --reassign')"
  if [ "$trocken" = "1" ]; then
    fw_zeile "Geplante Schritte:"
    local n=0
    if ! fw_installiert; then
      n=$((n + 1))
      if [ -n "$paketdatei" ]; then fw_zeile "  $n. Host-Paket installieren: sudo apt-get install -y $paketdatei  (bzw. dnf/zypper bei .rpm)"
      else fw_zeile "  $n. Host-Paket laden und installieren: ${url%%\?*}"; fi
    fi
    n=$((n + 1)); fw_zeile "  $n. Dienst aktivieren: sudo systemctl enable --now teamviewerd"
    if [ "$FW_MODUS" = "assignmentId" ] && [ "$erledigt" != "1" ]; then n=$((n + 1)); fw_zeile "  $n. Zuordnen: $zuordnen_cmd"; fi
    n=$((n + 1)); fw_zeile "  $n. TeamViewer-ID lesen (teamviewer info), Statusdatei für die Kassa schreiben"
    fw_ok "Trockenlauf beendet — es wurde nichts verändert."
    return 0
  fi

  # --- 1. Installieren ------------------------------------------------------------
  if ! fw_installiert; then
    local tmp=""
    if [ -z "$paketdatei" ]; then
      [ -n "$url" ] || { fw_fehler "Kein Host-Paket gefunden und keine passende Download-Adresse für diese Plattform."; fw_hinweis "Die Kassa wird trotzdem installiert. $nachholen"; return 0; }
      tmp="$(mktemp -d)"; paketdatei="$tmp/$(basename "${url%%\?*}")"
      fw_hinweis "Lade ${url%%\?*} …"
      if ! curl -fsSL -o "$paketdatei" "$url" 2>/dev/null; then
        fw_fehler "Download fehlgeschlagen: ${url%%\?*}"; rm -rf "$tmp"
        fw_hinweis "Die Kassa wird trotzdem installiert. $nachholen"; return 0
      fi
    fi
    fw_hinweis "Installiere TeamViewer Host (kann etwas dauern) …"
    if fw_paket_installieren "$paketdatei"; then fw_ok "TeamViewer Host installiert"
    else
      fw_fehler "Installation des Host-Pakets fehlgeschlagen (apt/dnf-Ausgabe: Befehl von Hand ausführen)."
      [ -n "$tmp" ] && rm -rf "$tmp"
      fw_hinweis "Die Kassa wird trotzdem installiert. $nachholen"; return 0
    fi
    [ -n "$tmp" ] && rm -rf "$tmp"
  fi

  # --- 2. Dienst + Autostart -----------------------------------------------------------
  if fw_dienst_sichern; then fw_ok "TeamViewer-Dienst läuft und startet mit dem System (Autostart)"
  else fw_warnung "TeamViewer-Dienst konnte nicht aktiviert werden (systemctl status teamviewerd)."; fi

  # --- 3. Zuordnung ----------------------------------------------------------------------
  local zuordnung_ok=1
  if [ "$FW_MODUS" = "keine" ]; then
    fw_hinweis "Keine Zuordnung konfiguriert — das Gerät muss von Hand dem TeamViewer-Konto zugeordnet werden."
  elif [ "$erledigt" = "1" ]; then
    fw_ok "Zuordnung war schon erledigt"
  else
    # Der Dienst braucht einen Moment, bis er verbunden ist — erst dann gibt es eine ID
    local i=0 verbunden=0
    while [ "$i" -lt 30 ]; do [ -n "$(fw_id_lesen || true)" ] && { verbunden=1; break; }; sleep "$FW_TAKT"; i=$((i + 1)); done
    local args=(assignment --id "$FW_ASSIGNMENT_ID")
    [ "$neu" = "1" ] && args+=(--reassign)
    fw_hinweis "Ordne das Gerät dem TeamViewer-Konto zu …"
    # („&& rc=0 || rc=$?" statt „; rc=$?": bleibt auch unter set -e unfallfrei)
    rc=0
    if [ "$verbunden" = "1" ]; then
      fw_sudo teamviewer "${args[@]}" "--device-alias=$alias" "--retries=$FW_RETRIES" "--timeout=$FW_TIMEOUT" >/dev/null 2>&1 && rc=0 || rc=$?
      # Die Doku nennt unter Linux teils --device_alias (Unterstrich): bei „ungültige Argumente" (1) damit erneut
      if [ "$rc" -eq 1 ]; then fw_sudo teamviewer "${args[@]}" --device_alias "$alias" >/dev/null 2>&1 && rc=0 || rc=$?; fi
    else
      fw_hinweis "Noch keine Verbindung zu TeamViewer — die Zuordnung wird vorgemerkt (--offline)."
      fw_sudo teamviewer "${args[@]}" "--device-alias=$alias" --offline >/dev/null 2>&1 && rc=0 || rc=$?
      if [ "$rc" -eq 1 ]; then fw_sudo teamviewer "${args[@]}" --device_alias "$alias" --offline >/dev/null 2>&1 && rc=0 || rc=$?; fi
      if [ "$rc" -eq 0 ]; then
        zuordnung_ok=0
        fw_warnung "Zuordnung ist vorgemerkt, aber noch nicht erfolgt. Sobald das Gerät online ist, den Installer erneut ausführen — dann wird der Status für die Kassa geschrieben."
      fi
    fi
    if [ "$zuordnung_ok" = "1" ]; then
      case "$rc" in
        0)       fw_ok "Gerät dem TeamViewer-Konto zugeordnet" ;;
        49|409)  fw_ok "Gerät war bereits dieser Rollout-Konfiguration zugeordnet" ;;
        43|403)  zuordnung_ok=0; fw_warnung "Zuordnung nicht gelungen: keine Verbindung zu TeamViewer — Internetverbindung prüfen." ;;
        *)       zuordnung_ok=0; fw_warnung "Zuordnung nicht gelungen (Exit-Code $rc). Ist das Gerät schon einem anderen Konto zugeordnet? Dann mit KASSA_FERNWARTUNG_NEU=1 erneut ausführen." ;;
      esac
    fi
  fi

  # --- 4. ID lesen + Status schreiben --------------------------------------------------------
  fw_hinweis "Lese die TeamViewer-ID …"
  id=""; local j=0
  while [ "$j" -lt 20 ]; do id="$(fw_id_lesen || true)"; [ -n "$id" ] && break; sleep "$FW_TAKT"; j=$((j + 1)); done
  if [ -z "$id" ]; then
    fw_warnung "TeamViewer-ID konnte nicht ausgelesen werden (teamviewer info)."; fw_hinweis "$nachholen"; return 0
  fi
  fw_ok "TeamViewer-ID: $(fw_id_format "$id")  (Gerätename: $alias)"
  if [ "$zuordnung_ok" = "1" ] && [ "$FW_MODUS" != "keine" ]; then
    seit="$frueher_seit"; { [ -n "$seit" ] && [ "$frueher_id" = "$id" ]; } || seit="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if json="$(fw_status_json "$id" "$alias" "$FW_GRUPPE" "$seit")" && [ -n "$json" ]; then
      fw_sudo mkdir -p "$(dirname "$status")" 2>/dev/null || true
      if printf '%s\n' "$json" | fw_sudo tee "$status" >/dev/null 2>&1; then
        fw_sudo chmod 644 "$status" 2>/dev/null || true
      else fw_warnung "Statusdatei konnte nicht geschrieben werden: $status"; fi
    else
      fw_warnung "Statusdatei nicht geschrieben (python3 oder jq fehlt)."
    fi
  elif [ "$FW_MODUS" = "keine" ]; then
    fw_hinweis "Ohne Zuordnung zum Konto zeigt die Kassa die Fernwartung NICHT als eingerichtet an."
  else
    fw_hinweis "$nachholen"
  fi
  return 0
}

# Nach „docker compose up": gespeicherten Status in die Kassa übernehmen (nie fatal)
fw_veroeffentliche_ergebnis() { # $1 = Kassa-Verzeichnis, $2 = Statusdatei
  local ziel="$1" status="${2:-$FW_STATUS_DATEI_STANDARD}"
  [ -f "$status" ] || return 0
  fw_hinweis "Übergebe den Fernwartungs-Status an die Kassa …"
  if fw_veroeffentlichen "$status" "$ziel"; then fw_ok "Fernwartung ist in der Kassa sichtbar (Einstellungen → System → Fernwartung)"
  else fw_warnung "Der Status konnte nicht an die Kassa übergeben werden (Update-Dienst noch nicht bereit?). Installer später erneut ausführen."; fi
  return 0
}
