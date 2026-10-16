/**
 * Drucker — EINE Liste aller Drucker im Betrieb: Bondrucker (Rechnung/Beleg) und Bonierdrucker
 * (Küche/Schank, auch als Zweitdrucker) — anlegen, ändern, testen, löschen. Jede Zeile zeigt, WOFÜR der Drucker
 * eingesetzt ist: an welchen Kassen er die Rechnung druckt, welche Warengruppen/Artikel/Kassen-Ausnahmen auf
 * ihn gehen, welche KDS-Station er bedient, wessen Backup-Drucker er ist und ob er der Fallback ist.
 *
 * Zwei Begriffe, die nicht verwechselt werden dürfen: der BACKUP-Drucker springt nur ein, wenn ein Drucker
 * nicht erreichbar ist (fallbackId); der ZWEITDRUCKER bekommt dagegen immer eine Kopie jedes Bons (istBackup).
 *
 * Früher zwei getrennte Bibliotheken (Einstellungen → Hardware) plus die Zuordnung je Kasse darunter.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STATION_LABELS, type Bonierdrucker, type DruckerPool, type DruckerPoolInput } from '@kassa/shared'
import { artikelApi, bonierdruckerApi, druckerPoolApi, kategorieApi, kdsDruckerApi } from '../../lib/api'
import { getAuth } from '../../lib/auth'
import { useServerHost } from '../../lib/serverHost'
import { bonierdruckerBackup, bonierdruckerVerwendung, kassenMitRechnungsdrucker, kassenName } from '../../lib/einrichtung'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { DruckerStatusLed } from '../DruckerStatusLed'
import { useEinrichtung } from './EinrichtungKontext'

type Art = 'bon' | 'bonier'

const LEERER_BON: DruckerPoolInput = { name: '', ip: '', port: 9100, breite: 42, timeoutSek: 5, aktiv: true }
const AUSWAHL = 'block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40'

/** Zeile der gemeinsamen Liste — ein Bondrucker (Pool) oder ein Bonierdrucker. */
type Eintrag =
  | { art: 'bon';    id: string; name: string; ip: string; port: number; aktiv: boolean; roh: DruckerPool }
  | { art: 'bonier'; id: string; name: string; ip: string; port: number; aktiv: boolean; roh: Bonierdrucker }

function Chip({ children, titel, ton = 'marke' }: { children: React.ReactNode; titel?: string; ton?: 'marke' | 'gruen' | 'bernstein' | 'grau' }) {
  const farbe = {
    marke:     'bg-brand-50 text-brand-700',
    gruen:     'bg-emerald-50 text-emerald-700',
    bernstein: 'bg-amber-100 text-amber-700',
    grau:      'bg-panel-2 text-ink-muted',
  }[ton]
  return (
    <span {...(titel ? { title: titel } : {})} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${farbe}`}>
      {children}
    </span>
  )
}

/** Namen höchstens `max` anzeigen, der Rest als „+n" (Tooltip: alle). */
const kurz = (namen: string[], max = 3) => namen.length <= max ? namen.join(', ') : `${namen.slice(0, max).join(', ')} +${namen.length - max}`

export function DruckerSektion() {
  const qc = useQueryClient()
  const auth = getAuth()!
  const { kassen, daten, istGastro, neuLaden } = useEinrichtung()

  const poolQuery   = useQuery({ queryKey: ['drucker-pool'], queryFn: () => druckerPoolApi.list() })
  const bonierQuery = useQuery({ queryKey: ['bonierdrucker'], queryFn: bonierdruckerApi.list, enabled: istGastro })
  // Wofür wird ein Bonierdrucker gebraucht? — Warengruppen, Artikel und KDS-Stationen mit Bezug auf ihn
  const kategorienQuery = useQuery({ queryKey: ['kategorien', 'alle'], queryFn: () => kategorieApi.list(false), enabled: istGastro })
  const artikelQuery    = useQuery({ queryKey: ['artikel', auth.mandant.id, false], queryFn: () => artikelApi.list(auth.mandant.id, false), enabled: istGastro })
  const stationQuery    = useQuery({ queryKey: ['kds-station-drucker'],  queryFn: () => kdsDruckerApi.list(),     enabled: istGastro })
  const fallbackQuery   = useQuery({ queryKey: ['kds-fallback-drucker'], queryFn: () => kdsDruckerApi.fallback(),  enabled: istGastro })

  const eintraege: Eintrag[] = [
    ...(poolQuery.data ?? []).map((d): Eintrag => ({ art: 'bon', id: d.id, name: d.name, ip: d.ip, port: d.port, aktiv: d.aktiv, roh: d })),
    ...(bonierQuery.data ?? []).map((d): Eintrag => ({ art: 'bonier', id: d.id, name: d.name, ip: d.ip, port: d.port, aktiv: d.aktiv, roh: d })),
  ]

  const [modal, setModal]       = useState<{ art: Art; eintrag: Eintrag | null } | null>(null)
  const [testMeldung, setTestMeldung] = useState<Record<string, string>>({})

  const nachAenderung = () => {
    void qc.invalidateQueries({ queryKey: ['drucker-pool'] })
    void qc.invalidateQueries({ queryKey: ['bonierdrucker'] })
    void qc.invalidateQueries({ queryKey: ['drucker'] })
    void qc.invalidateQueries({ queryKey: ['kategorien'] })
    void qc.invalidateQueries({ queryKey: ['artikel'] })
    void qc.invalidateQueries({ queryKey: ['kds-station-drucker'] })
    void qc.invalidateQueries({ queryKey: ['kds-fallback-drucker'] })
    void neuLaden()
  }

  const loeschen = useMutation({
    mutationFn: (e: Eintrag) => e.art === 'bon' ? druckerPoolApi.delete(e.id) : bonierdruckerApi.delete(e.id),
    onSuccess: nachAenderung,
  })

  const testen = useMutation({
    mutationFn: (e: Eintrag) => e.art === 'bon' ? druckerPoolApi.test(e.id) : bonierdruckerApi.test(e.id),
    onSuccess: (res, e) => setTestMeldung(m => ({ ...m, [e.id]: res.erfolgreich ? '✓ Testdruck gesendet' : `✗ ${res.fehler ?? 'Fehler'}` })),
    onError:   (err, e) => setTestMeldung(m => ({ ...m, [e.id]: `✗ ${err instanceof Error ? err.message : 'Fehler'}` })),
  })

  const verwendung = (e: Eintrag) => e.art === 'bon' ? null : bonierdruckerVerwendung(e.id, {
    kategorien:     kategorienQuery.data ?? [],
    artikel:        artikelQuery.data ?? [],
    ausnahmen:      daten?.ausnahmen ?? [],
    stationDrucker: stationQuery.data?.eintraege ?? [],
    fallbackId:     fallbackQuery.data?.bonierdruckerId ?? null,
  })

  function loeschenFragen(e: Eintrag) {
    const v = verwendung(e)
    const backupFuer = e.art === 'bonier' ? bonierdruckerBackup(e.id, bonierQuery.data ?? []).backupFuer : []
    const folgen = e.art === 'bon'
      ? (kassenMitRechnungsdrucker(e.id, kassen).length > 0 ? ' Kassen, die ihn nutzen, drucken danach nicht mehr.' : '')
      : v && (v.warengruppen.length + v.artikel + v.ausnahmen + v.stationen.length > 0 || v.fallback)
        ? ' Seine Zuordnungen (Warengruppen, Artikel, Kassen-Ausnahmen, KDS-Stationen) fallen weg.' : ''
    // Ein gelöschter Backup-Drucker lässt den Drucker, den er vertrat, ohne Ersatz zurück — das merkt man erst beim nächsten Ausfall
    const backupFolge = backupFuer.length > 0
      ? ` Er ist Backup-Drucker für ${backupFuer.map(n => `„${n}"`).join(', ')} — dort springt danach niemand mehr ein.` : ''
    if (window.confirm(`Drucker „${e.name}" löschen?${folgen}${backupFolge}`)) loeschen.mutate(e)
  }

  const laedt = poolQuery.isLoading || (istGastro && bonierQuery.isLoading)

  return (
    <section id="einrichtung-drucker" className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Drucker</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Alle Bondrucker{istGastro ? ' und Bonierdrucker' : ''} an einer Stelle. Welche Kasse auf welchem Drucker druckt, stellst du
            oben bei „Kassen" ein, welche Warengruppe/Artikel wohin geht weiter unten bei „Drucker & KDS-Station je Kasse".
            {istGastro && ' Der Backup-Drucker eines Bonierdruckers springt ein, wenn dieser nicht erreichbar ist.'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setModal({ art: 'bon', eintrag: null })}>+ weiteren Drucker einrichten</Button>
      </div>

      {laedt ? (
        <p className="text-xs text-ink-subtle">Wird geladen…</p>
      ) : eintraege.length === 0 ? (
        <p className="text-xs text-ink-subtle">Noch kein Drucker angelegt — „weiteren Drucker einrichten" klicken.</p>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line" data-testid="drucker-liste">
          {eintraege.map(e => {
            const v = verwendung(e)
            const kassenDamit = e.art === 'bon' ? kassenMitRechnungsdrucker(e.id, kassen) : []
            const backupInfo = e.art === 'bonier' ? bonierdruckerBackup(e.id, bonierQuery.data ?? []) : null
            const roh = e.roh
            return (
              <div key={`${e.art}-${e.id}`} data-testid={`drucker-zeile-${e.name}`} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 ${e.aktiv ? '' : 'opacity-60'}`}>
                <div className="min-w-[14rem] flex-1">
                  <p className="text-sm font-medium text-ink">
                    {e.name}
                    {e.art === 'bonier' && (roh as Bonierdrucker).istBackup
                      ? <span className="ml-2"><Chip ton="bernstein" titel="Bekommt zusätzlich eine Kopie jedes Bons — springt nicht bei Ausfall ein">Zweitdrucker</Chip></span>
                      : <span className="ml-2"><Chip ton="grau">{e.art === 'bon' ? 'Bondrucker (Rechnung)' : 'Bonierdrucker'}</Chip></span>}
                    {!e.aktiv && <span className="ml-2 text-xs text-ink-subtle">(deaktiviert)</span>}
                  </p>
                  <p className="text-xs text-ink-muted font-mono">
                    {e.ip}:{e.port}
                    {e.art === 'bon' && <> · {(roh as DruckerPool).breite} Zeichen · {(roh as DruckerPool).timeoutSek}s</>}
                    {testMeldung[e.id] && <span className={`ml-2 ${testMeldung[e.id]?.startsWith('✓') ? 'text-green-700' : 'text-red-700'}`}>{testMeldung[e.id]}</span>}
                  </p>
                </div>

                {/* Wofür ist der Drucker eingesetzt? */}
                <div className="flex min-w-[14rem] flex-[2] flex-wrap items-center gap-1" data-testid="drucker-verwendung">
                  {e.art === 'bon' && (
                    kassenDamit.length > 0
                      ? <Chip titel={kassenDamit.map(kassenName).join(', ')}>Rechnung: {kurz(kassenDamit.map(kassenName))}</Chip>
                      : <Chip ton="grau">keiner Kasse zugeordnet</Chip>
                  )}
                  {v && (
                    <>
                      {v.warengruppen.length > 0 && <Chip titel={v.warengruppen.join(', ')}>Warengruppen: {kurz(v.warengruppen)}</Chip>}
                      {v.artikel > 0 && <Chip>Artikel: {v.artikel}</Chip>}
                      {v.ausnahmen > 0 && <Chip titel="Warengruppen oder Artikel, die an einer bestimmten Kasse auf diesen Drucker gehen">Kassen-Ausnahmen: {v.ausnahmen}</Chip>}
                      {v.stationen.length > 0 && <Chip ton="gruen">KDS-Papier: {v.stationen.map(s => STATION_LABELS[s]).join(', ')}</Chip>}
                      {v.fallback && <Chip ton="gruen" titel="Letzte Rückfallebene: übernimmt, wenn ein Drucker und dessen Backup-Drucker nicht erreichbar sind">Fallback</Chip>}
                      {backupInfo?.backup && (
                        <Chip
                          ton={backupInfo.backup.aktiv ? 'gruen' : 'bernstein'}
                          titel={backupInfo.backup.aktiv ? 'Springt ein, wenn dieser Drucker nicht erreichbar ist' : 'Ist deaktiviert und springt deshalb nicht ein'}
                        >
                          Backup: {backupInfo.backup.name}{backupInfo.backup.aktiv ? '' : ' (deaktiviert)'}
                        </Chip>
                      )}
                      {backupInfo && backupInfo.backupFuer.length > 0 && (
                        <Chip ton="gruen" titel={`Springt ein, wenn ${backupInfo.backupFuer.join(', ')} nicht erreichbar ist`}>
                          Backup für: {kurz(backupInfo.backupFuer)}
                        </Chip>
                      )}
                      {!(roh as Bonierdrucker).istBackup && v.warengruppen.length + v.artikel + v.ausnahmen + v.stationen.length === 0 && !v.fallback
                        && !backupInfo?.backupFuer.length && (
                        <Chip ton="grau">nicht zugeordnet</Chip>
                      )}
                    </>
                  )}
                </div>

                <DruckerStatusLed druckerId={e.id} fetchStatus={e.art === 'bon' ? druckerPoolApi.status : bonierdruckerApi.status} />
                <div className="flex items-center gap-1.5 shrink-0">
                  <button type="button" onClick={() => testen.mutate(e)} disabled={testen.isPending}
                    className="text-xs px-2 py-1 rounded border border-line-strong text-ink hover:border-brand-400 disabled:opacity-50">Testdruck</button>
                  <button type="button" onClick={() => setModal({ art: e.art, eintrag: e })}
                    className="text-xs px-2 py-1 rounded border border-line-strong text-ink hover:border-brand-400">Bearbeiten</button>
                  <button type="button" onClick={() => loeschenFragen(e)}
                    className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50">Löschen</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <DruckerFormular
          art={modal.art}
          eintrag={modal.eintrag}
          istGastro={istGastro}
          bonierListe={bonierQuery.data ?? []}
          onClose={() => setModal(null)}
          onGespeichert={() => { setModal(null); nachAenderung() }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Anlegen / Bearbeiten
// ---------------------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/

/**
 * Anhaltspunkt für die Drucker-IP: die Adresse dieser Kassa im Netzwerk. Der Drucker muss im selben Netz liegen,
 * also meist mit denselben ersten drei Zahlen beginnen (z. B. 192.168.1.x). Die Adresse kommt aus lib/serverHost —
 * im Docker-Betrieb kann das Backend sie nicht selbst ermitteln, dann zählt die Adresse, über die der Browser die Kassa erreicht.
 */
function NetzHinweis({ ip, onPraefix }: { ip: string; onPraefix: (ip: string) => void }) {
  const { host, fertig } = useServerHost()
  if (!fertig) return null
  const teile = host ? IPV4.exec(host) : null
  if (!host || !teile) {
    return (
      <p data-testid="drucker-netz-hinweis" className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-ink-muted">
        Die Netzwerk-Adresse dieser Kassa ist von hier aus nicht zu erkennen{host ? ` (Zugriff über „${host}")` : ' (Zugriff über „localhost")'}.
        Drucker müssen im selben Netz liegen — die Adresse des Kassen-PCs findest du in Windows unter <em>ipconfig</em> (IPv4-Adresse);
        der Drucker beginnt meist mit denselben drei Zahlen. Tipp: die Kassa einmal über diese Adresse öffnen, dann zeigt sie sie hier an.
      </p>
    )
  }
  const praefix = `${teile[1]}.${teile[2]}.${teile[3]}.`
  return (
    <p data-testid="drucker-netz-hinweis" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-ink">
      <span>
        Diese Kassa: <span className="font-mono font-semibold">{host}</span> — der Drucker liegt im selben Netz und beginnt meist mit{' '}
        <span className="font-mono font-semibold">{praefix}</span>
      </span>
      {ip.trim() === '' && (
        <button type="button" onClick={() => onPraefix(praefix)}
          className="rounded border border-line-strong bg-panel px-2 py-0.5 text-ink hover:border-brand-400">
          {praefix} übernehmen
        </button>
      )}
    </p>
  )
}

function DruckerFormular({ art: startArt, eintrag, istGastro, bonierListe, onClose, onGespeichert }: {
  art:           Art
  eintrag:       Eintrag | null
  istGastro:     boolean
  bonierListe:   Bonierdrucker[]
  onClose:       () => void
  onGespeichert: () => void
}) {
  const bearbeiten = eintrag !== null
  const [art, setArt] = useState<Art>(startArt)
  const [fehler, setFehler] = useState<string | null>(null)

  const bon = eintrag?.art === 'bon' ? eintrag.roh : null
  const bonier = eintrag?.art === 'bonier' ? eintrag.roh : null
  const [name, setName]   = useState(eintrag?.name ?? '')
  const [ip, setIp]       = useState(eintrag?.ip ?? '')
  const [port, setPort]   = useState(String(eintrag?.port ?? 9100))
  const [aktiv, setAktiv] = useState(eintrag?.aktiv ?? true)
  const [breite, setBreite]         = useState(bon?.breite ?? LEERER_BON.breite)
  const [timeoutSek, setTimeoutSek] = useState(bon?.timeoutSek ?? LEERER_BON.timeoutSek)
  const [istBackup, setIstBackup]   = useState(bonier?.istBackup ?? false)
  const [backupId, setBackupId]     = useState(bonier?.fallbackId ?? "")

  const speichern = useMutation({
    mutationFn: async () => {
      const basis = { name: name.trim(), ip: ip.trim(), port: parseInt(port, 10) || 9100 }
      if (art === 'bon') {
        const input: DruckerPoolInput = { ...basis, breite, timeoutSek, aktiv }
        return bearbeiten ? druckerPoolApi.update(eintrag!.id, input) : druckerPoolApi.create(input)
      }
      const ersatz = backupId || null
      return bearbeiten
        ? bonierdruckerApi.update(eintrag!.id, { ...basis, istBackup, aktiv, fallbackId: ersatz })
        : bonierdruckerApi.create({ ...basis, istBackup, fallbackId: ersatz })
    },
    onSuccess: onGespeichert,
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <Modal open onClose={onClose} title={bearbeiten ? 'Drucker bearbeiten' : 'Neuen Drucker einrichten'}>
      <div className="space-y-4">
        {!bearbeiten && istGastro && (
          <div role="radiogroup" aria-label="Art des Druckers" className="grid grid-cols-2 gap-2">
            {([
              ['bon',    'Bondrucker', 'Rechnung/Beleg an der Kasse'],
              ['bonier', 'Bonierdrucker', 'Küche/Schank, Bonierzettel'],
            ] as const).map(([wert, titel, text]) => (
              <button
                key={wert}
                type="button"
                role="radio"
                aria-checked={art === wert}
                onClick={() => setArt(wert)}
                className={`rounded-lg border p-3 text-left transition ${art === wert ? 'border-brand-600 bg-brand-50' : 'border-line-strong hover:border-brand-400'}`}
              >
                <span className="block text-sm font-semibold text-ink">{titel}</span>
                <span className="block text-xs text-ink-muted">{text}</span>
              </button>
            ))}
          </div>
        )}

        <Field label="Name" hint={art === 'bon' ? 'z. B. Kasse vorne oder Theke' : 'z. B. „Küchendrucker" oder „Schankdrucker"'}>
          <Input aria-label="Name" value={name} onChange={e => setName(e.target.value)} placeholder={art === 'bon' ? 'Kasse vorne' : 'Küchendrucker'} autoFocus />
        </Field>
        <NetzHinweis ip={ip} onPraefix={setIp} />
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="IP-Adresse" hint="z. B. 192.168.1.100">
              <Input aria-label="IP-Adresse" value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.1.100" />
            </Field>
          </div>
          <Field label="Port">
            <Input aria-label="Port" type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="9100" />
          </Field>
        </div>

        {art === 'bon' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Papierbreite" hint="Zeichen pro Zeile">
              <select className={AUSWAHL} value={breite} onChange={e => setBreite(parseInt(e.target.value, 10))}>
                <option value={32}>58mm (32 Zeichen)</option>
                <option value={42}>80mm Standard (42 Zeichen)</option>
                <option value={48}>80mm Kompakt (48 Zeichen)</option>
              </select>
            </Field>
            <Field label="Timeout" hint="Sekunden (1–30)">
              <Input type="number" min={1} max={30} value={timeoutSek}
                onChange={e => setTimeoutSek(Math.min(30, Math.max(1, parseInt(e.target.value || '5', 10))))} />
            </Field>
          </div>
        ) : (
          <label className="flex items-center gap-3 cursor-pointer rounded-lg border border-amber-200 bg-amber-50 p-3">
            <input type="checkbox" className="h-4 w-4 rounded border-line-strong text-amber-500 focus:ring-amber-400"
              checked={istBackup} onChange={e => setIstBackup(e.target.checked)} />
            <div>
              <p className="text-sm font-medium text-amber-900">Zweitdrucker</p>
              <p className="text-xs text-amber-700">
                Druckt zusätzlich eine Kopie <em>jedes</em> Bonierbons — unabhängig von der Zuordnung. Das ist kein Ersatz bei Ausfall:
                dafür gibt es den Backup-Drucker.
              </p>
            </div>
          </label>
        )}

        {art === "bonier" && !istBackup && (
          <Field label="Backup-Drucker (optional)" hint="Springt ein, wenn dieser Drucker nicht erreichbar ist — für alles, was er druckt">
            <select className={AUSWAHL} value={backupId} onChange={e => setBackupId(e.target.value)}>
              <option value="">Kein Backup-Drucker</option>
              {bonierListe.filter(d => d.id !== eintrag?.id).map(d => (
                <option key={d.id} value={d.id}>{d.name} ({d.ip}){d.istBackup ? " – Zweitdrucker" : ""}{d.aktiv ? "" : " – deaktiviert"}</option>
              ))}
            </select>
          </Field>
        )}

        {bearbeiten && (
          <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
              checked={aktiv} onChange={e => setAktiv(e.target.checked)} />
            Drucker aktiviert
          </label>
        )}

        {fehler && <div className="rounded-md bg-red-50 border border-red-200 text-red-700 p-3 text-sm">{fehler}</div>}

        <div className="flex gap-2 pt-1 border-t border-line">
          <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
          <Button onClick={() => { setFehler(null); speichern.mutate() }} loading={speichern.isPending}
            disabled={!name.trim() || !ip.trim()} className="flex-1">
            {bearbeiten ? 'Speichern' : 'Anlegen'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
