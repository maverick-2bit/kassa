# =============================================================================
# Kassa POS — Offline-Installer (Windows, OHNE Internet)
#
# Liegt im Offline-Paket (erstellt mit erstelle-offline-paket.ps1) und
# installiert die komplette Kassa vom USB-Stick:
#   1. WSL2 + Docker Desktop aus dem Paket (falls nötig; inkl. Autostart)
#   2. Code aus code.zip nach C:\kassa-pos
#   3. .env mit sicheren Zufalls-Secrets (nur beim ersten Lauf)
#   4. docker load kassa-images.tar  ->  docker compose up (ohne Build)
#   5. Windows-Firewall + Geräte-URL-Tabelle
#
# Start über Kassa-Setup-Offline.cmd (Doppelklick) im selben Ordner.
# Erneut ausführen = Update (Daten/.env bleiben erhalten).
# Kompatibel mit Windows PowerShell 5.1.
# =============================================================================

param(
  [string]$Ziel = 'C:\kassa-pos',
  # Nur Code + .env vorbereiten, Docker/Firewall überspringen (Testlauf)
  [switch]$OhneDocker
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# Paket-Ordner = Ordner dieses Skripts (USB-Stick)
$paket = $PSScriptRoot
if (-not $paket) { $paket = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Schritt([string]$Text)  { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text)       { Write-Host "    OK: $Text" -ForegroundColor Green }
function Hinweis([string]$Text)  { Write-Host "    $Text" -ForegroundColor Yellow }
function Fehler([string]$Text)   { Write-Host "FEHLER: $Text" -ForegroundColor Red }

function Neues-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  $rng.Dispose()
  return ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ' Kassa POS — Offline-Installation / Update (Windows)' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan

# ── 0. Administrator + Paket-Inhalt prüfen ───────────────────────────────────
$istAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $istAdmin -and -not $OhneDocker) {
  Fehler 'Bitte über Kassa-Setup-Offline.cmd starten (holt Administrator-Rechte).'
  exit 1
}
foreach ($datei in @('code.zip')) {
  if (-not (Test-Path (Join-Path $paket $datei))) {
    Fehler "Paket unvollständig: $datei fehlt neben diesem Skript."
    exit 1
  }
}

$desktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'

function Docker-Laeuft {
  try { docker info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

function Aktiviere-DockerAutostart {
  if (-not (Test-Path $desktopExe)) { return }
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'Docker Desktop' -Value ('"' + $desktopExe + '"') -PropertyType String -Force | Out-Null
  foreach ($datei in @("$env:APPDATA\Docker\settings-store.json", "$env:APPDATA\Docker\settings.json")) {
    if (Test-Path $datei) {
      try {
        $json = Get-Content -Raw $datei | ConvertFrom-Json
        if ($json.PSObject.Properties.Name -contains 'AutoStart')      { $json.AutoStart = $true }
        elseif ($json.PSObject.Properties.Name -contains 'autoStart')  { $json.autoStart = $true }
        else { $json | Add-Member -NotePropertyName 'AutoStart' -NotePropertyValue $true -Force }
        $json | ConvertTo-Json -Depth 20 | Set-Content -Path $datei -Encoding utf8
      } catch { }
    }
  }
  Ok 'Autostart für Docker Desktop aktiviert (startet künftig mit Windows)'
}

function Starte-DockerDesktop([int]$MaxSekunden) {
  Hinweis 'Starte Docker Desktop — die Engine braucht beim ersten Mal einige Minuten …'
  Start-Process $desktopExe | Out-Null
  $bisher = 0
  while ($bisher -lt $MaxSekunden) {
    Start-Sleep -Seconds 5
    $bisher += 5
    if (Docker-Laeuft) { return $true }
  }
  return $false
}

# ── 1. Docker Desktop (offline) ──────────────────────────────────────────────
if (-not $OhneDocker) {
  Schritt 'Prüfe Docker Desktop'

  if (-not (Docker-Laeuft)) {

    if (-not (Test-Path $desktopExe)) {
      # 1a. WSL2-Windows-Funktionen (offline aktivierbar; ggf. einmaliger Neustart)
      Schritt 'Prüfe Windows-Funktion WSL2'
      $neustartNoetig = $false
      foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $f = Get-WindowsOptionalFeature -Online -FeatureName $feature
        if ($f.State -ne 'Enabled') {
          Hinweis "Aktiviere $feature …"
          $erg = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
          if ($erg.RestartNeeded) { $neustartNoetig = $true }
        }
      }
      # WSL2-Kernel aus dem Paket (still installierbar, kein Internet nötig)
      $kernelMsi = Join-Path $paket 'wsl_update_x64.msi'
      if (Test-Path $kernelMsi) {
        Hinweis 'Installiere WSL2-Kernel-Update …'
        Start-Process msiexec.exe -ArgumentList '/i', ('"' + $kernelMsi + '"'), '/qn' -Wait
      }
      if ($neustartNoetig) {
        Write-Host ''
        Hinweis '>>> NEUSTART ERFORDERLICH (einmalig, wegen Windows-Funktion WSL2). <<<'
        Hinweis 'Nach dem Neustart Kassa-Setup-Offline.cmd ERNEUT doppelklicken —'
        Hinweis 'die Installation läuft dann automatisch weiter.'
        exit 0
      }

      # 1b. Docker Desktop aus dem Paket installieren (Lizenz wird akzeptiert)
      $dockerInstaller = Join-Path $paket 'DockerDesktopInstaller.exe'
      if (-not (Test-Path $dockerInstaller)) {
        Fehler 'DockerDesktopInstaller.exe fehlt im Paket.'
        exit 1
      }
      Schritt 'Installiere Docker Desktop aus dem Paket (dauert einige Minuten)'
      Start-Process $dockerInstaller -ArgumentList 'install', '--quiet', '--accept-license' -Wait
      if (-not (Test-Path $desktopExe)) {
        Fehler 'Docker-Desktop-Installation fehlgeschlagen.'
        exit 1
      }
      Ok 'Docker Desktop installiert (Lizenz akzeptiert)'
    }

    Aktiviere-DockerAutostart
    if (-not (Starte-DockerDesktop 360)) {
      Fehler 'Docker Desktop wurde gestartet, ist aber nach 6 Minuten noch nicht bereit.'
      Hinweis 'Bitte warten, bis das Docker-Symbol unten rechts "running" zeigt,'
      Hinweis 'und Kassa-Setup-Offline.cmd dann erneut doppelklicken.'
      exit 1
    }
  } else {
    Aktiviere-DockerAutostart
  }
  Ok 'Docker ist erreichbar'
}

# ── 2. Code aus dem Paket installieren ───────────────────────────────────────
Schritt "Installiere Code nach $Ziel"
$tempDir = Join-Path $env:TEMP ("kassa-offline-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Expand-Archive -Path (Join-Path $paket 'code.zip') -DestinationPath $tempDir -Force
$quelle = Get-ChildItem -Path $tempDir -Directory | Where-Object { $_.Name -like 'kassa-*' } | Select-Object -First 1
if (-not $quelle) { Fehler 'code.zip hat unerwarteten Inhalt.'; exit 1 }
New-Item -ItemType Directory -Path $Ziel -Force | Out-Null
robocopy $quelle.FullName $Ziel /MIR /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fehler "Kopieren fehlgeschlagen (robocopy-Code $LASTEXITCODE)"; exit 1 }
$global:LASTEXITCODE = 0
Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
Ok 'Code installiert'

# ── 3. .env beim ersten Lauf erzeugen ────────────────────────────────────────
$envDatei = Join-Path $Ziel '.env'
if (Test-Path $envDatei) {
  Schritt 'Bestehende .env gefunden — bleibt unverändert (Update-Modus)'
} else {
  Schritt 'Erzeuge .env mit sicheren Zufalls-Secrets (Erstinstallation)'
  $inhalt = Get-Content -Raw (Join-Path $Ziel '.env.example')
  $inhalt = $inhalt -replace 'POSTGRES_PASSWORD=.*',  ('POSTGRES_PASSWORD=' + (Neues-Secret 24))
  $inhalt = $inhalt -replace 'MASTER_PASSPHRASE=.*',  ('MASTER_PASSPHRASE=' + (Neues-Secret 24))
  $inhalt = $inhalt -replace 'JWT_SECRET=.*',         ('JWT_SECRET='        + (Neues-Secret 48))
  Set-Content -Path $envDatei -Value $inhalt -Encoding utf8
  Ok '.env erstellt'
  Hinweis 'WICHTIG: Sichere dir eine Kopie der .env an einem sicheren Ort!'
}

function Env-Port([string]$Name, [int]$Standard) {
  $zeile = Select-String -Path $envDatei -Pattern ("^" + $Name + "=(\d+)") -ErrorAction SilentlyContinue
  if ($zeile -and $zeile.Matches[0].Groups[1].Value) { return [int]$zeile.Matches[0].Groups[1].Value }
  return $Standard
}
$ports = [ordered]@{
  'Kassa (Haupt-App)' = (Env-Port 'FRONTEND_PORT' 80)
  'KDS Küche/Schank'  = (Env-Port 'KDS_PORT' 8080)
  'Kundendisplay'     = (Env-Port 'KUNDENDISPLAY_PORT' 8081)
  'Gast-Bestellung'   = (Env-Port 'GAST_PORT' 8082)
  'Kellner-App'       = (Env-Port 'KELLNER_PORT' 8083)
  'SB-Terminal'       = (Env-Port 'TERMINAL_PORT' 8084)
  'Abholmonitor'      = (Env-Port 'ABHOLMONITOR_PORT' 8085)
}

if ($OhneDocker) {
  Schritt 'Testlauf (-OhneDocker): Image-Import, Start und Firewall übersprungen'
  Ok ("Code + .env liegen bereit in " + $Ziel)
  exit 0
}

# ── 4. Images importieren + Container starten (KEIN Internet nötig) ──────────
$imagesTar = Join-Path $paket 'kassa-images.tar'
if (-not (Test-Path $imagesTar)) { Fehler 'kassa-images.tar fehlt im Paket.'; exit 1 }
Schritt 'Importiere Docker-Images aus dem Paket (dauert einige Minuten)'
docker load -i $imagesTar
if ($LASTEXITCODE -ne 0) { Fehler 'docker load fehlgeschlagen.'; exit 1 }
Ok 'Images importiert'

Schritt 'Starte alle Container'
Push-Location $Ziel
try {
  docker compose up -d --no-build
  if ($LASTEXITCODE -ne 0) { Fehler 'docker compose up fehlgeschlagen — Ausgabe oben prüfen.'; exit 1 }
} finally { Pop-Location }
Ok 'Container laufen'

# ── 5. Firewall öffnen ───────────────────────────────────────────────────────
Schritt 'Öffne Windows-Firewall für die Kassa-Ports'
foreach ($eintrag in $ports.GetEnumerator()) {
  $regelName = 'Kassa POS - ' + $eintrag.Key
  $vorhanden = Get-NetFirewallRule -DisplayName $regelName -ErrorAction SilentlyContinue
  if (-not $vorhanden) {
    New-NetFirewallRule -DisplayName $regelName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $eintrag.Value -Profile Any | Out-Null
  }
}
Ok 'Firewall-Regeln vorhanden'

# ── 6. Gesundheitscheck + URLs ───────────────────────────────────────────────
Schritt 'Warte auf die Kassa (Gesundheitscheck)'
$frontendPort = $ports['Kassa (Haupt-App)']
$gesund = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $res = Invoke-WebRequest -Uri ("http://localhost:" + $frontendPort + "/api/health") -UseBasicParsing -TimeoutSec 3
    if ($res.StatusCode -eq 200) { $gesund = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if ($gesund) { Ok 'Kassa antwortet' } else {
  Hinweis 'Kassa antwortet noch nicht — der erste Start kann dauern.'
  Hinweis ("Status prüfen:  cd " + $Ziel + "  und dann:  docker compose ps   bzw.   docker compose logs backend")
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
if (-not $lanIp) { $lanIp = '<IP-dieses-PCs>' }

Write-Host ''
Write-Host '=============================================' -ForegroundColor Green
Write-Host ' Kassa POS ist installiert (offline)!' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Green
Write-Host ''
Write-Host ' Geräte-URLs (im selben Netzwerk):' -ForegroundColor Cyan
foreach ($eintrag in $ports.GetEnumerator()) {
  $port = $eintrag.Value
  $suffix = ''
  if ($port -ne 80) { $suffix = ':' + $port }
  Write-Host ('   {0,-18} http://{1}{2}' -f ($eintrag.Key + ':'), $lanIp, $suffix)
}
Write-Host ''
Write-Host ' Erste Schritte:' -ForegroundColor Cyan
Write-Host ('   1. Am PC öffnen:  http://localhost' + $(if ($ports['Kassa (Haupt-App)'] -ne 80) { ':' + $ports['Kassa (Haupt-App)'] } else { '' }))
Write-Host '   2. Setup-Assistent ausfüllen (Firma, Kasse, Admin) — RKSV-Testmodus wählen'
Write-Host '   3. Bondrucker: Einstellungen -> Hardware -> IP des LAN-Druckers eintragen + Testdruck'
Write-Host ''
Write-Host ' Update: neues Offline-Paket erstellen und hier erneut doppelklicken.' -ForegroundColor Yellow
Write-Host ' Autostart ist eingerichtet: Docker + Kassa starten mit Windows.' -ForegroundColor Yellow
Write-Host ''
