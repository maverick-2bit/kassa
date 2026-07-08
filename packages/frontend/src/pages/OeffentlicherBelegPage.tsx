/**
 * Öffentliche Beleg-Ansicht (digitaler Beleg) — KEIN Login.
 *
 * Zielseite des QR-Codes, den der Gast an der Kassa / am Kundendisplay scannt.
 * Lädt den Beleg über `GET /api/oeffentlich/beleg/:belegId` und zeigt ihn als
 * sauberen Bon inkl. RKSV-QR + „Als PDF speichern". Read-only (keine Kasse-
 * Aktionen wie Nachdruck/E-Mail).
 */

import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { MWST_LABELS } from '@kassa/shared'
import { oeffentlicherBelegApi } from '../lib/api'
import { formatPreis, formatDatum } from '../lib/format'
import { druckeRechnung } from '../lib/rechnung'

export function OeffentlicherBelegPage() {
  const { belegId } = useParams<{ belegId: string }>()

  const query = useQuery({
    queryKey: ['oeffentlicher-beleg', belegId],
    queryFn:  () => oeffentlicherBelegApi.get(belegId!),
    enabled:  !!belegId,
    retry:    false,
  })

  return (
    <div className="min-h-screen bg-gray-100 flex justify-center py-6 px-3">
      <div className="w-full max-w-md">
        {query.isLoading && (
          <p className="text-center text-sm text-gray-500 py-20">Beleg wird geladen…</p>
        )}

        {query.isError && (
          <div className="rounded-xl bg-white border border-gray-200 shadow-sm p-6 text-center">
            <p className="text-4xl">🧾</p>
            <p className="mt-3 font-semibold text-gray-900">Beleg nicht gefunden</p>
            <p className="mt-1 text-sm text-gray-500">
              Dieser digitale Beleg ist nicht (mehr) verfügbar. Bitte prüfe den gescannten Code.
            </p>
          </div>
        )}

        {query.data && (() => {
          const { beleg, firmenname, uid, kassenId } = query.data
          const steuer = (
            [
              ['normal',      beleg.betraege.normal],
              ['ermaessigt1', beleg.betraege.ermaessigt1],
              ['ermaessigt2', beleg.betraege.ermaessigt2],
              ['null',        beleg.betraege.null],
              ['besonders',   beleg.betraege.besonders],
            ] as const
          ).filter(([, cent]) => cent !== 0)

          return (
            <div className="rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              {/* Kopf */}
              <div className="px-5 pt-5 pb-4 text-center border-b border-dashed border-gray-300">
                <p className="text-lg font-bold text-gray-900">{firmenname}</p>
                <p className="text-xs text-gray-500">UID: {uid}</p>
                <p className="mt-2 text-sm font-semibold text-gray-800">{beleg.belegTyp}</p>
                <p className="text-xs text-gray-500">
                  Beleg-Nr. {beleg.belegNummer} · {formatDatum(beleg.belegDatum)}
                </p>
              </div>

              {/* Positionen */}
              <table className="w-full text-sm px-5">
                <tbody className="divide-y divide-gray-100">
                  {beleg.positionen.map((p, i) => (
                    <tr key={i}>
                      <td className="py-2 pl-5 text-gray-800">
                        {p.menge} × {p.bezeichnung}
                        {p.seriennummern && p.seriennummern.length > 0 && (
                          <span className="block text-[10px] text-gray-400 font-mono">
                            S/N: {p.seriennummern.join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-5 text-right font-mono text-gray-900 whitespace-nowrap">
                        {formatPreis(p.einzelpreisBreutto * p.menge)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Steuer + Gesamt */}
              <div className="px-5 py-3 border-t border-dashed border-gray-300 text-xs space-y-1">
                {steuer.map(([key, cent]) => (
                  <div key={key} className="flex justify-between text-gray-500">
                    <span>{MWST_LABELS[key]}</span>
                    <span className="font-mono">{formatPreis(cent)}</span>
                  </div>
                ))}
              </div>
              <div className="px-5 pb-3 flex items-center justify-between text-base font-bold text-gray-900">
                <span>Gesamt</span>
                <span className="font-mono">{formatPreis(beleg.gesamtbetragCent)}</span>
              </div>

              {/* Zahlung */}
              <div className="mx-5 mb-4 rounded-md bg-gray-50 px-3 py-2 text-sm space-y-1">
                {beleg.summeBarCent > 0 && (
                  <div className="flex justify-between text-gray-700"><span>Bar</span><span className="font-mono">{formatPreis(beleg.summeBarCent)}</span></div>
                )}
                {beleg.summeKarteCent > 0 && (
                  <div className="flex justify-between text-gray-700"><span>Karte</span><span className="font-mono">{formatPreis(beleg.summeKarteCent)}</span></div>
                )}
                {beleg.summeSonstigeCent > 0 && (
                  <div className="flex justify-between text-gray-700"><span>Sonstige</span><span className="font-mono">{formatPreis(beleg.summeSonstigeCent)}</span></div>
                )}
              </div>

              {/* RKSV-QR */}
              <div className="px-5 py-4 border-t border-dashed border-gray-300 flex flex-col items-center">
                <QRCodeSVG value={beleg.maschinenlesbareCode} size={148} level="M" includeMargin />
                <p className="mt-2 text-[10px] text-gray-400 text-center">
                  RKSV-Signatur · Zert.-SN {beleg.zertifikatSn} · Kasse {kassenId}
                </p>
              </div>

              {/* Aktion */}
              <div className="px-5 pb-5">
                <button
                  type="button"
                  onClick={() => druckeRechnung(beleg, { firmenname, uid })}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Als PDF speichern / drucken
                </button>
              </div>
            </div>
          )
        })()}

        <p className="mt-4 text-center text-[11px] text-gray-400">
          Digitaler Beleg gemäß österreichischer Belegerteilungspflicht.
        </p>
      </div>
    </div>
  )
}
