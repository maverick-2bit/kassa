# Kassa Kartenbrücke — gemeinsame Funktionen für installiere-kartenbruecke.ps1 und die Kassa-Installer
# (install.ps1 / install-offline.ps1). Nur Funktionen, beim Laden passiert nichts.
# Tests: ops/kartenbruecke/test-kartenbruecke.ps1 — Windows PowerShell 5.1.
#
# Achtung: PowerShell zählt auch typografische Anführungszeichen als Anführungszeichen. In doppelt quotierten
# Texten darum keine verwenden.

# .env lesen/schreiben ohne Kodierungsschäden (gemeinsam mit ops/lan-https.ps1)
. (Join-Path $PSScriptRoot '..\env-datei.ps1')

$KARTENBRUECKE_AUFGABE = 'Kassa Kartenbruecke'

# Version, die in einem kartenbruecke.ps1 steht ($VERSION = '2'); $null, wenn keine zu finden ist
function Lies-BrueckenVersion([string]$Skript) {
  if (-not (Test-Path -LiteralPath $Skript)) { return $null }
  $text = [System.IO.File]::ReadAllText($Skript, [System.Text.Encoding]::UTF8)
  if ($text -match '(?m)^\$VERSION = ''(\d+)''') { return $Matches[1] }
  return $null
}

# Port aus den Argumenten der geplanten Aufgabe — ein Update darf einen abweichenden Port nicht zurückstellen
function Lies-BrueckenPort([string]$Argumente, [int]$Standard) {
  if ($Argumente -match '(?:^|\s)-Port\s+(\d{1,5})(?:\s|$)') { return [int]$Matches[1] }
  return $Standard
}

function Test-KartenbrueckeInstalliert {
  return [bool](Get-ScheduledTask -TaskName $KARTENBRUECKE_AUFGABE -ErrorAction SilentlyContinue)
}

function Test-KartenleserVorhanden {
  try { return @(Get-PnpDevice -Class SmartCardReader -PresentOnly -ErrorAction Stop).Count -gt 0 } catch { return $false }
}

# Rückfrage im Installer; ohne Bedienung (Fernaufruf, umgeleitete Eingabe) immer nein
function Frage-Kartenbruecke {
  try {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $false }
    $antwort = Read-Host 'Kartenleser gefunden. Signiert diese Kassa mit einer RKSV-Signaturkarte (Stick)? Kartenbrücke einrichten? (j/N)'
    return $antwort -match '^\s*[jJyY]'
  } catch { return $false }
}

# Eigener Prozess: ein Abbruch dort beendet nie den Kassa-Installer
function Starte-BrueckenInstaller([string]$Skript, [string]$Ziel) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Skript -KassaOrdner $Ziel | Out-Host
  $code = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  return $code
}

# Schritt der Kassa-Installer (vor dem Start der Container, damit das Backend die .env-Werte gleich liest):
#   - Brücke schon eingerichtet             → mit diesem Stand aktualisieren
#   - -Neu                                  → einrichten
#   - Kartenleser steckt, noch keine Brücke → nachfragen (Standard nein)
#   - -Ohne                                 → nichts tun
# Fehler brechen die Kassa-Installation NIE ab. Ergebnis: was passiert ist (für Tests).
function Invoke-KartenbrueckeImInstaller {
  param([string]$Ziel, [switch]$Neu, [switch]$Ohne)
  if ($Ohne) { return 'uebersprungen' }
  try {
    $skript = Join-Path $Ziel 'ops\kartenbruecke\installiere-kartenbruecke.ps1'
    $da = Test-KartenbrueckeInstalliert
    if (-not $da -and -not $Neu) {
      if (-not (Test-KartenleserVorhanden)) { return 'nicht noetig' }
      if (-not (Frage-Kartenbruecke)) { return 'abgelehnt' }
    }
    if ($da) { Schritt 'Kartenbrücke (RKSV-Signaturkarte) aktualisieren' } else { Schritt 'Kartenbrücke (RKSV-Signaturkarte) einrichten' }
    $code = Starte-BrueckenInstaller $skript $Ziel
    if ($code -ne 0) { throw "Installer der Kartenbrücke meldet Fehler $code (Ausgabe oben)" }
    if ($da) { return 'aktualisiert' } else { return 'eingerichtet' }
  } catch {
    Hinweis ('Kartenbrücke: ' + $_.Exception.Message)
    Hinweis 'Die Kassa wird trotzdem installiert. Kartenbrücke nachholen: ops\kartenbruecke\LIES-MICH.md'
    return 'fehler'
  }
}
