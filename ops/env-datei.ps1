# .env der Kassa lesen und schreiben — für die Installer-Bausteine (ops/lan-https.ps1, ops/kartenbruecke).
# Nur Funktionen, beim Laden passiert nichts. Windows PowerShell 5.1.
# Tests: ops/kartenbruecke/test-kartenbruecke.ps1
#
# Warum nicht Get-Content/Set-Content: PowerShell 5.1 liest eine UTF-8-Datei ohne BOM als ANSI und schreibt sie
# mit -Encoding utf8 zurück — ein Umlaut in einem Passwort (z. B. MASTER_PASSPHRASE) wäre danach zerstört.

# Liest die Datei so, wie sie ist: UTF-8 (mit oder ohne BOM), sonst ANSI. UTF-16 wird abgelehnt.
function Lies-EnvDatei([string]$Pfad) {
  $bytes = [System.IO.File]::ReadAllBytes($Pfad)
  if ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
    throw "$Pfad ist als UTF-16 gespeichert — bitte als UTF-8 speichern und erneut ausführen."
  }
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $start = if ($bom) { 3 } else { 0 }
  $kodierung = New-Object System.Text.UTF8Encoding($false, $true)
  try { $text = $kodierung.GetString($bytes, $start, $bytes.Length - $start) }
  catch {
    $kodierung = [System.Text.Encoding]::Default
    $text = $kodierung.GetString($bytes, $start, $bytes.Length - $start)
  }
  return @{ Text = $text; Bom = $bom; Kodierung = $kodierung }
}

# Wert der ersten nicht auskommentierten Zeile NAME=… (getrimmt) oder $null; auch, wenn die Datei fehlt
function Lies-EnvWert([string]$Pfad, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Pfad -PathType Leaf)) { return $null }
  foreach ($zeile in (Lies-EnvDatei $Pfad).Text.Split([char]10)) {
    if ($zeile -match ('^' + [regex]::Escape($Name) + '=(.*)$')) { return $Matches[1].Trim() }
  }
  return $null
}

# Werte in einer .env setzen, ohne den Rest anzufassen: Kodierung (UTF-8 mit/ohne BOM, sonst ANSI), Zeilenenden
# und alle anderen Zeilen bleiben Byte für Byte erhalten. Get-Content/Set-Content können das unter PowerShell 5.1
# nicht: eine UTF-8-Datei ohne BOM lesen sie als ANSI, ein Umlaut in einem Passwort wäre danach zerstört.
function Setze-EnvWerte {
  param([string]$Pfad, [System.Collections.IDictionary]$Werte)
  $datei = Lies-EnvDatei $Pfad
  $text = $datei.Text; $bom = $datei.Bom; $kodierung = $datei.Kodierung
  $ende = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  # Nur am LF trennen: ein CR am Zeilenende bleibt so an seiner Zeile hängen
  $zeilen = New-Object System.Collections.Generic.List[string]
  $gesetzt = @{}
  foreach ($zeile in $text.Split([char]10)) {
    $name = $null
    if ($zeile -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $name = $Matches[1] }
    if ($name -and $Werte.Contains($name)) {
      if ($gesetzt[$name]) { continue }   # doppelte Einträge zusammenfassen
      $cr = if ($zeile.EndsWith("`r")) { "`r" } else { '' }
      $zeilen.Add($name + '=' + $Werte[$name] + $cr)
      $gesetzt[$name] = $true
    } else { $zeilen.Add($zeile) }
  }
  $neu = [string]::Join("`n", $zeilen)
  foreach ($name in $Werte.Keys) {
    if ($gesetzt[$name]) { continue }
    if ($neu.Length -gt 0 -and -not $neu.EndsWith("`n")) { $neu += $ende }
    $neu += $name + '=' + $Werte[$name] + $ende
  }
  if ($neu -ceq $text) { return }
  $inhalt = $kodierung.GetBytes($neu)
  if ($bom) { $inhalt = [byte[]]@(0xEF, 0xBB, 0xBF) + $inhalt }
  # Erst daneben schreiben, dann ersetzen (Rechte der .env bleiben): nie eine halb geschriebene .env
  $neben = $Pfad + '.kartenbruecke-neu'
  try {
    [System.IO.File]::WriteAllBytes($neben, [byte[]]$inhalt)
    [System.IO.File]::Replace($neben, $Pfad, [NullString]::Value)
  } finally {
    if (Test-Path -LiteralPath $neben) { Remove-Item -LiteralPath $neben -Force }
  }
}
