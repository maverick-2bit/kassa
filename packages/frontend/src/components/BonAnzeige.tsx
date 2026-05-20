/**
 * Anzeige eines signierten Belegs in Bon-Form.
 * Zeigt Positionen, Steueraufteilung und den RKSV-Maschinencode.
 */

import type { BelegResponse } from '@kassa/shared'
import { MWST_LABELS } from '@kassa/shared'
import { formatPreis, formatDatum } from '../lib/format'

interface Props {
  beleg: BelegResponse
}

export function BonAnzeige({ beleg }: Props) {
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

      {/* RKSV-Code */}
      <details className="text-xs">
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
