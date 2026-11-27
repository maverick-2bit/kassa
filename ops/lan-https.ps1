# =============================================================================
# Kassa – HTTPS im LAN: gemeinsame Funktionen für install.ps1 und install-offline.ps1
#
# Wird nach dem Kopieren des Codes aus dem Installationsordner geladen
# (. "$Ziel\ops\lan-https.ps1"). Bedeutung und Ports: ops/caddy/Caddyfile.lan.
#
# Regeln:
#   - Erstinstallation: Profil „lan-https" einschalten, wenn die LAN-IP eindeutig
#     ermittelt ist und keiner der Ports belegt ist (sonst nur ein Hinweis).
#   - Update: die .env bleibt, wie sie ist. Einzige Ausnahme: Ist das Profil an
#     und KASSA_LAN_IP leer, wird die IP nachgetragen. Weicht die IP ab, gibt es
#     nur einen Hinweis — eine falsch erkannte Adresse (WLAN, VPN, Hyper-V) darf
#     eine funktionierende Einrichtung nicht überschreiben.
# =============================================================================

# Feste Ports des lan-https-Dienstes (docker-compose.yml, Caddyfile.lan)
$LanHttpsPorts = [ordered]@{
  'Kassa (HTTPS)'         = 8443
  'KDS (HTTPS)'           = 9080
  'Kellner-App (HTTPS)'   = 9083
  'SB-Terminal (HTTPS)'   = 9084
  'Einlass-App (HTTPS)'   = 9087
  'Geräte-Einrichtung'    = 9079
}

# IPv4 des Adapters mit Standard-Gateway (das ist das LAN, nicht WSL/Hyper-V/Docker).
# Mehrere Kandidaten → $null (lieber keine als die falsche Adresse).
function Get-KassaLanIp {
  try {
    $kandidaten = @(Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      ForEach-Object { $_.IPv4Address.IPAddress } |
      Where-Object { $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' } |
      Sort-Object -Unique)
    if ($kandidaten.Count -eq 1) { return $kandidaten[0] }
  } catch { }
  return $null
}

# Wert einer NICHT auskommentierten Zeile NAME=… (oder $null)
function Get-EnvWert([string]$Datei, [string]$Name) {
  foreach ($zeile in (Get-Content -LiteralPath $Datei -ErrorAction SilentlyContinue)) {
    if ($zeile -match ('^' + [regex]::Escape($Name) + '=(.*)$')) { return $Matches[1].Trim() }
  }
  return $null
}

# Setzt NAME=Wert: ersetzt die erste nicht auskommentierte Zeile oder hängt an.
function Set-EnvWert([string]$Datei, [string]$Name, [string]$Wert) {
  $zeilen = @(Get-Content -LiteralPath $Datei -ErrorAction SilentlyContinue)
  $muster = '^' + [regex]::Escape($Name) + '='
  $gesetzt = $false
  for ($i = 0; $i -lt $zeilen.Count; $i++) {
    if (-not $gesetzt -and $zeilen[$i] -match $muster) { $zeilen[$i] = $Name + '=' + $Wert; $gesetzt = $true }
  }
  if (-not $gesetzt) { $zeilen += ($Name + '=' + $Wert) }
  Set-Content -LiteralPath $Datei -Value $zeilen -Encoding utf8
}

function Test-LanHttpsAktiv([string]$EnvDatei) {
  $profile = Get-EnvWert $EnvDatei 'COMPOSE_PROFILES'
  if (-not $profile) { return $false }
  return @($profile -split ',' | ForEach-Object { $_.Trim() }) -contains 'lan-https'
}

function Get-BelegteLanHttpsPorts {
  $belegt = @()
  try {
    $offen = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $_.LocalPort })
    foreach ($p in $LanHttpsPorts.Values) { if ($offen -contains $p) { $belegt += $p } }
  } catch { }
  return $belegt
}

# Liefert $true, wenn HTTPS im LAN nach diesem Lauf aktiv ist.
function Initialize-LanHttps([string]$EnvDatei, [switch]$Erstinstallation) {
  $ip = Get-KassaLanIp
  if ($Erstinstallation -and -not (Test-LanHttpsAktiv $EnvDatei)) {
    $belegt = @(Get-BelegteLanHttpsPorts)
    if (-not $ip) {
      Hinweis 'HTTPS im LAN nicht eingeschaltet: Die LAN-IP dieses PCs ist nicht eindeutig.'
      Hinweis 'Nachholen: in der .env COMPOSE_PROFILES=lan-https und KASSA_LAN_IP=<IPv4> setzen (ops/DEPLOYMENT.md).'
      return $false
    }
    if ($belegt.Count -gt 0) {
      Hinweis ('HTTPS im LAN nicht eingeschaltet: Port(s) ' + ($belegt -join ', ') + ' sind schon belegt.')
      return $false
    }
    $profile = Get-EnvWert $EnvDatei 'COMPOSE_PROFILES'
    $neu = if ($profile) { $profile + ',lan-https' } else { 'lan-https' }
    Set-EnvWert $EnvDatei 'COMPOSE_PROFILES' $neu
    Set-EnvWert $EnvDatei 'KASSA_LAN_IP' $ip
    Ok ('HTTPS im LAN eingeschaltet (Zertifikat für ' + $ip + ')')
    return $true
  }
  if (-not (Test-LanHttpsAktiv $EnvDatei)) { return $false }

  $eingetragen = Get-EnvWert $EnvDatei 'KASSA_LAN_IP'
  if (-not $eingetragen) {
    if ($ip) {
      Set-EnvWert $EnvDatei 'KASSA_LAN_IP' $ip
      Ok ('HTTPS im LAN: KASSA_LAN_IP auf ' + $ip + ' gesetzt')
    } else {
      Hinweis 'HTTPS im LAN ist eingeschaltet, aber KASSA_LAN_IP fehlt in der .env — bitte die IPv4 dieses PCs eintragen.'
    }
  } elseif ($ip -and $ip -ne $eingetragen) {
    Hinweis ('HTTPS im LAN: Das Zertifikat gilt für ' + $eingetragen + ', dieser PC hat jetzt aber ' + $ip + '.')
    Hinweis 'Ist die neue Adresse richtig, KASSA_LAN_IP in der .env anpassen und den Installer erneut starten.'
    Hinweis 'Die Geräte behalten ihr Zertifikat (die Zertifizierungsstelle bleibt dieselbe).'
  }
  return $true
}

# Zeilen für die Geräte-URL-Tabelle am Ende des Installers
function Show-LanHttpsAdressen([string]$EnvDatei) {
  $ip = Get-EnvWert $EnvDatei 'KASSA_LAN_IP'
  if (-not $ip) { $ip = '<IP-dieses-PCs>' }
  Write-Host ''
  Write-Host ' Gesicherte Adressen (HTTPS im LAN):' -ForegroundColor Cyan
  foreach ($eintrag in $LanHttpsPorts.GetEnumerator()) {
    $schema = if ($eintrag.Value -eq 9079) { 'http' } else { 'https' }
    Write-Host ('   {0,-22} {1}://{2}:{3}' -f ($eintrag.Key + ':'), $schema, $ip, $eintrag.Value)
  }
  Write-Host ('   Jedes Handy/Tablet einmal einrichten: http://' + $ip + ':9079 öffnen und den Schritten folgen.') -ForegroundColor DarkGray
}
