# Tests der Kartenbrücken-Bibliothek und ihrer Anbindung an die Kassa-Installer (Windows PowerShell 5.1)
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\kartenbruecke\test-kartenbruecke.ps1
#
# Arbeitet nur in einem eigenen Temp-Ordner: keine geplante Aufgabe, kein Kartenleser, keine echte .env.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'bibliothek.ps1')

$script:ok = 0; $script:rot = 0
function Pruefe([string]$Name, [scriptblock]$Bedingung) {
  $gut = $false
  try { $gut = [bool](& $Bedingung) } catch { Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray }
  if ($gut) { $script:ok++; Write-Host "  ok   $Name" -ForegroundColor Green }
  else { $script:rot++; Write-Host "  ROT  $Name" -ForegroundColor Red }
}

$tmp = Join-Path $env:TEMP ('kassa-kb-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$envDatei = Join-Path $tmp '.env'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$ue = [string][char]0xFC
$werte = [ordered]@{ KARTENBRUECKE_URL = 'http://x:1'; KARTENBRUECKE_SCHLUESSEL = 'neu$1-_' }

function Schreibe([byte[]]$b) { [System.IO.File]::WriteAllBytes($envDatei, $b) }
function Hex([byte[]]$b) { return [System.BitConverter]::ToString($b) }
function IstGleich([byte[]]$erwartet) { return (Hex ([System.IO.File]::ReadAllBytes($envDatei))) -ceq (Hex $erwartet) }

try {
  Write-Host "`n1. Setze-EnvWerte"
  $zusatzLf = "KARTENBRUECKE_URL=http://x:1`nKARTENBRUECKE_SCHLUESSEL=neu`$1-_`n"
  $basis = "# K${ue}che`nPASSWORT=g${ue}n`$stig`n"
  Schreibe $utf8.GetBytes($basis)
  Setze-EnvWerte -Pfad $envDatei -Werte $werte
  Pruefe 'UTF-8 ohne BOM, LF: Umlaute und Rest bleiben Byte für Byte, Werte angehängt' { IstGleich $utf8.GetBytes($basis + $zusatzLf) }

  Setze-EnvWerte -Pfad $envDatei -Werte $werte
  Pruefe 'zweiter Lauf ändert nichts' { IstGleich $utf8.GetBytes($basis + $zusatzLf) }

  $bom = [byte[]]@(0xEF, 0xBB, 0xBF)
  $crlf = "A=1`r`nKARTENBRUECKE_SCHLUESSEL=alt`r`nPASSWORT=g${ue}n`r`n"
  Schreibe ($bom + $utf8.GetBytes($crlf))
  Setze-EnvWerte -Pfad $envDatei -Werte $werte
  Pruefe 'UTF-8 mit BOM, CRLF: BOM und Zeilenenden bleiben, vorhandener Wert an seiner Stelle ersetzt' {
    IstGleich ($bom + $utf8.GetBytes("A=1`r`nKARTENBRUECKE_SCHLUESSEL=neu`$1-_`r`nPASSWORT=g${ue}n`r`nKARTENBRUECKE_URL=http://x:1`r`n"))
  }

  $ansi = [System.Text.Encoding]::Default
  if ($ansi.IsSingleByte) {
    Schreibe $ansi.GetBytes("PASSWORT=g${ue}n`n")
    Setze-EnvWerte -Pfad $envDatei -Werte $werte
    Pruefe 'ANSI-Datei bleibt ANSI' { IstGleich $ansi.GetBytes("PASSWORT=g${ue}n`n" + $zusatzLf) }
  }

  Schreibe $utf8.GetBytes('A=1')
  Setze-EnvWerte -Pfad $envDatei -Werte $werte
  Pruefe 'ohne Zeilenende am Schluss: der letzte Wert wird nicht verklebt' { IstGleich $utf8.GetBytes("A=1`n" + $zusatzLf) }

  Schreibe $utf8.GetBytes("# KARTENBRUECKE_URL=kommentar`nKARTENBRUECKE_URL=a`nKARTENBRUECKE_URL=b`nKARTENBRUECKE_URL_ALT=c`n")
  Setze-EnvWerte -Pfad $envDatei -Werte $werte
  Pruefe 'doppelte Einträge zusammengefasst, Kommentar und ähnlicher Name unberührt' {
    IstGleich $utf8.GetBytes("# KARTENBRUECKE_URL=kommentar`nKARTENBRUECKE_URL=http://x:1`nKARTENBRUECKE_URL_ALT=c`nKARTENBRUECKE_SCHLUESSEL=neu`$1-_`n")
  }

  $utf16 = [byte[]]@(0xFF, 0xFE) + [System.Text.Encoding]::Unicode.GetBytes("A=1`n")
  Schreibe $utf16
  $geworfen = $false
  try { Setze-EnvWerte -Pfad $envDatei -Werte $werte } catch { $geworfen = $true }
  Pruefe 'UTF-16: klarer Abbruch, Datei unverändert' { $geworfen -and (IstGleich $utf16) }
  Pruefe 'keine Nebendatei bleibt liegen' { @(Get-ChildItem -LiteralPath $tmp -Force).Count -eq 1 }

  Write-Host "`n2. Version und Port"
  Pruefe 'Version aus dem ausgelieferten kartenbruecke.ps1' { (Lies-BrueckenVersion (Join-Path $here 'kartenbruecke.ps1')) -match '^\d+$' }
  Pruefe 'fehlendes Skript → keine Version' { $null -eq (Lies-BrueckenVersion (Join-Path $tmp 'gibt-es-nicht.ps1')) }
  Pruefe 'Port aus den Argumenten der Aufgabe' { (Lies-BrueckenPort '-NoProfile -File "C:\x y\kartenbruecke.ps1" -Port 47999 -LogDatei "x"' 47110) -eq 47999 }
  Pruefe 'ohne Port-Angabe gilt der Standard' { (Lies-BrueckenPort '-NoProfile' 47110) -eq 47110 }

  Write-Host "`n3. Schritt im Kassa-Installer (Attrappen)"
  # Attrappen ersetzen alles, was den PC berühren würde
  $script:installiert = $false; $script:leser = $false; $script:antwort = $false; $script:code = 0
  function Test-KartenbrueckeInstalliert { return $script:installiert }
  function Test-KartenleserVorhanden { return $script:leser }
  function Frage-Kartenbruecke { $script:gefragt = $true; return $script:antwort }
  function Starte-BrueckenInstaller([string]$Skript, [string]$Ziel) { $script:aufruf = "$Skript|$Ziel"; if ($script:code -eq 99) { throw 'kaputt' }; return $script:code }
  function Schritt([string]$t) { }
  function Hinweis([string]$t) { $script:hinweise += $t + '|' }
  function Lauf([bool]$inst, [bool]$leser, [bool]$antwort, [int]$code = 0, [switch]$Neu, [switch]$Ohne) {
    $script:installiert = $inst; $script:leser = $leser; $script:antwort = $antwort; $script:code = $code
    $script:aufruf = ''; $script:gefragt = $false; $script:hinweise = ''
    return Invoke-KartenbrueckeImInstaller -Ziel 'C:\kassa x' -Neu:$Neu -Ohne:$Ohne
  }
  Pruefe 'eingerichtete Brücke wird ohne Rückfrage aktualisiert' { (Lauf $true $false $false) -eq 'aktualisiert' -and -not $script:gefragt -and $script:aufruf -eq 'C:\kassa x\ops\kartenbruecke\installiere-kartenbruecke.ps1|C:\kassa x' }
  Pruefe 'kein Kartenleser, keine Brücke: keine Frage, nichts passiert' { (Lauf $false $false $true) -eq 'nicht noetig' -and -not $script:gefragt -and -not $script:aufruf }
  Pruefe 'Kartenleser steckt, Antwort nein: nichts passiert' { (Lauf $false $true $false) -eq 'abgelehnt' -and $script:gefragt -and -not $script:aufruf }
  Pruefe 'Kartenleser steckt, Antwort ja: eingerichtet' { (Lauf $false $true $true) -eq 'eingerichtet' -and [bool]$script:aufruf }
  Pruefe '-Kartenbruecke richtet ohne Rückfrage ein' { (Lauf $false $false $false -Neu) -eq 'eingerichtet' -and -not $script:gefragt }
  Pruefe '-OhneKartenbruecke überspringt auch eine eingerichtete Brücke' { (Lauf $true $true $true -Ohne) -eq 'uebersprungen' -and -not $script:aufruf }
  Pruefe 'Fehlercode der Brücke: Hinweis, kein Abbruch' { (Lauf $true $false $false 1) -eq 'fehler' -and $script:hinweise -match 'trotzdem installiert' }
  Pruefe 'Ausnahme: Hinweis, kein Abbruch' { (Lauf $true $false $false 99) -eq 'fehler' -and $script:hinweise -match 'kaputt' }

  Write-Host "`n4. Anbindung in den Installern"
  foreach ($v in @(@{ Skript = 'install.ps1'; Marke = '# ── 4c. Kartenbrücke' }, @{ Skript = 'install-offline.ps1'; Marke = '# ── 3c. Kartenbrücke' })) {
    $text = [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) $v.Skript), [System.Text.Encoding]::UTF8)
    $von = $text.IndexOf($v.Marke)
    Pruefe "$($v.Skript): Schritt liegt nach dem Testlauf-Ausstieg und vor dem Start der Container" {
      $von -gt $text.IndexOf('if ($OhneDocker) {') -and $von -lt $text.IndexOf('  docker compose up -d')
    }
    $block = $text.Substring($von, $text.IndexOf('# ── ', $von + 5) - $von)
    # Attrappen-Bibliothek: hält fest, womit der Block sie aufruft
    $Ziel = Join-Path $tmp ('ziel-' + $v.Skript)
    $script:blockAufruf = ''
    $Kartenbruecke = $true; $OhneKartenbruecke = $false
    Invoke-Expression $block
    Pruefe "$($v.Skript): fehlt die Bibliothek (älterer Stand), passiert nichts" { $script:blockAufruf -eq '' }
    New-Item -ItemType Directory -Path (Join-Path $Ziel 'ops\kartenbruecke') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Ziel 'ops\kartenbruecke\bibliothek.ps1'),
      'function Invoke-KartenbrueckeImInstaller { param([string]$Ziel, [switch]$Neu, [switch]$Ohne) $script:blockAufruf = "$Ziel|$Neu|$Ohne" }')
    Invoke-Expression $block
    Pruefe "$($v.Skript): Ziel und Schalter kommen an" { $script:blockAufruf -eq "$Ziel|True|False" }
  }

  Write-Host "`n5. Skripte"
  foreach ($datei in @('bibliothek.ps1', 'installiere-kartenbruecke.ps1', 'kartenbruecke.ps1', 'test-kartenbruecke.ps1', '..\install.ps1', '..\install-offline.ps1')) {
    $pfad = [System.IO.Path]::GetFullPath((Join-Path $here $datei))
    $t = $null; $f = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($pfad, [ref]$t, [ref]$f)
    Pruefe "$datei`: keine Parserfehler" { @($f).Count -eq 0 }
    $b = [System.IO.File]::ReadAllBytes($pfad)
    Pruefe "$datei`: UTF-8 mit BOM (PS 5.1 liest sonst ANSI)" { $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF }
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Host "`n$($script:ok) ok, $($script:rot) rot"
if ($script:rot -gt 0) { exit 1 }
