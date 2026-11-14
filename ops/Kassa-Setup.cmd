@echo off
rem ============================================================
rem  Kassa POS - Setup / Update  (Doppelklick-Installer)
rem
rem  Diese Datei auf den Ziel-PC kopieren (z. B. USB-Stick) und
rem  per Doppelklick ausfuehren. Holt sich Administrator-Rechte,
rem  laedt den aktuellen Installer von GitHub und startet ihn.
rem
rem  Erneut ausfuehren = Update (Daten bleiben erhalten).
rem  Voraussetzung: Internetverbindung. Docker Desktop wird bei
rem  Bedarf automatisch mitinstalliert (Nachfrage im Installer).
rem ============================================================
title Kassa POS - Setup

rem -- 1. Administrator-Rechte? Sonst selbst neu elevated starten --
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Starte neu mit Administrator-Rechten ^(UAC-Abfrage bestaetigen^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo  Kassa POS - Setup / Update
echo  ==========================
echo.

rem -- 2. Neuestes RELEASE (Git-Tag vX.Y.Z, nicht die master-Spitze) ermitteln und dessen Installer laden --
echo Suche das neueste Release auf GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = 3072; $r = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'kassa-setup' } -Uri 'https://api.github.com/repos/maverick-2bit/kassa/git/matching-refs/tags/v'; $t = $r | ForEach-Object { $_.ref } | Where-Object { $_ -match '^refs/tags/v\d+\.\d+\.\d+$' } | ForEach-Object { $_ -replace '^refs/tags/', '' } | Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1; if (-not $t) { exit 2 }; Write-Host ('Neuestes Release: ' + $t); Invoke-WebRequest -UseBasicParsing -OutFile (Join-Path $env:TEMP 'kassa-install.ps1') -Uri ('https://raw.githubusercontent.com/maverick-2bit/kassa/' + $t + '/ops/install.ps1'); exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
  echo.
  echo FEHLER: Kein Release gefunden oder Download fehlgeschlagen - bitte Internetverbindung pruefen.
  echo.
  pause
  exit /b 1
)

rem -- 3. Installer ausfuehren --
rem    Liegt neben dieser Datei eine fernwartung.json, richtet der Installer zusaetzlich
rem    die Fernwartung (TeamViewer Host) ein - siehe ops/DEPLOYMENT.md.
if exist "%~dp0fernwartung.json" goto mit_fernwartung
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\kassa-install.ps1"
goto installer_fertig
:mit_fernwartung
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\kassa-install.ps1" -FernwartungKonfig "%~dp0fernwartung.json"
:installer_fertig

echo.
echo Fenster kann geschlossen werden.
pause
