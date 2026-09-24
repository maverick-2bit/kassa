import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TICKETSHOP_KAUFHINWEIS_VORSCHLAG, TicketShopEinstellungenSchema } from '@kassa/shared'
import { kasseApi, ticketingApi } from '../../lib/api'
import { fehlerText } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'

/**
 * Online-Verkauf (Ticketshop): Verkaufskasse für die RKSV-Belege, Rechtstexte
 * und der Link auf die Übersicht aller Events. Bezahlt wird über das
 * Stripe-Konto aus den Einstellungen.
 */
export function OnlineVerkauf() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['ticketshop-einstellungen'], queryFn: ticketingApi.shopEinstellungen })
  const { data: kassen = [] } = useQuery({ queryKey: ['kassen-liste'], queryFn: kasseApi.liste })
  const [kasseId,     setKasseId]     = useState('')
  const [agb,         setAgb]         = useState('')
  const [datenschutz, setDatenschutz] = useState('')
  const [impressum,   setImpressum]   = useState('')
  const [hinweis,     setHinweis]     = useState('')
  const [fehler,      setFehler]      = useState<string | null>(null)
  const [ok,          setOk]          = useState(false)
  const [kopiert,     setKopiert]     = useState(false)

  useEffect(() => {
    if (!data) return
    setKasseId(data.verkaufKasseId ?? '')
    setAgb(data.agbUrl ?? '')
    setDatenschutz(data.datenschutzUrl ?? '')
    setImpressum(data.impressumUrl ?? '')
    setHinweis(data.kaufhinweis ?? '')
  }, [data])

  const speichern = useMutation({
    mutationFn: () => {
      const input = TicketShopEinstellungenSchema.parse({
        verkaufKasseId: kasseId || null,
        agbUrl:         agb.trim() || null,
        datenschutzUrl: datenschutz.trim() || null,
        impressumUrl:   impressum.trim() || null,
        kaufhinweis:    hinweis.trim() || null,
      })
      return ticketingApi.setzeShopEinstellungen(input)
    },
    onSuccess: (d) => {
      qc.setQueryData(['ticketshop-einstellungen'], d)
      setFehler(null); setOk(true); setTimeout(() => setOk(false), 2500)
    },
    onError: (err) => {
      const issues = (err as { issues?: Array<{ message: string }> }).issues
      setFehler(issues ? issues.map(i => i.message).join(' · ') : fehlerText(err))
    },
  })

  const aktiveKassen = kassen.filter(k => !k.ausserBetriebAm)
  const bereit = !!data?.verkaufKasseId && !!data.stripe.konfiguriert

  return (
    <section className={`rounded-xl border p-4 ${data && !bereit ? 'border-amber-200 bg-amber-50' : 'border-line bg-panel'}`}>
      <h2 className="text-sm font-semibold text-ink">Online-Verkauf</h2>
      <p className="mt-0.5 text-xs text-ink-muted">
        Gäste kaufen Tickets selbst über die Ticket-Adresse. Bezahlt wird mit Stripe; jeder Kauf wird als Beleg auf der
        Verkaufskasse gebucht und die Tickets kommen per E-Mail.
      </p>

      {data && (
        <ul className="mt-2 space-y-0.5 text-xs">
          <li className={data.stripe.konfiguriert ? 'text-green-700' : 'text-amber-800'}>
            {data.stripe.konfiguriert
              ? `✓ Online-Zahlung eingerichtet${data.stripe.eigenesKonto ? ' (eigenes Stripe-Konto)' : ''}`
              : <>Online-Zahlung fehlt — unter <Link to="/einstellungen" className="underline">Einstellungen → Online-Zahlung (Stripe)</Link> eintragen</>}
          </li>
          <li className={data.verkaufKasseId ? 'text-green-700' : 'text-amber-800'}>
            {data.verkaufKasseId ? '✓ Verkaufskasse gewählt' : 'Verkaufskasse fehlt — ohne sie ist der Verkauf kostenpflichtiger Tickets aus'}
          </li>
        </ul>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-ink sm:col-span-2">
          Verkaufskasse <span className="font-normal text-ink-muted">— auf dieser Kasse entstehen die RKSV-Belege der Online-Käufe</span>
          <Select className="mt-1" value={kasseId} onChange={e => setKasseId(e.target.value)}>
            <option value="">— kein Online-Verkauf —</option>
            {aktiveKassen.map(k => <option key={k.id} value={k.id}>{k.bezeichnung ?? k.kassenId} ({k.kassenId})</option>)}
          </Select>
        </label>
        <label className="block text-xs font-medium text-ink">
          AGB (Adresse)
          <Input className="mt-1" value={agb} onChange={e => setAgb(e.target.value)} placeholder="https://…/agb" />
        </label>
        <label className="block text-xs font-medium text-ink">
          Datenschutzerklärung (Adresse)
          <Input className="mt-1" value={datenschutz} onChange={e => setDatenschutz(e.target.value)} placeholder="https://…/datenschutz" />
        </label>
        <label className="block text-xs font-medium text-ink">
          Impressum (Adresse)
          <Input className="mt-1" value={impressum} onChange={e => setImpressum(e.target.value)} placeholder="https://…/impressum" />
        </label>
        <label className="block text-xs font-medium text-ink sm:col-span-2">
          Hinweis im Kaufformular <span className="font-normal text-ink-muted">— optional, z. B. zum Rücktrittsrecht</span>
          <textarea value={hinweis} onChange={e => setHinweis(e.target.value)} rows={2} maxLength={2000}
            className="mt-1 block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink" />
          {!hinweis.trim() && (
            <button type="button" className="mt-1 text-xs font-normal text-brand-600 hover:underline"
              onClick={() => setHinweis(TICKETSHOP_KAUFHINWEIS_VORSCHLAG)}>
              Vorschlag einfügen (Rücktrittsrecht bei Veranstaltungen mit fixem Termin — bitte rechtlich prüfen lassen)
            </button>
          )}
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" loading={speichern.isPending} onClick={() => speichern.mutate()}>Online-Verkauf speichern</Button>
        {ok && <span className="text-xs text-green-700">✓ gespeichert</span>}
      </div>
      {fehler && <p className="mt-2 text-xs text-red-600">{fehler}</p>}

      {data?.shopUrl && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          Alle Events zum Verlinken (Website, Social Media):
          <a href={data.shopUrl} target="_blank" rel="noreferrer" className="font-mono text-brand-600 hover:underline">{data.shopUrl}</a>
          <button type="button" className="text-brand-600 hover:underline"
            onClick={() => { void navigator.clipboard?.writeText(data.shopUrl!); setKopiert(true); setTimeout(() => setKopiert(false), 2000) }}>
            {kopiert ? '✓ kopiert' : 'kopieren'}
          </button>
        </p>
      )}
      <p className="mt-2 text-[11px] text-ink-subtle">
        Stripe-Webhook: zusätzlich zu „checkout.session.completed“ die Ereignisse „checkout.session.expired“,
        „checkout.session.async_payment_succeeded“ und „…async_payment_failed“ abonnieren — dann werden abgebrochene
        Zahlungen sofort wieder frei (sonst spätestens nach 45 Minuten).
      </p>
    </section>
  )
}
