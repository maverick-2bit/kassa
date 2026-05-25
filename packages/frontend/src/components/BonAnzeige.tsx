/**
 * Anzeige eines signierten Belegs in Bon-Form.
 * Zeigt Positionen, Steueraufteilung und den RKSV-Maschinencode.
 */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { BelegResponse } from '@kassa/shared'
import { MWST_LABELS } from '@kassa/shared'
import { druckerApi } from '../lib/api'
import { formatPreis, formatDatum } from '../lib/format'
import { druckeRechnung } from '../lib/rechnung'
import { getAuth } from '../lib/auth'

interface Props {
  beleg:            BelegResponse
  /** Maschinenlesbaren Code sofort aufgeklappt zeigen (z. B. für Jahresbeleg-Prüfung) */
  codeAufgeklappt?: boolean
}

export function BonAnzeige({ beleg, codeAufgeklappt = false }: Props) {
  const [druckStatus, setDruckStatus] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const druckMutation = useMutation({
    mutationFn: () => druckerApi.reprint(beleg.id),
    onSuccess:  () => setDruckStatus({ typ: 'ok', text: 'Druckauftrag gesendet' }),
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
          <p className="font-semibold text-gray-900">{beleg.belegTyp}</p>
          <p className="text-gray-500">{formatDatum(beleg.belegDatum)}</p>
        </div>
        <div className="text-right">
          <p className="text-gray-500">Beleg-Nr.</p>
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
        <thead className="text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
          <tr>
            <th className="py-1.5 text-left font-semibold">Artikel</th>
            <th className="py-1.5 text-right font-semibold">Menge</th>
            <th className="py-1.5 text-right font-semibold">Einzel</th>
            <th className="py-1.5 text-right font-semibold">Summe</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {beleg.positionen.map((p, i) => (
            <tr key={i}>
              <td className="py-1.5 text-gray-900">{p.bezeichnung}</td>
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
        <div className="border-t border-gray-200 pt-3 text-xs space-y-1">
          {steuerEintraege.map(([key, cent]) => (
            <div key={key} className="flex justify-between text-gray-600">
              <span>{MWST_LABELS[key]}</span>
              <span className="font-mono">{formatPreis(cent)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Gesamt */}
      <div className="border-t border-gray-200 pt-3 flex items-center justify-between text-base font-bold">
        <span>Gesamt</span>
        <span className="font-mono">{formatPreis(beleg.gesamtbetragCent)}</span>
      </div>

      {/* Zahlungsaufteilung */}
      <div className="bg-gray-50 rounded-md p-3 text-sm space-y-1">
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

      {/* Drucken */}
      <div className="border-t border-gray-200 pt-3 flex items-center justify-between flex-wrap gap-2">
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
          <button
            type="button"
            onClick={() => { setDruckStatus(null); druckMutation.mutate() }}
            disabled={druckMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 4v3H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2h1a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd"/>
            </svg>
            {druckMutation.isPending ? 'Drucke…' : 'Bon drucken'}
          </button>
        </div>
      </div>

      {/* RKSV-Code */}
      <details className="text-xs" open={codeAufgeklappt}>
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
          RKSV-Maschinencode anzeigen
        </summary>
        <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[10px] break-all text-gray-700">
          {beleg.maschinenlesbareCode}
        </div>
        <p className="mt-1 text-gray-400">
          Signaturzertifikat-SN: <span className="font-mono">{beleg.zertifikatSn}</span>
        </p>
      </details>
    </div>
  )
}
