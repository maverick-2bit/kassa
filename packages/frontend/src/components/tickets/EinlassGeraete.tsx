import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import type { EinlassGeraetAngelegt } from '@kassa/shared'
import { ticketingApi } from '../../lib/api'
import { fehlerText } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'

const ZULETZT = new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * Scanner-Handys für den Einlass. Jedes Gerät bekommt einen eigenen Zugang
 * (einzeln sperrbar — verlorenes Handy); der Einrichtungs-QR wird nur einmal
 * gezeigt, weil er diesen Zugang enthält.
 */
export function EinlassGeraete({ einlassAdresseFehlt }: { einlassAdresseFehlt: boolean }) {
  const qc = useQueryClient()
  const [name,     setName]     = useState('')
  const [neu,      setNeu]      = useState<EinlassGeraetAngelegt | null>(null)
  const [fehler,   setFehler]   = useState<string | null>(null)

  const { data: geraete = [] } = useQuery({ queryKey: ['einlass-geraete'], queryFn: ticketingApi.einlassGeraete })
  const aktive = geraete.filter(g => !g.widerrufenAt)

  const anlegen = useMutation({
    mutationFn: () => ticketingApi.einlassGeraetAnlegen(name.trim() || `Einlass ${aktive.length + 1}`),
    onSuccess:  (g) => { setNeu(g); setName(''); setFehler(null); void qc.invalidateQueries({ queryKey: ['einlass-geraete'] }) },
    onError:    (err) => setFehler(fehlerText(err)),
  })
  const sperren = useMutation({
    mutationFn: ticketingApi.einlassGeraetSperren,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['einlass-geraete'] }),
    onError:    (err) => setFehler(fehlerText(err)),
  })

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold text-ink">Einlass-Geräte</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Handys oder Tablets, die am Eingang Tickets scannen. Jedes Gerät bekommt seinen eigenen Zugang und lässt sich
        einzeln sperren, falls es verloren geht.
      </p>

      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); anlegen.mutate() }}>
        <div className="min-w-[12rem] flex-1">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={`Einlass ${aktive.length + 1}`} maxLength={60} />
        </div>
        <Button size="sm" type="submit" loading={anlegen.isPending}>+ Gerät einrichten</Button>
      </form>
      {einlassAdresseFehlt && (
        <p className="mt-2 text-xs text-amber-700">
          Tipp: Mit eingetragener Einlass-Adresse bekommt jedes Gerät einen QR zum Einrichten. Ohne sie bleibt nur das
          Einfügen des Zugangs von Hand.
        </p>
      )}
      {fehler && <p className="mt-2 text-xs text-red-600">{fehler}</p>}

      {geraete.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {geraete.map(g => (
            <li key={g.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`h-2 w-2 rounded-full ${g.widerrufenAt ? 'bg-red-500' : 'bg-green-500'}`} />
              <span className={`flex-1 font-medium ${g.widerrufenAt ? 'text-ink-subtle line-through' : 'text-ink'}`}>{g.name}</span>
              <span className="text-xs text-ink-muted">
                {g.widerrufenAt ? 'gesperrt' : g.zuletztAktivAt ? `zuletzt ${ZULETZT.format(new Date(g.zuletztAktivAt))}` : 'noch nicht verbunden'}
              </span>
              {!g.widerrufenAt && (
                <button type="button" className="text-xs font-medium text-red-600 hover:underline"
                  onClick={() => { if (window.confirm(`Gerät „${g.name}“ sperren? Es kann danach nicht mehr scannen.`)) sperren.mutate(g.id) }}>
                  Sperren
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={neu !== null} onClose={() => setNeu(null)} title={`Gerät „${neu?.geraet.name ?? ''}“ einrichten`} size="sm">
        {neu && (
          <div className="space-y-3 text-sm">
            {neu.url ? (
              <>
                <p className="text-ink-muted">Mit der <strong>Kamera des Einlass-Handys</strong> scannen — der Link öffnet die Einlass-App und verbindet das Gerät.</p>
                <div className="flex justify-center rounded-lg bg-white p-4">
                  <QRCodeSVG value={neu.url} size={240} level="M" />
                </div>
              </>
            ) : (
              <>
                <p className="text-ink-muted">
                  Ohne Einlass-Adresse gibt es keinen QR. In der Einlass-App „Token von Hand einfügen“ wählen und diesen
                  Zugang einfügen:
                </p>
                <textarea readOnly value={neu.token} rows={5} onFocus={e => e.target.select()}
                  className="block w-full rounded-md border border-line-strong bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink" />
              </>
            )}
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Der QR enthält den Zugang dieses Geräts. Nur mit dem Einlass-Gerät scannen und nicht weitergeben —
              er wird aus Sicherheitsgründen nur jetzt angezeigt. Geht das Gerät verloren: hier sperren.
            </p>
            <div className="flex justify-end"><Button onClick={() => setNeu(null)}>Fertig</Button></div>
          </div>
        )}
      </Modal>
    </section>
  )
}
