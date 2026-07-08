/**
 * E-Mail-Service — versendet Belege als HTML-E-Mail.
 *
 * Wird nur aktiv wenn SMTP_HOST in der Umgebung gesetzt ist.
 * Ohne SMTP-Konfiguration gibt isEmailAktiv() false zurück.
 */

import nodemailer from 'nodemailer'
import type { Config } from '../config.js'

export function isEmailAktiv(config: Config): boolean {
  return !!config.SMTP_HOST && !!config.SMTP_USER && !!config.SMTP_PASS
}

function erstelleTransporter(config: Config) {
  return nodemailer.createTransport({
    host:   config.SMTP_HOST!,
    port:   config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER!,
      pass: config.SMTP_PASS!,
    },
  })
}

export interface BelegEmailDaten {
  belegNummer:  number
  belegDatum:   string
  firmenname:   string
  uid:          string
  positionen:   Array<{
    bezeichnung: string
    menge:       number
    preisBruttoCent: number
    mwstSatz:    string
  }>
  summeCent:    number
  signaturwert: string
  /** Voller RKSV-Maschinencode — macht die Mail zum rechtlich vollständigen elektronischen Beleg */
  maschinenlesbareCode?: string
}

export async function sendeBelegEmail(
  empfaenger: string,
  daten:      BelegEmailDaten,
  config:     Config,
): Promise<void> {
  const transporter = erstelleTransporter(config)
  const from        = config.SMTP_FROM ?? config.SMTP_USER!

  const betragEuro = (daten.summeCent / 100).toFixed(2).replace('.', ',')
  const datum      = new Date(daten.belegDatum).toLocaleDateString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const zeilenHtml = daten.positionen.map(p => {
    const preis    = (p.preisBruttoCent / 100).toFixed(2).replace('.', ',')
    const gesamt   = (p.preisBruttoCent * p.menge / 100).toFixed(2).replace('.', ',')
    return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${p.menge}× ${p.bezeichnung}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace">${preis} €</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-weight:600">${gesamt} €</td>
      </tr>`
  }).join('')

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Beleg #${daten.belegNummer}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

    <div style="background:#1d4ed8;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:20px">Beleg #${daten.belegNummer}</h1>
      <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px">${datum}</p>
    </div>

    <div style="padding:20px 28px">
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280">Aussteller</p>
      <p style="margin:0;font-weight:600;color:#111827">${daten.firmenname}</p>
      <p style="margin:2px 0 0;font-size:12px;color:#6b7280">UID: ${daten.uid}</p>
    </div>

    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Artikel</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Preis</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Gesamt</th>
        </tr>
      </thead>
      <tbody>${zeilenHtml}</tbody>
    </table>

    <div style="padding:16px 28px;border-top:2px solid #1d4ed8;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:16px;font-weight:700;color:#111827">Gesamt</span>
      <span style="font-size:20px;font-weight:800;color:#1d4ed8;font-family:monospace">${betragEuro} €</span>
    </div>

    <div style="padding:12px 28px 24px;background:#f9fafb">
      <p style="margin:0 0 4px;font-size:10px;color:#6b7280;font-weight:600">RKSV-Maschinencode</p>
      <p style="margin:0;font-size:10px;color:#9ca3af;font-family:monospace;word-break:break-all">
        ${daten.maschinenlesbareCode ?? `Sig: ${daten.signaturwert.substring(0, 40)}…`}
      </p>
    </div>
  </div>
</body>
</html>`

  await transporter.sendMail({
    from,
    to:      empfaenger,
    subject: `Beleg #${daten.belegNummer} — ${daten.firmenname}`,
    html,
    text:    `Beleg #${daten.belegNummer}\n${datum}\n${daten.firmenname}\nGesamt: ${betragEuro} €`,
  })
}

// ---------------------------------------------------------------------------
// Reservierungs-Bestätigung
// ---------------------------------------------------------------------------

export interface ReservierungsEmailDaten {
  firmenname:     string
  name:           string
  datum:          string  // YYYY-MM-DD
  zeitVon:        string  // HH:MM
  dauer:          number  // Minuten
  personenAnzahl: number
  tischLabel:     string | null
  notiz:          string | null
  stornierUrl?:   string
}

export async function sendeReservierungsBestaetigung(
  empfaenger: string,
  daten:      ReservierungsEmailDaten,
  config:     Config,
): Promise<void> {
  const transporter = erstelleTransporter(config)
  const from        = config.SMTP_FROM ?? config.SMTP_USER!

  const datumFormatiert = new Date(daten.datum + 'T00:00:00').toLocaleDateString('de-AT', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })
  const dauerStd = Math.floor(daten.dauer / 60)
  const dauerMin = daten.dauer % 60
  const dauerText = dauerStd > 0
    ? dauerMin > 0 ? `${dauerStd} Std. ${dauerMin} Min.` : `${dauerStd} Stunde${dauerStd > 1 ? 'n' : ''}`
    : `${dauerMin} Min.`

  const storniereBlock = daten.stornierUrl
    ? `<div style="margin:20px 0;text-align:center">
        <a href="${daten.stornierUrl}" style="background:#ef4444;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">
          Reservierung stornieren
        </a>
       </div>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Reservierungsbestätigung</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#1d4ed8;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:20px">Reservierungsbestätigung</h1>
      <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px">${daten.firmenname}</p>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 20px;font-size:16px;color:#111827">
        Hallo <strong>${daten.name}</strong>,<br>
        Ihre Reservierung wurde bestätigt!
      </p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:40%">Datum</td>
            <td style="padding:8px 0;font-weight:600;font-size:13px">${datumFormatiert}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Uhrzeit</td>
            <td style="padding:8px 0;font-weight:600;font-size:13px">${daten.zeitVon} Uhr (${dauerText})</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Personen</td>
            <td style="padding:8px 0;font-weight:600;font-size:13px">${daten.personenAnzahl} Personen</td></tr>
        ${daten.tischLabel ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Tisch</td>
            <td style="padding:8px 0;font-weight:600;font-size:13px">${daten.tischLabel}</td></tr>` : ''}
        ${daten.notiz ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Anmerkung</td>
            <td style="padding:8px 0;font-size:13px;color:#374151">${daten.notiz}</td></tr>` : ''}
      </table>
      ${storniereBlock}
      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af">Bei Fragen wenden Sie sich bitte direkt an ${daten.firmenname}.</p>
    </div>
  </div>
</body>
</html>`

  await transporter.sendMail({
    from,
    to:      empfaenger,
    subject: `Reservierungsbestätigung — ${daten.firmenname}`,
    html,
    text:    `Reservierungsbestätigung\n${daten.firmenname}\n\nDatum: ${datumFormatiert}\nUhrzeit: ${daten.zeitVon} Uhr\nPersonen: ${daten.personenAnzahl}\n`,
  })
}

// ---------------------------------------------------------------------------
// Tagesabschluss-E-Mail
// ---------------------------------------------------------------------------

export interface TagesabschlussEmailDaten {
  firmenname:              string
  kassenId:                string
  datum:                   string
  nettoUmsatzCent:         number
  barCent:                 number
  karteCent:               number
  sonstigCent:             number
  anzahlBarzahlungsbelege: number
  anzahlStornobelege:      number
  mwst: Array<{ satz: string; nettoCent: number; steuerCent: number; bruttoCent: number }>
}

export async function sendeTagesabschlussEmail(
  empfaenger: string,
  daten:      TagesabschlussEmailDaten,
  config:     Config,
): Promise<void> {
  const transporter = erstelleTransporter(config)
  const from        = config.SMTP_FROM ?? config.SMTP_USER!

  const fmt = (cent: number) => (cent / 100).toFixed(2).replace('.', ',') + ' €'
  const datumFormatiert = new Date(daten.datum + 'T00:00:00').toLocaleDateString('de-AT', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })

  const mwstZeilen = daten.mwst.map(m => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${m.satz}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(m.nettoCent)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(m.steuerCent)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(m.bruttoCent)}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>Tagesabschluss ${daten.datum}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#1d4ed8;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:20px">Tagesabschluss</h1>
      <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px">${datumFormatiert} — Kasse ${daten.kassenId}</p>
    </div>
    <div style="padding:20px 28px">
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280">Betrieb</p>
      <p style="margin:0;font-weight:600;color:#111827">${daten.firmenname}</p>
    </div>

    <!-- Zahlungsarten -->
    <div style="padding:0 28px 16px">
      <h2 style="font-size:14px;color:#374151;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em">Umsatz nach Zahlungsart</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600">Art</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Betrag</th>
        </tr>
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">Bar</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(daten.barCent)}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">Karte</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(daten.karteCent)}</td>
        </tr>
        ${daten.sonstigCent > 0 ? `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">Sonstige</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-family:monospace;font-size:13px">${fmt(daten.sonstigCent)}</td>
        </tr>` : ''}
      </table>
      <div style="padding:12px 12px;border-top:2px solid #1d4ed8;display:flex;justify-content:space-between">
        <span style="font-weight:700;font-size:15px;color:#111827">Netto-Umsatz gesamt</span>
        <span style="font-weight:800;font-size:18px;color:#1d4ed8;font-family:monospace">${fmt(daten.nettoUmsatzCent)}</span>
      </div>
    </div>

    <!-- MwSt-Tabelle -->
    <div style="padding:0 28px 16px">
      <h2 style="font-size:14px;color:#374151;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em">Steuerübersicht</h2>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600">Steuersatz</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Netto</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Steuer</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600">Brutto</th>
        </tr></thead>
        <tbody>${mwstZeilen}</tbody>
      </table>
    </div>

    <!-- Belegzähler -->
    <div style="padding:12px 28px 24px;background:#f9fafb;display:flex;gap:24px">
      <div style="text-align:center">
        <p style="margin:0;font-size:24px;font-weight:800;color:#111827">${daten.anzahlBarzahlungsbelege}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#6b7280">Belege</p>
      </div>
      <div style="text-align:center">
        <p style="margin:0;font-size:24px;font-weight:800;color:#ef4444">${daten.anzahlStornobelege}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#6b7280">Stornos</p>
      </div>
    </div>
  </div>
</body>
</html>`

  await transporter.sendMail({
    from,
    to:      empfaenger,
    subject: `Tagesabschluss ${daten.datum} — ${daten.firmenname}`,
    html,
    text:    `Tagesabschluss ${daten.datum}\n${daten.firmenname} / Kasse ${daten.kassenId}\n\nNetto-Umsatz: ${fmt(daten.nettoUmsatzCent)}\nBar: ${fmt(daten.barCent)}\nKarte: ${fmt(daten.karteCent)}\nBelege: ${daten.anzahlBarzahlungsbelege}\nStornos: ${daten.anzahlStornobelege}\n`,
  })
}
