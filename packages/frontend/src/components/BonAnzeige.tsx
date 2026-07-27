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
import { AusgabeDialog } from './AusgabeDialog'

interface Props {
  beleg:            BelegResponse
  /** Maschinenlesbaren Code sofort aufgeklappt zeigen (z. B. für Jahresbeleg-Prüfung) */
  codeAufgeklappt?: boolean
  /** Belegausgabe-Modus der Kasse — 'digital'/'beides' zeigt den Foto-Beleg (RKSV-QR am Bildschirm) */
  belegModus?:      string | undefined
  /** Aufruf wenn der Gast den digitalen Beleg akzeptiert (bzw. nach Ausweich-Druck) → Dialog schließen */
  onAkzeptiert?:    () => void
}

export function BonAnzeige({ beleg, codeAufgeklappt = false, belegModus, onAkzeptiert }: Props) {
  const [druckStatus,  setDruckStatus]  = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [ausgabeOffen, setAusgabeOffen] = useState(false)

  const istDigital = belegModus === 'digital' && beleg.belegTyp === 'Barzahlungsbeleg'

  // „Nicht akzeptiert" → Rechnung auf den Kassa-Bondrucker drucken (Ausweich, erzwungen)
  const nichtAkzeptiertMutation = useMutation({
    mutationFn: () => druckerApi.reprint(beleg.id, { ausweich: true }),
    onSuccess:  () => onAkzeptiert?.(),
    onError:    (err) => setDruckStatus({ typ: 'fehler', text: `Ausweich-Druck fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` }),
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

      {/* Digitaler Beleg = Foto-Beleg: vollständiger Beleg am Bildschirm inkl. RKSV-QR,
          der Gast fotografiert ihn ab (kein Netz nötig — nichts verlässt den Laden) */}
      {(belegModus === 'digital' || belegModus === 'beides') && beleg.belegTyp === 'Barzahlungsbeleg' && (
        <div className="border-t border-line pt-4 flex flex-col items-center gap-2">
          {(() => { const auth = getAuth(); return auth ? (
            <p className="text-xs text-ink-muted text-center">
              <span className="font-semibold text-ink">{auth.mandant.firmenname}</span> · UID {auth.mandant.uid}
            </p>
          ) : null })()}
          <div className="rounded-lg bg-white p-2 border border-line">
            <QRCodeSVG value={beleg.maschinenlesbareCode} size={148} level="M" includeMargin />
          </div>
          <p className="text-xs font-medium text-ink">Digitaler Beleg — bitte abfotografieren, oder per E-Mail erhalten</p>
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
        {/* EIN Weg für alle Ausgaben — identisch zu Rechnung, Lieferschein,
            Gutschein, Inventur … (siehe AusgabeDialog). */}
        <button
          type="button"
          onClick={() => { setDruckStatus(null); setAusgabeOffen(true) }}
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:bg-panel-2"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5 4v3H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2h1a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd"/>
          </svg>
          Ausgabe wählen …
        </button>
      </div>

      <AusgabeDialog
        open={ausgabeOffen}
        onClose={() => setAusgabeOffen(false)}
        titel={`Beleg #${beleg.belegNummer} ausgeben`}
        wege={{
          // Im Digital-Modus läuft der Papierweg bewusst über „Nicht akzeptiert"
          bon: !istDigital,
          a4:  beleg.belegTyp === 'Barzahlungsbeleg',
          weitereDrucker: !istDigital,
          mail: true,
          ohne: true,
        }}
        onAusgabe={async (ziel) => {
          const auth = getAuth()
          switch (ziel.art) {
            case 'bon':     await druckerApi.reprint(beleg.id); setDruckStatus({ typ: 'ok', text: 'Druckauftrag gesendet' }); break
            case 'drucker': await druckerApi.reprint(beleg.id, { druckerId: ziel.druckerId }); setDruckStatus({ typ: 'ok', text: `Gesendet an ${ziel.name}` }); break
            case 'mail':    await emailApi.sendBeleg(beleg.id, ziel.empfaenger); setDruckStatus({ typ: 'ok', text: `E-Mail an ${ziel.empfaenger} gesendet` }); break
            case 'a4':
              if (auth) druckeRechnung(beleg, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
              break
            case 'keine':   break
          }
        }}
      />

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
