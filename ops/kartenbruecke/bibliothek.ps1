# Kassa Kartenbrücke — gemeinsame Funktionen für installiere-kartenbruecke.ps1 und die Kassa-Installer
# (install.ps1 / install-offline.ps1). Nur Funktionen, beim Laden passiert nichts.
# Tests: ops/kartenbruecke/test-kartenbruecke.ps1 — Windows PowerShell 5.1.
#
# Achtung: PowerShell zählt auch typografische Anführungszeichen als Anführungszeichen. In doppelt quotierten
# Texten darum keine verwenden.

$KARTENBRUECKE_AUFGABE = 'Kassa Kartenbruecke'

# Werte in einer .env setzen, ohne den Rest anzufassen: Kodierung (UTF-8 mit/ohne BOM, sonst ANSI), Zeilenenden
# und alle anderen Zeilen bleiben Byte für Byte erhalten. Get-Content/Set-Content können das unter PowerShell 5.1
# nicht: eine UTF-8-Datei ohne BOM lesen sie als ANSI, ein Umlaut in einem Passwort wäre danach zerstört.
function Setze-EnvWerte {
  param([string]$Pfad, [System.Collections.IDictionary]$Werte)
  $bytes = [System.IO.File]::ReadAllBytes($Pfad)
  if ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
    throw "$Pfad ist als UTF-16 gespeichert — bitte als UTF-8 speichern und erneut ausführen."
  }
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $start = if ($bom) { 3 } else { 0 }
  $kodierung = New-Object System.Text.UTF8Encoding($false, $true)
  try { $text = $kodierung.GetString($bytes, $start, $bytes.Length - $start) }
  catch {
    $kodierung = [System.Text.Encoding]::Default
    $text = $kodierung.GetString($bytes, $start, $bytes.Length - $start)
  }
  $ende = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  # Nur am LF trennen: ein CR am Zeilenende bleibt so an seiner Zeile hängen
  $zeilen = New-Object System.Collections.Generic.List[string]
  $gesetzt = @{}
  foreach ($zeile in $text.Split([char]10)) {
    $name = $null
    if ($zeile -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $name = $Matches[1] }
    if ($name -and $Werte.Contains($name)) {
      if ($gesetzt[$name]) { continue }   # doppelte Einträge zusammenfassen
      $cr = if ($zeile.EndsWith("`r")) { "`r" } else { '' }
      $zeilen.Add($name + '=' + $Werte[$name] + $cr)
      $gesetzt[$name] = $true
    } else { $zeilen.Add($zeile) }
  }
  $neu = [string]::Join("`n", $zeilen)
  foreach ($name in $Werte.Keys) {
    if ($gesetzt[$name]) { continue }
    if ($neu.Length -gt 0 -and -not $neu.EndsWith("`n")) { $neu += $ende }
    $neu += $name + '=' + $Werte[$name] + $ende
  }
  if ($neu -ceq $text) { return }
  $inhalt = $kodierung.GetBytes($neu)
  if ($bom) { $inhalt = [byte[]]@(0xEF, 0xBB, 0xBF) + $inhalt }
  # Erst daneben schreiben, dann ersetzen (Rechte der .env bleiben): nie eine halb geschriebene .env
  $neben = $Pfad + '.kartenbruecke-neu'
  try {
    [System.IO.File]::WriteAllBytes($neben, [byte[]]$inhalt)
    [System.IO.File]::Replace($neben, $Pfad, [NullString]::Value)
  } finally {
    if (Test-Path -LiteralPath $neben) { Remove-Item -LiteralPath $neben -Force }
  }
}

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
