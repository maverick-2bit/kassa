# Kassa Kartenbrücke — reicht APDUs von der Kassa (Docker-Container) an den Kartenleser am PC durch.
#
# Docker Desktop kann keinen USB-Kartenleser in den Container durchreichen. Dieser kleine Dienst läuft
# direkt unter Windows, spricht über PC/SC (winscard.dll) mit dem Leser und bietet der Kassa zwei Aufrufe:
#
#   GET  /leser   → { "leser": [ { "name": "...", "atr": "3BDF..." | null } ] }
#   POST /apdu    { "leser": "...", "apdus": ["00A4000C023F00", ...] }
#                 → { "antworten": ["9000", ...] }   eine exklusive Kartensitzung; Abbruch nach dem
#                                                    ersten Statuswort, das weder 9000 noch 6282 ist
#
# Alles Fachliche (Kartentyp, Zertifikat, PIN-Schutz) macht die Kassa (@kassa/rksv, see/karte).
# Die Brücke ist absichtlich dumm — und hält deshalb keine PIN, kein Zertifikat, keinen Zustand.
#
# Sicherheit:
#   - lauscht nur auf 127.0.0.1 (Docker Desktop erreicht das über host.docker.internal)
#   - jede Anfrage braucht den gemeinsamen Schlüssel (Authorization: Bearer …)
#   - Anfragen laufen strikt nacheinander (eine Karte, mehrere Kassen)
#   - nach jeder Sitzung wird die Karte zurückgesetzt: eine bestätigte PIN gilt nie über die Sitzung hinaus
#   - APDU-Inhalte werden NIE protokolliert (das VERIFY enthält die PIN), nur Anzahl und Statuswörter
#
# Aufruf (Dienst richtet installiere-kartenbruecke.ps1 ein):
#   powershell -NoProfile -ExecutionPolicy Bypass -File kartenbruecke.ps1 [-Port 47110] [-Adresse 127.0.0.1]
#              [-SchluesselDatei C:\ProgramData\KassaPOS\kartenbruecke\schluessel.txt] [-Schluessel …]

param(
  [int]    $Port           = 47110,
  [string] $Adresse        = '127.0.0.1',
  [string] $SchluesselDatei = (Join-Path $env:ProgramData 'KassaPOS\kartenbruecke\schluessel.txt'),
  [string] $Schluessel     = '',
  [string] $LogDatei       = (Join-Path $env:ProgramData 'KassaPOS\kartenbruecke\kartenbruecke.log')
)

$ErrorActionPreference = 'Stop'
$VERSION = '1'

if (-not $Schluessel) {
  if (-not (Test-Path -LiteralPath $SchluesselDatei)) { throw "Schlüsseldatei fehlt: $SchluesselDatei" }
  $Schluessel = (Get-Content -LiteralPath $SchluesselDatei -Raw).Trim()
}
if ($Schluessel.Length -lt 32) { throw 'Der Schlüssel der Kartenbrücke muss mindestens 32 Zeichen lang sein' }

function Log([string] $text) {
  $zeile = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $text
  Write-Host $zeile
  try {
    $ordner = Split-Path -Parent $LogDatei
    if (-not (Test-Path -LiteralPath $ordner)) { New-Item -ItemType Directory -Path $ordner -Force | Out-Null }
    if ((Test-Path -LiteralPath $LogDatei) -and (Get-Item -LiteralPath $LogDatei).Length -gt 1MB) {
      Move-Item -LiteralPath $LogDatei -Destination "$LogDatei.1" -Force
    }
    Add-Content -LiteralPath $LogDatei -Value $zeile -Encoding UTF8
  } catch { }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class KassaPcSc {
  const uint SCARD_SCOPE_SYSTEM = 2;
  const uint SCARD_SHARE_SHARED = 2;
  const uint SCARD_PROTOCOL_T0 = 1, SCARD_PROTOCOL_T1 = 2;
  const uint SCARD_LEAVE_CARD = 0, SCARD_RESET_CARD = 1;
  const int  SCARD_E_NO_READERS_AVAILABLE = unchecked((int)0x8010002E);

  [DllImport("winscard.dll")] static extern int SCardEstablishContext(uint scope, IntPtr r1, IntPtr r2, out IntPtr ctx);
  [DllImport("winscard.dll")] static extern int SCardReleaseContext(IntPtr ctx);
  [DllImport("winscard.dll", CharSet=CharSet.Unicode)] static extern int SCardListReaders(IntPtr ctx, string groups, char[] readers, ref int len);
  [DllImport("winscard.dll", CharSet=CharSet.Unicode)] static extern int SCardConnect(IntPtr ctx, string reader, uint share, uint proto, out IntPtr card, out uint active);
  [DllImport("winscard.dll")] static extern int SCardDisconnect(IntPtr card, uint disp);
  [DllImport("winscard.dll")] static extern int SCardBeginTransaction(IntPtr card);
  [DllImport("winscard.dll")] static extern int SCardEndTransaction(IntPtr card, uint disp);
  [DllImport("winscard.dll", CharSet=CharSet.Unicode)] static extern int SCardStatus(IntPtr card, char[] names, ref int nlen, out uint state, out uint proto, byte[] atr, ref int atrLen);
  [DllImport("winscard.dll")] static extern int SCardTransmit(IntPtr card, ref IoRequest sendPci, byte[] send, int sendLen, IntPtr recvPci, byte[] recv, ref int recvLen);

  [StructLayout(LayoutKind.Sequential)] public struct IoRequest { public uint Protocol; public uint PciLength; }

  public class Fehler : Exception { public int Code; public Fehler(string m, int c) : base(m) { Code = c; } }

  static void Pruefe(int rc, string was) { if (rc != 0) throw new Fehler(was + String.Format(" (0x{0:X8})", rc), rc); }

  static IntPtr Kontext() { IntPtr ctx; Pruefe(SCardEstablishContext(SCARD_SCOPE_SYSTEM, IntPtr.Zero, IntPtr.Zero, out ctx), "PC/SC nicht verfügbar"); return ctx; }

  static string Hex(byte[] b, int n) { var s = new System.Text.StringBuilder(n * 2); for (int i = 0; i < n; i++) s.Append(b[i].ToString("X2")); return s.ToString(); }

  public static byte[] AusHex(string h) {
    if (h == null || h.Length % 2 != 0) throw new ArgumentException("APDU ist kein gültiges Hex");
    var b = new byte[h.Length / 2];
    for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(h.Substring(i * 2, 2), 16);
    return b;
  }

  /// Alle Leser mit ATR der gesteckten Karte (null = leer)
  public static List<string[]> Leser() {
    var ergebnis = new List<string[]>();
    IntPtr ctx = Kontext();
    try {
      int len = 0;
      int rc = SCardListReaders(ctx, null, null, ref len);
      if (rc == SCARD_E_NO_READERS_AVAILABLE || len <= 1) return ergebnis;
      Pruefe(rc, "Leser auflisten");
      var buf = new char[len];
      Pruefe(SCardListReaders(ctx, null, buf, ref len), "Leser auflisten");
      foreach (var name in new string(buf).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries)) {
        IntPtr card; uint proto;
        string atr = null;
        if (SCardConnect(ctx, name, SCARD_SHARE_SHARED, SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1, out card, out proto) == 0) {
          var a = new byte[36]; int al = 36, nl = 0; uint st, p;
          if (SCardStatus(card, null, ref nl, out st, out p, a, ref al) == 0) atr = Hex(a, al);
          SCardDisconnect(card, SCARD_LEAVE_CARD);
        }
        ergebnis.Add(new[] { name, atr });
      }
      return ergebnis;
    } finally { SCardReleaseContext(ctx); }
  }

  /// Eine exklusive Sitzung: APDUs der Reihe nach, Abbruch nach dem ersten SW ausser 9000/6282.
  /// Danach wird die Karte zurückgesetzt (eine bestätigte PIN gilt nicht über die Sitzung hinaus).
  public static List<string> Sitzung(string leser, string[] apdus) {
    var antworten = new List<string>();
    IntPtr ctx = Kontext();
    try {
      IntPtr card; uint proto;
      // T=1 bevorzugt (A-Trust-Empfehlung); T=0 bräuchte GET RESPONSE — wird unten nachgeholt
      Pruefe(SCardConnect(ctx, leser, SCARD_SHARE_SHARED, SCARD_PROTOCOL_T1 | SCARD_PROTOCOL_T0, out card, out proto), "Keine Karte im Leser");
      try {
        Pruefe(SCardBeginTransaction(card), "Karte belegt");
        try {
          var pci = new IoRequest { Protocol = proto, PciLength = 8 };
          foreach (var hex in apdus) {
            var apdu = AusHex(hex);
            var antwort = Sende(card, ref pci, apdu);
            antworten.Add(Hex(antwort, antwort.Length));
            int n = antwort.Length;
            string sw = n >= 2 ? Hex(new[] { antwort[n - 2], antwort[n - 1] }, 2) : "";
            if (sw != "9000" && sw != "6282") break;
          }
        } finally { SCardEndTransaction(card, SCARD_LEAVE_CARD); }
      } finally { SCardDisconnect(card, SCARD_RESET_CARD); }
      return antworten;
    } finally { SCardReleaseContext(ctx); }
  }

  static byte[] Sende(IntPtr card, ref IoRequest pci, byte[] apdu) {
    var recv = new byte[4096]; int rl = recv.Length;
    Pruefe(SCardTransmit(card, ref pci, apdu, apdu.Length, IntPtr.Zero, recv, ref rl), "Übertragung zur Karte");
    // T=0: 61xx = Daten abholen (GET RESPONSE), 6Cxx = mit richtiger Länge wiederholen
    if (rl == 2 && recv[0] == 0x61) {
      var get = new byte[] { 0x00, 0xC0, 0x00, 0x00, recv[1] };
      rl = recv.Length;
      Pruefe(SCardTransmit(card, ref pci, get, get.Length, IntPtr.Zero, recv, ref rl), "Übertragung zur Karte");
    } else if (rl == 2 && recv[0] == 0x6C) {
      var neu = (byte[])apdu.Clone(); neu[neu.Length - 1] = recv[1];
      rl = recv.Length;
      Pruefe(SCardTransmit(card, ref pci, neu, neu.Length, IntPtr.Zero, recv, ref rl), "Übertragung zur Karte");
    }
    var aus = new byte[rl]; Array.Copy(recv, aus, rl); return aus;
  }
}
'@

# ---------------------------------------------------------------------------
# Minimaler HTTP-Server (TcpListener: braucht keine URL-Reservierung und keine Adminrechte)
# ---------------------------------------------------------------------------

function Antworte($stream, [int] $status, $objekt) {
  $texte = @{ 200 = 'OK'; 400 = 'Bad Request'; 401 = 'Unauthorized'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 413 = 'Payload Too Large'; 500 = 'Internal Server Error'; 503 = 'Service Unavailable' }
  $json  = ConvertTo-Json -InputObject $objekt -Depth 5 -Compress
  $body  = [System.Text.Encoding]::UTF8.GetBytes($json)
  $kopf  = "HTTP/1.1 $status $($texte[$status])`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
  $k = [System.Text.Encoding]::ASCII.GetBytes($kopf)
  $stream.Write($k, 0, $k.Length)
  $stream.Write($body, 0, $body.Length)
  $stream.Flush()
}

function LeseAnfrage($stream) {
  $puffer = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 4096
  $kopfEnde = -1
  while ($kopfEnde -lt 0) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { return $null }
    $puffer.Write($buf, 0, $n)
    if ($puffer.Length -gt 65536) { return @{ zuGross = $true } }
    $text = [System.Text.Encoding]::ASCII.GetString($puffer.ToArray())
    $kopfEnde = $text.IndexOf("`r`n`r`n")
  }
  $zeilen = @($text.Substring(0, $kopfEnde) -split "`r`n" | Where-Object { $_ })
  $erste  = $zeilen[0].Split(' ')
  $kopf = @{}
  foreach ($z in $zeilen | Select-Object -Skip 1) {
    $i = $z.IndexOf(':'); if ($i -gt 0) { $kopf[$z.Substring(0, $i).Trim().ToLowerInvariant()] = $z.Substring($i + 1).Trim() }
  }
  $laenge = 0; if ($kopf['content-length']) { $laenge = [int]$kopf['content-length'] }
  if ($laenge -gt 65536) { return @{ zuGross = $true } }
  $alle = $puffer.ToArray()
  $bodyStart = $kopfEnde + 4
  while ($alle.Length - $bodyStart -lt $laenge) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $puffer.Write($buf, 0, $n); $alle = $puffer.ToArray()
  }
  $body = if ($laenge -gt 0) { [System.Text.Encoding]::UTF8.GetString($alle, $bodyStart, [Math]::Min($laenge, $alle.Length - $bodyStart)) } else { '' }
  return @{ methode = $erste[0]; pfad = $erste[1]; kopf = $kopf; body = $body }
}

function GleicherSchluessel([string] $a, [string] $b) {
  if ($a.Length -ne $b.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ([int][char]$a[$i] -bxor [int][char]$b[$i]) }
  return $diff -eq 0
}

function Bearbeite($anfrage, $stream) {
  if ($anfrage.zuGross) { Antworte $stream 413 @{ fehler = 'Anfrage zu groß' }; return }
  $auth = $anfrage.kopf['authorization']
  if (-not $auth -or -not $auth.StartsWith('Bearer ') -or -not (GleicherSchluessel $auth.Substring(7) $Schluessel)) {
    Log "abgewiesen: $($anfrage.methode) $($anfrage.pfad) ohne gültigen Schlüssel"
    Antworte $stream 401 @{ fehler = 'Schlüssel fehlt oder ist falsch' }; return
  }
  switch ($anfrage.pfad) {
    '/leser' {
      if ($anfrage.methode -ne 'GET') { Antworte $stream 405 @{ fehler = 'nur GET' }; return }
      $liste = @([KassaPcSc]::Leser() | ForEach-Object { @{ name = $_[0]; atr = $_[1] } })
      Antworte $stream 200 @{ leser = $liste; version = $VERSION }
    }
    '/apdu' {
      if ($anfrage.methode -ne 'POST') { Antworte $stream 405 @{ fehler = 'nur POST' }; return }
      $daten = $anfrage.body | ConvertFrom-Json
      if (-not $daten.leser -or -not $daten.apdus -or @($daten.apdus).Count -gt 64) { Antworte $stream 400 @{ fehler = 'leser und apdus (höchstens 64) nötig' }; return }
      try {
        $antworten = @([KassaPcSc]::Sitzung([string]$daten.leser, [string[]]@($daten.apdus)))
      } catch [System.Management.Automation.MethodInvocationException] {
        $inner = $_.Exception.InnerException
        Log "Sitzung fehlgeschlagen: $($inner.Message)"
        Antworte $stream 404 @{ fehler = $inner.Message; antworten = @() }; return
      }
      $sws = ($antworten | ForEach-Object { if ($_.Length -ge 4) { $_.Substring($_.Length - 4) } else { '----' } }) -join ' '
      Log "Sitzung $($daten.leser): $(@($daten.apdus).Count) APDUs, SW $sws"
      Antworte $stream 200 @{ antworten = $antworten }
    }
    default { Antworte $stream 404 @{ fehler = 'unbekannter Pfad' } }
  }
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse($Adresse)), $Port
$listener.Start()
Log "Kartenbrücke v$VERSION lauscht auf ${Adresse}:$Port"
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      $anfrage = LeseAnfrage $stream
      if ($anfrage) {
        try { Bearbeite $anfrage $stream }
        catch {
          Log "Fehler: $($_.Exception.Message)"
          try { Antworte $stream 500 @{ fehler = $_.Exception.Message } } catch { }
        }
      }
    } catch {
      Log "Verbindung abgebrochen: $($_.Exception.Message)"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
