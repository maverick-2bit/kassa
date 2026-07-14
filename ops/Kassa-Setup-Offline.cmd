@echo off
rem ============================================================
rem  Kassa POS - OFFLINE-Setup / Update  (Doppelklick)
rem
rem  Gehoert in den Offline-Paketordner (mit code.zip,
rem  kassa-images.tar, DockerDesktopInstaller.exe, ...).
rem  Ordner auf den Ziel-PC kopieren und diese Datei
rem  doppelklicken - KEIN Internet noetig.
rem ============================================================
title Kassa POS - Offline-Setup

rem -- Administrator-Rechte? Sonst selbst neu elevated starten --
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Starte neu mit Administrator-Rechten ^(UAC-Abfrage bestaetigen^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%~dp0install-offline.ps1" (
  echo FEHLER: install-offline.ps1 nicht gefunden - bitte den KOMPLETTEN
  echo Paketordner kopieren und diese Datei darin ausfuehren.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-offline.ps1"

echo.
echo Fenster kann geschlossen werden.
pause
