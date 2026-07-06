/**
 * A4-Rechnungsdruck via Browser Print API.
 * Generiert ein sauberes HTML-Dokument und öffnet den Druckdialog.
 * Der Benutzer kann direkt drucken oder als PDF speichern.
 */

import type { AngebotPosition, AngebotResponse, BelegResponse, GutscheinResponse, LiferscheinResponse, SammelrechnungResponse } from '@kassa/shared'

interface MandantInfo {
  firmenname: string
  uid:        string
}

// ---------------------------------------------------------------------------
// MwSt-Hilfsfunktionen
// ---------------------------------------------------------------------------

const MWST_SAETZE: Record<string, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:        0,
  besonders:   5,
}

function mwstFaktor(satz: string): number {
  return 1 + (MWST_SAETZE[satz] ?? 0) / 100
}

function centZuEuro(cent: number): string {
  return (cent / 100).toFixed(2).replace('.', ',')
}

function formatDatumDe(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Europe/Vienna',
  })
}

// ---------------------------------------------------------------------------
// Steueraufteilung berechnen
// ---------------------------------------------------------------------------

interface SteuerZeile {
  label:      string
  satz:       number
  bruttoCent: number
  nettoCent:  number
  ustCent:    number
}

/** Steueraufteilung aus Angebot-Positionen berechnen (gruppiert nach MwSt-Satz) */
function berechneSteueraufteilungVonPositionen(positionen: AngebotPosition[]): SteuerZeile[] {
  const LABELS: Record<string, string> = {
    normal:      '20 % (Normal)',
    ermaessigt1: '10 % (Ermäßigt)',
    ermaessigt2: '13 % (Ermäßigt 2)',
    besonders:   '5 % (Besonders)',
    null:        '0 % (Steuerfrei)',
  }
  const gruppen = new Map<string, number>()
  for (const p of positionen) {
    const prev = gruppen.get(p.mwstSatz) ?? 0
    gruppen.set(p.mwstSatz, prev + Math.round(p.einzelpreisBreutto * p.menge))
  }
  const zeilen: SteuerZeile[] = []
  for (const [satz, bruttoCent] of gruppen) {
    if (bruttoCent === 0) continue
    const faktor    = mwstFaktor(satz)
    const nettoCent = Math.round(bruttoCent / faktor)
    zeilen.push({
      label:      LABELS[satz] ?? satz,
      satz:       MWST_SAETZE[satz] ?? 0,
      bruttoCent,
      nettoCent,
      ustCent:    bruttoCent - nettoCent,
    })
  }
  return zeilen
}

function berechneSteueraufteilung(beleg: BelegResponse): SteuerZeile[] {
  const eintraege = [
    ['normal',      '20 % (Normal)',       beleg.betraege.normal],
    ['ermaessigt1', '10 % (Ermäßigt)',     beleg.betraege.ermaessigt1],
    ['ermaessigt2', '13 % (Ermäßigt 2)',   beleg.betraege.ermaessigt2],
    ['besonders',   '5 % (Besonders)',      beleg.betraege.besonders],
    ['null',        '0 % (Steuerfrei)',     beleg.betraege.null],
  ] as const

  return eintraege
    .filter(([, , cent]) => cent !== 0)
    .map(([satz, label, bruttoCent]) => {
      const faktor    = mwstFaktor(satz)
      const nettoCent = Math.round(bruttoCent / faktor)
      return {
        label,
        satz:    MWST_SAETZE[satz] ?? 0,
        bruttoCent,
        nettoCent,
        ustCent: bruttoCent - nettoCent,
      }
    })
}

// ---------------------------------------------------------------------------
// Gemeinsames CSS
// ---------------------------------------------------------------------------

function generiereBaseCss(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    background: white;
  }
  .seite {
    max-width: 210mm;
    margin: 0 auto;
    padding: 15mm 15mm 20mm 20mm;
  }
  .kopf {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12mm;
    padding-bottom: 6mm;
    border-bottom: 2px solid #1a1a1a;
  }
  .firmenname {
    font-size: 18pt;
    font-weight: bold;
    line-height: 1.2;
  }
  .firmen-uid {
    font-size: 9pt;
    color: #555;
    margin-top: 2mm;
  }
  .rechnungstitel {
    text-align: right;
  }
  .rechnungstitel h1 {
    font-size: 20pt;
    font-weight: bold;
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .rechnungstitel .meta {
    font-size: 9pt;
    color: #555;
    margin-top: 2mm;
  }
  .adressen {
    display: flex;
    gap: 20mm;
    margin-bottom: 10mm;
  }
  .adress-block {
    flex: 1;
    font-size: 10pt;
    line-height: 1.6;
  }
  .adress-block .label {
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #888;
    margin-bottom: 2mm;
  }
  .text-grau { color: #888; }
  .positionen-tabelle {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 6mm;
    font-size: 10pt;
  }
  .positionen-tabelle thead tr {
    background: #f5f5f5;
    border-bottom: 1px solid #ccc;
  }
  .positionen-tabelle th {
    padding: 2.5mm 3mm;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #555;
    font-weight: 600;
  }
  .positionen-tabelle td {
    padding: 2.5mm 3mm;
    border-bottom: 1px solid #eee;
    vertical-align: top;
  }
  .pos-bezeichnung { width: 45%; }
  .pos-menge       { width: 10%; text-align: center; }
  .pos-einzelpreis { width: 18%; text-align: right; }
  .pos-mwst        { width: 10%; text-align: center; color: #666; }
  .pos-gesamt      { width: 17%; text-align: right; font-weight: 600; }
  .abschluss {
    display: flex;
    gap: 10mm;
    margin-top: 4mm;
  }
  .steuer-tabelle {
    flex: 1;
    border-collapse: collapse;
    font-size: 9pt;
  }
  .steuer-tabelle th {
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    padding: 1.5mm 2mm;
    border-bottom: 1px solid #ddd;
  }
  .steuer-tabelle td {
    padding: 1.5mm 2mm;
    border-bottom: 1px solid #f0f0f0;
  }
  .rechts { text-align: right; }
  .gesamt-box {
    min-width: 65mm;
    border: 1px solid #ccc;
    border-radius: 3mm;
    padding: 4mm 5mm;
    font-size: 10pt;
  }
  .gesamt-zeile {
    display: flex;
    justify-content: space-between;
    padding: 1mm 0;
    color: #555;
  }
  .gesamt-zeile.netto { font-size: 9pt; }
  .gesamt-zeile.ust   { font-size: 9pt; }
  .gesamt-zeile.gesamt {
    font-size: 14pt;
    font-weight: bold;
    color: #1a1a1a;
    border-top: 2px solid #1a1a1a;
    margin-top: 2mm;
    padding-top: 2mm;
  }
  .zahlung-info {
    margin-top: 2mm;
    font-size: 9pt;
    color: #555;
    text-align: right;
  }
  .fusszeile {
    margin-top: 10mm;
    padding-top: 4mm;
    border-top: 1px solid #ddd;
    font-size: 8pt;
    color: #888;
    display: flex;
    justify-content: space-between;
    gap: 5mm;
  }
  .rksv-code {
    font-family: 'Courier New', monospace;
    font-size: 7pt;
    word-break: break-all;
    max-width: 140mm;
    color: #aaa;
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .seite { padding: 0; max-width: 100%; }
    @page { size: A4; margin: 15mm 15mm 20mm 20mm; }
  }`
}

// ---------------------------------------------------------------------------
// HTML-Generierung
// ---------------------------------------------------------------------------

export function generiereRechnungHtml(beleg: BelegResponse, mandant: MandantInfo): string {
  const steuer    = berechneSteueraufteilung(beleg)
  const gesamtNetto = steuer.reduce((s, z) => s + z.nettoCent, 0)
  const gesamtUst   = steuer.reduce((s, z) => s + z.ustCent,   0)

  const zahlungsarten: string[] = []
  if (beleg.summeBarCent   > 0) zahlungsarten.push(`Bar € ${centZuEuro(beleg.summeBarCent)}`)
  if (beleg.summeKarteCent > 0) zahlungsarten.push(`Karte € ${centZuEuro(beleg.summeKarteCent)}`)
  if (beleg.summeSonstigeCent > 0) zahlungsarten.push(`Sonstige € ${centZuEuro(beleg.summeSonstigeCent)}`)

  const positionenHtml = beleg.positionen.map(p => `
    <tr>
      <td class="pos-bezeichnung">${esc(p.bezeichnung)}</td>
      <td class="pos-menge">${p.menge}</td>
      <td class="pos-einzelpreis">€ ${centZuEuro(p.einzelpreisBreutto)}</td>
      <td class="pos-mwst">${MWST_SAETZE[p.mwstSatz] ?? 0} %</td>
      <td class="pos-gesamt">€ ${centZuEuro(p.einzelpreisBreutto * p.menge)}</td>
    </tr>`).join('')

  const steuerHtml = steuer.map(z => `
    <tr>
      <td>${esc(z.label)}</td>
      <td class="rechts">€ ${centZuEuro(z.nettoCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.ustCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.bruttoCent)}</td>
    </tr>`).join('')

  const kundeHtml = beleg.kunde ? `
    <div class="adress-block">
      <strong>${esc(beleg.kunde.bezeichnung)}</strong><br>
      ${beleg.kunde.strasse ? `${esc(beleg.kunde.strasse)}<br>` : ''}
      ${(beleg.kunde.plz || beleg.kunde.ort)
        ? `${[beleg.kunde.plz, beleg.kunde.ort].filter(Boolean).map(esc).join(' ')}<br>`
        : ''}
      ${beleg.kunde.uid ? `UID: ${esc(beleg.kunde.uid)}<br>` : ''}
      ${beleg.kunde.email ? esc(beleg.kunde.email) : ''}
    </div>` : '<div class="adress-block text-grau">Barkunde</div>'

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Rechnung #${beleg.belegNummer} – ${mandant.firmenname}</title>
<style>${generiereBaseCss()}</style>
</head>
<body>
<div class="seite">

  <!-- Kopfzeile -->
  <div class="kopf">
    <div>
      <div class="firmenname">${esc(mandant.firmenname)}</div>
      <div class="firmen-uid">UID: ${esc(mandant.uid)}</div>
    </div>
    <div class="rechnungstitel">
      <h1>Rechnung</h1>
      <div class="meta">
        Nr. ${beleg.belegNummer}<br>
        Datum: ${formatDatumDe(beleg.belegDatum)}<br>
        Kassen-Beleg-Nr.: #${beleg.belegNummer}
      </div>
    </div>
  </div>

  <!-- Adressen -->
  <div class="adressen">
    <div class="adress-block">
      <div class="label">Rechnungsempfänger</div>
      ${kundeHtml}
    </div>
    <div class="adress-block">
      <div class="label">Leistungsdatum</div>
      ${formatDatumDe(beleg.belegDatum)}
    </div>
  </div>

  <!-- Positionen -->
  <table class="positionen-tabelle">
    <thead>
      <tr>
        <th class="pos-bezeichnung">Bezeichnung</th>
        <th class="pos-menge">Menge</th>
        <th class="pos-einzelpreis">Einzelpreis</th>
        <th class="pos-mwst">MwSt</th>
        <th class="pos-gesamt">Gesamt</th>
      </tr>
    </thead>
    <tbody>
      ${positionenHtml}
    </tbody>
  </table>

  <!-- Steueraufteilung + Gesamtbetrag -->
  <div class="abschluss">
    <div>
      ${steuer.length > 0 ? `
      <table class="steuer-tabelle">
        <thead>
          <tr>
            <th>Steuersatz</th>
            <th class="rechts">Netto</th>
            <th class="rechts">MwSt</th>
            <th class="rechts">Brutto</th>
          </tr>
        </thead>
        <tbody>
          ${steuerHtml}
          ${steuer.length > 1 ? `
          <tr style="font-weight:600; border-top: 1px solid #ccc;">
            <td>Gesamt</td>
            <td class="rechts">€ ${centZuEuro(gesamtNetto)}</td>
            <td class="rechts">€ ${centZuEuro(gesamtUst)}</td>
            <td class="rechts">€ ${centZuEuro(beleg.gesamtbetragCent)}</td>
          </tr>` : ''}
        </tbody>
      </table>` : ''}
    </div>
    <div class="gesamt-box">
      ${gesamtNetto !== beleg.gesamtbetragCent ? `
      <div class="gesamt-zeile netto">
        <span>Netto</span><span>€ ${centZuEuro(gesamtNetto)}</span>
      </div>
      <div class="gesamt-zeile ust">
        <span>MwSt</span><span>€ ${centZuEuro(gesamtUst)}</span>
      </div>` : ''}
      <div class="gesamt-zeile gesamt">
        <span>Gesamt</span><span>€ ${centZuEuro(beleg.gesamtbetragCent)}</span>
      </div>
      <div class="zahlung-info">Zahlung: ${zahlungsarten.join(' + ') || '—'}</div>
    </div>
  </div>

  <!-- Fußzeile -->
  <div class="fusszeile">
    <div>
      Dieser Beleg wurde gemäß RKSV elektronisch signiert.<br>
      Belegtyp: ${esc(beleg.belegTyp)} | Zertifikat-SN: ${esc(beleg.zertifikatSn)}
    </div>
    <div class="rksv-code" title="RKSV-Maschinencode">
      ${esc(beleg.maschinenlesbareCode)}
    </div>
  </div>

</div>
<script>window.onload = () => window.print()</script>
</body>
</html>`
}

function esc(s: string | undefined | null): string {
  if (!s) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Drucken / PDF-Download
// ---------------------------------------------------------------------------

export function druckeRechnung(beleg: BelegResponse, mandant: MandantInfo): void {
  const html = generiereRechnungHtml(beleg, mandant)
  const win  = window.open('', '_blank', 'width=900,height=1200')
  if (!win) {
    alert('Bitte Pop-ups für diese Seite erlauben, um die Rechnung zu öffnen.')
    return
  }
  win.document.write(html)
  win.document.close()
}

// ---------------------------------------------------------------------------
// Angebot-PDF
// ---------------------------------------------------------------------------

export function generiereAngebotHtml(angebot: AngebotResponse, mandant: MandantInfo): string {
  const steuer    = berechneSteueraufteilungVonPositionen(angebot.positionen)
  const gesamtNetto = steuer.reduce((s, z) => s + z.nettoCent, 0)
  const gesamtUst   = steuer.reduce((s, z) => s + z.ustCent,   0)

  const positionenHtml = angebot.positionen.map(p => `
    <tr>
      <td class="pos-bezeichnung">${esc(p.bezeichnung)}</td>
      <td class="pos-menge">${p.menge}</td>
      <td class="pos-einzelpreis">€ ${centZuEuro(p.einzelpreisBreutto)}</td>
      <td class="pos-mwst">${MWST_SAETZE[p.mwstSatz] ?? 0} %</td>
      <td class="pos-gesamt">€ ${centZuEuro(p.einzelpreisBreutto * p.menge)}</td>
    </tr>`).join('')

  const steuerHtml = steuer.map(z => `
    <tr>
      <td>${esc(z.label)}</td>
      <td class="rechts">€ ${centZuEuro(z.nettoCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.ustCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.bruttoCent)}</td>
    </tr>`).join('')

  const kundeHtml = angebot.kunde ? `
    <div class="adress-block">
      <strong>${esc(angebot.kunde.bezeichnung)}</strong><br>
      ${angebot.kunde.strasse ? `${esc(angebot.kunde.strasse)}<br>` : ''}
      ${(angebot.kunde.plz || angebot.kunde.ort)
        ? `${[angebot.kunde.plz, angebot.kunde.ort].filter(Boolean).map(esc).join(' ')}<br>`
        : ''}
      ${angebot.kunde.uid ? `UID: ${esc(angebot.kunde.uid)}<br>` : ''}
      ${angebot.kunde.email ? esc(angebot.kunde.email) : ''}
    </div>` : '<div class="adress-block text-grau">Kein Kunde zugewiesen</div>'

  // Basis-CSS aus Rechnung wiederverwenden (inline)
  const css = generiereBaseCss()

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Angebot A-${String(angebot.nummer).padStart(4, '0')} – ${mandant.firmenname}</title>
<style>${css}
  .angebot-hinweis {
    background: #fffbeb; border: 1px solid #fbbf24;
    border-radius: 4px; padding: 8px 12px;
    font-size: 9pt; color: #92400e;
    margin-bottom: 6mm;
  }
</style>
</head>
<body>
<div class="seite">

  <div class="kopf">
    <div>
      <div class="firmenname">${esc(mandant.firmenname)}</div>
      <div class="firmen-uid">UID: ${esc(mandant.uid)}</div>
    </div>
    <div class="rechnungstitel">
      <h1>Angebot</h1>
      <div class="meta">
        Nr. A-${String(angebot.nummer).padStart(4, '0')}<br>
        Datum: ${formatDatumDe(angebot.datum)}<br>
        ${angebot.gueltigBis ? `Gültig bis: <strong>${formatDatumDe(angebot.gueltigBis + 'T00:00:00Z')}</strong>` : 'Gültigkeitsdatum: auf Anfrage'}
      </div>
    </div>
  </div>

  <div class="angebot-hinweis">
    Dieses Angebot ist freibleibend und stellt keine verbindliche Rechnung dar.
    ${angebot.gueltigBis ? `Angebot gültig bis ${formatDatumDe(angebot.gueltigBis + 'T00:00:00Z')}.` : ''}
  </div>

  <div class="adressen">
    <div class="adress-block">
      <div class="label">Angebot für</div>
      ${kundeHtml}
    </div>
    <div class="adress-block">
      <div class="label">Angebotsdatum</div>
      ${formatDatumDe(angebot.datum)}
    </div>
  </div>

  ${angebot.notiz ? `<div style="margin-bottom:6mm;font-size:10pt;color:#555;border-left:3px solid #ddd;padding-left:8px">${esc(angebot.notiz)}</div>` : ''}

  <table class="positionen-tabelle">
    <thead>
      <tr>
        <th class="pos-bezeichnung">Bezeichnung</th>
        <th class="pos-menge">Menge</th>
        <th class="pos-einzelpreis">Einzelpreis</th>
        <th class="pos-mwst">MwSt</th>
        <th class="pos-gesamt">Gesamt</th>
      </tr>
    </thead>
    <tbody>${positionenHtml}</tbody>
  </table>

  <div class="abschluss">
    <div>
      ${steuer.length > 0 ? `
      <table class="steuer-tabelle">
        <thead>
          <tr>
            <th>Steuersatz</th>
            <th class="rechts">Netto</th>
            <th class="rechts">MwSt</th>
            <th class="rechts">Brutto</th>
          </tr>
        </thead>
        <tbody>
          ${steuerHtml}
          ${steuer.length > 1 ? `
          <tr style="font-weight:600;border-top:1px solid #ccc">
            <td>Gesamt</td>
            <td class="rechts">€ ${centZuEuro(gesamtNetto)}</td>
            <td class="rechts">€ ${centZuEuro(gesamtUst)}</td>
            <td class="rechts">€ ${centZuEuro(angebot.gesamtbetragCent)}</td>
          </tr>` : ''}
        </tbody>
      </table>` : ''}
    </div>
    <div class="gesamt-box">
      ${gesamtNetto !== angebot.gesamtbetragCent ? `
      <div class="gesamt-zeile netto">
        <span>Netto</span><span>€ ${centZuEuro(gesamtNetto)}</span>
      </div>
      <div class="gesamt-zeile ust">
        <span>MwSt</span><span>€ ${centZuEuro(gesamtUst)}</span>
      </div>` : ''}
      <div class="gesamt-zeile gesamt">
        <span>Angebotssumme</span><span>€ ${centZuEuro(angebot.gesamtbetragCent)}</span>
      </div>
    </div>
  </div>

  <div class="fusszeile">
    <div>${esc(mandant.firmenname)} | UID: ${esc(mandant.uid)}</div>
    <div style="text-align:right;color:#bbb;font-size:7pt">
      Dieses Dokument wurde elektronisch erstellt und ist ohne Unterschrift gültig.
    </div>
  </div>

</div>
<script>window.onload = () => window.print()</script>
</body>
</html>`
}

export function druckeAngebot(angebot: AngebotResponse, mandant: MandantInfo): void {
  const html = generiereAngebotHtml(angebot, mandant)
  const win  = window.open('', '_blank', 'width=900,height=1200')
  if (!win) {
    alert('Bitte Pop-ups für diese Seite erlauben.')
    return
  }
  win.document.write(html)
  win.document.close()
}

// ---------------------------------------------------------------------------
// Lieferschein-PDF  (keine Preise)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lieferschein-Hilfsfunktionen (intern)
// ---------------------------------------------------------------------------

function lieferscheinKundeHtml(ls: LiferscheinResponse): string {
  if (!ls.kunde) return '<div class="adress-block text-grau">Kein Kunde zugewiesen</div>'
  const k = ls.kunde
  return `
    <div class="adress-block">
      <strong>${esc(k.bezeichnung)}</strong><br>
      ${k.strasse ? `${esc(k.strasse)}<br>` : ''}
      ${(k.plz || k.ort) ? `${[k.plz, k.ort].filter(Boolean).map(esc).join(' ')}<br>` : ''}
      ${k.uid   ? `UID: ${esc(k.uid)}<br>` : ''}
      ${k.email ? esc(k.email) : ''}
    </div>`
}

const LIEFERSCHEIN_CSS = `
  .ls-tabelle {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 10mm;
    font-size: 10pt;
  }
  .ls-tabelle thead tr { background: #f5f5f5; border-bottom: 2px solid #ccc; }
  .ls-tabelle th {
    padding: 2.5mm 3mm;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #555;
    font-weight: 600;
  }
  .ls-tabelle td { padding: 3mm 3mm; border-bottom: 1px solid #eee; vertical-align: top; }
  .ls-tabelle tbody tr:nth-child(even) { background: #fafafa; }
  .ls-pos         { width: 8%;  text-align: center; color: #999; font-size: 9pt; }
  .ls-bezeichnung { width: 72%; }
  .ls-menge       { width: 10%; text-align: right; font-weight: 600; }
  .ls-einheit     { width: 10%; padding-left: 4px; color: #666; }
  .referenz-box {
    background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 3mm;
    padding: 3mm 5mm; font-size: 9pt; color: #555; margin-bottom: 8mm;
  }
  .unterschrift-block { margin-top: 16mm; display: flex; gap: 20mm; }
  .unterschrift-feld {
    flex: 1; border-top: 1px solid #999; padding-top: 2mm; font-size: 8pt; color: #888;
  }
`

export function generiereLiferscheinHtml(ls: LiferscheinResponse, mandant: MandantInfo): string {
  const lieferNr  = `L-${String(ls.nummer).padStart(4, '0')}`
  const angebotNr = `A-${String(ls.angebotNummer).padStart(4, '0')}`

  const positionenHtml = ls.positionen.map((p, i) => `
    <tr>
      <td class="ls-pos">${i + 1}</td>
      <td class="ls-bezeichnung">${esc(p.bezeichnung)}${
        p.seriennummern && p.seriennummern.length > 0
          ? `<div style="font-size:9px;color:#555;margin-top:2px">Seriennummern: ${p.seriennummern.map(esc).join(', ')}</div>`
          : ''
      }</td>
      <td class="ls-menge">${p.menge % 1 === 0 ? p.menge.toFixed(0) : p.menge}</td>
      <td class="ls-einheit">Stk.</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Lieferschein ${lieferNr} – ${mandant.firmenname}</title>
<style>${generiereBaseCss()}${LIEFERSCHEIN_CSS}</style>
</head>
<body>
<div class="seite">
  <div class="kopf">
    <div>
      <div class="firmenname">${esc(mandant.firmenname)}</div>
      <div class="firmen-uid">UID: ${esc(mandant.uid)}</div>
    </div>
    <div class="rechnungstitel">
      <h1>Lieferschein</h1>
      <div class="meta">
        Nr. ${lieferNr}<br>
        Datum: ${formatDatumDe(ls.datum)}<br>
        Zu Angebot: ${angebotNr}
      </div>
    </div>
  </div>
  <div class="adressen">
    <div class="adress-block">
      <div class="label">Empfänger</div>
      ${lieferscheinKundeHtml(ls)}
    </div>
    <div class="adress-block">
      <div class="label">Lieferdatum</div>
      ${formatDatumDe(ls.datum)}
    </div>
  </div>
  <div class="referenz-box">
    Dieser Lieferschein bezieht sich auf Angebot <strong>${angebotNr}</strong>.
    ${ls.notiz ? `<br>Hinweis: ${esc(ls.notiz)}` : ''}
  </div>
  <table class="ls-tabelle">
    <thead>
      <tr>
        <th class="ls-pos">Pos.</th>
        <th class="ls-bezeichnung">Bezeichnung</th>
        <th class="ls-menge" style="text-align:right">Menge</th>
        <th class="ls-einheit">Einheit</th>
      </tr>
    </thead>
    <tbody>${positionenHtml}</tbody>
  </table>
  <div class="unterschrift-block">
    <div class="unterschrift-feld">Übergabe (${esc(mandant.firmenname)})</div>
    <div class="unterschrift-feld">Übernahme bestätigt (Empfänger)</div>
  </div>
  <div class="fusszeile" style="margin-top:8mm">
    <div>${esc(mandant.firmenname)} | UID: ${esc(mandant.uid)}</div>
    <div style="text-align:right;font-size:7pt;color:#bbb">Lieferschein – enthält keine Preisangaben</div>
  </div>
</div>
<script>window.onload = () => window.print()</script>
</body>
</html>`
}

export function druckeLiferschein(ls: LiferscheinResponse, mandant: MandantInfo): void {
  const html = generiereLiferscheinHtml(ls, mandant)
  const win  = window.open('', '_blank', 'width=900,height=1200')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(html)
  win.document.close()
}

// ---------------------------------------------------------------------------
// Sammelrechnung-PDF
// ---------------------------------------------------------------------------

export function generiereSammelrechnungHtml(sr: SammelrechnungResponse, mandant: MandantInfo): string {
  const srNr = `SR-${String(sr.nummer).padStart(4, '0')}`

  // Kundeblock (vom ersten Lieferschein / Snapshot)
  const kundeHtml = sr.kunde ? (() => {
    const k = sr.kunde!
    return `
      <div class="adress-block">
        <strong>${esc(k.bezeichnung)}</strong><br>
        ${k.strasse ? `${esc(k.strasse)}<br>` : ''}
        ${(k.plz || k.ort) ? `${[k.plz, k.ort].filter(Boolean).map(esc).join(' ')}<br>` : ''}
        ${k.uid   ? `UID: ${esc(k.uid)}<br>` : ''}
        ${k.email ? esc(k.email) : ''}
      </div>`
  })() : '<div class="adress-block text-grau">Kein Kunde zugewiesen</div>'

  // Alle Positionen aus allen Lieferscheinen für die Gesamt-Steueraufteilung
  const allePositionen = sr.lieferscheine.flatMap(ls => ls.positionen)
  const steuer         = berechneSteueraufteilungVonPositionen(allePositionen)
  const gesamtNetto    = steuer.reduce((s, z) => s + z.nettoCent, 0)
  const gesamtUst      = steuer.reduce((s, z) => s + z.ustCent, 0)

  // HTML-Blöcke pro Lieferschein
  const lsBlöcke = sr.lieferscheine.map((ls, lsIdx) => {
    const lsNr       = `L-${String(ls.nummer).padStart(4, '0')}`
    const lsSumme    = ls.positionen.reduce((s, p) => s + Math.round(p.einzelpreisBreutto * p.menge), 0)
    const posHtml    = ls.positionen.map((p, i) => `
      <tr>
        <td class="pos-bezeichnung">${esc(p.bezeichnung)}</td>
        <td class="pos-menge">${p.menge % 1 === 0 ? p.menge.toFixed(0) : p.menge}</td>
        <td class="pos-einzelpreis">€ ${centZuEuro(p.einzelpreisBreutto)}</td>
        <td class="pos-mwst">${MWST_SAETZE[p.mwstSatz] ?? 0} %</td>
        <td class="pos-gesamt">€ ${centZuEuro(Math.round(p.einzelpreisBreutto * p.menge))}</td>
      </tr>`).join('')

    return `
      <div class="ls-abschnitt${lsIdx > 0 ? ' ls-abschnitt--folge' : ''}">
        <div class="ls-kopf">
          <span class="ls-kopf-nr">${lsNr}</span>
          <span class="ls-kopf-datum">Lieferdatum: ${formatDatumDe(ls.datum)}</span>
          <span class="ls-kopf-angebot">Zu Angebot A-${String(ls.angebotNummer).padStart(4, '0')}</span>
        </div>
        <table class="positionen-tabelle">
          <thead>
            <tr>
              <th class="pos-bezeichnung">Bezeichnung</th>
              <th class="pos-menge">Menge</th>
              <th class="pos-einzelpreis">Einzelpreis</th>
              <th class="pos-mwst">MwSt</th>
              <th class="pos-gesamt">Gesamt</th>
            </tr>
          </thead>
          <tbody>${posHtml}</tbody>
          <tfoot>
            <tr class="ls-subtotal">
              <td colspan="4" style="text-align:right;padding-right:8px;font-size:9pt;color:#555">
                Zwischensumme ${lsNr}
              </td>
              <td class="pos-gesamt" style="border-top:1px solid #ccc;font-size:10pt">
                € ${centZuEuro(lsSumme)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>`
  }).join('')

  // Steueraufteilung
  const steuerHtml = steuer.map(z => `
    <tr>
      <td>${esc(z.label)}</td>
      <td class="rechts">€ ${centZuEuro(z.nettoCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.ustCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.bruttoCent)}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Sammelrechnung ${srNr} – ${mandant.firmenname}</title>
<style>
${generiereBaseCss()}
  /* Sammelrechnung-spezifisch */
  .ls-abschnitt { margin-bottom: 6mm; }
  .ls-abschnitt--folge {
    margin-top: 8mm;
    padding-top: 6mm;
    border-top: 2px dashed #ccc;
  }
  .ls-kopf {
    display: flex;
    align-items: baseline;
    gap: 6mm;
    background: #f0f4ff;
    border: 1px solid #c7d7f5;
    border-radius: 2mm;
    padding: 2.5mm 4mm;
    margin-bottom: 3mm;
    font-size: 10pt;
  }
  .ls-kopf-nr     { font-weight: bold; font-size: 11pt; color: #1e3a8a; }
  .ls-kopf-datum  { color: #555; font-size: 9pt; }
  .ls-kopf-angebot { color: #888; font-size: 8pt; margin-left: auto; }
  .ls-subtotal td { background: #f9f9f9; }
  /* Gesamt-Abschluss */
  .abschluss-gesamt {
    margin-top: 8mm;
    padding-top: 6mm;
    border-top: 3px solid #1a1a1a;
  }
</style>
</head>
<body>
<div class="seite">
  <!-- Kopfzeile -->
  <div class="kopf">
    <div>
      <div class="firmenname">${esc(mandant.firmenname)}</div>
      <div class="firmen-uid">UID: ${esc(mandant.uid)}</div>
    </div>
    <div class="rechnungstitel">
      <h1>Sammelrechnung</h1>
      <div class="meta">
        Nr. ${srNr}<br>
        Datum: ${formatDatumDe(sr.datum)}<br>
        ${sr.lieferscheine.length} Lieferschein${sr.lieferscheine.length !== 1 ? 'e' : ''}
      </div>
    </div>
  </div>

  <!-- Empfänger -->
  <div class="adressen">
    <div class="adress-block">
      <div class="label">Rechnungsempfänger</div>
      ${kundeHtml}
    </div>
    <div class="adress-block">
      <div class="label">Leistungszeitraum</div>
      ${formatDatumDe(sr.lieferscheine[sr.lieferscheine.length - 1]!.datum)}
      ${sr.lieferscheine.length > 1
        ? ` – ${formatDatumDe(sr.lieferscheine[0]!.datum)}`
        : ''}
    </div>
  </div>

  <!-- Lieferschein-Blöcke -->
  ${lsBlöcke}

  <!-- Gesamt-Abschluss -->
  <div class="abschluss-gesamt">
    <div class="abschluss">
      <div>
        ${steuer.length > 0 ? `
        <table class="steuer-tabelle">
          <thead>
            <tr>
              <th>Steuersatz</th>
              <th class="rechts">Netto</th>
              <th class="rechts">MwSt</th>
              <th class="rechts">Brutto</th>
            </tr>
          </thead>
          <tbody>
            ${steuerHtml}
            ${steuer.length > 1 ? `
            <tr style="font-weight:600;border-top:1px solid #ccc">
              <td>Gesamt</td>
              <td class="rechts">€ ${centZuEuro(gesamtNetto)}</td>
              <td class="rechts">€ ${centZuEuro(gesamtUst)}</td>
              <td class="rechts">€ ${centZuEuro(sr.gesamtbetragCent)}</td>
            </tr>` : ''}
          </tbody>
        </table>` : ''}
      </div>
      <div class="gesamt-box">
        ${gesamtNetto !== sr.gesamtbetragCent ? `
        <div class="gesamt-zeile netto">
          <span>Netto gesamt</span><span>€ ${centZuEuro(gesamtNetto)}</span>
        </div>
        <div class="gesamt-zeile ust">
          <span>MwSt gesamt</span><span>€ ${centZuEuro(gesamtUst)}</span>
        </div>` : ''}
        <div class="gesamt-zeile gesamt">
          <span>Rechnungsbetrag</span><span>€ ${centZuEuro(sr.gesamtbetragCent)}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Fußzeile -->
  <div class="fusszeile">
    <div>${esc(mandant.firmenname)} | UID: ${esc(mandant.uid)}</div>
    <div style="text-align:right;font-size:7pt;color:#bbb">
      Diese Sammelrechnung wurde elektronisch erstellt.
    </div>
  </div>
</div>
<script>window.onload = () => window.print()</script>
</body>
</html>`
}

export function druckeSammelrechnung(sr: SammelrechnungResponse, mandant: MandantInfo): void {
  const html = generiereSammelrechnungHtml(sr, mandant)
  const win  = window.open('', '_blank', 'width=900,height=1200')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(html)
  win.document.close()
}

// ---------------------------------------------------------------------------
// Gutschein-Slip
// ---------------------------------------------------------------------------

function generiereGutscheinHtml(gs: GutscheinResponse, mandant: MandantInfo): string {
  const restCent = Math.max(0, gs.betragCent - gs.bezahltCent)
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Gutschein ${gs.code}</title>
<style>
${generiereBaseCss()}
body { font-family: Arial, Helvetica, sans-serif; }
.gs-card {
  max-width: 420px;
  margin: 40px auto;
  border: 3px solid #1d4ed8;
  border-radius: 12px;
  overflow: hidden;
}
.gs-header {
  background: #1d4ed8;
  color: white;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.gs-header h1 { margin: 0; font-size: 20px; }
.gs-header .firma { font-size: 12px; opacity: 0.85; }
.gs-body { padding: 24px; }
.gs-code {
  font-family: 'Courier New', monospace;
  font-size: 28px;
  font-weight: bold;
  letter-spacing: 4px;
  color: #1d4ed8;
  text-align: center;
  padding: 16px;
  background: #eff6ff;
  border-radius: 8px;
  margin: 16px 0;
}
.gs-betrag {
  font-size: 36px;
  font-weight: bold;
  color: #111;
  text-align: center;
  margin: 8px 0;
}
.gs-meta { font-size: 12px; color: #6b7280; margin-top: 16px; }
.gs-meta table { width: 100%; border-collapse: collapse; }
.gs-meta td { padding: 2px 0; }
.gs-meta td:last-child { text-align: right; font-weight: 600; color: #374151; }
.gs-hinweis {
  margin-top: 16px;
  padding: 10px 12px;
  background: #f3f4f6;
  border-radius: 6px;
  font-size: 11px;
  color: #6b7280;
  text-align: center;
}
</style>
</head>
<body>
<div class="gs-card">
  <div class="gs-header">
    <div>
      <h1>Gutschein</h1>
      <div class="firma">${mandant.firmenname}</div>
    </div>
    <div style="text-align:right; font-size:12px; opacity:0.9">
      Nr. ${String(gs.nummer).padStart(4, '0')}<br>
      ${formatDatumDe(gs.datum)}
    </div>
  </div>
  <div class="gs-body">
    <div class="gs-code">${gs.code}</div>
    <div class="gs-betrag">€ ${centZuEuro(restCent)}</div>
    ${gs.betragCent !== restCent ? `<div style="text-align:center; font-size:13px; color:#6b7280">Ursprungswert: € ${centZuEuro(gs.betragCent)}</div>` : ''}

    <div class="gs-meta">
      <table>
        ${gs.kunde ? `<tr><td>Inhaber</td><td>${gs.kunde.bezeichnung}</td></tr>` : ''}
        ${gs.gueltigBis ? `<tr><td>Gültig bis</td><td>${gs.gueltigBis}</td></tr>` : ''}
        <tr><td>Status</td><td>${gs.status === 'aktiv' ? 'Aktiv' : gs.status === 'teileingeloest' ? 'Teileingelöst' : 'Eingelöst'}</td></tr>
      </table>
    </div>

    ${gs.notiz ? `<div style="margin-top:12px; font-size:12px; color:#374151; font-style:italic">${gs.notiz}</div>` : ''}

    <div class="gs-hinweis">
      Dieser Gutschein ist an der Kasse einzulösen.<br>
      ${mandant.firmenname} · ${mandant.uid}
    </div>
  </div>
</div>
</body>
</html>`
}

export function druckeGutschein(gs: GutscheinResponse, mandant: MandantInfo): void {
  const html = generiereGutscheinHtml(gs, mandant)
  const win  = window.open('', '_blank', 'width=600,height=800')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(html)
  win.document.close()
}
