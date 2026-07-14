# =============================================================================
# Kassa POS — Windows-Installer (Docker Desktop)
#
# Installiert bzw. aktualisiert die komplette Kassa auf einem Windows-PC:
#   1. prüft Docker Desktop
#   2. lädt den aktuellen Code von GitHub (ZIP, kein Git nötig)
#   3. erzeugt beim ersten Lauf die .env mit sicheren Zufalls-Secrets
#   4. baut + startet alle Container (docker compose up -d --build)
#   5. öffnet die Windows-Firewall für die Geräte im LAN
#   6. zeigt die Geräte-URLs an
#
# Aufruf (PowerShell ALS ADMINISTRATOR, EINE Zeile — umgeht Execution-Policy-
# und TLS-Stolpersteine frischer Windows-Installationen):
#   Set-ExecutionPolicy Bypass -Scope Process -Force; [Net.ServicePointManager]::SecurityProtocol = 3072; iwr 'https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.ps1' -OutFile "$env:TEMP\kassa-install.ps1" -UseBasicParsing; & "$env:TEMP\kassa-install.ps1"
#
# Erneut ausführen = Update (Code neu laden + Container neu bauen; .env und
# alle Daten/Volumes bleiben unangetastet).
#
# Kompatibel mit Windows PowerShell 5.1 (Standard auf Windows 10/11).
# =============================================================================

param(
  # Installationsverzeichnis
  [string]$Ziel = 'C:\kassa-pos',
  # Git-Branch, dessen Stand installiert wird
  [string]$Branch = 'master',
  # Nur Code + .env vorbereiten, Docker/Firewall überspringen (Testlauf)
  [switch]$OhneDocker
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # schnellere Downloads in PS 5.1

# TLS 1.2 erzwingen — ältere PowerShell-5.1-Setups verhandeln sonst kein
# GitHub-HTTPS ("Could not create SSL/TLS secure channel").
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch { }

function Schritt([string]$Text)  { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text)       { Write-Host "    OK: $Text" -ForegroundColor Green }
function Hinweis([string]$Text)  { Write-Host "    $Text" -ForegroundColor Yellow }
function Fehler([string]$Text)   { Write-Host "FEHLER: $Text" -ForegroundColor Red }

# Kryptografisch sicheres Hex-Secret (PS-5.1-kompatibel)
function Neues-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  $rng.Dispose()
  return ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host ' Kassa POS — Installation / Update (Windows)' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ── 0. Administrator? (für Firewall-Regeln nötig) ────────────────────────────
$istAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $istAdmin -and -not $OhneDocker) {
  Fehler 'Bitte PowerShell ALS ADMINISTRATOR starten (Rechtsklick -> "Als Administrator ausführen").'
  exit 1
}

# ── 1. Docker Desktop prüfen ─────────────────────────────────────────────────
if (-not $OhneDocker) {
  Schritt 'Prüfe Docker Desktop'
  $dockerOk = $false
  try {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
  } catch { $dockerOk = $false }

  if (-not $dockerOk) {
    Fehler 'Docker Desktop läuft nicht (oder ist nicht installiert).'
    # Ist Docker Desktop nur nicht gestartet? Dann versuchen zu starten.
    $desktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $desktopExe) {
      Hinweis 'Docker Desktop ist installiert — starte es jetzt (dauert bis zu 2 Minuten) …'
      Start-Process $desktopExe | Out-Null
      for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 3
        try { docker info *> $null; if ($LASTEXITCODE -eq 0) { $dockerOk = $true; break } } catch { }
      }
      if (-not $dockerOk) {
        Fehler 'Docker Desktop wurde gestartet, ist aber noch nicht bereit.'
        Hinweis 'Bitte warten, bis das Docker-Symbol unten rechts "running" zeigt,'
        Hinweis 'und dieses Setup dann erneut ausführen.'
        exit 1
      }
    } else {
      # Nicht installiert → automatische Installation anbieten (winget)
      $antwort = 'n'
      try { $antwort = Read-Host 'Docker Desktop jetzt automatisch installieren? (j/n)' } catch { }
      if ($antwort -match '^[jJyY]') {
        Schritt 'Installiere Docker Desktop (winget — Download ~500 MB, bitte warten)'
        winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
          Fehler 'winget-Installation fehlgeschlagen. Bitte Docker Desktop manuell installieren: https://www.docker.com/products/docker-desktop/'
          exit 1
        }
        Ok 'Docker Desktop installiert'
        Hinweis 'JETZT NÖTIG (einmalig): Docker Desktop über das Startmenü öffnen,'
        Hinweis 'die Lizenz/WSL2-Abfrage bestätigen und warten, bis es "running" zeigt.'
        Hinweis 'In den Docker-Einstellungen "Start Docker Desktop when you sign in" aktivieren.'
        Hinweis 'Danach dieses Setup einfach erneut ausführen — es macht dann fertig.'
        exit 0
      }
      Hinweis 'Manuelle Installation:  winget install -e --id Docker.DockerDesktop'
      Hinweis 'Danach Docker Desktop einmal starten und dieses Setup erneut ausführen.'
      exit 1
    }
  }
  Ok 'Docker ist erreichbar'
}

# ── 2. Code von GitHub laden (ZIP — bewahrt LF-Zeilenenden für die Container) ─
Schritt "Lade Kassa-Code (Branch '$Branch') von GitHub"
$zipUrl  = "https://github.com/maverick-2bit/kassa/archive/refs/heads/$Branch.zip"
$tempDir = Join-Path $env:TEMP ("kassa-install-" + [guid]::NewGuid().ToString('N'))
$zipDatei = Join-Path $tempDir 'kassa.zip'
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Invoke-WebRequest -Uri $zipUrl -OutFile $zipDatei -UseBasicParsing
Expand-Archive -Path $zipDatei -DestinationPath $tempDir -Force
$quelle = Join-Path $tempDir "kassa-$Branch"
if (-not (Test-Path $quelle)) { Fehler "Entpacktes Verzeichnis nicht gefunden: $quelle"; exit 1 }
Ok "Heruntergeladen nach $tempDir"

# ── 3. In das Zielverzeichnis spiegeln (.env und Git-Reste bleiben verschont) ─
Schritt "Installiere nach $Ziel"
New-Item -ItemType Directory -Path $Ziel -Force | Out-Null
# robocopy /MIR spiegelt den neuen Stand; .env wird ausgenommen (bleibt erhalten).
robocopy $quelle $Ziel /MIR /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fehler "Kopieren fehlgeschlagen (robocopy-Code $LASTEXITCODE)"; exit 1 }
$global:LASTEXITCODE = 0
Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
Ok 'Code aktualisiert'

# ── 4. .env beim ersten Lauf erzeugen (Secrets generieren) ───────────────────
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
  Hinweis 'Die MASTER_PASSPHRASE darf NIE geändert werden oder verloren gehen —'
  Hinweis 'sonst sind die RKSV-Signaturschlüssel unlesbar.'
}

# Ports aus der .env lesen (für Firewall + URL-Tabelle)
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
  Schritt 'Testlauf (-OhneDocker): Docker-Build, Firewall und Start übersprungen'
  Ok ("Code + .env liegen bereit in " + $Ziel)
  exit 0
}

# ── 5. Container bauen + starten ─────────────────────────────────────────────
Schritt 'Baue und starte alle Container (erster Lauf dauert einige Minuten …)'
Push-Location $Ziel
try {
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { Fehler 'docker compose up fehlgeschlagen — Ausgabe oben prüfen.'; exit 1 }
} finally { Pop-Location }
Ok 'Container laufen'

# ── 6. Firewall für Geräte im LAN öffnen ─────────────────────────────────────
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

# ── 7. Auf das Backend warten ────────────────────────────────────────────────
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

# ── 8. Geräte-URLs anzeigen ──────────────────────────────────────────────────
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
if (-not $lanIp) { $lanIp = '<IP-dieses-PCs>' }

Write-Host ''
Write-Host '=============================================' -ForegroundColor Green
Write-Host ' Kassa POS ist installiert!' -ForegroundColor Green
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
Write-Host ' Update später: dieses Skript einfach erneut ausführen.' -ForegroundColor Yellow
Write-Host ' Wichtig: In Docker Desktop den Autostart aktivieren, damit die Kassa nach' -ForegroundColor Yellow
Write-Host ' einem PC-Neustart von selbst hochkommt (Container starten automatisch).' -ForegroundColor Yellow
Write-Host ''
