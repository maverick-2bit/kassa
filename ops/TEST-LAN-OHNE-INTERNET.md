# Test vor Ort: Kassa im LAN ohne Internet

Ziel: Nachweisen, dass Kassa, Bonierdrucker, Küchenbildschirme (KDS), Kundendisplay und
Kellner-Geräte im lokalen Netz weiterlaufen, wenn das Internet ausfällt — z. B. hinter einem
Unifi Cloud Gateway (UCG), alle Geräte mit fester IP.

Automatisch geprüft (jede CI): `packages/backend/tests/integration/lan-ohne-internet.test.ts`
(Backend: Drucker, KDS, Verkauf, Z-Bon, A-Trust ohne Internet, mit Zeitmessung),
`packages/frontend/e2e/zy-lan-ohne-internet.spec.ts` (Browser: keine einzige Anfrage ins
Internet) und `packages/frontend/src/lib/lan-ohne-internet.test.ts` (keine App lädt Schriften,
Skripte oder Bilder von außen). Diese Checkliste deckt ab, was nur der echte Aufbau zeigen kann:
Gateway, WLAN, Tablets, Drucker-Hardware, Kartenterminal, Neustart.

---

## Was ohne Internet geht — und was nicht

| Funktion | Ohne Internet | Hinweis |
|---|---|---|
| Bonieren an Bonierdrucker (Schank, Küche …) | ✅ | direkt per IP:Port (ESC/POS) |
| KDS-Geräte mit fester IP / Browser-KDS | ✅ | direkt per IP bzw. LAN-Verbindung zur Kassa |
| Kundendisplay, Kellner-App, Kasse am Tablet | ✅ | alles kommt vom Kassen-PC, nichts aus dem Internet |
| Bestellsystem ohne Beleg (nur Bonieren) | ✅ | braucht keine Signatureinheit |
| Verkauf mit Software-Signatur (lokal) | ✅ | signiert sofort — laut Entscheidung nur Test/Demo (siehe unten) |
| Verkauf mit A-Trust (online) | ⚠️ Ausfallmodus | 1. Verkauf wartet ~2,5 s, dann Belege mit Vermerk „Sicherheitseinrichtung ausgefallen", ohne Wartezeit |
| Rückkehr aus dem Ausfallmodus | ✅ automatisch | Hintergrundsonde (≤ 1 min nach Rückkehr des Internets), signierter Sammelbeleg — bei Ausfall unter 48 h |
| Ausfall ≥ 48 h | ⚠️ Meldung nötig | FinanzOnline-Meldung über den roten Banner, sobald Internet da ist |
| Kartenzahlung (ZVT-Terminal) | ❌ meist nicht | das Terminal braucht selbst Internet zur Autorisierung (Offline-/Floor-Limit beim Anbieter erfragen) |
| Z-Bon drucken | ✅ | sofort |
| Z-Bon per E-Mail | ❌ geht verloren | wird NICHT nachgeschickt — Z-Bon im Ausfall später erneut senden/ausdrucken |
| Gast-Onlinebestellung mit Stripe, Ticketshop-Zahlung | ❌ | Zahlungsanbieter nicht erreichbar |
| Update-Prüfung, Fernwartung (TeamViewer), Off-Site-Backup, Leitstand | ❌ | holen nach, sobald Internet da ist; lokale DB-Sicherung läuft weiter |

**Lokale Signatur ohne Internet (RKSV-konform):** Heute gibt es zwei Signaturarten: Software
(nur Test/Demo, nicht für den Echtbetrieb) und A-Trust online. Eine lokal signierende,
RKSV-taugliche Einheit (z. B. A-Trust-Signaturkarte „a.sign RK CHIP" am Kassen-PC) ist noch
nicht angebunden — mit A-Trust online läuft die Kassa ohne Internet im Ausfallmodus weiter.

---

## Vorbereitung (mit Internet)

1. **Feste IPs** im Unifi-Netzwerk (Client → *Fixed IP* bzw. DHCP-Reservierung) für:
   Kassen-PC, jeden Drucker, jedes KDS-Gerät, Kundendisplay, Tablets/Kellner-Handys.
   Notieren:

   | Gerät | IP | Port | in der Kassa eingetragen? |
   |---|---|---|---|
   | Kassen-PC | | 80 | — |
   | Bondrucker | | 9100 | ☐ |
   | Bonierdrucker Schank | | 9100 | ☐ |
   | Bonierdrucker Küche | | 9100 | ☐ |
   | KDS Küche | | | ☐ |
   | Kundendisplay | | | ☐ |
   | Kartenterminal | | | ☐ |

2. **In der Kassa nur IP-Adressen** eintragen (Drucker, KDS-Stationen), keine Gerätenamen —
   Namen brauchen DNS. Tablets und Displays rufen die Kassa ebenfalls **per IP** auf
   (`http://<IP-Kassen-PC>/…`, QR-Codes unter *Einstellungen → Geräte*).
3. **Jedes Gerät** einmal mit Internet öffnen und die Seite neu laden (die App legt sich dabei
   für den Offline-Fall im Gerät ab).
4. **Android-Tablets/-Handys:** WLAN der Kassa → „Verbindung beibehalten / Ohne Internet
   verbinden" aktivieren; „Mobile Daten bei schlechtem WLAN" bzw. „Adaptives WLAN" ausschalten
   — sonst wechselt das Gerät ohne Internet aufs Mobilnetz und erreicht die Kassa nicht mehr.
   **iPad/iPhone:** Einstellungen → Mobilfunk → „WLAN-Unterstützung" aus.
5. **Kartenterminal:** beim Anbieter klären, ob es ohne Internet (Offline-Limit) zahlt.
6. **Uhrzeit Kassen-PC** prüfen (Windows: Einstellungen → Zeit). Ohne Internet gibt es keine
   Zeitsynchronisation; die Kassa verweigert Belege, wenn die Uhr *vor* dem letzten Beleg steht.
7. Testartikel anlegen: je einer für Schank und Küche (mit Bonierdrucker), einer ohne Station.

## Test (Internet weg)

**Internet trennen:** WAN-Kabel am UCG ziehen (oder WAN-Port in Unifi deaktivieren). Das LAN
und WLAN bleiben an, das Gateway vergibt weiter Adressen.

| # | Schritt | Erwartung | Zeit / ok |
|---|---|---|---|
| 1 | Kasse am Kassen-PC und an einem Tablet neu laden | Kasse erscheint, Artikel sichtbar | ☐ |
| 2 | Kellner-App: Tisch öffnen, Schank- + Küchenartikel bonieren | Schank- und Küchendrucker drucken getrennt, < 2 s | ☐ |
| 3 | KDS aktiv: Bon erscheint an der richtigen Station; „Erledigt" | Runner-Bon druckt | ☐ |
| 4 | Kundendisplay während eines Verkaufs | zeigt Positionen/Summe | ☐ |
| 5 | Barverkauf an der Kasse | Bon druckt. A-Trust: 1. Verkauf ~3 s, danach roter Banner „Signatureinheit ausgefallen", weitere Verkäufe ohne Wartezeit, Bon mit Vermerk | ☐ |
| 6 | Tisch abrechnen (bar) | Beleg + Bon | ☐ |
| 7 | Kartenzahlung | Terminal: zahlt (Offline-Limit) oder lehnt ab → Kasse meldet es; danach bar kassieren | ☐ |
| 8 | Tablet: WLAN aus/an, Seite neu laden | Kasse wieder da (Gerät wechselt NICHT ins Mobilnetz) | ☐ |
| 9 | Kassen-PC neu starten (ohne Internet) | Kassa startet von selbst, Schritte 1–5 klappen wieder | ☐ |
| 10 | Z-Bon drucken | druckt sofort (Mail kommt nicht — siehe oben) | ☐ |

Fällt etwas durch: notieren *welches Gerät, welche IP, was angezeigt wurde*, und unter
*Einstellungen → System* die Versionsnummer.

## Danach (Internet wieder da)

1. WAN-Kabel wieder einstecken.
2. A-Trust: Innerhalb von etwa einer Minute verschwindet der rote Banner von selbst; in der
   Belegliste steht ein **Sammelbeleg** (signierter Nullbeleg). Bei einem Ausfall ≥ 48 h die
   FinanzOnline-Meldung über den Banner abschicken.
3. Z-Bon-Mail des Testtags bei Bedarf erneut auslösen.
4. Offline erfasste Verkäufe (Tablets mit Verbindungsabbruch): blauer Balken
   „… werden nachgebucht" verschwindet; ein roter Balken nennt abgelehnte Verkäufe.
