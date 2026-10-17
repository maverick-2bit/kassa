# =============================================================================
# Kassa POS — Übergabe: komplette Kassa (alle Daten + Schlüssel) auf einen
# anderen PC übertragen, z. B. im Büro aufgesetzte Kundenkassa → Kunden-Hardware.
#
#   EXPORT (Quell-PC, im Büro):
#     .\uebergabe.ps1 -Export -Name kunde-mustermann [-Hochladen] [-Stilllegen]
#   IMPORT (Ziel-PC, beim Kunden — Kassa vorher ganz normal mit Kassa-Setup installieren):
#     .\uebergabe.ps1 -Import -Datei C:\pfad\kassa-uebergabe-kunde-mustermann-2026-10-17.kuep
#     .\uebergabe.ps1 -Import -Herunterladen -Name kunde-mustermann
#
# Was übertragen wird: die komplette Datenbank (Mandant, Artikel, Layout, Benutzer
# samt PIN-Hashes, Kassen, Drucker, Belege, Signaturkette, DEP …) und die
# MASTER_PASSPHRASE (ohne sie sind die RKSV-Signaturschlüssel unlesbar).
# Die Datei ist mit einem Übergabe-Passwort verschlüsselt (AES-256 + HMAC); ohne
# das Passwort ist sie wertlos — das Passwort NIE ins Repo oder in die Datei-Nähe.
#
# ACHTUNG RKSV: Es darf immer nur EINE Kassa mit diesem Datenstand produktiv
# laufen. Läuft die Kopie im Büro weiter, entstehen doppelte Belegnummern und eine
# gegabelte Signaturkette. Darum: -Stilllegen (stoppt die Quell-Kassa nach dem Export)
# und die Übergabe möglichst VOR dem ersten echten Beleg.
#
# Hochladen/Herunterladen nutzt ein PRIVATES GitHub-Repo (Standard
# maverick-2bit/kassa-uebergaben) über die vorhandene Git-Anmeldung. Das Repo muss
# vorher existieren und privat sein. Kompatibel mit Windows PowerShell 5.1.
# =============================================================================

param(
  [switch]$Export,
  [switch]$Import,
  # Installationsverzeichnis der Kassa (Standard wie Kassa-Setup)
  [string]$Ziel = 'C:\kassa-pos',
  # Kurzname der Übergabe (nur a-z, 0-9, Bindestrich) — Teil des Dateinamens
  [string]$Name = '',
  # Export: Datei zusätzlich in das private GitHub-Repo laden
  [switch]$Hochladen,
  # Export: Quell-Kassa nach erfolgreichem Export stoppen (Container "stop")
  [switch]$Stilllegen,
  # Import: Datei lokal (.kuep)
  [string]$Datei = '',
  # Import: neueste Datei zu -Name aus dem GitHub-Repo holen
  [switch]$Herunterladen,
  # Import: auch in eine Kassa mit bereits vorhandenen Daten einspielen (ersetzt sie!)
  [switch]$Ueberschreiben,
  [string]$Repo = 'https://github.com/maverick-2bit/kassa-uebergaben.git',
  # Nur für Tests: Passwort ohne Rückfrage (landet sonst nie in Befehlen!)
  [string]$PasswortTest = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Schritt([string]$t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Ok([string]$t)      { Write-Host "    OK: $t" -ForegroundColor Green }
function Hinweis([string]$t) { Write-Host "    $t" -ForegroundColor Yellow }
function Abbruch([string]$t) { Write-Host "FEHLER: $t" -ForegroundColor Red; exit 1 }

$MAGIC       = [Text.Encoding]::ASCII.GetBytes('KUEP1')
$ITERATIONEN = 600000
$MAX_BYTES   = 90MB   # GitHub lehnt Dateien ab 100 MB ab

# ── Verschlüsselung: PBKDF2-SHA256 → 64 Byte (32 AES + 32 HMAC), AES-256-CBC, encrypt-then-MAC ──
function Ableiten([string]$Passwort, [byte[]]$Salt) {
  $kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($Passwort, $Salt, $ITERATIONEN, [Security.Cryptography.HashAlgorithmName]::SHA256)
  try { return $kdf.GetBytes(64) } finally { $kdf.Dispose() }
}

function Verschluessele([byte[]]$Klar, [string]$Passwort) {
  $rng  = [Security.Cryptography.RandomNumberGenerator]::Create()
  $salt = New-Object byte[] 16; $rng.GetBytes($salt)
  $iv   = New-Object byte[] 16; $rng.GetBytes($iv)
  $rng.Dispose()
  $schluessel = Ableiten $Passwort $salt
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.Key = $schluessel[0..31]; $aes.IV = $iv
  $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
  $krypt = $aes.CreateEncryptor().TransformFinalBlock($Klar, 0, $Klar.Length)
  $aes.Dispose()
  $kopf = [byte[]]($MAGIC + $salt + $iv)
  $hmac = New-Object Security.Cryptography.HMACSHA256(,[byte[]]$schluessel[32..63])
  $mac  = $hmac.ComputeHash([byte[]]($kopf + $krypt))
  $hmac.Dispose()
  return [byte[]]($kopf + $krypt + $mac)
}

function Entschluessele([byte[]]$Paket, [string]$Passwort) {
  $kopfLaenge = $MAGIC.Length + 32
  if ($Paket.Length -lt ($kopfLaenge + 16 + 32)) { throw 'Datei ist zu kurz / beschädigt.' }
  for ($i = 0; $i -lt $MAGIC.Length; $i++) { if ($Paket[$i] -ne $MAGIC[$i]) { throw 'Keine Kassa-Übergabedatei (Kennung fehlt).' } }
  $salt = $Paket[$MAGIC.Length..($MAGIC.Length + 15)]
  $iv   = $Paket[($MAGIC.Length + 16)..($MAGIC.Length + 31)]
  $krypt = $Paket[$kopfLaenge..($Paket.Length - 33)]
  $macDatei = $Paket[($Paket.Length - 32)..($Paket.Length - 1)]
  $schluessel = Ableiten $Passwort ([byte[]]$salt)
  $hmac = New-Object Security.Cryptography.HMACSHA256(,[byte[]]$schluessel[32..63])
  $mac  = $hmac.ComputeHash([byte[]]$Paket[0..($Paket.Length - 33)])
  $hmac.Dispose()
  $gleich = $true
  for ($i = 0; $i -lt 32; $i++) { if ($mac[$i] -ne $macDatei[$i]) { $gleich = $false } }
  if (-not $gleich) { throw 'Falsches Passwort oder Datei verändert.' }
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.Key = $schluessel[0..31]; $aes.IV = [byte[]]$iv
  $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'
  $klar = $aes.CreateDecryptor().TransformFinalBlock([byte[]]$krypt, 0, $krypt.Length)
  $aes.Dispose()
  return ,$klar
}

function Frage-Passwort([bool]$Doppelt) {
  if ($PasswortTest) { return $PasswortTest }
  $p1 = Read-Host 'Übergabe-Passwort' -AsSecureString
  $klar = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
  if ($klar.Length -lt 10) { Abbruch 'Das Übergabe-Passwort braucht mindestens 10 Zeichen.' }
  if ($Doppelt) {
    $p2 = Read-Host 'Übergabe-Passwort wiederholen' -AsSecureString
    $klar2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($klar -ne $klar2) { Abbruch 'Die Passwörter stimmen nicht überein.' }
  }
  return $klar
}

# Nur für Tests der Verschlüsselung: Skript als Bibliothek laden
if ($env:KASSA_UEBERGABE_BIBLIOTHEK) { return }

if (($Export -and $Import) -or (-not $Export -and -not $Import)) {
  Abbruch 'Bitte genau eines angeben: -Export oder -Import.'
}

function Env-Wert([string]$Pfad, [string]$Schluessel) {
  $z = Select-String -Path $Pfad -Pattern ('^' + $Schluessel + '=(.*)$') | Select-Object -First 1
  if ($z) { return $z.Matches[0].Groups[1].Value.Trim() }
  return ''
}

function Docker-Pruefen {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Abbruch 'Docker wurde nicht gefunden.' }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Abbruch 'Docker läuft nicht — Docker Desktop starten und erneut versuchen.' }
}

$envDatei = Join-Path $Ziel '.env'
if (-not (Test-Path $envDatei)) { Abbruch "Keine Kassa-Installation in '$Ziel' gefunden (.env fehlt). Mit -Ziel das Installationsverzeichnis angeben." }
Docker-Pruefen
Set-Location $Ziel

# Läuft die Datenbank? (compose up -d startet sonst nur postgres)
function Postgres-Bereit {
  docker compose up -d postgres | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    docker compose exec -T postgres pg_isready -U kassa -d kassa *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  }
  Abbruch 'Die Datenbank wird nicht bereit.'
}

$temp = Join-Path $env:TEMP ('kassa-uebergabe-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {

# =============================================================================
if ($Export) {
  if ($Name -notmatch '^[a-z0-9][a-z0-9-]{1,40}$') { Abbruch "-Name fehlt oder ist ungültig (nur a-z, 0-9, Bindestrich; z. B. kunde-mustermann)." }
  Schritt 'Datenbank sichern'
  Postgres-Bereit
  docker compose exec -T postgres sh -c 'pg_dump -U kassa -d kassa -Fc -f /tmp/uebergabe.dump'
  if ($LASTEXITCODE -ne 0) { Abbruch 'pg_dump ist fehlgeschlagen.' }
  docker compose cp postgres:/tmp/uebergabe.dump (Join-Path $temp 'db.dump')
  if ($LASTEXITCODE -ne 0) { Abbruch 'Dump konnte nicht aus dem Container kopiert werden.' }
  docker compose exec -T postgres rm -f /tmp/uebergabe.dump | Out-Null
  $dump = Join-Path $temp 'db.dump'
  Ok ('Dump: ' + [math]::Round((Get-Item $dump).Length / 1MB, 1) + ' MB')

  $master = Env-Wert $envDatei 'MASTER_PASSPHRASE'
  if ($master.Length -lt 16) { Abbruch 'MASTER_PASSPHRASE in der .env fehlt oder ist zu kurz.' }
  $meta = @{ name = $Name; erstellt = (Get-Date).ToString('o'); rechner = $env:COMPUTERNAME; masterPassphrase = $master } | ConvertTo-Json -Compress
  Set-Content -Path (Join-Path $temp 'meta.json') -Value $meta -Encoding UTF8

  Schritt 'Paket schnüren und verschlüsseln'
  $zip = Join-Path $temp 'paket.zip'
  Compress-Archive -Path $dump, (Join-Path $temp 'meta.json') -DestinationPath $zip -CompressionLevel Optimal
  $passwort = Frage-Passwort $true
  $paket    = Verschluessele ([IO.File]::ReadAllBytes($zip)) $passwort
  if ($paket.Length -gt $MAX_BYTES) { Abbruch ('Paket ist ' + [math]::Round($paket.Length / 1MB) + ' MB groß — zu groß für GitHub (max. 90 MB). Bitte als Datei per USB/OneDrive übergeben und GitHub weglassen.') }
  $ausgabe = Join-Path (Get-Location).Path ("kassa-uebergabe-$Name-" + (Get-Date -Format 'yyyy-MM-dd-HHmm') + '.kuep')
  [IO.File]::WriteAllBytes($ausgabe, $paket)
  Ok "Übergabedatei: $ausgabe"

  if ($Hochladen) {
    Schritt "Ins private GitHub-Repo hochladen ($Repo)"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Abbruch 'git wurde nicht gefunden.' }
    $klon = Join-Path $temp 'repo'
    git clone --depth 1 $Repo $klon
    if ($LASTEXITCODE -ne 0) { Abbruch 'Das Repo konnte nicht geklont werden (existiert es, ist es privat, bist du angemeldet?).' }
    Copy-Item $ausgabe $klon
    Push-Location $klon
    git add -- (Split-Path $ausgabe -Leaf)
    git commit -q -m ("Übergabe $Name")
    git push -q origin HEAD
    $pushCode = $LASTEXITCODE
    Pop-Location
    if ($pushCode -ne 0) { Abbruch 'git push ist fehlgeschlagen.' }
    Ok 'Hochgeladen'
  }

  if ($Stilllegen) {
    Schritt 'Quell-Kassa stilllegen'
    docker compose stop
    Ok 'Alle Container gestoppt — diese Kassa darf nicht mehr produktiv laufen.'
  } else {
    Hinweis 'Die Quell-Kassa läuft noch. Nach der Übergabe NICHT mehr produktiv verwenden (doppelte Belege!) — oder gleich mit -Stilllegen exportieren.'
  }
  Write-Host "`nFertig. Passwort getrennt von der Datei aufbewahren." -ForegroundColor Green
}

# =============================================================================
if ($Import) {
  if ($Herunterladen) {
    if ($Name -notmatch '^[a-z0-9][a-z0-9-]{1,40}$') { Abbruch '-Name fehlt oder ist ungültig.' }
    Schritt "Neueste Übergabe '$Name' aus dem GitHub-Repo holen"
    $klon = Join-Path $temp 'repo'
    git clone --depth 1 $Repo $klon
    if ($LASTEXITCODE -ne 0) { Abbruch 'Das Repo konnte nicht geklont werden (Anmeldung bei GitHub nötig: z. B. "gh auth login").' }
    $treffer = Get-ChildItem $klon -Filter "kassa-uebergabe-$Name-*.kuep" | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $treffer) { Abbruch "Keine Übergabedatei für '$Name' im Repo." }
    $Datei = $treffer.FullName
    Ok $treffer.Name
  }
  if (-not $Datei -or -not (Test-Path $Datei)) { Abbruch '-Datei <Pfad zur .kuep> angeben (oder -Herunterladen -Name ...).' }

  Schritt 'Übergabedatei entschlüsseln'
  $passwort = Frage-Passwort $false
  try { $klar = Entschluessele ([IO.File]::ReadAllBytes($Datei)) $passwort } catch { Abbruch $_.Exception.Message }
  $zip = Join-Path $temp 'paket.zip'
  [IO.File]::WriteAllBytes($zip, $klar)
  $entpackt = Join-Path $temp 'inhalt'
  Expand-Archive -Path $zip -DestinationPath $entpackt -Force
  $meta = Get-Content -Raw (Join-Path $entpackt 'meta.json') | ConvertFrom-Json
  Ok ("Übergabe '" + $meta.name + "' vom " + $meta.erstellt + " (Rechner " + $meta.rechner + ")")

  Schritt 'Ziel-Kassa prüfen'
  Postgres-Bereit
  $anzahl = (docker compose exec -T postgres psql -U kassa -d kassa -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name = 'belege'").Trim()
  $belege = '0'
  if ($anzahl -eq '1') { $belege = (docker compose exec -T postgres psql -U kassa -d kassa -tAc 'SELECT count(*) FROM belege').Trim() }
  if ([int]$belege -gt 0 -and -not $Ueberschreiben) {
    Abbruch "Die Ziel-Kassa enthält bereits $belege Belege. Das Einspielen würde sie ERSETZEN — nur mit -Ueberschreiben."
  }

  Schritt 'Datenbank einspielen'
  docker compose stop backend | Out-Null
  docker compose cp (Join-Path $entpackt 'db.dump') postgres:/tmp/uebergabe.dump
  if ($LASTEXITCODE -ne 0) { Abbruch 'Dump konnte nicht in den Container kopiert werden.' }
  docker compose exec -T postgres psql -U kassa -d postgres -c 'DROP DATABASE IF EXISTS kassa WITH (FORCE)'
  if ($LASTEXITCODE -ne 0) { Abbruch 'Alte Datenbank konnte nicht entfernt werden.' }
  docker compose exec -T postgres psql -U kassa -d postgres -c 'CREATE DATABASE kassa OWNER kassa'
  if ($LASTEXITCODE -ne 0) { Abbruch 'Neue Datenbank konnte nicht angelegt werden.' }
  docker compose exec -T postgres pg_restore -U kassa -d kassa --no-owner --exit-on-error /tmp/uebergabe.dump
  if ($LASTEXITCODE -ne 0) { Abbruch 'pg_restore ist fehlgeschlagen — die Ziel-Datenbank ist jetzt unvollständig! Import wiederholen.' }
  docker compose exec -T postgres rm -f /tmp/uebergabe.dump | Out-Null
  Ok 'Daten eingespielt'

  Schritt 'MASTER_PASSPHRASE übernehmen (.env)'
  $sicherung = $envDatei + '.vor-uebergabe-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  Copy-Item $envDatei $sicherung
  $zeilen = Get-Content $envDatei | ForEach-Object { if ($_ -match '^MASTER_PASSPHRASE=') { 'MASTER_PASSPHRASE=' + $meta.masterPassphrase } else { $_ } }
  Set-Content -Path $envDatei -Value $zeilen -Encoding UTF8
  Ok ('Alte .env gesichert als ' + (Split-Path $sicherung -Leaf))

  Schritt 'Kassa starten'
  docker compose up -d
  if ($LASTEXITCODE -ne 0) { Abbruch 'docker compose up ist fehlgeschlagen.' }
  Ok 'Läuft (Migrationen laufen beim Start automatisch)'
  Hinweis 'Jetzt prüfen: Anmelden, Drucker-IPs und Kartenterminal (ZVT) auf die Geräte beim Kunden anpassen (Einstellungen → Kassen & Drucker).'
  Hinweis 'Die .env-Sicherung enthält ein Geheimnis — nach erfolgreichem Test löschen.'
}

} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
