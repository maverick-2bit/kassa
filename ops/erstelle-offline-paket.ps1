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
#     fernwartung.ps1             <- Fernwartungs-Schritt (TeamViewer Host), siehe unten
#     fernwartung.example.json    <- Vorlage für fernwartung.json
#     TeamViewer_Host.msi / .exe  <- NUR mit -FernwartungKonfig (optional)
#     LIES-MICH.txt
#
# Fernwartung (optional): Mit -FernwartungKonfig <Pfad zur fernwartung.json> (oder einer
# fernwartung.json neben diesem Skript) legt das Skript den dort angegebenen TeamViewer-
# Host-Installer (msiPfad / hostInstallerUrl) ins Paket. Die fernwartung.json selbst wird
# NICHT kopiert — sie enthält das Token. Wer die Zuordnung zum TeamViewer-Konto schon beim
# Installieren am Ziel-PC will, legt sie von Hand in den Paketordner (siehe ops/DEPLOYMENT.md).
#
# Den Ordner auf einen USB-Stick kopieren -> am Ziel-PC (ganz ohne Internet)
# Kassa-Setup-Offline.cmd doppelklicken.
#
# Aufruf:  powershell -ExecutionPolicy Bypass -File .\erstelle-offline-paket.ps1
# =============================================================================

param(
  [string]$Ziel   = "$env:USERPROFILE\Desktop\kassa-offline-paket",
  [string]$Branch = 'master',
  # Optional: fernwartung.json (siehe ops/fernwartung.example.json) — daraus wird der
  # TeamViewer-Host-Installer ins Paket gelegt. Die Datei selbst wird NICHT kopiert.
  [string]$FernwartungKonfig = ''
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
# Fernwartungs-Schritt (optional zur Laufzeit) + Vorlage der Konfiguration
foreach ($datei in @('fernwartung.ps1', 'fernwartung.example.json')) {
  $quellDatei = Join-Path $codeDir ('ops\' + $datei)
  if (Test-Path -LiteralPath $quellDatei) { Copy-Item $quellDatei (Join-Path $Ziel $datei) -Force }
}

# ── 7b. Fernwartung (optional): TeamViewer-Host-Installer ins Paket ──────────
$fwKonfigPfad = $FernwartungKonfig
if (-not $fwKonfigPfad -and $PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'fernwartung.json') -PathType Leaf)) {
  $fwKonfigPfad = Join-Path $PSScriptRoot 'fernwartung.json'
}
if ($fwKonfigPfad) {
  Schritt 'Fernwartung: TeamViewer-Host-Installer ins Paket legen'
  try {
    $fwLib = Join-Path $codeDir 'ops\fernwartung.ps1'
    if (-not (Test-Path -LiteralPath $fwLib)) { throw "ops\fernwartung.ps1 fehlt im Branch '$Branch'." }
    . $fwLib
    $gelesen = Lese-FernwartungKonfig -Pfad $fwKonfigPfad
    foreach ($w in $gelesen.Warnungen) { Write-Host ("    Hinweis: " + (Maskiere-Geheimnisse $w)) -ForegroundColor Yellow }
    if ($gelesen.Fehler.Count -gt 0 -or -not $gelesen.Konfig) { throw ($gelesen.Fehler -join ' ') }
    $hole = Hole-FernwartungInstaller -Konfig $gelesen.Konfig -ZielVerzeichnis $Ziel
    $zielDatei = Join-Path $Ziel (Split-Path -Leaf $hole.Pfad)
    if ((Resolve-Path -LiteralPath $hole.Pfad).ProviderPath -ne (Resolve-Path -LiteralPath $zielDatei -ErrorAction SilentlyContinue).ProviderPath) {
      Copy-Item -LiteralPath $hole.Pfad -Destination $zielDatei -Force
    }
    Ok ("TeamViewer-Host-Installer im Paket: " + (Split-Path -Leaf $zielDatei) + (" ({0:N0} MB)" -f ((Get-Item -LiteralPath $zielDatei).Length / 1MB)))
    Write-Host '    Die fernwartung.json (enthält das Token) wurde NICHT ins Paket kopiert.' -ForegroundColor Yellow
    Write-Host '    Soll die Zuordnung zum TeamViewer-Konto schon am Ziel-PC passieren, die Datei von Hand' -ForegroundColor Yellow
    Write-Host '    in den Paketordner legen (und den Stick danach sicher aufbewahren bzw. löschen).' -ForegroundColor Yellow
  } catch {
    $fwMeldung = $_.Exception.Message
    # (die Maskierung gibt es erst, wenn die Bibliothek geladen ist)
    if (Get-Command Maskiere-Geheimnisse -ErrorAction SilentlyContinue) { $fwMeldung = Maskiere-Geheimnisse $fwMeldung }
    Write-Host ("    Fernwartung nicht ins Paket gelegt: " + $fwMeldung) -ForegroundColor Red
    Write-Host '    Das Paket wird trotzdem erstellt (ohne TeamViewer-Installer).' -ForegroundColor Yellow
  }
}

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

Fernwartung (optional): Liegt neben Kassa-Setup-Offline.cmd eine Datei
fernwartung.json (Vorlage: fernwartung.example.json), installiert das Setup
zusaetzlich TeamViewer Host (der Installer liegt dann ebenfalls im Paket) und
ordnet den PC Ihrem TeamViewer-Konto zu. Ohne Internet merkt sich TeamViewer die
Zuordnung und fuehrt sie aus, sobald der PC online ist - dann das Setup noch einmal
doppelklicken, damit die Kassa die Fernwartung anzeigt. Die fernwartung.json
enthaelt Zugangsdaten: nur auf Ihrem eigenen Stick aufbewahren.
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
