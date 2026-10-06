# =============================================================================
# Kassa POS — Tests für den Fernwartungs-Schritt (TeamViewer Host)
#
# Prüft OHNE etwas zu installieren oder zu verändern:
#   - Konfiguration (fernwartung.json): Prüfregeln, Platzhalter, kaputtes JSON
#   - Parameter-Aufbereitung: Gerätename, Gruppe, Kommandozeilen (msiexec,
#     TeamViewer.exe assignment / assign), Quoting, Maskierung
#   - dass das Token/die Assignment-ID in KEINER Ausgabe vorkommt
#     (Trockenlauf, Fehlerfälle, vollständiger Ablauf mit simuliertem System)
#   - Idempotenz (zweiter Lauf installiert/ordnet nicht erneut zu), Statusdatei
#   - install.ps1 -Trockenlauf als eigener Prozess (Windows PowerShell 5.1 und pwsh)
#
# Aufruf:   powershell -NoProfile -ExecutionPolicy Bypass -File ops\test-fernwartung.ps1
#           pwsh -NoProfile -File ops/test-fernwartung.ps1
# Exit-Code 0 = alles bestanden, 1 = mindestens ein Test fehlgeschlagen.
#
# Die Systemzugriffe (Dienst, Registry, msiexec, Docker) werden im Test durch
# Funktionen ersetzt, die nur Aufrufe mitschreiben — dieser Test kann also auch auf
# einem PC laufen, auf dem TeamViewer produktiv im Einsatz ist.
# =============================================================================

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

# Erfundene Geheimnisse — daran wird geprüft, dass sie nirgends ausgegeben werden
$TOKEN = '1234567-DUMMYTOKENabcdefghijkl'
$ASSID = '0001DUMMYASSIGNMENTIDabcdefghijklmnopqrstuvwxyz0123456789-ZZZZ'
$URLQ  = '?sig=DUMMYQUERYKEY123456'

. (Join-Path $here 'fernwartung.ps1')

# ---- Mini-Testrahmen --------------------------------------------------------
$script:Anzahl = 0
$script:Fehlschlaege = New-Object System.Collections.Generic.List[string]

# ACHTUNG: Die Bedingung läuft im Gültigkeitsbereich von Pruefe — Testvariablen dürfen deshalb
# nicht $text, $ok oder $grund heißen (PowerShell würde die lokalen Variablen von Pruefe lesen).
function Pruefe([string]$Beschreibung, [scriptblock]$Bedingung) {
  $script:Anzahl++
  $ok = $false
  $grund = ''
  try { $ok = [bool](& $Bedingung) } catch { $ok = $false; $grund = ' (Ausnahme: ' + $_.Exception.Message + ')' }
  if ($ok) { Write-Host ('  [ok]   ' + $Beschreibung) -ForegroundColor Green }
  else {
    Write-Host ('  [FAIL] ' + $Beschreibung + $grund) -ForegroundColor Red
    $script:Fehlschlaege.Add($Beschreibung)
  }
}
function Gruppe([string]$Titel) { Write-Host ("`n" + $Titel) -ForegroundColor Cyan }

function Fange-Ausgabe([scriptblock]$Block) {
  # Fängt alles ab, was in die Konsole (Write-Host & Co.) geschrieben wird
  $script:FangErgebnis = $null
  $text = (& { $script:FangErgebnis = (& $Block) } *>&1 | Out-String)
  return [pscustomobject]@{ Text = $text; Ergebnis = $script:FangErgebnis }
}

function Neues-Tempverzeichnis {
  $d = Join-Path ([System.IO.Path]::GetTempPath()) ('kassa-fw-test-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  return $d
}
function Schreibe-Text([string]$Pfad, [string]$Text) {
  [System.IO.File]::WriteAllText($Pfad, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Lies-Konfig([string]$Json, [string]$Verzeichnis = 'C:\konfig') {
  Pruefe-FernwartungKonfig -Roh ($Json | ConvertFrom-Json) -Verzeichnis $Verzeichnis
}

function Umg([hashtable]$Basis, [hashtable]$Ueber) {
  # Hashtables mischen (die rechte Seite gewinnt) — $a + $b wirft bei doppelten Schlüsseln
  $n = @{}
  foreach ($k in $Basis.Keys) { $n[$k] = $Basis[$k] }
  foreach ($k in $Ueber.Keys) { $n[$k] = $Ueber[$k] }
  return $n
}
$aufraeumen = New-Object System.Collections.Generic.List[string]

# =============================================================================
Gruppe '1. Kleine reine Funktionen'
# =============================================================================

Pruefe 'Alias: Vorlage + Name' { (Format-FernwartungAlias -Vorlage 'Kassa {Name}' -Name 'Gasthof Mayr' -Computername 'PC01') -eq 'Kassa Gasthof Mayr' }
Pruefe 'Alias: ohne Name gilt der Computername' { (Format-FernwartungAlias -Vorlage '{Name}' -Name '' -Computername 'KASSA-PC') -eq 'KASSA-PC' }
Pruefe 'Alias: {Computername} in der Vorlage' { (Format-FernwartungAlias -Vorlage '{Name} ({Computername})' -Name 'Cafe' -Computername 'PC7') -eq 'Cafe (PC7)' }
Pruefe 'Alias: Umlaute bleiben erhalten' { (Format-FernwartungAlias -Vorlage '{Name}' -Name 'Café Müller Straße' -Computername 'X') -eq 'Café Müller Straße' }
Pruefe 'Alias: Anführungszeichen, %, &, | werden entfernt' {
  $a = Format-FernwartungAlias -Vorlage '{Name}' -Name 'A"B''C%D&E|F;G' -Computername 'X'
  ($a -notmatch '["''%&|;]') -and ($a -match '^A B C D E F G$')
}
Pruefe 'Alias: höchstens 64 Zeichen' { (Format-FernwartungAlias -Vorlage '{Name}' -Name ('x' * 200) -Computername 'X').Length -le 64 }
Pruefe 'Alias: nur Sonderzeichen → Computername als Rückfall' { (Format-FernwartungAlias -Vorlage '{Name}' -Name '"""' -Computername 'PC9') -eq 'PC9' }

Pruefe 'ID-Format: 9 Stellen' { (Formatiere-TeamViewerId '123456789') -eq '123 456 789' }
Pruefe 'ID-Format: 10 Stellen (von rechts gruppiert)' { (Formatiere-TeamViewerId '1234567890') -eq '1 234 567 890' }
Pruefe 'ID-Format: Leerzeichen/Müll werden ignoriert' { (Formatiere-TeamViewerId ' 123-456 789 ') -eq '123 456 789' }
Pruefe 'ID aus Registry: DWORD positiv' { (Konvertiere-TeamViewerId ([int]123456789)) -eq '123456789' }
Pruefe 'ID aus Registry: DWORD ab 2^31 kommt negativ an und wird korrigiert' { (Konvertiere-TeamViewerId ([int]-2000000000)) -eq '2294967296' }
Pruefe 'ID aus Registry: Text mit Leerzeichen' { (Konvertiere-TeamViewerId '123 456 789') -eq '123456789' }
Pruefe 'ID aus Registry: 0, Müll, zu kurz → $null' {
  ($null -eq (Konvertiere-TeamViewerId ([int]0))) -and ($null -eq (Konvertiere-TeamViewerId 'abc')) -and ($null -eq (Konvertiere-TeamViewerId '1234'))
}

Pruefe 'Kommandozeile: einfache Argumente unverändert' { (Baue-Kommandozeile @('assignment', '--id', 'ABC', '--retries=3')) -eq 'assignment --id ABC --retries=3' }
Pruefe 'Kommandozeile: --option=Wert mit Leerzeichen → --option="Wert" (wie in der TeamViewer-Doku)' {
  (Baue-Kommandozeile @('--device-alias=Kassa Müller')) -eq '--device-alias="Kassa Müller"'
}
Pruefe 'Kommandozeile: Leerzeichen-Argument wird in Anführungszeichen gesetzt' { (Baue-Kommandozeile @('--alias', 'Kassa Müller')) -eq '--alias "Kassa Müller"' }
Pruefe 'Kommandozeile: Pfad mit Backslash am Ende' { (Baue-Kommandozeile @('C:\Program Files\X\')) -eq '"C:\Program Files\X\\"' }
Pruefe 'MSI-Eigenschaft: NAME="Wert"' { (Baue-MsiEigenschaft 'CUSTOMCONFIGID' 'abc123') -eq 'CUSTOMCONFIGID="abc123"' }
Pruefe 'MSI-Eigenschaft: Anführungszeichen im Wert wird abgelehnt' {
  $fehlgeschlagen = $false
  try { Baue-MsiEigenschaft 'X' 'a"b' | Out-Null } catch { $fehlgeschlagen = $true }
  $fehlgeschlagen
}

$script:FwGeheimnisse = @($TOKEN, $ASSID)
Pruefe 'Maskierung: bekannte Geheimnisse' { (Maskiere-Geheimnisse "x $TOKEN y $ASSID z") -eq 'x *** y *** z' }
$script:FwGeheimnisse = @()
Pruefe 'Maskierung: Sicherheitsnetz für APITOKEN=… auch ohne bekannte Liste' { (Maskiere-Geheimnisse 'msiexec /i a.msi APITOKEN="abc-12345678" /qn') -eq 'msiexec /i a.msi APITOKEN="***" /qn' }
Pruefe 'Maskierung: Sicherheitsnetz für --api-token und assignment --id' {
  $t = Maskiere-Geheimnisse 'TeamViewer.exe assign --api-token geheim123456 --alias X; TeamViewer.exe assignment --id langeid1234567890'
  ($t -notmatch 'geheim123456') -and ($t -notmatch 'langeid1234567890')
}
Pruefe 'Maskierung: ASSIGNMENTID=… ' { (Maskiere-Geheimnisse 'ASSIGNMENTID="langeid1234567890"') -eq 'ASSIGNMENTID="***"' }

# =============================================================================
Gruppe '2. Konfiguration prüfen'
# =============================================================================

$jsonRollout = @"
{ "anbieter": "teamviewer", "msiPfad": "TeamViewer_Host.msi", "customConfigId": "abc1234",
  "assignmentId": "$ASSID", "gruppe": "Mietkassen", "aliasVorlage": "Kassa {Name}" }
"@
$jsonToken = @"
{ "msiPfad": "C:\\tv\\TeamViewer_Host.msi", "customConfigId": "abc1234", "apiToken": "$TOKEN",
  "gruppeId": "12345678", "aliasVorlage": "{Name}" }
"@

$e = Lies-Konfig $jsonRollout
Pruefe 'Rollout-Konfiguration: gültig, Modus assignmentId' { $e.Fehler.Count -eq 0 -and $e.Konfig.Modus -eq 'assignmentId' }
Pruefe 'Rollout-Konfiguration: relativer msiPfad wird zum Konfig-Verzeichnis aufgelöst' { $e.Konfig.InstallerPfad -eq (Join-Path 'C:\konfig' 'TeamViewer_Host.msi') }
Pruefe 'Rollout-Konfiguration: Installer-Typ msi, Signaturprüfung standardmäßig an' { $e.Konfig.InstallerTyp -eq 'msi' -and $e.Konfig.SignaturPruefen -eq $true }
Pruefe 'Rollout-Konfiguration: Assignment-ID steht in der Geheimnisliste' { $e.Konfig.Geheimnisse -contains $ASSID }
Pruefe 'Rollout-Konfiguration: Standardwerte für Retries/Timeout' { $e.Konfig.Retries -eq 20 -and $e.Konfig.Timeout -eq 120 }
Pruefe 'Rollout-Konfiguration: Gruppe nur zur Anzeige → Warnung, kein Fehler' { $e.Warnungen.Count -ge 1 }

$e = Lies-Konfig $jsonToken
Pruefe 'API-Token-Konfiguration: gültig, Modus apiToken, absoluter Pfad bleibt' { $e.Fehler.Count -eq 0 -and $e.Konfig.Modus -eq 'apiToken' -and $e.Konfig.InstallerPfad -eq 'C:\tv\TeamViewer_Host.msi' }
Pruefe 'API-Token-Konfiguration: gruppeId wird mit „g" normalisiert' { $e.Konfig.GruppeId -eq 'g12345678' }
Pruefe 'API-Token-Konfiguration: Token steht in der Geheimnisliste' { $e.Konfig.Geheimnisse -contains $TOKEN }

$e = Lies-Konfig ('{ "assignmentId": "' + $ASSID + '", "apiToken": "' + $TOKEN + '" }')
Pruefe 'Beides gesetzt: es gilt die Rollout-Konfiguration + Warnung' { $e.Konfig.Modus -eq 'assignmentId' -and (($e.Warnungen -join ' ') -match 'apiToken') }

$e = Lies-Konfig '{ "msiPfad": "a.msi" }'
Pruefe 'Ohne Zuordnung: erlaubt (nur installieren), mit Warnung' { $e.Fehler.Count -eq 0 -and $e.Konfig.Modus -eq 'keine' -and $e.Warnungen.Count -ge 1 }

$e = Lies-Konfig '{ "msiPfad": "a.msi", "apiToken": "kurz" }'
Pruefe 'Token mit unerwartetem Format → Fehler OHNE den Wert zu nennen' { $e.Fehler.Count -ge 1 -and (($e.Fehler -join ' ') -notmatch 'kurz') }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "apiToken": "1234567-abc def" }'
Pruefe 'Token mit Leerzeichen → Fehler (Kommandozeilen-Schutz)' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig ('{ "hostInstallerUrl": "http://example.com/a.msi", "assignmentId": "' + $ASSID + '" }')
Pruefe 'http:// als Installer-URL → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "msiPfad": "a.zip" }'
Pruefe 'Installer ohne .msi/.exe → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "anbieter": "anydesk", "msiPfad": "a.msi" }'
Pruefe 'Unbekannter Anbieter → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "gruppe": "Miet\"kassen" }'
Pruefe 'Gruppe mit Anführungszeichen → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "gruppeId": "abc" }'
Pruefe 'Ungültige gruppeId → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "assignmentRetries": 99999 }'
Pruefe 'assignmentRetries außerhalb 0..600 → Fehler' { $e.Fehler.Count -ge 1 }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "customConfigIdd": "abc" }'
Pruefe 'Tippfehler im Feldnamen → Warnung „Unbekanntes Feld"' { ($e.Warnungen -join ' ') -match 'Unbekanntes Feld' }
$e = Lies-Konfig '{ "_kommentar": "egal", "msiPfad": "a.msi" }'
Pruefe 'Felder mit führendem _ sind Kommentare (keine Warnung)' { (($e.Warnungen -join ' ') -notmatch 'Unbekannt') }
$e = Lies-Konfig '{ "msiPfad": "a.msi", "customConfigId": "ERSETZEN-DURCH-CUSTOMCONFIGID" }'
Pruefe 'Nicht ersetzter Platzhalter → Fehler' { ($e.Fehler -join ' ') -match 'Platzhalter' }
$e = Lies-Konfig ('{ "hostInstallerUrl": "https://example.com/TeamViewer_Host.msi?sig=DUMMYQUERYKEY123456", "assignmentId": "' + $ASSID + '" }')
Pruefe 'Installer-URL: Query-Teil gilt als Geheimnis, Typ aus dem Pfad' { $e.Fehler.Count -eq 0 -and $e.Konfig.InstallerTyp -eq 'msi' -and ($e.Konfig.Geheimnisse -contains '?sig=DUMMYQUERYKEY123456') }
$e = Lies-Konfig ('{ "msiPfad": "a.msi", "assignmentId": "' + $ASSID + '", "zuordnungsweg": "msi" }')
Pruefe 'Rollout über MSI-Eigenschaft: Warnung (kein Gerätename, Erfolg nicht prüfbar)' { $e.Fehler.Count -eq 0 -and (($e.Warnungen -join ' ') -match 'NICHT übernommen') }
$e = Lies-Konfig ('{ "msiPfad": "TeamViewer_Host_Setup_x64.exe", "customConfigId": "abc1234", "zuordnungsweg": "msi", "apiToken": "' + $TOKEN + '" }')
Pruefe 'EXE-Installer: customConfigId ignoriert und zuordnungsweg msi → cli (mit Warnungen)' { $e.Konfig.InstallerTyp -eq 'exe' -and $e.Konfig.Zuordnungsweg -eq 'cli' -and $e.Warnungen.Count -ge 2 }

# Datei lesen — Fehlerfälle dürfen den Dateiinhalt nicht preisgeben
$tmp = Neues-Tempverzeichnis; $aufraeumen.Add($tmp)
$r = Lese-FernwartungKonfig -Pfad (Join-Path $tmp 'gibt-es-nicht.json')
Pruefe 'Datei fehlt → Fehlermeldung, kein Absturz' { $null -eq $r.Konfig -and $r.Fehler.Count -eq 1 }
Schreibe-Text (Join-Path $tmp 'kaputt.json') ('{ "apiToken": "' + $TOKEN + '" "gruppe": "x" }')
$o = Fange-Ausgabe { Lese-FernwartungKonfig -Pfad (Join-Path $tmp 'kaputt.json') }
Pruefe 'Kaputtes JSON → Fehler, der Fehlertext enthält nichts aus der Datei' { $null -eq $o.Ergebnis.Konfig -and (($o.Ergebnis.Fehler -join ' ') -notmatch [regex]::Escape($TOKEN)) -and ($o.Text -notmatch [regex]::Escape($TOKEN)) }
Schreibe-Text (Join-Path $tmp 'ok.json') $jsonRollout
$r = Lese-FernwartungKonfig -Pfad (Join-Path $tmp 'ok.json')
Pruefe 'Datei lesen: Konfig-Verzeichnis = Ordner der Datei' { $r.Konfig.Verzeichnis -eq $tmp }
$script:FwGeheimnisse = @()

# Beispieldatei
$bsp = Get-Content -LiteralPath (Join-Path $here 'fernwartung.example.json') -Raw -Encoding UTF8
Pruefe 'Beispieldatei: gültiges JSON' { $null -ne ($bsp | ConvertFrom-Json) }
$eb = Pruefe-FernwartungKonfig -Roh ($bsp | ConvertFrom-Json) -Verzeichnis $here
Pruefe 'Beispieldatei: unveränderte Platzhalter werden vom Installer abgelehnt' { ($eb.Fehler -join ' ') -match 'Platzhalter' }
$bspOhne = ($bsp -replace '"[^"]*ERSETZEN[^"]*"', '"abc12345678901234567890"')
$ebo = Pruefe-FernwartungKonfig -Roh ($bspOhne | ConvertFrom-Json) -Verzeichnis $here
Pruefe 'Beispieldatei: mit ersetzten Platzhaltern vollständig gültig' { $ebo.Fehler.Count -eq 0 -and $ebo.Konfig.Modus -eq 'assignmentId' }
Pruefe 'Beispieldatei: alle bekannten Felder sind dokumentiert' {
  $fehlt = @($script:FwBekannteFelder | Where-Object { $bsp -notmatch ('"' + $_ + '"') -and $bsp -notmatch ('\b' + $_ + '\b') })
  $fehlt.Count -eq 0
}
Pruefe '.gitignore schützt die echte Konfiguration' {
  $gi = Get-Content -LiteralPath (Join-Path $here '..\.gitignore') -Raw
  ($gi -match '(?m)^ops/fernwartung\.json\s*$') -and ($gi -match '(?m)^ops/fernwartung\*\.local\.json\s*$')
}

# =============================================================================
Gruppe '2b. Signaturprüfung des Installers'
# =============================================================================

$tmpS = Neues-Tempverzeichnis; $aufraeumen.Add($tmpS)
Schreibe-Text (Join-Path $tmpS 'ohne-signatur.msi') 'kein echter Installer'
$s = Pruefe-InstallerSignatur -Datei (Join-Path $tmpS 'ohne-signatur.msi')
Pruefe 'Datei ohne Signatur wird abgelehnt' { $s.Gueltig -eq $false -and $s.Grund }
$s = Pruefe-InstallerSignatur -Datei (Join-Path $tmpS 'gibt-es-nicht.msi')
Pruefe 'Fehlende Datei wird abgelehnt (kein Absturz)' { $s.Gueltig -eq $false }
if ($PSVersionTable.PSEdition -ne 'Core' -or $IsWindows) {
  $s = Pruefe-InstallerSignatur -Datei (Join-Path $env:SystemRoot 'System32\cmd.exe')
  Pruefe 'Gültig signiert, aber von Microsoft statt TeamViewer → abgelehnt' { $s.Gueltig -eq $false -and ($s.Grund -match 'nicht von TeamViewer') }
  $tvExe = Join-Path $env:ProgramFiles 'TeamViewer\TeamViewer.exe'
  if (Test-Path -LiteralPath $tvExe) {
    $s = Pruefe-InstallerSignatur -Datei $tvExe
    Pruefe 'Echte TeamViewer.exe (auf diesem PC installiert): Signatur gültig und von TeamViewer' { $s.Gueltig -eq $true }
  }
}
# =============================================================================
Gruppe '3. Pläne (msiexec- und TeamViewer-Kommandozeilen)'
# =============================================================================

$kRollout = (Lies-Konfig $jsonRollout 'C:\konfig').Konfig
$kToken   = (Lies-Konfig $jsonToken 'C:\konfig').Konfig
$umg = @{ Installiert = $false; InstallerDatei = 'C:\Pfad mit Leerzeichen\TeamViewer_Host.msi'; TeamViewerExe = 'C:\Program Files\TeamViewer\TeamViewer.exe'; LogDatei = 'C:\Temp\tv.log' }

$p = Neuer-FernwartungsPlan -Konfig $kRollout -Alias 'Kassa Müller' -Umgebung $umg
Pruefe 'Rollout/cli: zwei Schritte (installieren, zuordnen)' { $p.Schritte.Count -eq 2 -and $p.Schritte[0].Id -eq 'installieren' -and $p.Schritte[1].Id -eq 'zuordnen' }
Pruefe 'Rollout/cli: msiexec still, ohne Neustart, mit Log und CUSTOMCONFIGID' {
  $a = $p.Schritte[0].ArgumentString
  $p.Schritte[0].Datei -eq 'msiexec.exe' -and $a -match '^/i "C:\\Pfad mit Leerzeichen\\TeamViewer_Host.msi" /qn /norestart ' -and $a -match 'CUSTOMCONFIGID="abc1234"' -and $a -match '/L\*v "C:\\Temp\\tv.log"'
}
Pruefe 'Rollout/cli: die Assignment-ID steht NICHT auf der msiexec-Kommandozeile' { $p.Schritte[0].ArgumentString -notmatch [regex]::Escape($ASSID) }
Pruefe 'Rollout/cli: assignment-Befehl mit --id, --device-alias="…", --retries, --timeout' {
  $a = $p.Schritte[1].ArgumentString
  $a -eq ('assignment --id ' + $ASSID + ' --device-alias="Kassa Müller" --retries=20 --timeout=120')
}
Pruefe 'Rollout/cli: Anzeige maskiert die Assignment-ID' { ($p.Schritte[1].Anzeige -notmatch [regex]::Escape($ASSID)) -and ($p.Schritte[1].Anzeige -match '--id \*\*\*') }
$p2 = Neuer-FernwartungsPlan -Konfig $kRollout -Alias 'K' -Umgebung (Umg $umg @{ NeuZuordnen = $true })
Pruefe 'Rollout: -NeuZuordnen hängt --reassign an' { $p2.Schritte[1].ArgumentString -match ' --reassign$' }
$p2 = Neuer-FernwartungsPlan -Konfig $kRollout -Alias 'K' -Umgebung (Umg $umg @{ Installiert = $true })
Pruefe 'Rollout: schon installiert → nur die Zuordnung' { $p2.Schritte.Count -eq 1 -and $p2.Schritte[0].Id -eq 'zuordnen' }
$p2 = Neuer-FernwartungsPlan -Konfig $kRollout -Alias 'K' -Umgebung (Umg $umg @{ Installiert = $true; ZuordnungErledigt = $true })
Pruefe 'Rollout: schon installiert und zugeordnet → nichts zu tun' { $p2.Schritte.Count -eq 0 }
$p2 = Neuer-FernwartungsPlan -Konfig $kRollout -Alias 'K' -Umgebung (Umg $umg @{ Installiert = $true; Offline = $true })
Pruefe 'Rollout: Vormerken nutzt --offline statt --retries/--timeout' { $p2.Schritte[0].ArgumentString -match ' --offline' -and $p2.Schritte[0].ArgumentString -notmatch '--retries' }

$p = Neuer-FernwartungsPlan -Konfig $kToken -Alias 'Cafe Mayr' -Umgebung $umg
Pruefe 'Token/cli: das Token steht NICHT auf der msiexec-Kommandozeile' { $p.Schritte[0].ArgumentString -notmatch [regex]::Escape($TOKEN) -and $p.Schritte[0].ArgumentString -notmatch 'APITOKEN' }
Pruefe 'Token/cli: assign-Befehl mit --api-token, --alias, --group-id, --grant-easy-access' {
  $p.Schritte[1].ArgumentString -eq ('assign --api-token ' + $TOKEN + ' --alias "Cafe Mayr" --group-id g12345678 --grant-easy-access')
}
Pruefe 'Token/cli: Anzeige maskiert das Token' { ($p.Schritte[1].Anzeige -notmatch [regex]::Escape($TOKEN)) -and ($p.Schritte[1].Anzeige -match '--api-token \*\*\*') }
$kTokenGruppe = (Lies-Konfig ('{ "msiPfad": "a.msi", "apiToken": "' + $TOKEN + '", "gruppe": "Mietkassen" }') 'C:\konfig').Konfig
$p2 = Neuer-FernwartungsPlan -Konfig $kTokenGruppe -Alias 'X' -Umgebung (Umg $umg @{ Installiert = $true; NeuZuordnen = $true })
Pruefe 'Token: Gruppe per Name (--group) und --reassign' { $p2.Schritte[0].ArgumentString -match '--group Mietkassen --grant-easy-access --reassign$' }

$kMsi = (Lies-Konfig ('{ "msiPfad": "a.msi", "customConfigId": "abc1234", "apiToken": "' + $TOKEN + '", "gruppeId": "g123456", "zuordnungsweg": "msi" }') 'C:\konfig').Konfig
$p = Neuer-FernwartungsPlan -Konfig $kMsi -Alias 'Cafe Mayr' -Umgebung $umg
Pruefe 'Token/msi (Einschritt): ein Schritt, Zuordnung über MSI-Eigenschaften' { $p.Schritte.Count -eq 1 -and $p.ZuordnungImMsi -eq $true }
Pruefe 'Token/msi: APITOKEN und ASSIGNMENTOPTIONS wie in der Doku' {
  $a = $p.Schritte[0].ArgumentString
  ($a -match [regex]::Escape('APITOKEN="' + $TOKEN + '"')) -and ($a -match [regex]::Escape('ASSIGNMENTOPTIONS="--alias ''Cafe Mayr'' --group-id g123456 --grant-easy-access"'))
}
Pruefe 'Token/msi: Anzeige maskiert das Token' { ($p.Schritte[0].Anzeige -notmatch [regex]::Escape($TOKEN)) -and ($p.Schritte[0].Anzeige -match 'APITOKEN="\*\*\*"') }
Pruefe 'Token/msi: KEIN MSI-Log (würde das Token mitschreiben)' { $p.Schritte[0].ArgumentString -notmatch '/L\*v' }
$p2 = Neuer-FernwartungsPlan -Konfig $kMsi -Alias 'X' -Umgebung (Umg $umg @{ Installiert = $true })
Pruefe 'Token/msi: ist TeamViewer schon installiert, wird per Kommandozeile zugeordnet' { $p2.Schritte.Count -eq 1 -and $p2.Schritte[0].Id -eq 'zuordnen' }
$kAMsi = (Lies-Konfig ('{ "msiPfad": "a.msi", "assignmentId": "' + $ASSID + '", "zuordnungsweg": "msi" }') 'C:\konfig').Konfig
$p = Neuer-FernwartungsPlan -Konfig $kAMsi -Alias 'X' -Umgebung $umg
Pruefe 'Rollout/msi: ASSIGNMENTID als MSI-Eigenschaft, maskiert angezeigt' {
  ($p.Schritte[0].ArgumentString -match [regex]::Escape('ASSIGNMENTID="' + $ASSID + '"')) -and ($p.Schritte[0].Anzeige -match 'ASSIGNMENTID="\*\*\*"') -and ($p.Schritte[0].Anzeige -notmatch [regex]::Escape($ASSID))
}

$kExe = (Lies-Konfig ('{ "msiPfad": "TeamViewer_Host_Setup_x64.exe", "apiToken": "' + $TOKEN + '" }') 'C:\konfig').Konfig
$p = Neuer-FernwartungsPlan -Konfig $kExe -Alias 'Cafe' -Umgebung (Umg $umg @{ InstallerDatei = 'C:\tv\TeamViewer_Host_Setup_x64.exe' })
Pruefe 'EXE: Installation mit /S, danach assign' { $p.Schritte[0].Datei -eq 'C:\tv\TeamViewer_Host_Setup_x64.exe' -and $p.Schritte[0].ArgumentString -eq '/S' -and $p.Schritte[1].ArgumentString -match '^assign --api-token' }

$kNur = (Lies-Konfig '{ "msiPfad": "a.msi" }' 'C:\konfig').Konfig
$p = Neuer-FernwartungsPlan -Konfig $kNur -Alias 'X' -Umgebung $umg
Pruefe 'Ohne Zuordnung: nur die Installation' { $p.Schritte.Count -eq 1 -and $p.Schritte[0].Id -eq 'installieren' }

# =============================================================================
Gruppe '4. Statusdatei (ohne Geheimnisse, reines ASCII)'
# =============================================================================

$j = Neuer-FernwartungStatus -Id '123456789' -Alias 'Café "Müller" \ Straße' -Gruppe 'Mietkassen' -InstalliertAm '2026-10-06T20:15:00Z'
Pruefe 'Status: gültiges JSON mit den erwarteten Feldern' {
  $o = $j | ConvertFrom-Json
  $o.anbieter -eq 'teamviewer' -and $o.id -eq '123456789' -and $o.gruppe -eq 'Mietkassen'
}
Pruefe 'Status: Umlaute und Sonderzeichen überstehen den Rundlauf' { (($j | ConvertFrom-Json).alias) -eq 'Café "Müller" \ Straße' }
Pruefe 'Status: reines ASCII (übersteht jede Kodierung unterwegs)' { -not ($j.ToCharArray() | Where-Object { [int]$_ -gt 126 -or ([int]$_ -lt 32) }) }
Pruefe 'Status: ohne Gruppe → null' { ((Neuer-FernwartungStatus -Id '123456789' -Alias 'A') | ConvertFrom-Json).gruppe -eq $null }
Pruefe 'Status: Rücklesen per Regex (id, alias, installiertAm unverändert)' {
  $x = Lese-FernwartungStatusText $j
  $x.id -eq '123456789' -and $x.alias -eq 'Café "Müller" \ Straße' -and $x.installiertAm -eq '2026-10-06T20:15:00Z'
}
Pruefe 'Status: Müll oder ungültige ID → $null' { ($null -eq (Lese-FernwartungStatusText '{"id":"abc"}')) -and ($null -eq (Lese-FernwartungStatusText 'kein json')) }

# =============================================================================
Gruppe '5. Ablauf mit simuliertem System (Trockenlauf, voller Lauf, Wiederholung, Fehler)'
# =============================================================================

# Ersatz für alles, was das System anfasst — schreibt nur Aufrufe mit
$script:FakeInstalliert = $false
$script:FakeId          = $null
$script:FakeIdNachInstall = '123456789'
$script:FakeAdmin       = $true
$script:Aufrufe         = New-Object System.Collections.Generic.List[object]
$script:ProzessCode     = @{ msiexec = 0; assignment = 0; assign = 0 }
$script:ProzessAusnahme = $false

function Get-TeamViewerInstallation {
  [pscustomobject]@{
    Installiert = $script:FakeInstalliert
    ExePfad     = $(if ($script:FakeInstalliert) { 'C:\Program Files\TeamViewer\TeamViewer.exe' } else { $null })
    Version     = '15.99.9'; DienstStatus = 'Running'; DienstStart = 'Auto'
  }
}
function Get-TeamViewerId { return $script:FakeId }
function Teste-Administrator { return $script:FakeAdmin }
function Sichere-TeamViewerDienst { return $true }
function Warte-Auf { param($Bedingung, $Sekunden, $Takt) return [bool](& $Bedingung) }
function Hole-FernwartungInstaller { param($Konfig, $ZielVerzeichnis) [pscustomobject]@{ Pfad = 'C:\fake\TeamViewer_Host.msi'; Temporaer = $false } }
function Invoke-FwProzess {
  param([string]$Datei, [string]$ArgumentString = '', [int]$TimeoutSekunden = 600, [string]$Arbeitsverzeichnis = '')
  $script:Aufrufe.Add([pscustomobject]@{ Datei = $Datei; Args = $ArgumentString })
  if ($script:ProzessAusnahme) { throw 'simulierter Absturz beim Start' }
  if ($Datei -eq 'msiexec.exe') {
    if ($script:ProzessCode.msiexec -eq 0) { $script:FakeInstalliert = $true; $script:FakeId = $script:FakeIdNachInstall }
    return [pscustomobject]@{ ExitCode = $script:ProzessCode.msiexec; Zeitueberschreitung = $false; Ausgabe = '' }
  }
  $art = $(if ($ArgumentString -match '^assignment') { 'assignment' } else { 'assign' })
  $code = $script:ProzessCode[$art]
  if ($ArgumentString -match '--offline' -and $art -eq 'assignment') { $code = 0 }
  return [pscustomobject]@{ ExitCode = $code; Zeitueberschreitung = $false; Ausgabe = $(if ($code -ne 0) { "device assignment failed (Token $TOKEN)" } else { '' }) }
}

function Setze-Szenario([hashtable]$Werte) {
  $script:FakeInstalliert = $false; $script:FakeId = $null; $script:FakeAdmin = $true; $script:FakeIdNachInstall = '123456789'
  $script:ProzessCode = @{ msiexec = 0; assignment = 0; assign = 0 }; $script:ProzessAusnahme = $false
  $script:Aufrufe.Clear()
  foreach ($k in $Werte.Keys) { Set-Variable -Scope Script -Name $k -Value $Werte[$k] }
}

$tmp = Neues-Tempverzeichnis; $aufraeumen.Add($tmp)
Schreibe-Text (Join-Path $tmp 'fw-rollout.json') $jsonRollout
Schreibe-Text (Join-Path $tmp 'fw-token.json') $jsonToken
New-Item -ItemType File -Path (Join-Path $tmp 'TeamViewer_Host.msi') -Force | Out-Null
$status = Join-Path $tmp 'status\fernwartung-status.json'

# --- Trockenlauf ---------------------------------------------------------------
Setze-Szenario @{}
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-token.json') -Name 'Mayr' -Trockenlauf -StatusDatei $status }
Pruefe 'Trockenlauf (Token): zeigt msiexec- und assign-Aufruf' { ($o.Text -match 'msiexec\.exe /i') -and ($o.Text -match 'TeamViewer\.exe" assign --api-token \*\*\*') }
Pruefe 'Trockenlauf (Token): das Token steht in KEINER Ausgabe' { $o.Text -notmatch [regex]::Escape($TOKEN) }
Pruefe 'Trockenlauf: führt nichts aus und schreibt nichts' { $script:Aufrufe.Count -eq 0 -and -not (Test-Path (Join-Path $tmp 'status')) -and $o.Ergebnis.Erfolg -eq $true }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -Name 'Mayr' -Trockenlauf -StatusDatei $status }
Pruefe 'Trockenlauf (Rollout): Assignment-ID maskiert, Gerätename sichtbar' { ($o.Text -notmatch [regex]::Escape($ASSID)) -and ($o.Text -match 'assignment --id \*\*\*') -and ($o.Text -match 'Kassa Mayr') }
Setze-Szenario @{ FakeInstalliert = $true; FakeId = '123456789' }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -Trockenlauf -StatusDatei $status }
Pruefe 'Trockenlauf bei installiertem TeamViewer: keine Neuinstallation geplant' { ($o.Text -match 'bereits installiert') -and ($o.Text -notmatch 'msiexec') }

# --- Voller Lauf: Neuinstallation -------------------------------------------------
Setze-Szenario @{}
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -Name 'Mayr' -StatusDatei $status }
$erg = $o.Ergebnis
Pruefe 'Voller Lauf (Rollout): erfolgreich, ID 123456789' { $erg.Erfolg -eq $true -and $erg.Id -eq '123456789' -and $erg.Meldung -eq 'eingerichtet' }
Pruefe 'Voller Lauf: erst msiexec, dann assignment (genau diese zwei Prozesse)' { $script:Aufrufe.Count -eq 2 -and $script:Aufrufe[0].Datei -eq 'msiexec.exe' -and $script:Aufrufe[1].Args -match '^assignment --id ' }
Pruefe 'Voller Lauf: Assignment-ID erscheint in KEINER Ausgabe' { $o.Text -notmatch [regex]::Escape($ASSID) }
Pruefe 'Voller Lauf: Statusdatei geschrieben, ohne Geheimnis' {
  $t = Get-Content -LiteralPath $status -Raw
  ($t -match '"id":"123456789"') -and ($t -match '"alias":"Kassa Mayr"') -and ($t -match '"gruppe":"Mietkassen"') -and ($t -notmatch [regex]::Escape($ASSID))
}
$erstZeit = (Lese-FernwartungStatusDatei -Pfad $status).installiertAm
Pruefe 'Voller Lauf: Ausgabe nennt die ID in Dreiergruppen' { $o.Text -match '123 456 789' }

# --- Wiederholung = Idempotenz --------------------------------------------------------
$script:Aufrufe.Clear()
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -StatusDatei $status }
Pruefe 'Zweiter Lauf: installiert und ordnet NICHT erneut zu' { $script:Aufrufe.Count -eq 0 -and $o.Ergebnis.Erfolg -eq $true }
Pruefe 'Zweiter Lauf: behält Gerätename und Installationszeitpunkt' { $s2 = Lese-FernwartungStatusDatei -Pfad $status; $s2.alias -eq 'Kassa Mayr' -and $s2.installiertAm -eq $erstZeit }
$script:Aufrufe.Clear()
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -NeuZuordnen -StatusDatei $status }
Pruefe 'Mit -NeuZuordnen: genau ein assignment-Aufruf mit --reassign (keine Neuinstallation)' { $script:Aufrufe.Count -eq 1 -and $script:Aufrufe[0].Args -match ' --reassign$' }
Pruefe 'Mit -NeuZuordnen: Assignment-ID weiterhin nirgends ausgegeben' { $o.Text -notmatch [regex]::Escape($ASSID) }

# --- Token-Variante, voller Lauf -------------------------------------------------------
Remove-Item -LiteralPath (Split-Path -Parent $status) -Recurse -Force
Setze-Szenario @{}
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-token.json') -Name 'Cafe Mayr' -StatusDatei $status }
Pruefe 'Voller Lauf (Token): erfolgreich, assign-Aufruf' { $o.Ergebnis.Erfolg -eq $true -and $script:Aufrufe[1].Args -match '^assign --api-token ' }
Pruefe 'Voller Lauf (Token): das Token steht in KEINER Ausgabe' { $o.Text -notmatch [regex]::Escape($TOKEN) }
Pruefe 'Voller Lauf (Token): Statusdatei ohne Token' { (Get-Content -LiteralPath $status -Raw) -notmatch [regex]::Escape($TOKEN) }

# --- Fehlerfälle: nie werfen, nie das Geheimnis ausgeben -------------------------------
Remove-Item -LiteralPath (Split-Path -Parent $status) -Recurse -Force -ErrorAction SilentlyContinue
Setze-Szenario @{ ProzessCode = @{ msiexec = 1603; assignment = 0; assign = 0 } }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-token.json') -StatusDatei $status }
Pruefe 'Installation schlägt fehl (1603): wirft nicht, meldet Fehler + Nachhol-Hinweis' { $o.Ergebnis.Erfolg -eq $false -and ($o.Text -match '1603') -and ($o.Text -match 'Nachholen') -and ($o.Text -match 'Kassa wird trotzdem installiert') }
Pruefe 'Installation schlägt fehl: kein Token in der Ausgabe, keine Statusdatei' { ($o.Text -notmatch [regex]::Escape($TOKEN)) -and -not (Test-Path $status) }

Setze-Szenario @{ ProzessCode = @{ msiexec = 0; assignment = 0; assign = 5 } }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-token.json') -StatusDatei $status }
Pruefe 'Zuordnung schlägt fehl: Warnung + Hinweis auf -FernwartungNeuZuordnen, KEINE Statusdatei' { $o.Ergebnis.Erfolg -eq $false -and ($o.Text -match 'Zuordnung nicht gelungen') -and ($o.Text -match 'FernwartungNeuZuordnen') -and -not (Test-Path $status) }
Pruefe 'Zuordnung schlägt fehl: Fehlerausgabe von TeamViewer wird maskiert angezeigt' { ($o.Text -match 'TeamViewer meldet') -and ($o.Text -notmatch [regex]::Escape($TOKEN)) }

Setze-Szenario @{ ProzessAusnahme = $true }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-token.json') -StatusDatei $status }
Pruefe 'Unerwartete Ausnahme: wird abgefangen (der Installer läuft weiter)' { $o.Ergebnis.Erfolg -eq $false -and $o.Ergebnis.Meldung -eq 'Fehler' -and ($o.Text -match 'simulierter Absturz') }

Setze-Szenario @{ FakeAdmin = $false }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -StatusDatei $status }
Pruefe 'Ohne Administratorrechte: Hinweis, nichts wird ausgeführt' { $o.Ergebnis.Erfolg -eq $false -and $script:Aufrufe.Count -eq 0 -and ($o.Text -match 'Administratorrechte') }

Setze-Szenario @{ ProzessCode = @{ msiexec = 0; assignment = 403; assign = 0 } }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -StatusDatei $status }
Pruefe 'Kein Internet (403): Zuordnung wird mit --offline vorgemerkt, Status NICHT geschrieben' {
  ($script:Aufrufe.Count -eq 3) -and ($script:Aufrufe[2].Args -match ' --offline') -and ($o.Text -match 'vorgemerkt') -and $o.Ergebnis.Erfolg -eq $false -and -not (Test-Path $status)
}

Remove-Item -LiteralPath (Split-Path -Parent $status) -Recurse -Force -ErrorAction SilentlyContinue
Setze-Szenario @{ FakeIdNachInstall = $null }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -StatusDatei $status }
Pruefe 'Kasse von Anfang an offline (keine ID): Zuordnung sofort mit --offline vorgemerkt, ohne den Online-Weg zu versuchen' {
  ($script:Aufrufe.Count -eq 2) -and ($script:Aufrufe[1].Args -match ' --offline') -and ($script:Aufrufe[1].Args -notmatch '--retries') -and ($o.Text -match 'vorgemerkt') -and $o.Ergebnis.Erfolg -eq $false -and -not (Test-Path $status)
}
Pruefe 'Offline: die Assignment-ID steht in KEINER Ausgabe' { $o.Text -notmatch [regex]::Escape($ASSID) }
Setze-Szenario @{ ProzessCode = @{ msiexec = 0; assignment = 409; assign = 0 } }
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-rollout.json') -StatusDatei $status }
Pruefe 'Schon zugeordnet (409): gilt als Erfolg' { $o.Ergebnis.Erfolg -eq $true -and ($o.Text -match 'bereits') }

Remove-Item -LiteralPath (Split-Path -Parent $status) -Recurse -Force -ErrorAction SilentlyContinue
Setze-Szenario @{}
Schreibe-Text (Join-Path $tmp 'fw-leer.json') '{ }'
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'fw-leer.json') -StatusDatei $status }
Pruefe 'Konfiguration ohne Zuordnung: installiert, aber zeigt NICHT „eingerichtet"' { $o.Ergebnis.Erfolg -eq $false -and $o.Ergebnis.Meldung -eq 'nicht zugeordnet' -and -not (Test-Path $status) }

Setze-Szenario @{}
$o = Fange-Ausgabe { Invoke-Fernwartung -KonfigPfad (Join-Path $tmp 'gibt-es-nicht.json') -StatusDatei $status }
Pruefe 'Konfiguration fehlt: Fehler + Hinweis, kein Absturz' { $o.Ergebnis.Erfolg -eq $false -and ($o.Text -match 'nicht gefunden') }

# =============================================================================
Gruppe '5b. Konfig-Suche, Veröffentlichen und die Schalter-Logik der Installer'
# =============================================================================

# --- Finde-FernwartungKonfig: ausdrücklicher Pfad → Installer-Ordner → aktueller Ordner ---
$ordA = Neues-Tempverzeichnis; $aufraeumen.Add($ordA)
$ordB = Neues-Tempverzeichnis; $aufraeumen.Add($ordB)
$ordC = Neues-Tempverzeichnis; $aufraeumen.Add($ordC)
Schreibe-Text (Join-Path $ordA 'fernwartung.json') '{}'
Schreibe-Text (Join-Path $ordB 'fernwartung.json') '{}'
$vorherOrt = (Get-Location).Path
Set-Location $ordB
Pruefe 'Konfig-Suche: ausdrücklicher Pfad hat Vorrang' { (Finde-FernwartungKonfig -Pfad 'X:\egal.json' -InstallerOrdner $ordA) -eq 'X:\egal.json' }
Pruefe 'Konfig-Suche: sonst neben dem Installer' { (Finde-FernwartungKonfig -InstallerOrdner $ordA) -eq (Join-Path $ordA 'fernwartung.json') }
Pruefe 'Konfig-Suche: sonst im aktuellen Ordner' { (Finde-FernwartungKonfig -InstallerOrdner $ordC) -eq (Join-Path $ordB 'fernwartung.json') }
Set-Location $ordC
Pruefe 'Konfig-Suche: nirgends → $null' { $null -eq (Finde-FernwartungKonfig -InstallerOrdner $ordC) }
Set-Location $vorherOrt

# --- Veroeffentliche-FernwartungStatus mit Attrappe „docker" (die echte Funktion, nur der Befehl ist ersetzt) ---
$script:EchteVeroeffentlichung = ${function:Veroeffentliche-FernwartungStatus}
$script:DockerAufrufe = New-Object System.Collections.Generic.List[object]
$script:DockerCodes = @(0)
function docker {
  $eingabe = @($input) -join ''
  $script:DockerAufrufe.Add([pscustomobject]@{ Args = ($args -join ' '); Stdin = $eingabe })
  $i = $script:DockerAufrufe.Count - 1
  $global:LASTEXITCODE = $(if ($i -lt $script:DockerCodes.Count) { $script:DockerCodes[$i] } else { $script:DockerCodes[$script:DockerCodes.Count - 1] })
}
$stJ = Neuer-FernwartungStatus -Id '123456789' -Alias 'Café' -Gruppe 'Mietkassen' -InstalliertAm '2026-10-06T10:00:00Z'
$script:DockerAufrufe.Clear(); $script:DockerCodes = @(0)
$veroeff = & $script:EchteVeroeffentlichung -Json $stJ -Ziel $ordA -Versuche 3 -Pause 0
Pruefe 'Veröffentlichen (docker): Weg A — JSON über stdin an „docker compose exec -T updater sh -c"' {
  $veroeff -eq $true -and $script:DockerAufrufe.Count -eq 1 -and $script:DockerAufrufe[0].Args -match '^compose exec -T updater sh -c cat > /control/fernwartung-status\.json\.tmp' -and $script:DockerAufrufe[0].Stdin -eq $stJ
}
Pruefe 'Veröffentlichen (docker): schreibt erst in .tmp und benennt dann atomar um (mv), mit && verkettet' {
  $a = $script:DockerAufrufe[0].Args
  ($a -match '&& chmod 644 /control/fernwartung-status\.json\.tmp') -and ($a -match '&& mv /control/fernwartung-status\.json\.tmp /control/fernwartung-status\.json$') -and ($a -notmatch ';')
}
$script:DockerAufrufe.Clear(); $script:DockerCodes = @(1, 0)
$veroeff = & $script:EchteVeroeffentlichung -Json $stJ -Ziel $ordA -Versuche 3 -Pause 0
Pruefe 'Veröffentlichen (docker): stdin scheitert → Weg B (Base64-Argument) gelingt' {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($stJ))
  $veroeff -eq $true -and $script:DockerAufrufe.Count -eq 2 -and $script:DockerAufrufe[1].Args -match ('echo ' + [regex]::Escape($b64) + ' \| base64 -d > /control/fernwartung-status\.json\.tmp') -and $script:DockerAufrufe[1].Stdin -eq ''
}
$script:DockerAufrufe.Clear(); $script:DockerCodes = @(1)
$veroeff = & $script:EchteVeroeffentlichung -Json $stJ -Ziel $ordA -Versuche 2 -Pause 0
Pruefe 'Veröffentlichen (docker): scheitert dauerhaft → nach den Versuchen false, kein Absturz' { $veroeff -eq $false -and $script:DockerAufrufe.Count -eq 4 }
$script:DockerAufrufe.Clear(); $script:DockerCodes = @(0)
$veroeff = & $script:EchteVeroeffentlichung -Json 'Café' -Ziel $ordA -Versuche 1 -Pause 0
Pruefe 'Veröffentlichen (docker): Nicht-ASCII wird gar nicht erst abgeschickt' { $veroeff -eq $false -and $script:DockerAufrufe.Count -eq 0 }
$script:DockerAufrufe.Clear(); $script:DockerCodes = @(0)
$veroeff = & $script:EchteVeroeffentlichung -Json $stJ -Ziel $ordA -Versuche 1 -Pause 0
Pruefe 'Veröffentlichen (docker): in der Befehlszeile steht kein Token/keine Assignment-ID (nur Status)' { ($script:DockerAufrufe | ForEach-Object { $_.Args + $_.Stdin }) -join ' ' -notmatch [regex]::Escape($ASSID) }
# --- Veröffentlichen: nur die selbst geschriebene Form, nie Müll ---
$script:VeroeffentlichtMit = $null
$script:VeroeffentlichenOk = $true
function Veroeffentliche-FernwartungStatus { param([string]$Json, [string]$Ziel, [int]$Versuche = 8, [int]$Pause = 3) $script:VeroeffentlichtMit = $Json; return $script:VeroeffentlichenOk }
$stJson = Neuer-FernwartungStatus -Id '123456789' -Alias 'Café' -Gruppe 'Mietkassen' -InstalliertAm '2026-10-06T10:00:00Z'
$stDatei = Join-Path $ordA 'st.json'
Schreibe-Text $stDatei $stJson
$o = Fange-Ausgabe { Veroeffentliche-FernwartungErgebnis -Ziel $ordA -StatusDatei $stDatei }
Pruefe 'Veröffentlichen: gibt die Statusdatei unverändert (ASCII) weiter und meldet Erfolg' { $o.Ergebnis -eq $true -and $script:VeroeffentlichtMit -eq $stJson -and ($o.Text -match 'sichtbar') }
$script:VeroeffentlichtMit = $null; $script:VeroeffentlichenOk = $false
$o = Fange-Ausgabe { Veroeffentliche-FernwartungErgebnis -Ziel $ordA -StatusDatei $stDatei }
Pruefe 'Veröffentlichen: Fehlschlag → Warnung mit Nachhol-Hinweis, kein Absturz' { $o.Ergebnis -eq $false -and ($o.Text -match 'nicht an die Kassa übergeben') }
$script:VeroeffentlichtMit = $null
Schreibe-Text (Join-Path $ordA 'kaputt.json') '{"id":"abc"}'
Schreibe-Text (Join-Path $ordA 'unicode.json') '{"anbieter":"teamviewer","id":"123456789","alias":"Café"}'
$o = Fange-Ausgabe { Veroeffentliche-FernwartungErgebnis -Ziel $ordA -StatusDatei (Join-Path $ordA 'kaputt.json') }
Pruefe 'Veröffentlichen: ungültige ID → nichts weitergegeben' { $o.Ergebnis -eq $false -and $null -eq $script:VeroeffentlichtMit }
$o = Fange-Ausgabe { Veroeffentliche-FernwartungErgebnis -Ziel $ordA -StatusDatei (Join-Path $ordA 'unicode.json') }
Pruefe 'Veröffentlichen: Nicht-ASCII-Inhalt (fremd geschrieben) → nichts weitergegeben' { $o.Ergebnis -eq $false -and $null -eq $script:VeroeffentlichtMit }
$o = Fange-Ausgabe { Veroeffentliche-FernwartungErgebnis -Ziel $ordA -StatusDatei (Join-Path $ordA 'gibt-es-nicht.json') }
Pruefe 'Veröffentlichen: keine Statusdatei → still false' { $o.Ergebnis -eq $false -and $o.Text.Trim() -eq '' }

# --- Schalter-Logik des Fernwartungs-Blocks in install.ps1 / install-offline.ps1 ---
# Der Block wird aus dem echten Skript herausgeschnitten und mit Attrappen ausgeführt —
# so ist die Verzweigung (Konfig vorhanden? -OhneDocker? -Fernwartung? …) wirklich geprüft.
$stubBibliothek = Join-Path $ordA 'stub-bibliothek.ps1'
Schreibe-Text $stubBibliothek @'
function Invoke-FernwartungImInstaller {
  param([string]$KonfigPfad, [string]$Name = '', [switch]$NeuZuordnen, [switch]$Trockenlauf, [string]$StatusDatei = '')
  $global:BlockAufruf = [pscustomobject]@{ Konfig = $KonfigPfad; Name = $Name; Neu = [bool]$NeuZuordnen }
}
'@

function Lass-Block-Laufen {
  param([string]$Skript, [string]$StartMarke, [hashtable]$P, [string]$SkriptOrdner, [string]$Arbeitsordner, [bool]$BibliothekDa = $true)
  $text = [System.IO.File]::ReadAllText((Join-Path $here $Skript), [System.Text.Encoding]::UTF8)
  $von = $text.IndexOf($StartMarke); if ($von -lt 0) { throw "Marke nicht gefunden: $StartMarke" }
  $bis = $text.IndexOf('if ($OhneDocker) {', $von); if ($bis -lt 0) { throw 'Ende nicht gefunden' }
  # Skript-Variablen des Installers durch Testwerte ersetzen
  $block = $text.Substring($von, $bis - $von).Replace('$PSScriptRoot', '$FwTestOrdner').Replace('$paket', '$FwTestOrdner')
  $FwTestOrdner = $SkriptOrdner
  $FernwartungKonfig = [string]$P.Konfig; $FernwartungName = [string]$P.Name
  $Fernwartung = [bool]$P.Fernwartung; $OhneFernwartung = [bool]$P.OhneFernwartung
  $OhneDocker = [bool]$P.OhneDocker; $FernwartungNeuZuordnen = [bool]$P.Neu
  $fwAktiv = $false
  $global:BlockAufruf = $null
  $global:BlockHinweise = New-Object System.Collections.Generic.List[string]
  function Finde-FernwartungBibliothek { if ($BibliothekDa) { return $stubBibliothek } return $null }
  function Hinweis([string]$t) { $global:BlockHinweise.Add($t) }
  $vorher = (Get-Location).Path
  Set-Location $Arbeitsordner
  try { $konsole = (Invoke-Expression $block *>&1 | Out-String) } finally { Set-Location $vorher }   # im Funktions-Scope (nicht in & { }), damit $fwAktiv sichtbar bleibt
  return [pscustomobject]@{ Aktiv = $fwAktiv; Aufruf = $global:BlockAufruf; Hinweise = ($global:BlockHinweise -join ' | '); Konsole = $konsole }
}

foreach ($variante in @(
  @{ Skript = 'install.ps1';         Marke = '# ── 4b. Fernwartung' },
  @{ Skript = 'install-offline.ps1'; Marke = '# ── 3b. Fernwartung' }
)) {
  $n = $variante.Skript
  $leer  = Neues-Tempverzeichnis; $aufraeumen.Add($leer)      # Skript-/Arbeitsordner OHNE fernwartung.json
  $mitFw = Neues-Tempverzeichnis; $aufraeumen.Add($mitFw)     # Ordner MIT fernwartung.json
  Schreibe-Text (Join-Path $mitFw 'fernwartung.json') '{}'
  $basis = @{ Konfig = ''; Name = ''; Fernwartung = $false; OhneFernwartung = $false; OhneDocker = $false; Neu = $false }

  $r = Lass-Block-Laufen $n $variante.Marke $basis $leer $leer
  Pruefe "$n`: ohne Konfiguration und ohne -Fernwartung: übersprungen, mit Hinweiszeile" { -not $r.Aktiv -and $null -eq $r.Aufruf -and ($r.Konsole -match 'keine fernwartung\.json') }

  $r = Lass-Block-Laufen $n $variante.Marke (Umg $basis @{ Konfig = 'C:\x\fernwartung.json'; Name = 'Mayr'; Neu = $true }) $leer $leer
  Pruefe "$n`: -FernwartungKonfig → Schritt läuft mit diesem Pfad, Name und -NeuZuordnen" { $r.Aktiv -and $r.Aufruf.Konfig -eq 'C:\x\fernwartung.json' -and $r.Aufruf.Name -eq 'Mayr' -and $r.Aufruf.Neu -eq $true }

  $r = Lass-Block-Laufen $n $variante.Marke $basis $mitFw $leer
  Pruefe "$n`: fernwartung.json neben dem Installer wird gefunden" { $r.Aktiv -and $r.Aufruf.Konfig -eq (Join-Path $mitFw 'fernwartung.json') }

  $r = Lass-Block-Laufen $n $variante.Marke $basis $leer $mitFw
  Pruefe "$n`: fernwartung.json im aktuellen Ordner wird gefunden" { $r.Aktiv -and $r.Aufruf.Konfig -eq (Join-Path $mitFw 'fernwartung.json') }

  $r = Lass-Block-Laufen $n $variante.Marke (Umg $basis @{ OhneFernwartung = $true }) $mitFw $mitFw
  Pruefe "$n`: -OhneFernwartung überspringt trotz Konfiguration (ohne Hinweiszeile)" { -not $r.Aktiv -and $null -eq $r.Aufruf -and ($r.Konsole -notmatch 'keine fernwartung') }

  $r = Lass-Block-Laufen $n $variante.Marke (Umg $basis @{ OhneDocker = $true }) $mitFw $mitFw
  Pruefe "$n`: -OhneDocker (Testlauf) installiert NIE versehentlich TeamViewer" { -not $r.Aktiv -and $null -eq $r.Aufruf }

  $r = Lass-Block-Laufen $n $variante.Marke (Umg $basis @{ OhneDocker = $true; Fernwartung = $true }) $mitFw $mitFw
  Pruefe "$n`: -OhneDocker zusammen mit -Fernwartung läuft" { $r.Aktiv -and $null -ne $r.Aufruf }

  $r = Lass-Block-Laufen $n $variante.Marke (Umg $basis @{ Fernwartung = $true }) $leer $leer
  Pruefe "$n`: -Fernwartung ohne Datei läuft mit dem Standardpfad (meldet dann: nicht gefunden)" { $r.Aktiv -and $r.Aufruf.Konfig -eq (Join-Path $leer 'fernwartung.json') }

  $r = Lass-Block-Laufen $n $variante.Marke $basis $mitFw $mitFw -BibliothekDa $false
  Pruefe "$n`: Bibliothek nicht ladbar → übersprungen mit Hinweis, Installer läuft weiter" { -not $r.Aktiv -and $null -eq $r.Aufruf -and ($r.Hinweise -match 'trotzdem installiert') }
}

# =============================================================================
Gruppe '6. install.ps1 -Trockenlauf als eigener Prozess (tut nichts, Token nie sichtbar)'
# =============================================================================

$tmp2 = Neues-Tempverzeichnis; $aufraeumen.Add($tmp2)
Schreibe-Text (Join-Path $tmp2 'fernwartung.json') $jsonToken
New-Item -ItemType File -Path (Join-Path $tmp2 'TeamViewer_Host.msi') -Force | Out-Null
$installPs1 = Join-Path $here 'install.ps1'
$motoren = New-Object System.Collections.Generic.List[object]
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (Test-Path $ps51) { $motoren.Add(@('Windows PowerShell 5.1', $ps51)) }
$pw = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pw) { $motoren.Add(@('PowerShell 7 (pwsh)', $pw.Source)) }
$skripte = @(@('install.ps1', (Join-Path $here 'install.ps1')), @('install-offline.ps1', (Join-Path $here 'install-offline.ps1')))
foreach ($m in $motoren) {
 foreach ($s in $skripte) {
  $exe = $m[1]
  $name = $m[0] + ' / ' + $s[0]
  $ausgabe = & $exe -NoProfile -ExecutionPolicy Bypass -File $s[1] -Trockenlauf -FernwartungKonfig (Join-Path $tmp2 'fernwartung.json') -FernwartungName 'Testkasse' 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pruefe ($name + ': Exit-Code 0') { $code -eq 0 }
  # Auf einem PC mit TeamViewer (Echtsystem!) steht statt msiexec „bereits installiert" — beides ist richtig
  Pruefe ($name + ': Plan wird angezeigt (Gerätename, Installation oder „bereits installiert", assign)') {
    ($ausgabe -match 'Testkasse') -and (($ausgabe -match 'msiexec\.exe /i') -or ($ausgabe -match 'bereits installiert')) -and ($ausgabe -match 'assign --api-token \*\*\*')
  }
  Pruefe ($name + ': das Token steht in KEINER Ausgabe') { $ausgabe -notmatch [regex]::Escape($TOKEN) }
  Pruefe ($name + ': tut nichts (keine Docker-/Installationsschritte)') { ($ausgabe -notmatch 'Prüfe Docker') -and ($ausgabe -notmatch 'Lade Kassa-Code') -and ($ausgabe -notmatch 'Installiere Code') }
 }
}
if ($motoren.Count -gt 0) {
  $leer = Neues-Tempverzeichnis; $aufraeumen.Add($leer)
  $ausgabe = & $motoren[0][1] -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'install.ps1') -Trockenlauf -FernwartungKonfig (Join-Path $leer 'gibt-es-nicht.json') 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pruefe 'Trockenlauf mit fehlender Konfiguration: Exit-Code 1 und klare Meldung' { $code -eq 1 -and ($ausgabe -match 'nicht gefunden') }
}

# Kassa-Setup.cmd gibt eine fernwartung.json neben der Datei weiter (und behält CRLF)
$cmd = [System.IO.File]::ReadAllText((Join-Path $here 'Kassa-Setup.cmd'))
Pruefe 'Kassa-Setup.cmd: gibt fernwartung.json neben der Datei an den Installer weiter' { $cmd -match '-FernwartungKonfig "%~dp0fernwartung\.json"' -and $cmd -match 'if exist "%~dp0fernwartung\.json"' }
Pruefe 'Kassa-Setup.cmd: durchgehend CRLF' { ($cmd -split "`n" | Where-Object { $_ -ne '' -and -not $_.EndsWith("`r") }).Count -eq 0 }
if ($motoren.Count -eq 0) { Pruefe 'PowerShell-Engine für den Prozess-Test vorhanden' { $false } }

# ---- Aufräumen + Ergebnis -----------------------------------------------------
foreach ($d in $aufraeumen) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
if ($script:Fehlschlaege.Count -eq 0) {
  Write-Host ("ALLE " + $script:Anzahl + " TESTS BESTANDEN (PowerShell " + $PSVersionTable.PSVersion + ")") -ForegroundColor Green
  exit 0
}
Write-Host ($script:Fehlschlaege.Count.ToString() + ' von ' + $script:Anzahl + ' TESTS FEHLGESCHLAGEN:') -ForegroundColor Red
foreach ($f in $script:Fehlschlaege) { Write-Host ('  - ' + $f) -ForegroundColor Red }
exit 1
