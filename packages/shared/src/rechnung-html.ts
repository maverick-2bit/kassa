/**
 * Rechnung als druckfertiges A4-HTML (Browser Print API).
 * Pure Funktionen ohne DOM-Abhängigkeit — nutzbar vom Haupt-Frontend
 * (Kasse/Belege) und vom KDS (Rechnungsdruck zu SB-Bestellungen).
 */

import type { AngebotPosition } from './schemas/angebot.js'
import type { BelegResponse } from './schemas/beleg.js'

export interface RechnungMandantInfo {
  firmenname: string
  uid:        string
}

// ---------------------------------------------------------------------------
// MwSt- und Format-Hilfsfunktionen
// ---------------------------------------------------------------------------

export const MWST_SAETZE: Record<string, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:        0,
  besonders:   5,
}

function mwstFaktor(satz: string): number {
  return 1 + (MWST_SAETZE[satz] ?? 0) / 100
}

export function centZuEuro(cent: number): string {
  return (cent / 100).toFixed(2).replace('.', ',')
}

export function formatDatumDe(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Europe/Vienna',
  })
}

export function esc(s: string | undefined | null): string {
  if (!s) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Steueraufteilung
// ---------------------------------------------------------------------------

export interface SteuerZeile {
  label:      string
  satz:       number
  bruttoCent: number
  nettoCent:  number
  ustCent:    number
}

/** Steueraufteilung aus (Angebot-)Positionen berechnen (gruppiert nach MwSt-Satz) */
export function berechneSteueraufteilungVonPositionen(positionen: AngebotPosition[]): SteuerZeile[] {
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

export function berechneSteueraufteilung(beleg: BelegResponse): SteuerZeile[] {
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
// Gemeinsames Druck-CSS
// ---------------------------------------------------------------------------

export function generiereBaseCss(): string {
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
// Rechnung (RKSV-Beleg) als A4-HTML
// ---------------------------------------------------------------------------

export function generiereRechnungHtml(beleg: BelegResponse, mandant: RechnungMandantInfo): string {
  const steuer    = berechneSteueraufteilung(beleg)
  const gesamtNetto = steuer.reduce((s, z) => s + z.nettoCent, 0)
  const gesamtUst   = steuer.reduce((s, z) => s + z.ustCent,   0)

  const zahlungsarten: string[] = []
  if (beleg.summeBarCent   > 0) zahlungsarten.push(`Bar € ${centZuEuro(beleg.summeBarCent)}`)
  if (beleg.summeKarteCent > 0) zahlungsarten.push(`Karte € ${centZuEuro(beleg.summeKarteCent)}`)
  if (beleg.summeSonstigeCent > 0) zahlungsarten.push(`Sonstige € ${centZuEuro(beleg.summeSonstigeCent)}`)

  const positionenHtml = beleg.positionen.map(p => `
    <tr>
      <td class="pos-bezeichnung">${esc(p.bezeichnung)}${
        p.seriennummern && p.seriennummern.length > 0
          ? `<div style="font-size:9px;color:#555;margin-top:2px">Seriennummern: ${p.seriennummern.map(esc).join(', ')}</div>`
          : ''
      }</td>
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
