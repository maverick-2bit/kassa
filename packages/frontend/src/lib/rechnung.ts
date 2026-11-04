/**
 * A4-Rechnungsdruck via Browser Print API.
 * Generiert ein sauberes HTML-Dokument und öffnet den Druckdialog.
 * Der Benutzer kann direkt drucken oder als PDF speichern.
 */

import type { AngebotResponse, BelegResponse, GutscheinResponse, LiferscheinResponse, RechnungMandantInfo, SammelrechnungResponse } from '@kassa/shared'
import {
  MWST_SAETZE,
  formatMwstProzent,
  berechneSteueraufteilung,
  berechneSteueraufteilungVonPositionen,
  centZuEuro,
  esc,
  formatDatumDe,
  generiereBaseCss,
  generiereRechnungHtml,
  formatiereIban,
} from '@kassa/shared'
import { MASSE, SN_ZEILENHOEHE, paginiere, positionsHoehe, seriennummernText, type SeitenZeile } from './sammelrechnung-seiten'

type MandantInfo = RechnungMandantInfo

// Rechnung-HTML lebt in @kassa/shared (auch vom KDS genutzt) — hier re-exportiert
export { generiereRechnungHtml }

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
      <td class="pos-mwst">${formatMwstProzent(MWST_SAETZE[p.mwstSatz] ?? 0)} %</td>
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

// A4-Seitenmaße der Sammelrechnung (mm)
const SEITENRAND_OBEN_MM  = 15
const SEITENRAND_UNTEN_MM = 20
const FUSSZEILE_MM        = 12
/** Höhe, die Kopfbereich + Tabelle + Abschluss einer Seite zusammen haben (297 − Ränder − Fußzeile − Reserve) */
const NUTZHOEHE_MM        = 297 - SEITENRAND_OBEN_MM - SEITENRAND_UNTEN_MM - FUSSZEILE_MM - 3
const TABELLENKOPF_MM     = 9
const FOLGEKOPF_MM        = 14

/** Stornorechnung zur Sammelrechnung: dieselben Positionen mit negativen Beträgen */
function stornoAnsicht(sr: SammelrechnungResponse): SammelrechnungResponse {
  return {
    ...sr,
    datum: sr.storniertAm ?? sr.datum,
    gesamtbetragCent: -sr.gesamtbetragCent,
    lieferscheine: sr.lieferscheine.map(ls => ({
      ...ls,
      positionen: ls.positionen.map(p => ({ ...p, einzelpreisBreutto: -p.einzelpreisBreutto })),
    })),
  }
}

export interface SammelrechnungDruckOptionen {
  /** Aufdruck oben rechts, z. B. „Kundenexemplar" oder „Kopie Buchhaltung" */
  exemplar?: string
  /** Stornorechnung (negative Beträge, eigene Nummer „ST-…") statt der Rechnung */
  storno?: boolean
}

export function generiereSammelrechnungHtml(srOriginal: SammelrechnungResponse, mandant: MandantInfo, opts: SammelrechnungDruckOptionen = {}): string {
  const istStorno = !!opts.storno
  const sr = istStorno ? stornoAnsicht(srOriginal) : srOriginal
  const origNr = `SR-${String(srOriginal.nummer).padStart(4, '0')}`
  const srNr = istStorno ? `ST-${String(srOriginal.stornoNummer ?? 0).padStart(4, '0')}` : origNr
  const titel = istStorno ? 'Stornorechnung' : 'Sammelrechnung'
  const storniert = !istStorno && !!sr.storniertAm

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

  // ---- Zeilenmodell: je Lieferschein „LS … vom …", die Positionen, danach zwei Leerzeilen ----
  type Zeile = SeitenZeile & { html: string }
  const zeilen: Zeile[] = []
  sr.lieferscheine.forEach((ls, idx) => {
    if (idx > 0) {
      for (let i = 0; i < 2; i++) {
        zeilen.push({ art: 'leer', hoehe: MASSE.leer, html: `<tr class="zeile-leer" style="height:${MASSE.leer}mm"><td colspan="5"></td></tr>` })
      }
    }
    const lsNr = `L-${String(ls.nummer).padStart(4, '0')}`
    const bezug = ls.angebotNummer !== undefined
      ? ` · zu Angebot A-${String(ls.angebotNummer).padStart(4, '0')}`
      : ls.wartungsvertragNummer !== undefined
        ? ` · Wartungsvertrag W-${String(ls.wartungsvertragNummer).padStart(4, '0')}${ls.periode ? `, ${ls.periode.slice(5, 7)}/${ls.periode.slice(0, 4)}` : ''}`
        : ''
    zeilen.push({
      art: 'kopf', hoehe: MASSE.kopf,
      html: `<tr class="zeile-kopf" style="height:${MASSE.kopf}mm"><td colspan="5">LS ${lsNr} vom ${formatDatumDe(ls.datum)}<span class="kopf-bezug">${esc(bezug)}</span></td></tr>`,
    })
    for (const p of ls.positionen) {
      const hoehe = positionsHoehe(p.bezeichnung, p.seriennummern)
      const sn = seriennummernText(p.seriennummern)
      const brutto = Math.round(p.einzelpreisBreutto * p.menge)
      zeilen.push({
        art: 'pos', hoehe, betragCent: brutto,
        html: `
      <tr class="zeile-pos" style="height:${hoehe}mm">
        <td class="pos-bezeichnung"><div class="zelle" style="max-height:${hoehe - 3}mm">${esc(p.bezeichnung)}${
          sn ? `<div class="sn">${esc(sn)}</div>` : ''
        }</div></td>
        <td class="pos-menge">${p.menge % 1 === 0 ? p.menge.toFixed(0) : p.menge}</td>
        <td class="pos-einzelpreis">€ ${centZuEuro(p.einzelpreisBreutto)}</td>
        <td class="pos-mwst">${formatMwstProzent(MWST_SAETZE[p.mwstSatz] ?? 0)} %</td>
        <td class="pos-gesamt">€ ${centZuEuro(brutto)}</td>
      </tr>`,
      })
    }
  })

  // Steueraufteilung
  const steuerHtml = steuer.map(z => `
    <tr>
      <td>${esc(z.label)}</td>
      <td class="rechts">€ ${centZuEuro(z.nettoCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.ustCent)}</td>
      <td class="rechts">€ ${centZuEuro(z.bruttoCent)}</td>
    </tr>`).join('')

  // Zahlungsangaben: Fälligkeit, Bankverbindung, Verwendungszweck
  const zahlungHtml = mandant.zahlungszielTage === undefined || storniert || istStorno ?'' : (() => {
    const faellig = new Date(Date.parse(sr.datum) + mandant.zahlungszielTage * 86_400_000).toISOString()
    return `
  <div class="zahlungsblock">
    <strong>Zahlbar bis ${formatDatumDe(faellig)}</strong> (${mandant.zahlungszielTage} Tage ab Rechnungsdatum)<br>
    ${mandant.iban ? `IBAN: ${esc(formatiereIban(mandant.iban))}<br>` : ''}
    ${mandant.bic ? `BIC: ${esc(mandant.bic)}<br>` : ''}
    Verwendungszweck: ${srNr}
  </div>`
  })()

  // ---- Seitenaufteilung ----
  const kopftextZeilen = mandant.kopftext ? mandant.kopftext.split('\n').length : 0
  const kopfbereichMm  = 76 + 4.2 * kopftextZeilen + (storniert ? 8 : 0)
  const abschlussMm    = 8 + Math.max(32, 10 + 6 * steuer.length) + (zahlungHtml ? 38 : 0)
  const seiten = paginiere(zeilen, {
    erste:     NUTZHOEHE_MM - kopfbereichMm - TABELLENKOPF_MM,
    folge:     NUTZHOEHE_MM - FOLGEKOPF_MM - TABELLENKOPF_MM,
    abschluss: abschlussMm,
  })
  const seitenZahl = seiten.length

  const tabellenKopf = `
          <thead>
            <tr>
              <th class="pos-bezeichnung">Bezeichnung</th>
              <th class="pos-menge">Menge</th>
              <th class="pos-einzelpreis">Einzelpreis</th>
              <th class="pos-mwst">MwSt</th>
              <th class="pos-gesamt">Gesamt</th>
            </tr>
          </thead>`

  const fuss = (nr: number) => `
    <div class="fusszeile">
      <div>${esc(mandant.firmenname)} | UID: ${esc(mandant.uid)}</div>
      <div style="text-align:right">
        Seite ${nr} von ${seitenZahl}<br>
        <span style="font-size:7pt;color:#bbb">Diese ${titel} wurde elektronisch erstellt.</span>
      </div>
    </div>`

  const seitenHtml = seiten.map((seite, idx) => {
    const nr = idx + 1
    const kopf = nr === 1 ? `
    <div class="kopfbereich" style="height:${kopfbereichMm}mm">
      <div class="kopf">
        <div>
          <div class="firmenname">${esc(mandant.firmenname)}</div>
          ${mandant.kopftext ? `<div class="firmen-uid">${esc(mandant.kopftext).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="firmen-uid">UID: ${esc(mandant.uid)}</div>
        </div>
        <div class="rechnungstitel">
          <h1>${titel}</h1>
          <div class="meta">
            Nr. ${srNr}<br>
            ${istStorno ? `Storno zu ${origNr} vom ${formatDatumDe(srOriginal.datum)}<br>` : ''}
            Datum: ${formatDatumDe(sr.datum)}<br>
            ${sr.lieferscheine.length} Lieferschein${sr.lieferscheine.length !== 1 ? 'e' : ''}
          </div>
          ${storniert ? `<div class="storno-hinweis">STORNIERT am ${formatDatumDe(sr.storniertAm!)}</div>` : ''}
        </div>
      </div>
      <div class="adressen">
        <div class="adress-block">
          <div class="label">Rechnungsempfänger</div>
          ${kundeHtml}
        </div>
        <div class="adress-block">
          <div class="label">Leistungszeitraum</div>
          ${sr.lieferscheine.length > 0 ? `${formatDatumDe(sr.lieferscheine[0]!.datum)}${sr.lieferscheine.length > 1 ? ` – ${formatDatumDe(sr.lieferscheine[sr.lieferscheine.length - 1]!.datum)}` : ''}` : ''}
        </div>
      </div>
    </div>` : `
    <div class="folgekopf" style="height:${FOLGEKOPF_MM}mm">
      <strong>${esc(mandant.firmenname)}</strong> · ${titel} ${srNr}${storniert ? ' · <span class="storno-text">STORNIERT</span>' : ''}
      <span style="float:right">Seite ${nr} von ${seitenZahl}</span>
    </div>`

    const uebertragHtml = seite.uebertragVor !== null ? `
          <tr class="zeile-uebertrag" style="height:${MASSE.uebertrag}mm">
            <td colspan="4">Übertrag von Seite ${nr - 1}</td>
            <td class="pos-gesamt">€ ${centZuEuro(seite.uebertragVor)}</td>
          </tr>` : ''
    const zwischenHtml = seite.zwischensummeNach !== null ? `
          <tr class="zeile-zwischen" style="height:${MASSE.zwischensumme}mm">
            <td colspan="4">Zwischensumme — Übertrag auf Seite ${nr + 1}</td>
            <td class="pos-gesamt">€ ${centZuEuro(seite.zwischensummeNach)}</td>
          </tr>` : ''

    const abschluss = seite.letzte ? `
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
    ${zahlungHtml}` : ''

    return `
<div class="seite">
  ${opts.exemplar ? `<div class="exemplar">${esc(opts.exemplar)}</div>` : ''}
  ${kopf}
  <div class="seiteninhalt">
    <table class="positionen-tabelle sr-tabelle">${tabellenKopf}
        <tbody>${uebertragHtml}${seite.zeilen.map(z => z.html).join('')}${zwischenHtml}
        </tbody>
    </table>
    ${abschluss}
  </div>
  ${fuss(nr)}
</div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>${titel} ${srNr} – ${mandant.firmenname}</title>
<style>
${generiereBaseCss()}
  /* Sammelrechnung: feste A4-Seiten mit Übertrag/Zwischensumme */
  @page { size: A4; margin: 0; }
  .seite {
    width: 210mm; height: 297mm; max-width: none; margin: 0 auto;
    padding: ${SEITENRAND_OBEN_MM}mm 15mm ${SEITENRAND_UNTEN_MM}mm 20mm;
    display: flex; flex-direction: column; overflow: hidden;
    page-break-after: always; break-after: page;
  }
  .seite:last-child { page-break-after: auto; break-after: auto; }
  .seite { position: relative; }
  .exemplar {
    position: absolute; top: 6mm; right: 15mm; font-size: 8pt; text-transform: uppercase; letter-spacing: 1px;
    color: #444; border: 1px solid #888; padding: 0.5mm 2.5mm; border-radius: 1mm;
  }
  .kopfbereich { overflow: hidden; flex: none; }
  .folgekopf {
    flex: none; overflow: hidden; font-size: 9pt; color: #555;
    border-bottom: 1px solid #ccc; padding-top: 2mm;
  }
  .seiteninhalt { flex: 1; min-height: 0; overflow: hidden; }
  .sr-tabelle { table-layout: fixed; margin-bottom: 0; }
  .sr-tabelle thead tr { height: ${TABELLENKOPF_MM}mm; }
  .sr-tabelle td { padding: 1.5mm 3mm; line-height: 4.5mm; overflow: hidden; }
  .sr-tabelle .zelle { overflow: hidden; }
  .sr-tabelle .sn { font-size: 8pt; line-height: ${SN_ZEILENHOEHE}mm; color: #555; word-break: break-word; }
  .zeile-kopf td {
    background: #f0f4ff; border: 1px solid #c7d7f5; font-weight: bold; font-size: 10pt; color: #1e3a8a;
    vertical-align: middle;
  }
  .kopf-bezug { font-weight: normal; font-size: 8pt; color: #666; margin-left: 4mm; }
  .zeile-leer td { border: none; }
  .zeile-uebertrag td, .zeile-zwischen td {
    background: #f9f9f9; font-style: italic; color: #444; vertical-align: middle;
    border-bottom: 1px solid #ccc;
  }
  .zeile-zwischen td { border-top: 1px solid #999; font-weight: 600; }
  .zeile-uebertrag td:first-child, .zeile-zwischen td:first-child { text-align: right; padding-right: 6mm; }
  .abschluss-gesamt { margin-top: 4mm; padding-top: 3mm; border-top: 3px solid #1a1a1a; }
  .zahlungsblock {
    margin-top: 4mm; padding: 3mm 5mm; border: 1px solid #c7d7f5; border-radius: 2mm;
    font-size: 10pt; line-height: 1.5;
  }
  .storno-hinweis {
    margin-top: 2mm; padding: 1mm 3mm; border: 2px solid #b91c1c; color: #b91c1c;
    font-weight: bold; font-size: 11pt; display: inline-block;
  }
  .storno-text { color: #b91c1c; font-weight: bold; }
  .gesamt-zeile { gap: 6mm; }
  .fusszeile { flex: none; margin-top: auto; height: ${FUSSZEILE_MM}mm; overflow: hidden; }
  @media print {
    .seite { padding: ${SEITENRAND_OBEN_MM}mm 15mm ${SEITENRAND_UNTEN_MM}mm 20mm; max-width: none; }
    @page { size: A4; margin: 0; }
  }
</style>
</head>
<body>
<div class="seiten">${seitenHtml}
</div>
<script>window.onload = () => window.print()</script>
</body>
</html>`
}

/** Ein Druckauftrag: eine Rechnung (oder Stornorechnung) in einem bestimmten Exemplar */
export interface SammelrechnungDruckauftrag extends SammelrechnungDruckOptionen {
  sr: SammelrechnungResponse
}

/**
 * Welche Exemplare werden für die Rechnung gedruckt? Per Mail verschickte Rechnungen brauchen nur die Kopie für die
 * Buchhaltung; Rechnungen, die der Kunde auf Papier bekommt, zusätzlich das Kundenexemplar.
 */
export function exemplareFuer(sr: SammelrechnungResponse): SammelrechnungDruckauftrag[] {
  return sr.emailEmpfaenger
    ? [{ sr, exemplar: 'Kopie Buchhaltung' }]
    : [{ sr, exemplar: 'Kundenexemplar' }, { sr, exemplar: 'Kopie Buchhaltung' }]
}

/** Mehrere Druckaufträge in einem Druckfenster, jeder auf eigenen Seiten. */
export function druckeSammelrechnungAuftraege(auftraege: SammelrechnungDruckauftrag[], mandant: MandantInfo): void {
  if (auftraege.length === 0) return
  const seiten = auftraege.map(a => generiereSammelrechnungHtml(a.sr, mandant, {
    ...(a.exemplar ? { exemplar: a.exemplar } : {}),
    ...(a.storno   ? { storno:   a.storno }   : {}),
  }))
  const erste  = seiten[0]!
  const kopf   = erste.slice(0, erste.indexOf('<body>') + '<body>'.length)
  const inhalt = seiten.map(h =>
    `<div style="break-after:page">${h.slice(h.indexOf('<body>') + '<body>'.length, h.lastIndexOf('<script>window.onload'))}</div>`,
  ).join('\n')
  const win = window.open('', '_blank', 'width=900,height=1200')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(`${kopf}\n${inhalt}\n<script>window.onload = () => window.print()</script>\n</body>\n</html>`)
  win.document.close()
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

// ---------------------------------------------------------------------------
// Inventur-Protokoll + Wareneingang als A4-Druckfenster
// ---------------------------------------------------------------------------

export interface InventurDruckDaten {
  bezeichnung:     string
  status:          string
  erstelltVon:     string
  abgeschlossenAm: string | null
  positionen:      Array<{ bezeichnung: string; sollMenge: number; istMenge: number | null; differenz: number | null }>
}

export function druckeInventur(inv: InventurDruckDaten, mandant: MandantInfo): void {
  const datum = new Date(inv.abgeschlossenAm ?? Date.now()).toLocaleString('de-AT', { dateStyle: 'medium', timeStyle: 'short' })
  const zeilen = inv.positionen.map(p => {
    const diff = p.differenz ?? 0
    const farbe = diff === 0 ? '#111' : diff > 0 ? '#15803d' : '#b91c1c'
    return `<tr>
      <td>${p.bezeichnung}</td>
      <td class="r">${p.sollMenge}</td>
      <td class="r">${p.istMenge ?? '–'}</td>
      <td class="r" style="color:${farbe};font-weight:600">${p.istMenge === null ? '–' : (diff > 0 ? '+' : '') + diff}</td>
    </tr>`
  }).join('')
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Inventur — ${inv.bezeichnung}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:2rem;color:#111}
    h1{font-size:1.3rem;margin:0 0 .2rem} .sub{color:#555;font-size:.85rem;margin:0 0 1.2rem}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th,td{padding:.35rem .5rem;border-bottom:1px solid #ddd;text-align:left} .r{text-align:right}
    thead th{background:#f5f5f5;text-transform:uppercase;font-size:.7rem;color:#555}
    @media print{ body{margin:0} }
  </style></head><body onload="print()">
  <h1>Inventur-Protokoll — ${inv.bezeichnung}${inv.status === 'offen' ? ' (Zwischenstand)' : ''}</h1>
  <p class="sub">${mandant.firmenname} · ${datum} · erfasst von ${inv.erstelltVon}</p>
  <table><thead><tr><th>Artikel</th><th class="r">Soll</th><th class="r">Ist</th><th class="r">Differenz</th></tr></thead>
  <tbody>${zeilen}</tbody></table>
  </body></html>`
  const win = window.open('', '_blank', 'width=900,height=1200')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(html)
  win.document.close()
}

export interface WareneingangDruckDaten {
  lieferant?: string
  positionen: Array<{ bezeichnung: string; menge: number }>
}

export function druckeWareneingang(we: WareneingangDruckDaten, mandant: MandantInfo): void {
  const datum  = new Date().toLocaleString('de-AT', { dateStyle: 'medium', timeStyle: 'short' })
  const zeilen = we.positionen.map(p =>
    `<tr><td>${p.bezeichnung}</td><td class="r" style="font-weight:600">+${p.menge}</td></tr>`).join('')
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Wareneingang</title>
  <style>
    body{font-family:Arial,sans-serif;margin:2rem;color:#111}
    h1{font-size:1.3rem;margin:0 0 .2rem} .sub{color:#555;font-size:.85rem;margin:0 0 1.2rem}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th,td{padding:.35rem .5rem;border-bottom:1px solid #ddd;text-align:left} .r{text-align:right}
    thead th{background:#f5f5f5;text-transform:uppercase;font-size:.7rem;color:#555}
    @media print{ body{margin:0} }
  </style></head><body onload="print()">
  <h1>Wareneingang${we.lieferant ? ' — ' + we.lieferant : ''}</h1>
  <p class="sub">${mandant.firmenname} · ${datum}</p>
  <table><thead><tr><th>Artikel</th><th class="r">Menge</th></tr></thead>
  <tbody>${zeilen}</tbody></table>
  </body></html>`
  const win = window.open('', '_blank', 'width=900,height=1200')
  if (!win) { alert('Bitte Pop-ups für diese Seite erlauben.'); return }
  win.document.write(html)
  win.document.close()
}
