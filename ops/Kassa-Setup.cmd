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

rem -- 2. Aktuellen Installer von GitHub laden (curl ist Teil von Windows 10/11) --
echo Lade aktuellen Installer von GitHub...
curl.exe -fsSL -o "%TEMP%\kassa-install.ps1" https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.ps1
if %errorlevel% neq 0 (
  echo.
  echo FEHLER: Download fehlgeschlagen - bitte Internetverbindung pruefen.
  echo.
  pause
  exit /b 1
)

rem -- 3. Installer ausfuehren --
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\kassa-install.ps1"

echo.
echo Fenster kann geschlossen werden.
pause
