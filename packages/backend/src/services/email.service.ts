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
      <p style="margin:0;font-size:10px;color:#9ca3af;font-family:monospace;word-break:break-all">
        Sig: ${daten.signaturwert.substring(0, 40)}…
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
