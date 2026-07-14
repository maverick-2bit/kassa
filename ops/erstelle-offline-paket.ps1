# =============================================================================
# Kassa POS — Offline-Paket erstellen
#
# Läuft auf einem PC MIT Docker Desktop + Internet (z. B. dem Test-PC) und
# erzeugt einen kompletten Offline-Installationsordner für den USB-Stick:
#
#   kassa-offline-paket\
#     Kassa-Setup-Offline.cmd     <- Doppelklick-Installer (Ziel-PC)
#     install-offline.ps1         <- Installationslogik
#     code.zip                    <- kompletter Quellcode
#     kassa-images.tar            <- alle fertig gebauten Docker-Images (~1–2 GB)
#     DockerDesktopInstaller.exe  <- Docker Desktop (~500 MB)
#     wsl_update_x64.msi          <- WSL2-Kernel (für PCs ohne WSL2)
#     LIES-MICH.txt
#
# Den Ordner auf einen USB-Stick kopieren -> am Ziel-PC (ganz ohne Internet)
# Kassa-Setup-Offline.cmd doppelklicken.
#
# Aufruf:  powershell -ExecutionPolicy Bypass -File .\erstelle-offline-paket.ps1
# =============================================================================

param(
  [string]$Ziel   = "$env:USERPROFILE\Desktop\kassa-offline-paket",
  [string]$Branch = 'master'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch { }

function Schritt([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text)      { Write-Host "    OK: $Text" -ForegroundColor Green }
function Fehler([string]$Text)  { Write-Host "FEHLER: $Text" -ForegroundColor Red }

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host ' Kassa POS — Offline-Installationspaket erstellen' -ForegroundColor Cyan
Write-Host '================================================' -ForegroundColor Cyan

# ── 1. Docker verfügbar? ─────────────────────────────────────────────────────
Schritt 'Prüfe Docker'
try { docker info *> $null } catch { }
if ($LASTEXITCODE -ne 0) {
  Fehler 'Docker läuft nicht. Dieses Skript braucht einen PC mit laufendem Docker Desktop (z. B. den Test-PC).'
  exit 1
}
Ok 'Docker läuft'

New-Item -ItemType Directory -Path $Ziel -Force | Out-Null

# ── 2. Code von GitHub laden ─────────────────────────────────────────────────
Schritt "Lade Kassa-Code (Branch '$Branch')"
$tempDir = Join-Path $env:TEMP ("kassa-paket-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$codeZip = Join-Path $tempDir 'code.zip'
Invoke-WebRequest -Uri "https://github.com/maverick-2bit/kassa/archive/refs/heads/$Branch.zip" -OutFile $codeZip -UseBasicParsing
Expand-Archive -Path $codeZip -DestinationPath $tempDir -Force
$codeDir = Join-Path $tempDir "kassa-$Branch"
Ok 'Code geladen'

# ── 3. Alle Images bauen ─────────────────────────────────────────────────────
Schritt 'Baue alle Kassa-Images (dauert beim ersten Mal einige Minuten)'
Push-Location $codeDir
try {
  docker compose build
  if ($LASTEXITCODE -ne 0) { Fehler 'docker compose build fehlgeschlagen.'; exit 1 }

  # ── 4. Vollständige Image-Liste + fehlende Basis-Images ziehen ─────────────
  Schritt 'Ermittle und lade Basis-Images (PostgreSQL, restic)'
  $images = docker compose config --images
  if ($LASTEXITCODE -ne 0 -or -not $images) { Fehler 'Image-Liste konnte nicht ermittelt werden.'; exit 1 }
  $images = @($images | Where-Object { $_ -and $_.Trim() -ne '' } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
  foreach ($img in $images) {
    docker image inspect $img *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "    ziehe $img ..."
      docker pull $img
      if ($LASTEXITCODE -ne 0) { Fehler "docker pull $img fehlgeschlagen."; exit 1 }
    }
  }
  Ok ("Images bereit: " + ($images.Count))

  # ── 5. Images in EINE Datei exportieren ─────────────────────────────────────
  Schritt 'Exportiere alle Images nach kassa-images.tar (~1–2 GB, bitte warten)'
  $tarPfad = Join-Path $Ziel 'kassa-images.tar'
  docker save -o $tarPfad @images
  if ($LASTEXITCODE -ne 0) { Fehler 'docker save fehlgeschlagen.'; exit 1 }
  Ok ("Exportiert: {0:N0} MB" -f ((Get-Item $tarPfad).Length / 1MB))
} finally { Pop-Location }

# ── 6. Docker-Desktop-Installer + WSL2-Kernel herunterladen ──────────────────
Schritt 'Lade Docker-Desktop-Installer (~500 MB)'
Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' `
  -OutFile (Join-Path $Ziel 'DockerDesktopInstaller.exe') -UseBasicParsing
Ok 'Docker-Desktop-Installer im Paket'

Schritt 'Lade WSL2-Kernel-Update (für Ziel-PCs ohne WSL2)'
Invoke-WebRequest -Uri 'https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi' `
  -OutFile (Join-Path $Ziel 'wsl_update_x64.msi') -UseBasicParsing
Ok 'WSL2-Kernel im Paket'

# ── 7. Code + Offline-Installer ins Paket ─────────────────────────────────────
Schritt 'Lege Code + Installer ins Paket'
Copy-Item $codeZip (Join-Path $Ziel 'code.zip') -Force
Copy-Item (Join-Path $codeDir 'ops\install-offline.ps1')     (Join-Path $Ziel 'install-offline.ps1') -Force
Copy-Item (Join-Path $codeDir 'ops\Kassa-Setup-Offline.cmd') (Join-Path $Ziel 'Kassa-Setup-Offline.cmd') -Force

$liesMich = @"
Kassa POS - Offline-Installation
================================

1. Diesen kompletten Ordner auf den Ziel-PC kopieren (z. B. per USB-Stick).
2. Auf dem Ziel-PC:  Kassa-Setup-Offline.cmd  doppelklicken.
3. UAC-Abfrage bestaetigen - der Rest laeuft automatisch (kein Internet noetig).

Hinweis: Fehlt auf dem Ziel-PC die Windows-Funktion WSL2, richtet das Setup sie
ein und bittet EINMALIG um einen Neustart. Danach Kassa-Setup-Offline.cmd
einfach erneut doppelklicken - die Installation laeuft automatisch weiter.

Update: neues Offline-Paket erstellen und am Ziel-PC erneut doppelklicken
(Datenbank, Belege und Einstellungen bleiben erhalten).
"@
Set-Content -Path (Join-Path $Ziel 'LIES-MICH.txt') -Value $liesMich -Encoding utf8

Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

$gesamtMb = [math]::Round(((Get-ChildItem $Ziel -Recurse | Measure-Object Length -Sum).Sum / 1MB))
Write-Host ''
Write-Host '================================================' -ForegroundColor Green
Write-Host ' Offline-Paket fertig!' -ForegroundColor Green
Write-Host '================================================' -ForegroundColor Green
Write-Host ("  Ort:    " + $Ziel)
Write-Host ("  Größe:  ~{0:N0} MB" -f $gesamtMb)
Write-Host '  Diesen Ordner auf einen USB-Stick kopieren und am Ziel-PC'
Write-Host '  Kassa-Setup-Offline.cmd doppelklicken.'
Write-Host ''
