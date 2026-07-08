/**
 * Anzeige eines signierten Belegs in Bon-Form.
 * Zeigt Positionen, Steueraufteilung und den RKSV-Maschinencode.
 */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import type { BelegResponse } from '@kassa/shared'
import { MWST_LABELS } from '@kassa/shared'
import { druckerApi, emailApi } from '../lib/api'
import { formatPreis, formatDatum } from '../lib/format'
import { druckeRechnung } from '../lib/rechnung'
import { getAuth } from '../lib/auth'

interface Props {
  beleg:            BelegResponse
  /** Maschinenlesbaren Code sofort aufgeklappt zeigen (z. B. für Jahresbeleg-Prüfung) */
  codeAufgeklappt?: boolean
  /** Wenn gesetzt: „Digitaler Beleg"-QR (URL zur öffentlichen Beleg-Ansicht) zum Scannen anzeigen */
  belegQrUrl?:      string | undefined
  /** Belegausgabe-Modus der Kasse — 'digital' zeigt Akzeptiert/Nicht-akzeptiert statt Druck-Buttons */
  belegModus?:      string | undefined
  /** Aufruf wenn der Gast den digitalen Beleg akzeptiert (bzw. nach Ausweich-Druck) → Dialog schließen */
  onAkzeptiert?:    () => void
}

export function BonAnzeige({ beleg, codeAufgeklappt = false, belegQrUrl, belegModus, onAkzeptiert }: Props) {
  const [druckStatus, setDruckStatus] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [emailOffen,  setEmailOffen]  = useState(false)
  const [emailAdresse, setEmailAdresse] = useState('')

  const istDigital = belegModus === 'digital' && beleg.belegTyp === 'Barzahlungsbeleg'

  const druckMutation = useMutation({
    mutationFn: () => druckerApi.reprint(beleg.id),
    onSuccess:  () => setDruckStatus({ typ: 'ok', text: 'Druckauftrag gesendet' }),
    onError:    (err) => setDruckStatus({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  // „Nicht akzeptiert" → Rechnung auf den Kassa-Bondrucker drucken (Ausweich, erzwungen)
  const nichtAkzeptiertMutation = useMutation({
    mutationFn: () => druckerApi.reprint(beleg.id, { ausweich: true }),
    onSuccess:  () => onAkzeptiert?.(),
    onError:    (err) => setDruckStatus({ typ: 'fehler', text: `Ausweich-Druck fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` }),
  })

  const emailMutation = useMutation({
    mutationFn: () => emailApi.sendBeleg(beleg.id, emailAdresse.trim()),
    onSuccess:  () => { setDruckStatus({ typ: 'ok', text: `E-Mail an ${emailAdresse.trim()} gesendet` }); setEmailOffen(false); setEmailAdresse('') },
    onError:    (err) => setDruckStatus({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })
  const steuerEintraege = (
    [
      ['normal',      beleg.betraege.normal],
      ['ermaessigt1', beleg.betraege.ermaessigt1],
      ['ermaessigt2', beleg.betraege.ermaessigt2],
      ['null',        beleg.betraege.null],
      ['besonders',   beleg.betraege.besonders],
    ] as const
  ).filter(([, cent]) => cent !== 0)

  return (
    <div className="space-y-5">
      {/* Kopf */}
      <div className="flex items-start justify-between text-sm">
        <div>
          <p className="font-semibold text-ink">{beleg.belegTyp}</p>
          <p className="text-ink-muted">{formatDatum(beleg.belegDatum)}</p>
        </div>
        <div className="text-right">
          <p className="text-ink-muted">Beleg-Nr.</p>
          <p className="font-mono font-semibold">#{beleg.belegNummer}</p>
        </div>
      </div>

      {/* Kunden-Block */}
      {beleg.kunde && (
        <div className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm space-y-0.5">
          <p className="font-semibold text-brand-800">{beleg.kunde.bezeichnung}</p>
          {beleg.kunde.strasse && (
            <p className="text-xs text-brand-700">
              {beleg.kunde.strasse}{beleg.kunde.plz || beleg.kunde.ort ? `, ${[beleg.kunde.plz, beleg.kunde.ort].filter(Boolean).join(' ')}` : ''}
            </p>
          )}
          {beleg.kunde.uid && (
            <p className="text-xs text-brand-600">UID: {beleg.kunde.uid}</p>
          )}
          {beleg.kunde.email && (
            <p className="text-xs text-brand-600">{beleg.kunde.email}</p>
          )}
        </div>
      )}

      {/* Positionen */}
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-ink-muted border-b border-line">
          <tr>
            <th className="py-1.5 text-left font-semibold">Artikel</th>
            <th className="py-1.5 text-right font-semibold">Menge</th>
            <th className="py-1.5 text-right font-semibold">Einzel</th>
            <th className="py-1.5 text-right font-semibold">Summe</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {beleg.positionen.map((p, i) => (
            <tr key={i}>
              <td className="py-1.5 text-ink">
                {p.bezeichnung}
                {p.seriennummern && p.seriennummern.length > 0 && (
                  <span className="block text-[10px] text-ink-muted font-mono">
                    S/N: {p.seriennummern.join(', ')}
                  </span>
                )}
              </td>
              <td className="py-1.5 text-right font-mono">{p.menge}</td>
              <td className="py-1.5 text-right font-mono">{formatPreis(p.einzelpreisBreutto)}</td>
              <td className="py-1.5 text-right font-mono font-medium">
                {formatPreis(p.einzelpreisBreutto * p.menge)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Steueraufteilung */}
      {steuerEintraege.length > 0 && (
        <div className="border-t border-line pt-3 text-xs space-y-1">
          {steuerEintraege.map(([key, cent]) => (
            <div key={key} className="flex justify-between text-ink-muted">
              <span>{MWST_LABELS[key]}</span>
              <span className="font-mono">{formatPreis(cent)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Gesamt */}
      <div className="border-t border-line pt-3 flex items-center justify-between text-base font-bold">
        <span>Gesamt</span>
        <span className="font-mono">{formatPreis(beleg.gesamtbetragCent)}</span>
      </div>

      {/* Zahlungsaufteilung */}
      <div className="bg-panel-2 rounded-md p-3 text-sm space-y-1">
        {beleg.summeBarCent > 0 && (
          <div className="flex justify-between"><span>Bar</span><span className="font-mono">{formatPreis(beleg.summeBarCent)}</span></div>
        )}
        {beleg.summeKarteCent > 0 && (
          <div className="flex justify-between"><span>Karte</span><span className="font-mono">{formatPreis(beleg.summeKarteCent)}</span></div>
        )}
        {beleg.summeSonstigeCent > 0 && (
          <div className="flex justify-between"><span>Sonstige</span><span className="font-mono">{formatPreis(beleg.summeSonstigeCent)}</span></div>
        )}
      </div>

      {/* Digitaler Beleg — QR zum Scannen (Gast holt sich den Beleg aufs Handy) */}
      {belegQrUrl && beleg.belegTyp === 'Barzahlungsbeleg' && (
        <div className="border-t border-line pt-4 flex flex-col items-center gap-2">
          <div className="rounded-lg bg-white p-2 border border-line">
            <QRCodeSVG value={belegQrUrl} size={128} level="M" includeMargin />
          </div>
          <p className="text-xs font-medium text-ink">Digitaler Beleg — zum Mitnehmen scannen</p>
        </div>
      )}

      {/* Digital-Modus: rechtlicher Akzeptanz-Ablauf (Belegerteilungspflicht) */}
      {istDigital && (
        <div className="border-t border-line pt-4 space-y-2">
          <p className="text-center text-xs text-ink-muted">Hat der Gast den digitalen Beleg angenommen?</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAkzeptiert?.()}
              className="flex-1 rounded-md bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Akzeptiert
            </button>
            <button
              type="button"
              onClick={() => { setDruckStatus(null); nichtAkzeptiertMutation.mutate() }}
              disabled={nichtAkzeptiertMutation.isPending}
              className="flex-1 rounded-md border border-line-strong bg-panel px-3 py-2.5 text-sm font-semibold text-ink hover:bg-panel-2 disabled:opacity-50"
            >
              {nichtAkzeptiertMutation.isPending ? 'Drucke…' : 'Nicht akzeptiert (drucken)'}
            </button>
          </div>
          {druckStatus && druckStatus.typ === 'fehler' && (
            <p className="text-center text-xs text-red-600">{druckStatus.text}</p>
          )}
        </div>
      )}

      {/* Drucken */}
      <div className="border-t border-line pt-3 flex items-center justify-between flex-wrap gap-2">
        <div>
          {druckStatus && (
            <p className={`text-xs ${druckStatus.typ === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
              {druckStatus.text}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {beleg.belegTyp === 'Barzahlungsbeleg' && (
            <button
              type="button"
              onClick={() => {
                const auth = getAuth()
                if (auth) druckeRechnung(beleg, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/>
              </svg>
              Rechnung / PDF
            </button>
          )}
          {/* „Bon drucken" nicht im Digital-Modus (dort läuft der Druck über „Nicht akzeptiert") */}
          {!istDigital && (
            <button
              type="button"
              onClick={() => { setDruckStatus(null); druckMutation.mutate() }}
              disabled={druckMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:bg-panel-2 disabled:opacity-50"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 4v3H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2h1a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd"/>
              </svg>
              {druckMutation.isPending ? 'Drucke…' : 'Bon drucken'}
            </button>
          )}
          {/* E-Mail-Button */}
          {!emailOffen ? (
            <button
              type="button"
              onClick={() => { setDruckStatus(null); setEmailOffen(true) }}
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:bg-panel-2"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/>
                <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/>
              </svg>
              Per E-Mail
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                type="email"
                value={emailAdresse}
                onChange={e => setEmailAdresse(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && emailAdresse.includes('@')) emailMutation.mutate() }}
                placeholder="email@example.com"
                className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
              <button
                type="button"
                onClick={() => emailMutation.mutate()}
                disabled={emailMutation.isPending || !emailAdresse.includes('@')}
                className="rounded-md bg-brand-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {emailMutation.isPending ? '…' : 'Senden'}
              </button>
              <button type="button" onClick={() => setEmailOffen(false)} className="text-ink-subtle hover:text-ink-muted px-1">✕</button>
            </div>
          )}
        </div>
      </div>

      {/* RKSV-Code */}
      <details className="text-xs" open={codeAufgeklappt}>
        <summary className="cursor-pointer text-ink-muted hover:text-ink">
          RKSV-Maschinencode anzeigen
        </summary>
        <div className="mt-2 rounded border border-line bg-panel-2 p-2 font-mono text-[10px] break-all text-ink">
          {beleg.maschinenlesbareCode}
        </div>
        <p className="mt-1 text-ink-subtle">
          Signaturzertifikat-SN: <span className="font-mono">{beleg.zertifikatSn}</span>
        </p>
      </details>
    </div>
  )
}
