# =============================================================================
# Kassa POS — Fernwartung (Windows): TeamViewer Host einrichten
#
# Bibliothek: enthält NUR Funktionen und hat beim Laden KEINE Nebenwirkung.
# Wird per Dot-Sourcing geladen von
#   - install.ps1 / install-offline.ps1   (Installer-Schritt „Fernwartung")
#   - erstelle-offline-paket.ps1          (Host-Installer ins Offline-Paket legen)
#   - test-fernwartung.ps1                (Tests, ohne etwas zu installieren)
#
# Was der Schritt tut (Einstieg: Invoke-Fernwartung):
#   1. fernwartung.json lesen + prüfen (NIE im Repo; das Token ist ein Geheimnis)
#   2. TeamViewer Host still installieren, falls noch nicht vorhanden
#   3. Gerät dem TeamViewer-Konto zuordnen (Rollout-Konfiguration ODER API-Token)
#   4. Dienst + Autostart sicherstellen, TeamViewer-ID auslesen
#   5. Statusdatei schreiben (OHNE Geheimnisse) — die Kassa zeigt sie unter
#      Einstellungen → System → Fernwartung an
#
# Sicherheit: Geheimnisse (API-Token, Assignment-ID, Query-Teil der Installer-URL)
# erscheinen in KEINER Ausgabe — jede Meldung läuft durch Maskiere-Geheimnisse.
# Fehler in diesem Schritt dürfen die Kassa-Installation nie abbrechen
# (Invoke-Fernwartung wirft nicht, sondern liefert ein Ergebnisobjekt).
#
# Quellen der TeamViewer-Parameter: siehe ops/DEPLOYMENT.md, Abschnitt Fernwartung.
# Kompatibel mit Windows PowerShell 5.1 und PowerShell 7.
# =============================================================================

# Bewusst KEIN Set-StrictMode / $ErrorActionPreference auf Dateiebene: durch das
# Dot-Sourcing würde das in den Installer durchschlagen.

$script:FwDienstName   = 'TeamViewer'
$script:FwGeheimnisse  = @()

# Felder, die fernwartung.json kennt (alles andere wird als Tippfehler gemeldet;
# Felder mit führendem „_" sind Kommentare und werden ignoriert)
$script:FwBekannteFelder = @(
  'anbieter', 'hostInstallerUrl', 'msiPfad', 'signaturPruefen', 'exeArgumente',
  'customConfigId', 'einstellungsDatei', 'assignmentId', 'apiToken',
  'zuordnungsweg', 'gruppe', 'gruppeId', 'aliasVorlage',
  'assignmentRetries', 'assignmentTimeout'
)

# -----------------------------------------------------------------------------
# Ausgabe — alles läuft durch die Maskierung
# -----------------------------------------------------------------------------

function Maskiere-Geheimnisse {
  # Ersetzt bekannte Geheimnisse und — als Sicherheitsnetz — die Werte typischer
  # TeamViewer-Parameter durch ***.
  param([string]$Text, [string[]]$Geheimnisse = $script:FwGeheimnisse)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $t = $Text
  foreach ($g in @($Geheimnisse)) {
    if ($g -and $g.Length -ge 4) { $t = $t.Replace($g, '***') }
  }
  # Sicherheitsnetz: der Wert hinter APITOKEN= / ASSIGNMENTID= / --api-token / assignment --id
  # wird auch dann ersetzt, wenn er NICHT in der Geheimnisliste steht (Anführungszeichen bleiben stehen)
  foreach ($kopf in @('APITOKEN\s*=\s*', 'ASSIGNMENTID\s*=\s*', '--api-token[ =]\s*', 'assignment\s+--id[ =]\s*')) {
    $t = [regex]::Replace($t, ('(?i)(' + $kopf + '")[^"]*(")'), '${1}***${2}')
    $t = [regex]::Replace($t, ("(?i)(" + $kopf + "')[^']*(')"), '${1}***${2}')
    $t = [regex]::Replace($t, ("(?i)(" + $kopf + ")(?![`"'])\S+"), '${1}***')
  }
  return $t
}

function Fw-Schritt([string]$Text) { Write-Host ("`n==> " + (Maskiere-Geheimnisse $Text)) -ForegroundColor Cyan }
function Fw-Ok([string]$Text)      { Write-Host ('    OK: ' + (Maskiere-Geheimnisse $Text)) -ForegroundColor Green }
function Fw-Hinweis([string]$Text) { Write-Host ('    ' + (Maskiere-Geheimnisse $Text)) -ForegroundColor Yellow }
function Fw-Warnung([string]$Text) { Write-Host ('    WARNUNG: ' + (Maskiere-Geheimnisse $Text)) -ForegroundColor Yellow }
function Fw-Fehler([string]$Text)  { Write-Host ('    FEHLER: ' + (Maskiere-Geheimnisse $Text)) -ForegroundColor Red }
function Fw-Zeile([string]$Text)   { Write-Host ('    ' + (Maskiere-Geheimnisse $Text)) }

# -----------------------------------------------------------------------------
# Kleine, reine Funktionen (ohne Nebenwirkung — hier sitzen die Tests)
# -----------------------------------------------------------------------------

function Hole-Feld($Objekt, [string]$Name) {
  # Feld eines PSCustomObject oder $null — ohne Fehler bei fehlenden Feldern
  if ($null -eq $Objekt) { return $null }
  $p = $Objekt.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Format-FernwartungAlias {
  # Gerätename in der TeamViewer-Liste: Vorlage + Name zusammensetzen und von
  # allem befreien, was auf einer Kommandozeile Ärger macht (Anführungszeichen,
  # %, &, | …). Erlaubt: Buchstaben (auch Umlaute), Ziffern, Leerzeichen und . _ - ( ) # +
  param([string]$Vorlage = '{Name}', [string]$Name = '', [string]$Computername = '')
  if ([string]::IsNullOrWhiteSpace($Vorlage)) { $Vorlage = '{Name}' }
  $wert = $Name
  if ([string]::IsNullOrWhiteSpace($wert)) { $wert = $Computername }
  $roh = $Vorlage.Replace('{Name}', $wert).Replace('{name}', $wert).Replace('{Computername}', $Computername).Replace('{computername}', $Computername)
  $roh = [regex]::Replace($roh, '[^\p{L}\p{N} ._\-()#+]', ' ')
  $roh = [regex]::Replace($roh, '\s+', ' ').Trim()
  if ($roh.Length -gt 64) { $roh = $roh.Substring(0, 64).Trim() }
  if ([string]::IsNullOrWhiteSpace($roh)) {
    $roh = [regex]::Replace($Computername, '[^\p{L}\p{N} ._\-()#+]', ' ').Trim()
  }
  if ([string]::IsNullOrWhiteSpace($roh)) { $roh = 'Kassa' }
  return $roh
}

function Formatiere-TeamViewerId {
  # '123456789' → '123 456 789'; 10-stellig → '1 234 567 890' (von rechts in
  # Dreiergruppen, so zeigt es auch TeamViewer selbst an)
  param([string]$Id)
  $z = ($Id -replace '\D', '')
  if ($z.Length -eq 0) { return '' }
  $teile = New-Object System.Collections.Generic.List[string]
  while ($z.Length -gt 3) {
    $teile.Insert(0, $z.Substring($z.Length - 3))
    $z = $z.Substring(0, $z.Length - 3)
  }
  $teile.Insert(0, $z)
  return ($teile -join ' ')
}

function Konvertiere-TeamViewerId {
  # Registry-DWORD (als Int32 gelesen — IDs ≥ 2^31 kommen dort NEGATIV an) bzw.
  # Text → reine Ziffernfolge. $null, wenn das keine plausible ID ist.
  param($Wert)
  if ($null -eq $Wert) { return $null }
  $text = $null
  if ($Wert -is [int]) {
    $text = [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Wert), 0)
  } elseif ($Wert -is [long] -or $Wert -is [uint32] -or $Wert -is [uint64]) {
    $text = [string]$Wert
  } else {
    $text = ([string]$Wert) -replace '\s', ''
  }
  if ($text -match '^\d{8,12}$' -and $text -notmatch '^0+$') { return $text }
  return $null
}

function Baue-Kommandozeile {
  # Windows-Kommandozeile aus einzelnen Argumenten (Regeln von CommandLineToArgvW).
  # Argumente der Form --option=Wert mit Leerzeichen im Wert werden als
  # --option="Wert" geschrieben — genau wie in der TeamViewer-Doku
  # (--device-alias="%COMPUTERNAME% test %USERNAME%").
  param([string[]]$Argumente)
  $ausgabe = New-Object System.Collections.Generic.List[string]
  foreach ($a in @($Argumente)) {
    if ($null -eq $a) { continue }
    if ($a -ne '' -and $a -notmatch '[\s"]') { $ausgabe.Add($a); continue }
    $praefix = ''
    $wert = $a
    if ($a -match '^(--?[A-Za-z][A-Za-z0-9_\-]*=)(.*)$') { $praefix = $Matches[1]; $wert = $Matches[2] }
    # Anführungszeichen maskieren; Backslashes vor Anführungszeichen/Ende verdoppeln
    $wert = [regex]::Replace($wert, '(\\*)"', '$1$1\"')
    $wert = [regex]::Replace($wert, '(\\+)$', '$1$1')
    $ausgabe.Add($praefix + '"' + $wert + '"')
  }
  return ($ausgabe -join ' ')
}

function Typ-AusDatei {
  # 'msi' / 'exe' aus der Dateiendung, sonst $null
  param([string]$Datei)
  if (-not $Datei) { return $null }
  $ext = [System.IO.Path]::GetExtension(($Datei -split '\?')[0]).ToLowerInvariant()
  if ($ext -eq '.msi') { return 'msi' }
  if ($ext -eq '.exe') { return 'exe' }
  return $null
}

function Baue-MsiEigenschaft {
  # NAME="Wert" — msiexec liest Eigenschaften mit eigener Syntax (Anführungszeichen
  # NACH dem Gleichheitszeichen). Wert darf selbst kein Anführungszeichen enthalten.
  param([string]$Name, [string]$Wert)
  if ($Wert.Contains('"')) { throw "Wert für $Name enthält ein Anführungszeichen." }
  return ($Name + '="' + $Wert + '"')
}

function Pruefe-FernwartungKonfig {
  # Prüft das aus fernwartung.json gelesene Objekt und liefert
  #   @{ Konfig = <normalisiertes Objekt>; Fehler = string[]; Warnungen = string[] }
  # Meldungen enthalten NIE Werte der Felder — nur deren Namen.
  param($Roh, [string]$Verzeichnis = '.')

  $fehler = New-Object System.Collections.Generic.List[string]
  $warn   = New-Object System.Collections.Generic.List[string]

  if ($null -eq $Roh -or $Roh -isnot [System.Management.Automation.PSCustomObject]) {
    $fehler.Add('Die Datei muss ein JSON-Objekt { ... } enthalten.')
    return [pscustomobject]@{ Konfig = $null; Fehler = @($fehler); Warnungen = @($warn) }
  }

  foreach ($p in $Roh.PSObject.Properties) {
    if ($p.Name.StartsWith('_')) { continue }
    if ($script:FwBekannteFelder -notcontains $p.Name) {
      $warn.Add("Unbekanntes Feld '" + $p.Name + "' wird ignoriert (Tippfehler?).")
    }
    # Platzhalter aus fernwartung.example.json, die niemand ersetzt hat
    if ($p.Value -is [string] -and $p.Value -match '(?i)ERSETZEN|BEISPIEL-') {
      $fehler.Add("Feld '" + $p.Name + "' enthält noch den Platzhalter aus der Beispieldatei — durch den echten Wert ersetzen oder das Feld löschen.")
    }
  }

  function Text-Feld($name) {
    $w = Hole-Feld $Roh $name
    if ($null -eq $w) { return $null }
    # Zahlen ohne Anführungszeichen (z. B. "gruppeId": 12345678) sind verzeihlich
    if ($w -is [int] -or $w -is [long] -or $w -is [double]) { $w = [string]$w }
    if ($w -isnot [string]) { $fehler.Add("Feld '$name' muss Text sein."); return $null }
    $w = $w.Trim()
    if ($w -eq '') { return $null }
    return $w
  }
  function Pfad-Aufloesen($p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    if ($p.Contains('"')) { $fehler.Add('Pfadangaben dürfen kein Anführungszeichen enthalten.'); return $null }
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $Verzeichnis $p)
  }

  $anbieter = Text-Feld 'anbieter'
  if (-not $anbieter) { $anbieter = 'teamviewer' }
  if ($anbieter.ToLowerInvariant() -ne 'teamviewer') {
    $fehler.Add("Anbieter '" + $anbieter + "' wird nicht unterstützt (nur 'teamviewer').")
  }

  # Installer: lokale Datei ODER URL
  $url = Text-Feld 'hostInstallerUrl'
  $geheimnisse = New-Object System.Collections.Generic.List[string]
  if ($url) {
    if ($url -notmatch '^https://[^\s"]+$') { $fehler.Add("Feld 'hostInstallerUrl' muss eine https://-Adresse sein."); $url = $null }
    elseif ($url.Contains('?')) {
      # Query-Teil kann ein Zugriffsschlüssel sein (z. B. vorsignierte Download-Links)
      $geheimnisse.Add($url.Substring($url.IndexOf('?')))
    }
  }
  $installerPfad = Pfad-Aufloesen (Text-Feld 'msiPfad')
  $einstellungen = Pfad-Aufloesen (Text-Feld 'einstellungsDatei')

  $signatur = Hole-Feld $Roh 'signaturPruefen'
  if ($null -eq $signatur) { $signatur = $true }
  if ($signatur -isnot [bool]) { $fehler.Add("Feld 'signaturPruefen' muss true oder false sein."); $signatur = $true }

  $exeArgs = @('/S')
  $exeRoh = Hole-Feld $Roh 'exeArgumente'
  if ($null -ne $exeRoh) {
    if ($exeRoh -is [string]) { $exeRoh = @($exeRoh) }
    $exeArgs = @($exeRoh | ForEach-Object { [string]$_ })
    foreach ($a in $exeArgs) {
      if ($a -notmatch '^[A-Za-z0-9/_=.:\\ -]*$' -or $a.Contains('"')) { $fehler.Add("Feld 'exeArgumente' enthält unzulässige Zeichen."); break }
    }
  }

  # Kennungen — nur Zeichen, die auf keiner Kommandozeile Ärger machen
  $customId = Text-Feld 'customConfigId'
  if ($customId -and $customId -notmatch '^[A-Za-z0-9_\-]{3,64}$') { $fehler.Add("Feld 'customConfigId' hat ein unerwartetes Format."); $customId = $null }

  $assignmentId = Text-Feld 'assignmentId'
  if ($assignmentId) {
    if ($assignmentId -notmatch '^[A-Za-z0-9_\-=+/]{16,512}$') { $fehler.Add("Feld 'assignmentId' hat ein unerwartetes Format."); $assignmentId = $null }
    else { $geheimnisse.Add($assignmentId) }
  }
  $apiToken = Text-Feld 'apiToken'
  if ($apiToken) {
    if ($apiToken -notmatch '^[A-Za-z0-9_\-.]{8,200}$') { $fehler.Add("Feld 'apiToken' hat ein unerwartetes Format."); $apiToken = $null }
    else { $geheimnisse.Add($apiToken) }
  }

  # Zuordnung
  $weg = Text-Feld 'zuordnungsweg'
  if (-not $weg) { $weg = 'cli' }
  $weg = $weg.ToLowerInvariant()
  if ($weg -ne 'cli' -and $weg -ne 'msi') { $fehler.Add("Feld 'zuordnungsweg' muss 'cli' oder 'msi' sein."); $weg = 'cli' }

  $modus = 'keine'
  if ($assignmentId) { $modus = 'assignmentId' }
  elseif ($apiToken) { $modus = 'apiToken' }
  if ($assignmentId -and $apiToken) {
    $warn.Add("Sowohl 'assignmentId' als auch 'apiToken' gesetzt — es gilt die Rollout-Konfiguration (assignmentId); den apiToken entfernen oder leeren.")
  }
  if ($modus -eq 'keine') {
    $warn.Add("Weder 'assignmentId' noch 'apiToken' gesetzt — TeamViewer wird nur installiert und muss danach von Hand dem Konto zugeordnet werden.")
  }

  $gruppe = Text-Feld 'gruppe'
  if ($gruppe -and $gruppe -notmatch '^[\p{L}\p{N} ._\-()#+]{1,64}$') { $fehler.Add("Feld 'gruppe' enthält unzulässige Zeichen (erlaubt: Buchstaben, Ziffern, Leerzeichen, . _ - ( ) # +)."); $gruppe = $null }
  $gruppeId = Text-Feld 'gruppeId'
  if ($gruppeId) {
    if ($gruppeId -match '^g?\d{3,15}$') { $gruppeId = 'g' + ($gruppeId -replace '^g', '') }
    else { $fehler.Add("Feld 'gruppeId' hat ein unerwartetes Format (erwartet: g12345678)."); $gruppeId = $null }
  }
  if ($modus -eq 'assignmentId' -and ($gruppeId -or $gruppe)) {
    $warn.Add("In der Rollout-Konfiguration legt TeamViewer die Gerätegruppe fest — 'gruppe'/'gruppeId' dienen hier nur der Anzeige in der Kassa.")
  }

  $vorlage = Text-Feld 'aliasVorlage'
  if (-not $vorlage) { $vorlage = '{Name}' }

  $retries = Hole-Feld $Roh 'assignmentRetries'
  if ($null -eq $retries) { $retries = 20 }
  if ($retries -isnot [int] -and $retries -isnot [long]) { $fehler.Add("Feld 'assignmentRetries' muss eine Zahl sein."); $retries = 20 }
  elseif ($retries -lt 0 -or $retries -gt 600) { $fehler.Add("Feld 'assignmentRetries' muss zwischen 0 und 600 liegen."); $retries = 20 }
  $timeout = Hole-Feld $Roh 'assignmentTimeout'
  if ($null -eq $timeout) { $timeout = 120 }
  if ($timeout -isnot [int] -and $timeout -isnot [long]) { $fehler.Add("Feld 'assignmentTimeout' muss eine Zahl sein."); $timeout = 120 }
  elseif ($timeout -lt 10 -or $timeout -gt 3600) { $fehler.Add("Feld 'assignmentTimeout' muss zwischen 10 und 3600 Sekunden liegen."); $timeout = 120 }

  # Typ des Installers aus der Endung (Pfad bzw. URL ohne Query)
  $typQuelle = $installerPfad
  if (-not $typQuelle -and $url) { $typQuelle = ($url -split '\?')[0] }
  $typ = $null
  if ($typQuelle) {
    $ext = [System.IO.Path]::GetExtension($typQuelle).ToLowerInvariant()
    if ($ext -eq '.msi') { $typ = 'msi' }
    elseif ($ext -eq '.exe') { $typ = 'exe' }
    else { $fehler.Add("Der Installer muss eine .msi- oder .exe-Datei sein.") }
  }
  if ($typ -eq 'exe' -and $customId) {
    $warn.Add("'customConfigId' gilt nur für die MSI — beim EXE-Installer wird sie ignoriert.")
  }
  if ($typ -eq 'exe' -and $weg -eq 'msi') {
    $warn.Add("'zuordnungsweg': 'msi' gibt es nur mit MSI-Installer — es wird 'cli' verwendet.")
    $weg = 'cli'
  }
  if ($weg -eq 'msi' -and $modus -eq 'assignmentId') {
    $warn.Add("Mit 'zuordnungsweg': 'msi' wird der Gerätename NICHT übernommen (nur 'cli' kennt --device-alias) und der Erfolg der Zuordnung lässt sich nicht prüfen.")
  } elseif ($weg -eq 'msi' -and $modus -eq 'apiToken') {
    $warn.Add("Mit 'zuordnungsweg': 'msi' lässt sich der Erfolg der Zuordnung nicht prüfen — im TeamViewer-Konto kontrollieren.")
  }

  $konfig = [pscustomobject]@{
    Anbieter          = 'teamviewer'
    Verzeichnis       = $Verzeichnis
    InstallerPfad     = $installerPfad
    InstallerUrl      = $url
    InstallerTyp      = $typ
    SignaturPruefen   = [bool]$signatur
    ExeArgumente      = @($exeArgs)
    CustomConfigId    = $customId
    EinstellungsDatei = $einstellungen
    Modus             = $modus
    AssignmentId      = $assignmentId
    ApiToken          = $apiToken
    Zuordnungsweg     = $weg
    Gruppe            = $gruppe
    GruppeId          = $gruppeId
    AliasVorlage      = $vorlage
    Retries           = [int]$retries
    Timeout           = [int]$timeout
    Geheimnisse       = @($geheimnisse | Where-Object { $_ })
  }
  return [pscustomobject]@{ Konfig = $konfig; Fehler = @($fehler); Warnungen = @($warn) }
}

function Lese-FernwartungKonfig {
  # Liest fernwartung.json. Gibt NIE den Dateiinhalt oder Teile davon aus (das
  # Token steht darin) — auch nicht in Fehlermeldungen des JSON-Parsers.
  param([Parameter(Mandatory)][string]$Pfad)
  if (-not (Test-Path -LiteralPath $Pfad -PathType Leaf)) {
    return [pscustomobject]@{ Konfig = $null; Fehler = @('Konfigurationsdatei nicht gefunden: ' + $Pfad); Warnungen = @() }
  }
  $vollPfad = (Resolve-Path -LiteralPath $Pfad).ProviderPath
  $roh = $null
  try {
    $text = Get-Content -LiteralPath $vollPfad -Raw -Encoding UTF8
    $roh  = $text | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      Konfig = $null
      Fehler = @('fernwartung.json ist kein gültiges JSON (Komma, Anführungszeichen oder Klammer prüfen — am einfachsten in VS Code öffnen, dort wird die Stelle markiert).')
      Warnungen = @()
    }
  }
  $ergebnis = Pruefe-FernwartungKonfig -Roh $roh -Verzeichnis (Split-Path -Parent $vollPfad)
  if ($ergebnis.Konfig) { $script:FwGeheimnisse = @($ergebnis.Konfig.Geheimnisse) }
  return $ergebnis
}

function Neuer-FernwartungsPlan {
  # Baut die geplanten Schritte — OHNE etwas auszuführen. Jeder Schritt hat
  #   Datei, ArgumentString (für den echten Aufruf, enthält ggf. das Geheimnis)
  #   Anzeige (maskiert, nur dafür zum Ausgeben bestimmt).
  # Umgebung: @{ Installiert = $bool; InstallerDatei = 'C:\...'; TeamViewerExe = '...';
  #              LogDatei = '...'; NeuZuordnen = $bool;
  #              ZuordnungErledigt = $bool   (laut früherer Statusdatei schon zugeordnet)
  #              Offline = $bool }           (Zuordnung vormerken statt jetzt ausführen)
  param($Konfig, [string]$Alias, [hashtable]$Umgebung = @{})

  $installiert = [bool]$Umgebung['Installiert']
  $neu         = [bool]$Umgebung['NeuZuordnen']
  $erledigt    = [bool]$Umgebung['ZuordnungErledigt']
  $vormerken   = [bool]$Umgebung['Offline']
  $tvExe       = [string]$Umgebung['TeamViewerExe']
  if (-not $tvExe) { $tvExe = 'C:\Program Files\TeamViewer\TeamViewer.exe' }
  $installerDatei = [string]$Umgebung['InstallerDatei']
  if (-not $installerDatei) { $installerDatei = [string]$Konfig.InstallerPfad }
  if (-not $installerDatei) { $installerDatei = '<TeamViewer-Installer>' }
  $logDatei = [string]$Umgebung['LogDatei']

  $schritte = New-Object System.Collections.Generic.List[object]
  $zuordnungImMsi = $false

  # --- 1. Installation ---------------------------------------------------------
  if (-not $installiert) {
    if ($Konfig.InstallerTyp -eq 'exe') {
      $argText = (Baue-Kommandozeile $Konfig.ExeArgumente)
      $schritte.Add([pscustomobject]@{
        Id = 'installieren'; Beschreibung = 'TeamViewer Host still installieren (EXE)'
        Datei = $installerDatei; ArgumentString = $argText
      })
    } else {
      $teile = New-Object System.Collections.Generic.List[string]
      $teile.Add('/i'); $teile.Add('"' + $installerDatei + '"'); $teile.Add('/qn'); $teile.Add('/norestart')
      if ($Konfig.CustomConfigId)    { $teile.Add((Baue-MsiEigenschaft 'CUSTOMCONFIGID' $Konfig.CustomConfigId)) }
      if ($Konfig.EinstellungsDatei) { $teile.Add((Baue-MsiEigenschaft 'SETTINGSFILE' $Konfig.EinstellungsDatei)) }

      if ($Konfig.Zuordnungsweg -eq 'msi' -and $Konfig.Modus -ne 'keine') {
        # Einschritt-Variante laut TeamViewer-Doku: Zuordnung direkt über MSI-Eigenschaften
        $zuordnungImMsi = $true
        if ($Konfig.Modus -eq 'assignmentId') {
          $teile.Add((Baue-MsiEigenschaft 'ASSIGNMENTID' $Konfig.AssignmentId))
        } else {
          $teile.Add((Baue-MsiEigenschaft 'APITOKEN' $Konfig.ApiToken))
          $opt = New-Object System.Collections.Generic.List[string]
          # Einfache Anführungszeichen im Wert: so beschreibt es TeamViewer für ASSIGNMENTOPTIONS
          $opt.Add("--alias '" + $Alias + "'")
          if ($Konfig.GruppeId)    { $opt.Add('--group-id ' + $Konfig.GruppeId) }
          elseif ($Konfig.Gruppe)  { $opt.Add("--group '" + $Konfig.Gruppe + "'") }
          $opt.Add('--grant-easy-access')
          if ($neu) { $opt.Add('--reassign') }
          $teile.Add((Baue-MsiEigenschaft 'ASSIGNMENTOPTIONS' ($opt -join ' ')))
        }
      } elseif ($logDatei) {
        # Ausführliches MSI-Log nur, wenn kein Geheimnis auf der Kommandozeile steht
        $teile.Add('/L*v'); $teile.Add('"' + $logDatei + '"')
      }
      $schritte.Add([pscustomobject]@{
        Id = 'installieren'; Beschreibung = 'TeamViewer Host still installieren (MSI)'
        Datei = 'msiexec.exe'; ArgumentString = ($teile -join ' ')
      })
    }
  }

  # --- 2. Zuordnung per TeamViewer-Kommandozeile ---------------------------------
  $brauchtZuordnung = ($Konfig.Modus -ne 'keine') -and (-not $erledigt) -and ((-not $zuordnungImMsi) -or $installiert)
  if ($brauchtZuordnung) {
    if ($Konfig.Modus -eq 'assignmentId') {
      # Aktueller Weg laut TeamViewer-Doku (Rollout-Konfiguration)
      $a = New-Object System.Collections.Generic.List[string]
      $a.Add('assignment'); $a.Add('--id'); $a.Add($Konfig.AssignmentId)
      $a.Add('--device-alias=' + $Alias)
      if ($vormerken) {
        # --offline: TeamViewer merkt sich die Zuordnung und führt sie aus, sobald das Gerät online ist
        $a.Add('--offline')
      } else {
        $a.Add('--retries=' + $Konfig.Retries); $a.Add('--timeout=' + $Konfig.Timeout)
      }
      if ($neu) { $a.Add('--reassign') }
      $schritte.Add([pscustomobject]@{
        Id = 'zuordnen'; Beschreibung = 'Gerät der Rollout-Konfiguration zuordnen (TeamViewer.exe assignment)'
        Datei = $tvExe; ArgumentString = (Baue-Kommandozeile @($a))
      })
    } else {
      # Älterer Weg (API-Token): TeamViewer.exe assign
      $a = New-Object System.Collections.Generic.List[string]
      $a.Add('assign'); $a.Add('--api-token'); $a.Add($Konfig.ApiToken)
      $a.Add('--alias'); $a.Add($Alias)
      if ($Konfig.GruppeId)   { $a.Add('--group-id'); $a.Add($Konfig.GruppeId) }
      elseif ($Konfig.Gruppe) { $a.Add('--group');    $a.Add($Konfig.Gruppe) }
      $a.Add('--grant-easy-access')
      if ($neu) { $a.Add('--reassign') }
      $schritte.Add([pscustomobject]@{
        Id = 'zuordnen'; Beschreibung = 'Gerät dem Konto zuordnen (TeamViewer.exe assign, API-Token)'
        Datei = $tvExe; ArgumentString = (Baue-Kommandozeile @($a))
      })
    }
  }

  # Anzeige-Text: nie das Geheimnis, nie Klartext des Aufrufs — nur die maskierte Fassung
  $geheim = @($Konfig.Geheimnisse)
  foreach ($s in $schritte) {
    $anzeige = $s.Datei
    if ($anzeige -match '\s') { $anzeige = '"' + $anzeige + '"' }
    if ($s.ArgumentString) { $anzeige = $anzeige + ' ' + $s.ArgumentString }
    $s | Add-Member -NotePropertyName Anzeige -NotePropertyValue (Maskiere-Geheimnisse $anzeige $geheim) -Force
  }
  return [pscustomobject]@{
    Modus          = $Konfig.Modus
    Weg            = $Konfig.Zuordnungsweg
    Alias          = $Alias
    ZuordnungImMsi = $zuordnungImMsi
    Schritte       = $schritte.ToArray()   # (@($liste) mit List[object] löst in PowerShell 7 einen Binder-Fehler aus)
  }
}

function ConvertTo-FwJsonText($Text) {
  # JSON-String, rein ASCII (Nicht-ASCII als \uXXXX): übersteht jede Kodierung
  # unterwegs (PowerShell-Pipeline, docker exec) unbeschadet. $null → null
  # (bewusst ohne [string]-Typ: der würde $null zu '' machen).
  if ($null -eq $Text) { return 'null' }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($c in ([string]$Text).ToCharArray()) {
    $code = [int]$c
    switch ($c) {
      '"'  { [void]$sb.Append('\"'); continue }
      '\'  { [void]$sb.Append('\\'); continue }
      default {
        if ($code -lt 32 -or $code -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($c) }
      }
    }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Neuer-FernwartungStatus {
  # Inhalt der Statusdatei, die die Kassa anzeigt. ENTHÄLT KEIN GEHEIMNIS —
  # nur ID, Gerätename, Gruppe und Zeitpunkt.
  param(
    [Parameter(Mandatory)][string]$Id,
    [string]$Alias,
    [string]$Gruppe,
    [string]$InstalliertAm
  )
  if (-not $InstalliertAm) { $InstalliertAm = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
  $felder = @(
    ('"anbieter":'      + (ConvertTo-FwJsonText 'teamviewer')),
    ('"id":'            + (ConvertTo-FwJsonText $Id)),
    ('"alias":'         + (ConvertTo-FwJsonText $(if ($Alias)  { $Alias }  else { $null }))),
    ('"gruppe":'        + (ConvertTo-FwJsonText $(if ($Gruppe) { $Gruppe } else { $null }))),
    ('"installiertAm":' + (ConvertTo-FwJsonText $InstalliertAm))
  )
  return ('{' + ($felder -join ',') + '}')
}

function Lese-FernwartungStatusText {
  # Felder aus dem Text einer Statusdatei (id, alias, gruppe, installiertAm) oder $null.
  # Bewusst per Regex statt ConvertFrom-Json: PowerShell 7 macht aus dem Zeitstempel
  # sonst ein DateTime-Objekt und verändert dabei das Format.
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  function Hole([string]$feld) {
    $m = [regex]::Match($Text, '"' + $feld + '"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $m.Success) { return $null }
    $w = $m.Groups[1].Value
    try { $w = [regex]::Unescape($w) } catch { }
    return $w
  }
  $id = Hole 'id'
  if (-not $id -or $id -notmatch '^\d{6,12}$') { return $null }
  return [pscustomobject]@{ id = $id; alias = (Hole 'alias'); gruppe = (Hole 'gruppe'); installiertAm = (Hole 'installiertAm') }
}

function Lese-FernwartungStatusDatei {
  # Liest eine früher geschriebene Statusdatei (für Idempotenz: Zeitpunkt der
  # Erstinstallation, bisheriger Gerätename, schon zugeordnet?). $null, wenn nicht lesbar.
  param([string]$Pfad)
  try {
    if (-not $Pfad -or -not (Test-Path -LiteralPath $Pfad -PathType Leaf)) { return $null }
    return (Lese-FernwartungStatusText (Get-Content -LiteralPath $Pfad -Raw -Encoding UTF8))
  } catch { return $null }
}

# -----------------------------------------------------------------------------
# Zugriff auf das System (Windows) — nicht Teil der Unit-Tests, sondern per
# Funktions-Ersatz im Test-Skript simuliert
# -----------------------------------------------------------------------------

function Teste-Administrator {
  try {
    return ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Get-TeamViewerInstallation {
  # Ist TeamViewer (Host oder Vollversion) installiert? Der Windows-Dienst heißt
  # in beiden Fällen „TeamViewer".
  $erg = [pscustomobject]@{ Installiert = $false; ExePfad = $null; Version = $null; DienstStatus = $null; DienstStart = $null }
  try {
    $dienst = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $script:FwDienstName + "'") -ErrorAction Stop
  } catch { $dienst = $null }
  if ($dienst) {
    $erg.Installiert  = $true
    $erg.DienstStatus = [string]$dienst.State
    $erg.DienstStart  = [string]$dienst.StartMode
    if ($dienst.PathName -match '^\s*"?([^"]+?\\)[^\\"]+\.exe') {
      $kandidat = Join-Path $Matches[1] 'TeamViewer.exe'
      if (Test-Path -LiteralPath $kandidat) { $erg.ExePfad = $kandidat }
    }
  }
  # Registry: 64-Bit-Client → HKLM\SOFTWARE\TeamViewer, 32-Bit-Client → WOW6432Node
  foreach ($k in @('HKLM:\SOFTWARE\TeamViewer', 'HKLM:\SOFTWARE\WOW6432Node\TeamViewer')) {
    try {
      if (-not (Test-Path -LiteralPath $k)) { continue }
      $key = Get-Item -LiteralPath $k
      $v = $key.GetValue('Version', $null); if ($v -and -not $erg.Version) { $erg.Version = ([string]$v).Trim() }
      $d = $key.GetValue('InstallationDirectory', $null)
      if ($d -and -not $erg.ExePfad) {
        $kandidat = Join-Path ([string]$d) 'TeamViewer.exe'
        if (Test-Path -LiteralPath $kandidat) { $erg.ExePfad = $kandidat }
      }
    } catch { }
  }
  if (-not $erg.ExePfad) {
    foreach ($basis in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
      if (-not $basis) { continue }
      $kandidat = Join-Path $basis 'TeamViewer\TeamViewer.exe'
      if (Test-Path -LiteralPath $kandidat) { $erg.ExePfad = $kandidat; break }
    }
  }
  if ($erg.ExePfad) { $erg.Installiert = $true }
  return $erg
}

function Get-TeamViewerId {
  # TeamViewer-ID aus der Registry (Wert „ClientID", DWORD). Der Schlüssel hängt
  # von der Bitness des Clients ab (an einem 64-Bit-Client 15.82 nachgemessen:
  # HKLM\SOFTWARE\TeamViewer; 32-Bit-Clients: WOW6432Node) — deshalb beide prüfen.
  foreach ($k in @('HKLM:\SOFTWARE\TeamViewer', 'HKLM:\SOFTWARE\WOW6432Node\TeamViewer')) {
    try {
      if (-not (Test-Path -LiteralPath $k)) { continue }
      $id = Konvertiere-TeamViewerId ((Get-Item -LiteralPath $k).GetValue('ClientID', $null))
      if ($id) { return $id }
    } catch { }
  }
  return $null
}

function Warte-Auf {
  # Wartet, bis die Bedingung wahr ist (true) oder die Zeit abläuft.
  param([scriptblock]$Bedingung, [int]$Sekunden = 60, [int]$Takt = 2)
  $bis = (Get-Date).AddSeconds($Sekunden)
  while ((Get-Date) -lt $bis) {
    $ok = $false
    try { $ok = [bool](& $Bedingung) } catch { $ok = $false }
    if ($ok) { return $true }
    Start-Sleep -Seconds $Takt
  }
  return $false
}

function Invoke-FwProzess {
  # Startet ein Programm, wartet (mit Zeitlimit) und liefert Exit-Code + Ausgabe.
  # Ausgabe wird abgefangen, damit nichts Unmaskiertes in der Konsole landet.
  param([string]$Datei, [string]$ArgumentString = '', [int]$TimeoutSekunden = 600, [string]$Arbeitsverzeichnis = '')
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName               = $Datei
  $psi.Arguments              = $ArgumentString
  $psi.UseShellExecute        = $false
  $psi.CreateNoWindow         = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  if ($Arbeitsverzeichnis) { $psi.WorkingDirectory = $Arbeitsverzeichnis }
  $p = [System.Diagnostics.Process]::Start($psi)
  $tOut = $p.StandardOutput.ReadToEndAsync()
  $tErr = $p.StandardError.ReadToEndAsync()
  $fertig = $p.WaitForExit($TimeoutSekunden * 1000)
  if (-not $fertig) {
    try { $p.Kill() } catch { }
    return [pscustomobject]@{ ExitCode = -9999; Zeitueberschreitung = $true; Ausgabe = '' }
  }
  $p.WaitForExit()
  # Nur kurz auf die Ausgabe warten: startet der Installer einen Dienst, der die
  # Pipe geerbt hat, würde ReadToEnd sonst ewig blockieren.
  $aus = ''
  try {
    [void]$tOut.Wait(3000); [void]$tErr.Wait(1000)
    if ($tOut.IsCompleted) { $aus += [string]$tOut.Result }
    if ($tErr.IsCompleted) { $aus += "`n" + [string]$tErr.Result }
    $aus = $aus.Trim()
  } catch { }
  return [pscustomobject]@{ ExitCode = [int]$p.ExitCode; Zeitueberschreitung = $false; Ausgabe = $aus }
}

function Pruefe-InstallerSignatur {
  # Der Installer läuft mit Administratorrechten — nur ausführen, wenn er gültig
  # signiert ist UND von TeamViewer stammt.
  param([string]$Datei)
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $Datei -ErrorAction Stop
  } catch {
    return [pscustomobject]@{ Gueltig = $false; Grund = 'Signaturprüfung nicht möglich.' }
  }
  if ($sig.Status -ne 'Valid') {
    return [pscustomobject]@{ Gueltig = $false; Grund = ('Digitale Signatur ist nicht gültig (Status: ' + $sig.Status + ').') }
  }
  $inhaber = ''
  if ($sig.SignerCertificate) { $inhaber = [string]$sig.SignerCertificate.Subject }
  if ($inhaber -notmatch 'TeamViewer') {
    return [pscustomobject]@{ Gueltig = $false; Grund = 'Die Datei ist nicht von TeamViewer signiert.' }
  }
  return [pscustomobject]@{ Gueltig = $true; Grund = '' }
}

function Anzeige-Url([string]$Url) {
  # URL ohne Query-Teil (kann einen Zugriffsschlüssel enthalten)
  if (-not $Url) { return '' }
  return ($Url -split '\?')[0]
}

function Finde-FernwartungInstaller {
  # Sucht die Installer-Datei: Pfad aus der Konfiguration → sonst Standardnamen neben
  # der Konfiguration. $null, wenn keine lokale Datei vorhanden ist.
  param($Konfig)
  if ($Konfig.InstallerPfad) {
    if (Test-Path -LiteralPath $Konfig.InstallerPfad -PathType Leaf) { return $Konfig.InstallerPfad }
    # Offline-Paket: der Pfad aus der Konfiguration (z. B. D:\tv\x.msi) gibt es auf dem Ziel-PC
    # nicht — dieselbe Datei liegt aber neben der Konfiguration
    if ($Konfig.Verzeichnis) {
      $gleichnamig = Join-Path $Konfig.Verzeichnis (Split-Path -Leaf $Konfig.InstallerPfad)
      if (Test-Path -LiteralPath $gleichnamig -PathType Leaf) { return $gleichnamig }
    }
    return $null
  }
  if ($Konfig.Verzeichnis -and (Test-Path -LiteralPath $Konfig.Verzeichnis -PathType Container)) {
    foreach ($muster in @('TeamViewer_Host.msi', 'TeamViewer_Host*.msi', 'TeamViewer_Host_Setup*.exe', 'TeamViewer_Host*.exe')) {
      $f = Get-ChildItem -LiteralPath $Konfig.Verzeichnis -Filter $muster -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($f) { return $f.FullName }
    }
  }
  return $null
}

function Hole-FernwartungInstaller {
  # Liefert den Pfad zur Installer-Datei — lokal vorhanden oder per Download in ein
  # Temp-Verzeichnis. Prüft auf Wunsch die Signatur. Wirft bei Fehlern.
  # Ergebnis: @{ Pfad; Temporaer }
  param($Konfig, [string]$ZielVerzeichnis = '')
  $datei = Finde-FernwartungInstaller $Konfig
  $temporaer = $false
  if (-not $datei) {
    if (-not $Konfig.InstallerUrl) {
      if ($Konfig.InstallerPfad) { throw ('Installer-Datei nicht gefunden: ' + $Konfig.InstallerPfad) }
      throw "Keine Installer-Datei: in fernwartung.json 'msiPfad' oder 'hostInstallerUrl' angeben (oder TeamViewer_Host.msi neben die Konfiguration legen)."
    }
    $ordner = $ZielVerzeichnis
    if (-not $ordner) { $ordner = Join-Path $env:TEMP ('kassa-fernwartung-' + [guid]::NewGuid().ToString('N')) }
    New-Item -ItemType Directory -Path $ordner -Force | Out-Null
    $name = [System.IO.Path]::GetFileName(($Konfig.InstallerUrl -split '\?')[0])
    if (-not $name) { $name = 'TeamViewer_Host.' + $(if ($Konfig.InstallerTyp) { $Konfig.InstallerTyp } else { 'exe' }) }
    $datei = Join-Path $ordner $name
    Fw-Hinweis ('Lade ' + (Anzeige-Url $Konfig.InstallerUrl) + ' …')
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
    $vorher = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Konfig.InstallerUrl -OutFile $datei -UseBasicParsing -ErrorAction Stop }
    catch { throw ('Download fehlgeschlagen: ' + (Anzeige-Url $Konfig.InstallerUrl)) }
    finally { $ProgressPreference = $vorher }
    $temporaer = $true
  }
  if ($Konfig.SignaturPruefen) {
    $s = Pruefe-InstallerSignatur $datei
    if (-not $s.Gueltig) {
      if ($temporaer) { Remove-Item -LiteralPath $datei -Force -ErrorAction SilentlyContinue }
      throw ('Installer wird NICHT ausgeführt: ' + $s.Grund + " (Mit 'signaturPruefen': false in fernwartung.json abschaltbar — nur für eigene, bewusst umgepackte Installer.)")
    }
  }
  return [pscustomobject]@{ Pfad = $datei; Temporaer = $temporaer }
}

function Sichere-TeamViewerDienst {
  # Dienst läuft und startet mit Windows (Automatisch). Liefert $true, wenn beides stimmt.
  $dienst = Get-Service -Name $script:FwDienstName -ErrorAction SilentlyContinue
  if (-not $dienst) { return $false }
  try {
    $cim = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $script:FwDienstName + "'") -ErrorAction Stop
    if ($cim.StartMode -ne 'Auto') {
      Set-Service -Name $script:FwDienstName -StartupType Automatic -ErrorAction Stop
    }
  } catch { return $false }
  if ($dienst.Status -ne 'Running') {
    try { Start-Service -Name $script:FwDienstName -ErrorAction Stop } catch { return $false }
  }
  return (Warte-Auf { (Get-Service -Name $script:FwDienstName).Status -eq 'Running' } 60 2)
}

function Schreibe-FernwartungStatusDatei {
  param([string]$Pfad, [string]$Json)
  $ordner = Split-Path -Parent $Pfad
  if ($ordner -and -not (Test-Path -LiteralPath $ordner)) { New-Item -ItemType Directory -Path $ordner -Force | Out-Null }
  # UTF-8 ohne BOM (Inhalt ist ohnehin reines ASCII)
  [System.IO.File]::WriteAllText($Pfad, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

function Veroeffentliche-FernwartungStatus {
  # Legt die Statusdatei in das Kontroll-Volume der Kassa (/control, dasselbe, über
  # das schon Updater und Backend sprechen). Der Updater-Container läuft als root und
  # hat das Volume gemountet — der Windows-Host kommt an ein benanntes Docker-Volume
  # nicht direkt heran. Das Backend liest die Datei nur.
  # Braucht laufende Container (nach „docker compose up"); NIE fatal.
  param([string]$Json, [string]$Ziel, [int]$Versuche = 8, [int]$Pause = 3)
  # Nur reines ASCII: übersteht die Pipeline nach docker unbeschadet (die Datei wird so geschrieben)
  if ($Json -notmatch '^[\x20-\x7E]+$') { return $false }
  # Alles mit && verkettet: bricht der Schreibvorgang ab, wird NICHTS umbenannt (keine halbe Datei)
  $nachlauf = ' && chmod 644 /control/fernwartung-status.json.tmp' +
              ' && (chown 1000:1000 /control/fernwartung-status.json.tmp 2>/dev/null || true)' +
              ' && mv /control/fernwartung-status.json.tmp /control/fernwartung-status.json'
  # Weg A: JSON über stdin (wie in install.sh). Weg B (Rückfall): als Base64-Argument — falls
  # stdin über die Docker-/PowerShell-Kombination nicht ankommt.
  $skriptA = 'cat > /control/fernwartung-status.json.tmp' + $nachlauf
  $skriptB = 'echo ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($Json)) + ' | base64 -d > /control/fernwartung-status.json.tmp' + $nachlauf
  Push-Location -LiteralPath $Ziel
  try {
    for ($i = 1; $i -le $Versuche; $i++) {
      $geschafft = $false
      $vorher = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try {
        $Json | docker compose exec -T updater sh -c $skriptA 2>&1 | Out-Null
        $geschafft = ($LASTEXITCODE -eq 0)
        if (-not $geschafft) {
          docker compose exec -T updater sh -c $skriptB 2>&1 | Out-Null
          $geschafft = ($LASTEXITCODE -eq 0)
        }
      } catch { $geschafft = $false }
      $ErrorActionPreference = $vorher
      if ($geschafft) { return $true }
      Start-Sleep -Seconds $Pause
    }
  } finally { Pop-Location }
  return $false
}

# Bedeutung der Exit-Codes von „TeamViewer.exe assignment" laut TeamViewer-Doku
function Beschreibe-ZuordnungsFehler {
  param([int]$Code)
  switch ($Code) {
    1   { return 'ungültige Kommandozeilen-Argumente' }
    2   { return 'Signaturprüfung fehlgeschlagen' }
    3   { return 'TeamViewer ist nicht installiert' }
    4   { return 'Dienst-Konfiguration nicht erreichbar — später erneut versuchen' }
    { $_ -in 40, 400 } { return 'ungültiges Argument — Assignment-ID prüfen' }
    { $_ -in 41, 401 } { return 'TeamViewer-Dienst läuft nicht' }
    { $_ -in 42, 402 } { return 'Dienst hat eine inkompatible Version — TeamViewer neu installieren' }
    { $_ -in 43, 403 } { return 'keine Verbindung zu TeamViewer (offline?) — Internetverbindung prüfen' }
    { $_ -in 44, 404 } { return 'eine Zuordnung läuft bereits' }
    { $_ -in 45, 405 } { return 'Zeitüberschreitung' }
    { $_ -in 46, 406 } { return 'unbekannter Fehler (TeamViewer-Logdateien sichern)' }
    { $_ -in 47, 407 } { return 'Zugriff verweigert — als Administrator ausführen' }
    { $_ -in 48, 408 } { return 'durch eine Richtlinie verhindert' }
    { $_ -in 49, 409 } { return 'Gerät ist bereits mit dieser Rollout-Konfiguration zugeordnet' }
    default { return ('Exit-Code ' + $Code) }
  }
}

# -----------------------------------------------------------------------------
# Einstieg
# -----------------------------------------------------------------------------

function Invoke-Fernwartung {
  # Führt den Fernwartungs-Schritt aus (oder zeigt im Trockenlauf nur den Plan).
  # WIRFT NIE: Fehler hier dürfen die Kassa-Installation nicht abbrechen.
  # Liefert @{ Ausgefuehrt; Erfolg; Id; Alias; Gruppe; StatusJson; Meldung }.
  #
  # Idempotent: Ist TeamViewer schon installiert, wird nicht neu installiert; ist das
  # Gerät laut Statusdatei schon zugeordnet, wird nicht erneut zugeordnet — außer mit
  # -NeuZuordnen (setzt --reassign: bisherige Zuordnung, Manager und Richtlinien werden
  # ersetzt, siehe TeamViewer-Doku).
  param(
    [Parameter(Mandatory)][string]$KonfigPfad,
    [string]$Name = '',
    [switch]$NeuZuordnen,
    [switch]$Trockenlauf,
    [string]$StatusDatei = ''
  )

  $ergebnis = [pscustomobject]@{ Ausgefuehrt = $false; Erfolg = $false; Id = $null; Alias = $null; Gruppe = $null; StatusJson = $null; Meldung = '' }
  $nachholen = 'Nachholen: Installer erneut ausführen (siehe ops/DEPLOYMENT.md, Abschnitt Fernwartung).'
  try {
    if (-not $StatusDatei) { $StatusDatei = Join-Path $env:ProgramData 'KassaPOS\fernwartung-status.json' }

    Fw-Schritt ('Fernwartung (TeamViewer Host)' + $(if ($Trockenlauf) { ' — TROCKENLAUF, es wird nichts verändert' } else { '' }))

    $gelesen = Lese-FernwartungKonfig -Pfad $KonfigPfad
    foreach ($w in $gelesen.Warnungen) { Fw-Warnung $w }
    if ($gelesen.Fehler.Count -gt 0 -or -not $gelesen.Konfig) {
      foreach ($f in $gelesen.Fehler) { Fw-Fehler $f }
      Fw-Hinweis ('Die Kassa wird trotzdem installiert. ' + $nachholen)
      $ergebnis.Meldung = 'Konfiguration fehlerhaft'
      return $ergebnis
    }
    $konfig = $gelesen.Konfig
    $ergebnis.Ausgefuehrt = $true

    $computer = $env:COMPUTERNAME
    if (-not $computer) { $computer = [System.Net.Dns]::GetHostName() }
    $frueher = Lese-FernwartungStatusDatei -Pfad $StatusDatei
    if (-not [string]::IsNullOrWhiteSpace($Name)) {
      $alias = Format-FernwartungAlias -Vorlage $konfig.AliasVorlage -Name $Name -Computername $computer
    } elseif ($frueher -and $frueher.alias) {
      # Früherer Gerätename bleibt — er steht schon fertig in der Statusdatei und
      # darf nicht ein zweites Mal durch die Vorlage laufen ("Kassa Kassa Mayr")
      $alias = Format-FernwartungAlias -Vorlage '{Name}' -Name ([string]$frueher.alias) -Computername $computer
    } else {
      $alias = Format-FernwartungAlias -Vorlage $konfig.AliasVorlage -Name '' -Computername $computer
    }

    # --- Bestandsaufnahme (nur lesend) ---------------------------------------------
    $inst = Get-TeamViewerInstallation
    $installerDatei = $null
    if (-not $inst.Installiert) {
      $installerDatei = Finde-FernwartungInstaller $konfig
      if ($installerDatei -and -not $konfig.InstallerTyp) { $konfig.InstallerTyp = Typ-AusDatei $installerDatei }
    }
    $aktuelleId = $null
    if ($inst.Installiert) { $aktuelleId = Get-TeamViewerId }
    $erledigt = [bool]($frueher -and $aktuelleId -and ([string]$frueher.id) -eq $aktuelleId -and -not $NeuZuordnen -and $konfig.Modus -ne 'keine')
    $logDatei = Join-Path $env:TEMP 'kassa-teamviewer-msi.log'
    $umgebung = @{
      Installiert = [bool]$inst.Installiert; InstallerDatei = $installerDatei; TeamViewerExe = $inst.ExePfad
      LogDatei = $logDatei; NeuZuordnen = [bool]$NeuZuordnen; ZuordnungErledigt = $erledigt
    }
    $plan = Neuer-FernwartungsPlan -Konfig $konfig -Alias $alias -Umgebung $umgebung

    # --- Übersicht -------------------------------------------------------------------
    Fw-Zeile ('Konfiguration:  ' + $konfig.Verzeichnis + '  (Geheimnisse werden nie angezeigt)')
    $modusText = switch ($konfig.Modus) {
      'assignmentId' { 'Rollout-Konfiguration (Assignment-ID)' }
      'apiToken'     { 'API-Token (TeamViewer.exe assign)' }
      default        { 'keine automatische Zuordnung' }
    }
    Fw-Zeile ('Zuordnung:      ' + $modusText + $(if ($konfig.Zuordnungsweg -eq 'msi') { ', über MSI-Eigenschaften' } else { '' }))
    Fw-Zeile ('Gerätename:     ' + $alias)
    $gruppeText = $(if ($konfig.Gruppe) { $konfig.Gruppe } elseif ($konfig.GruppeId) { $konfig.GruppeId } else { '' })
    if ($gruppeText) { Fw-Zeile ('Gruppe:         ' + $gruppeText) }
    if ($inst.Installiert) {
      Fw-Zeile ('TeamViewer:     bereits installiert' + $(if ($inst.Version) { ' (Version ' + $inst.Version + ')' } else { '' }) + ' — wird nicht neu installiert')
      if ($erledigt) { Fw-Zeile ('Zuordnung:      laut Statusdatei bereits erledigt — wird nicht wiederholt (erneut zuordnen: -FernwartungNeuZuordnen)') }
    } else {
      $quelle = $(if ($installerDatei) { $installerDatei } elseif ($konfig.InstallerUrl) { Anzeige-Url $konfig.InstallerUrl } else { '(keine Installer-Datei gefunden)' })
      Fw-Zeile ('TeamViewer:     nicht installiert — Installer: ' + $quelle)
    }

    if ($Trockenlauf) {
      Fw-Zeile 'Geplante Schritte:'
      $i = 0
      foreach ($s in $plan.Schritte) { $i++; Fw-Zeile ('  ' + $i + '. ' + $s.Beschreibung); Fw-Zeile ('     ' + $s.Anzeige) }
      $i++
      Fw-Zeile ('  ' + $i + '. Dienst + Autostart prüfen, TeamViewer-ID auslesen, Statusdatei für die Kassa schreiben')
      Fw-Ok 'Trockenlauf beendet — es wurde nichts verändert.'
      $ergebnis.Erfolg = $true
      $ergebnis.Meldung = 'Trockenlauf'
      return $ergebnis
    }

    if (-not (Teste-Administrator)) {
      Fw-Fehler 'Administratorrechte fehlen — TeamViewer kann so nicht installiert werden.'
      Fw-Hinweis ('Die Kassa wird trotzdem installiert. ' + $nachholen)
      $ergebnis.Meldung = 'keine Administratorrechte'
      return $ergebnis
    }

    # --- 1. Installieren -------------------------------------------------------------
    $zuordnungImMsi = [bool]$plan.ZuordnungImMsi
    $installSchritt = $plan.Schritte | Where-Object { $_.Id -eq 'installieren' } | Select-Object -First 1
    if ($installSchritt) {
      $hole = Hole-FernwartungInstaller -Konfig $konfig
      if (-not $konfig.InstallerTyp) { $konfig.InstallerTyp = Typ-AusDatei $hole.Pfad }
      # Plan mit dem tatsächlichen Pfad neu bauen (bei einem Download steht er erst jetzt fest)
      $umgebung['InstallerDatei'] = $hole.Pfad
      $plan = Neuer-FernwartungsPlan -Konfig $konfig -Alias $alias -Umgebung $umgebung
      $zuordnungImMsi = [bool]$plan.ZuordnungImMsi
      $installSchritt = $plan.Schritte | Where-Object { $_.Id -eq 'installieren' } | Select-Object -First 1
      Fw-Hinweis 'Installiere TeamViewer Host (still, dauert etwa eine Minute) …'
      $lauf = Invoke-FwProzess -Datei $installSchritt.Datei -ArgumentString $installSchritt.ArgumentString -TimeoutSekunden 900
      if ($hole.Temporaer) { Remove-Item -LiteralPath (Split-Path -Parent $hole.Pfad) -Recurse -Force -ErrorAction SilentlyContinue }
      if ($lauf.Zeitueberschreitung) { throw 'Die Installation von TeamViewer hat nach 15 Minuten nicht geendet.' }
      # 0 = Erfolg; 3010/1641 = Erfolg, Neustart vorgemerkt
      if ($lauf.ExitCode -ne 0 -and $lauf.ExitCode -ne 3010 -and $lauf.ExitCode -ne 1641) {
        $zusatz = ''
        if ($installSchritt.Datei -eq 'msiexec.exe' -and -not $zuordnungImMsi -and (Test-Path -LiteralPath $logDatei)) { $zusatz = ' Protokoll: ' + $logDatei }
        throw ('Installation fehlgeschlagen (Exit-Code ' + $lauf.ExitCode + ').' + $zusatz)
      }
      Fw-Ok 'TeamViewer Host installiert'
    }

    # --- 2. Dienst + Autostart -------------------------------------------------------
    if (-not (Warte-Auf { (Get-TeamViewerInstallation).Installiert } 60 2)) { throw 'TeamViewer ist nach der Installation nicht auffindbar.' }
    $inst = Get-TeamViewerInstallation
    if (Sichere-TeamViewerDienst) { Fw-Ok 'TeamViewer-Dienst läuft und startet mit Windows (Autostart)' }
    else { Fw-Warnung 'TeamViewer-Dienst konnte nicht gestartet bzw. auf Autostart gesetzt werden (Windows-Dienste → „TeamViewer").' }

    # --- 3. Zuordnung ----------------------------------------------------------------
    $zuordnungOk = $true
    $verbunden   = $true
    if ($konfig.Modus -eq 'keine') {
      Fw-Hinweis 'Keine Zuordnung konfiguriert — das Gerät muss von Hand dem TeamViewer-Konto zugeordnet werden.'
    } elseif ($zuordnungImMsi) {
      Fw-Ok 'Zuordnung erfolgte bei der Installation (MSI-Eigenschaften) — im TeamViewer-Konto kontrollieren'
    } elseif ($erledigt) {
      Fw-Ok 'Zuordnung war schon erledigt'
    } else {
      $exe = $inst.ExePfad
      if (-not $exe) { throw 'TeamViewer.exe nicht gefunden — Zuordnung nicht möglich.' }
      # Der Dienst braucht einen Moment, bis er mit TeamViewer verbunden ist (die Doku wartet 30 s).
      # Eine ID gibt es erst, wenn er die Verbindung hat — fehlt sie nach 90 s, ist die Kasse offline.
      $verbunden = Warte-Auf { $null -ne (Get-TeamViewerId) } 90 3
      $umgebung['Installiert'] = $true; $umgebung['TeamViewerExe'] = $exe
      if (-not $verbunden -and $konfig.Modus -eq 'assignmentId') {
        Fw-Hinweis 'Noch keine Verbindung zu TeamViewer — die Zuordnung wird gleich vorgemerkt (--offline).'
        $umgebung['Offline'] = $true
      }
      $plan = Neuer-FernwartungsPlan -Konfig $konfig -Alias $alias -Umgebung $umgebung
      $zuordnen = $plan.Schritte | Where-Object { $_.Id -eq 'zuordnen' } | Select-Object -First 1
      Fw-Hinweis 'Ordne das Gerät dem TeamViewer-Konto zu …'
      $lauf = Invoke-FwProzess -Datei $zuordnen.Datei -ArgumentString $zuordnen.ArgumentString -TimeoutSekunden ($konfig.Timeout + 60) -Arbeitsverzeichnis (Split-Path -Parent $exe)

      if ($umgebung['Offline'] -and $lauf.ExitCode -eq 0) {
        # War schon vorgemerkt (kein Netz) — fertig, ohne den Online-Weg noch einmal zu versuchen
        $zuordnungOk = $false
        Fw-Warnung 'Zuordnung ist vorgemerkt, aber noch nicht erfolgt. Sobald die Kasse online ist, den Installer erneut ausführen — dann wird der Status für die Kassa geschrieben.'
      }
      # Kein Internet: Zuordnung vormerken — TeamViewer führt sie aus, sobald es online ist
      elseif ($konfig.Modus -eq 'assignmentId' -and $lauf.ExitCode -in 43, 403, 45, 405) {
        Fw-Hinweis 'Keine Verbindung zu TeamViewer — merke die Zuordnung vor (--offline); sie läuft automatisch, sobald die Kasse online ist.'
        $umgebung['Offline'] = $true
        $plan = Neuer-FernwartungsPlan -Konfig $konfig -Alias $alias -Umgebung $umgebung
        $zuordnen = $plan.Schritte | Where-Object { $_.Id -eq 'zuordnen' } | Select-Object -First 1
        $lauf = Invoke-FwProzess -Datei $zuordnen.Datei -ArgumentString $zuordnen.ArgumentString -TimeoutSekunden 60 -Arbeitsverzeichnis (Split-Path -Parent $exe)
        if ($lauf.ExitCode -eq 0) {
          $zuordnungOk = $false
          Fw-Warnung 'Zuordnung ist vorgemerkt, aber noch nicht erfolgt. Sobald die Kasse online ist, den Installer erneut ausführen — dann wird der Status für die Kassa geschrieben.'
        }
      }

      if ($zuordnungOk) {
        if ($lauf.ExitCode -eq 0) {
          Fw-Ok 'Gerät dem TeamViewer-Konto zugeordnet'
        } elseif ($konfig.Modus -eq 'assignmentId' -and $lauf.ExitCode -in 49, 409) {
          Fw-Ok 'Gerät war bereits dieser Rollout-Konfiguration zugeordnet'
        } else {
          $zuordnungOk = $false
          $grund = $(if ($konfig.Modus -eq 'assignmentId') { Beschreibe-ZuordnungsFehler $lauf.ExitCode } else { 'Exit-Code ' + $lauf.ExitCode })
          Fw-Warnung ('Zuordnung nicht gelungen: ' + $grund)
          if ($lauf.Ausgabe) { Fw-Hinweis ('TeamViewer meldet: ' + (($lauf.Ausgabe -split "`n" | Select-Object -First 3) -join ' | ')) }
          Fw-Hinweis 'Ist das Gerät schon einem (anderen) Konto zugeordnet? Dann den Installer mit -FernwartungNeuZuordnen erneut ausführen.'
        }
      }
    }

    # --- 4. ID auslesen + Status schreiben ---------------------------------------------
    Fw-Hinweis 'Lese die TeamViewer-ID …'
    $id = $null
    # Offline (vorhin keine Verbindung) lohnt kein langes Warten
    if (Warte-Auf { $null -ne (Get-TeamViewerId) } $(if ($verbunden) { 120 } else { 15 }) 3) { $id = Get-TeamViewerId }
    if (-not $id) {
      Fw-Warnung 'TeamViewer-ID konnte nicht ausgelesen werden (Internetverbindung? Das TeamViewer-Symbol in der Taskleiste zeigt die ID).'
      Fw-Hinweis $nachholen
      $ergebnis.Meldung = 'ID nicht ermittelt'
      return $ergebnis
    }
    $ergebnis.Id = $id
    $ergebnis.Alias = $alias
    $ergebnis.Gruppe = $(if ($konfig.Gruppe) { $konfig.Gruppe } else { $null })
    Fw-Ok ('TeamViewer-ID: ' + (Formatiere-TeamViewerId $id) + '  (Gerätename: ' + $alias + ')')

    if ($zuordnungOk -and $konfig.Modus -ne 'keine') {
      $seit = $null
      if ($frueher -and ([string]$frueher.id) -eq $id -and $frueher.installiertAm) { $seit = [string]$frueher.installiertAm }
      $json = Neuer-FernwartungStatus -Id $id -Alias $alias -Gruppe $ergebnis.Gruppe -InstalliertAm $seit
      Schreibe-FernwartungStatusDatei -Pfad $StatusDatei -Json $json
      $ergebnis.StatusJson = $json
      $ergebnis.Erfolg = $true
      $ergebnis.Meldung = 'eingerichtet'
    } elseif ($konfig.Modus -eq 'keine') {
      Fw-Hinweis 'Ohne Zuordnung zum Konto zeigt die Kassa die Fernwartung NICHT als eingerichtet an.'
      $ergebnis.Meldung = 'nicht zugeordnet'
    } else {
      Fw-Hinweis $nachholen
      $ergebnis.Meldung = 'Zuordnung fehlgeschlagen'
    }
    return $ergebnis
  } catch {
    Fw-Fehler ('Fernwartung nicht eingerichtet: ' + $_.Exception.Message)
    Fw-Hinweis ('Die Kassa wird trotzdem installiert. ' + $nachholen)
    $ergebnis.Meldung = 'Fehler'
    return $ergebnis
  }
}

# -----------------------------------------------------------------------------
# Anbindung an die Installer (install.ps1 / install-offline.ps1)
# -----------------------------------------------------------------------------

function Finde-FernwartungKonfig {
  # Wo liegt fernwartung.json? Ausdrücklich angegebener Pfad → neben dem Installer →
  # im aktuellen Ordner. $null, wenn nirgends.
  param([string]$Pfad = '', [string]$InstallerOrdner = '')
  if ($Pfad) { return $Pfad }
  foreach ($ordner in @($InstallerOrdner, (Get-Location).Path)) {
    if (-not $ordner) { continue }
    $kandidat = Join-Path $ordner 'fernwartung.json'
    if (Test-Path -LiteralPath $kandidat -PathType Leaf) { return $kandidat }
  }
  return $null
}

function Invoke-FernwartungImInstaller {
  # Wie Invoke-Fernwartung, plus Rückfrage nach dem Gerätenamen (nur im
  # interaktiven Lauf und nur, wenn weder -FernwartungName noch ein früherer Name bekannt ist).
  param(
    [Parameter(Mandatory)][string]$KonfigPfad,
    [string]$Name = '',
    [switch]$NeuZuordnen,
    [switch]$Trockenlauf,
    [string]$StatusDatei = ''
  )
  if (-not $StatusDatei) { $StatusDatei = Join-Path $env:ProgramData 'KassaPOS\fernwartung-status.json' }
  $nameWert = $Name
  if ([string]::IsNullOrWhiteSpace($nameWert) -and -not $Trockenlauf) {
    $frueher = Lese-FernwartungStatusDatei -Pfad $StatusDatei
    if (-not ($frueher -and $frueher.alias)) {
      try {
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
          $computer = $env:COMPUTERNAME
          Write-Host ''
          $eingabe = Read-Host ('Name dieser Kasse in der TeamViewer-Geräteliste (Enter = ' + $computer + ')')
          if (-not [string]::IsNullOrWhiteSpace($eingabe)) { $nameWert = $eingabe.Trim() }
        }
      } catch { }
    }
  }
  return (Invoke-Fernwartung -KonfigPfad $KonfigPfad -Name $nameWert -NeuZuordnen:$NeuZuordnen -Trockenlauf:$Trockenlauf -StatusDatei $StatusDatei)
}

function Veroeffentliche-FernwartungErgebnis {
  # Nach „docker compose up": die auf dem PC gespeicherte Statusdatei in das
  # Kontroll-Volume der Kassa legen. Nichts zu veröffentlichen → still $false.
  param([Parameter(Mandatory)][string]$Ziel, [string]$StatusDatei = '')
  if (-not $StatusDatei) { $StatusDatei = Join-Path $env:ProgramData 'KassaPOS\fernwartung-status.json' }
  try {
    if (-not (Test-Path -LiteralPath $StatusDatei -PathType Leaf)) { return $false }
    $text = (Get-Content -LiteralPath $StatusDatei -Raw -Encoding UTF8).Trim()
    # Nur die selbst geschriebene Form (reines ASCII, gültige ID) weitergeben
    if (-not (Lese-FernwartungStatusText $text) -or $text -notmatch '^[\x20-\x7E]+$') { return $false }
    Fw-Hinweis 'Übergebe den Fernwartungs-Status an die Kassa …'
    if (Veroeffentliche-FernwartungStatus -Json $text -Ziel $Ziel) {
      Fw-Ok 'Fernwartung ist in der Kassa sichtbar (Einstellungen → System → Fernwartung)'
      return $true
    }
    Fw-Warnung 'Der Status konnte nicht an die Kassa übergeben werden (Update-Dienst noch nicht bereit?). Installer später erneut ausführen.'
  } catch {
    Fw-Warnung ('Fernwartungs-Status nicht übergeben: ' + $_.Exception.Message)
  }
  return $false
}
