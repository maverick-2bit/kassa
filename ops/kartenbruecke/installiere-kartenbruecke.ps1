# Kassa Kartenbrücke einrichten (Windows, als Administrator ausführen)
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installiere-kartenbruecke.ps1 [-KassaOrdner C:\kassa-pos]
#   powershell -NoProfile -ExecutionPolicy Bypass -File installiere-kartenbruecke.ps1 -Entfernen
#
# Was passiert:
#   1. kartenbruecke.ps1 nach C:\ProgramData\KassaPOS\kartenbruecke\ kopieren
#   2. Zugangsschlüssel erzeugen (einmalig; bleibt bei Updates erhalten), lesbar nur für SYSTEM und Administratoren
#   3. Geplante Aufgabe „Kassa Kartenbrücke": startet mit Windows unter SYSTEM, startet nach Absturz neu
#   4. KARTENBRUECKE_URL und KARTENBRUECKE_SCHLUESSEL in die .env der Kassa eintragen
#   5. Selbsttest: Brücke antwortet, Kartenleser und Karte werden angezeigt
# Danach die Kassa neu starten (docker compose up -d), damit das Backend den Schlüssel liest.

param(
  [string] $KassaOrdner = 'C:\kassa-pos',
  [int]    $Port = 47110,
  [switch] $Entfernen
)

$ErrorActionPreference = 'Stop'
$AUFGABE = 'Kassa Kartenbruecke'
$ordner  = Join-Path $env:ProgramData 'KassaPOS\kartenbruecke'
$skript  = Join-Path $ordner 'kartenbruecke.ps1'
$schluesselDatei = Join-Path $ordner 'schluessel.txt'

function Schritt([string] $t) { Write-Host "`n>> $t" -ForegroundColor Cyan }
function Ok([string] $t)      { Write-Host "   OK  $t" -ForegroundColor Green }
function Hinweis([string] $t) { Write-Host "   !   $t" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Bitte als Administrator ausführen (Rechtsklick → „Als Administrator ausführen").' }

if ($Entfernen) {
  Schritt 'Kartenbrücke entfernen'
  if (Get-ScheduledTask -TaskName $AUFGABE -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $AUFGABE -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $AUFGABE -Confirm:$false
    Ok 'Geplante Aufgabe entfernt'
  } else { Ok 'Keine geplante Aufgabe vorhanden' }
  Hinweis "Ordner $ordner (Schlüssel, Protokoll) bleibt liegen — bei Bedarf von Hand löschen."
  Hinweis 'In der .env der Kassa KARTENBRUECKE_SCHLUESSEL leeren, dann: docker compose up -d'
  return
}

# ── 1. Skript kopieren ──────────────────────────────────────────────────────
Schritt "Kartenbrücke nach $ordner kopieren"
New-Item -ItemType Directory -Path $ordner -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'kartenbruecke.ps1') -Destination $skript -Force
Ok 'kopiert'

# ── 2. Schlüssel ─────────────────────────────────────────────────────────────
Schritt 'Zugangsschlüssel'
if (Test-Path -LiteralPath $schluesselDatei) {
  $schluessel = (Get-Content -LiteralPath $schluesselDatei -Raw).Trim()
  Ok 'vorhandener Schlüssel bleibt'
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $schluessel = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Set-Content -LiteralPath $schluesselDatei -Value $schluessel -Encoding ASCII -NoNewline
  Ok 'neu erzeugt'
}
# Nur SYSTEM und Administratoren dürfen den Ordner lesen (Schlüssel, Protokoll)
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($wer in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($wer, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $ordner -AclObject $acl
Ok 'Zugriff auf SYSTEM und Administratoren beschränkt'

# ── 3. Geplante Aufgabe ──────────────────────────────────────────────────────
Schritt "Geplante Aufgabe „$AUFGABE“ (Start mit Windows, als SYSTEM)"
if (Get-ScheduledTask -TaskName $AUFGABE -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $AUFGABE -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $AUFGABE -Confirm:$false
}
$aktion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$skript`" -Port $Port"
$ausloeser = New-ScheduledTaskTrigger -AtStartup
$konto     = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$optionen  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $AUFGABE -Action $aktion -Trigger $ausloeser -Principal $konto -Settings $optionen `
  -Description 'Reicht Befehle der Kassa an die RKSV-Signaturkarte im Kartenleser durch (nur 127.0.0.1).' | Out-Null
Start-ScheduledTask -TaskName $AUFGABE
Ok 'eingerichtet und gestartet'

# ── 4. .env der Kassa ────────────────────────────────────────────────────────
Schritt "Schlüssel in die .env der Kassa eintragen ($KassaOrdner)"
$envDatei = Join-Path $KassaOrdner '.env'
if (Test-Path -LiteralPath $envDatei) {
  $zeilen = @(Get-Content -LiteralPath $envDatei | Where-Object { $_ -notmatch '^\s*KARTENBRUECKE_(URL|SCHLUESSEL)\s*=' })
  $zeilen += "KARTENBRUECKE_URL=http://host.docker.internal:$Port"
  $zeilen += "KARTENBRUECKE_SCHLUESSEL=$schluessel"
  Set-Content -LiteralPath $envDatei -Value $zeilen -Encoding utf8
  Ok 'eingetragen — jetzt die Kassa neu starten: docker compose up -d'
} else {
  Hinweis ".env nicht gefunden. Von Hand eintragen:"
  Hinweis "  KARTENBRUECKE_URL=http://host.docker.internal:$Port"
  Hinweis "  KARTENBRUECKE_SCHLUESSEL=<Inhalt von $schluesselDatei>"
}

# ── 5. Selbsttest ────────────────────────────────────────────────────────────
Schritt 'Selbsttest'
$antwort = $null
for ($i = 0; $i -lt 15 -and -not $antwort; $i++) {
  Start-Sleep -Seconds 1
  try {
    $antwort = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/leser" -Headers @{ Authorization = "Bearer $schluessel" } -TimeoutSec 5
  } catch { }
}
if (-not $antwort) {
  Hinweis "Die Brücke antwortet nicht. Protokoll: $(Join-Path $ordner 'kartenbruecke.log')"
  exit 1
}
Ok 'Brücke antwortet'
$leser = @($antwort.leser)
if ($leser.Count -eq 0) { Hinweis 'Kein Kartenleser gefunden — Leser anstecken.' }
foreach ($l in $leser) {
  $text = if ($l.atr) { "Karte gesteckt (ATR $($l.atr))" } else { 'leer' }
  Write-Host "      $($l.name): $text"
}
Write-Host "`nFertig. In der Kassa: Einstellungen → RKSV → Signaturerstellungseinheit → „Signaturkarte (lokal)“." -ForegroundColor Green
