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

# ── 1. Docker Desktop prüfen / installieren / starten (vollautomatisch) ──────

$desktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'

function Docker-Laeuft {
  try { docker info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

# Windows-Autostart für Docker Desktop setzen (das ist derselbe Mechanismus,
# den der Schalter "Start Docker Desktop when you sign in" verwendet) und die
# Docker-Desktop-Einstellung spiegeln, damit der Schalter in der UI an ist.
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

# Docker Desktop starten und warten, bis die Engine antwortet.
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

if (-not $OhneDocker) {
  Schritt 'Prüfe Docker Desktop'

  if (-not (Docker-Laeuft)) {

    # 1a. Noch gar nicht installiert → automatisch installieren
    if (-not (Test-Path $desktopExe)) {
      Hinweis 'Docker Desktop ist nicht installiert.'
      $antwort = 'j'
      try { $antwort = Read-Host 'Docker Desktop jetzt automatisch installieren? (J/n)' } catch { }
      if ($antwort -match '^[nN]') {
        Hinweis 'Abgebrochen. Manuelle Installation:  winget install -e --id Docker.DockerDesktop'
        exit 1
      }

      # WSL2 ist Voraussetzung — fehlt es, aktiviert Windows es nur mit Neustart.
      $wslOk = $false
      try { wsl.exe --status *> $null; if ($LASTEXITCODE -eq 0) { $wslOk = $true } } catch { }
      if (-not $wslOk) {
        Schritt 'Aktiviere WSL2 (Windows-Subsystem — einmalig nötig)'
        wsl.exe --install --no-distribution
        Write-Host ''
        Hinweis '>>> NEUSTART ERFORDERLICH (einmalig, wegen Windows-Funktion WSL2). <<<'
        Hinweis 'Nach dem Neustart einfach Kassa-Setup.cmd ERNEUT doppelklicken —'
        Hinweis 'die Installation läuft dann automatisch weiter.'
        exit 0
      }

      Schritt 'Installiere Docker Desktop (Download ~500 MB — bitte warten)'
      winget install -e --id Docker.DockerDesktop `
        --accept-package-agreements --accept-source-agreements `
        --override 'install --quiet --accept-license'
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $desktopExe)) {
        Fehler 'Automatische Installation fehlgeschlagen. Manuell installieren: https://www.docker.com/products/docker-desktop/'
        exit 1
      }
      Ok 'Docker Desktop installiert (Lizenz akzeptiert)'
    }

    # 1b. Installiert, aber Engine läuft nicht → Autostart setzen + jetzt starten
    Aktiviere-DockerAutostart
    if (-not (Starte-DockerDesktop 360)) {
      Fehler 'Docker Desktop wurde gestartet, ist aber nach 6 Minuten noch nicht bereit.'
      Hinweis 'Bitte warten, bis das Docker-Symbol unten rechts "running" zeigt,'
      Hinweis 'und Kassa-Setup.cmd dann erneut doppelklicken.'
      exit 1
    }
  } else {
    # Docker läuft schon — Autostart trotzdem sicherstellen
    Aktiviere-DockerAutostart
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
Write-Host ' Update später: Kassa-Setup.cmd einfach erneut doppelklicken.' -ForegroundColor Yellow
Write-Host ' Autostart ist eingerichtet: Nach einem PC-Neustart starten Docker Desktop' -ForegroundColor Yellow
Write-Host ' und alle Kassa-Container automatisch (Anmeldung am PC genügt).' -ForegroundColor Yellow
Write-Host ''
