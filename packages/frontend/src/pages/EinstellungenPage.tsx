import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { ALLE_STATIONEN, STATION_LABELS, type Station, type ZvtConfig, type WeitereKasseInput, type PosKonfig } from '@kassa/shared'
import { druckerApi, kdsApi, zvtApi, downloadDepExport, healthApi, monitoringApi, mandantApi, kasseApi, kategorieApi, posConfigApi, tischplanApi, dbBackupApi, belegApi, type DruckerConfig, type KdsConfig, type DbSicherungRow, type MonitoringStatus } from '../lib/api'
import { formatAusfallDauer } from '../components/SeeStatusBanner'
import { getKasseIdentity, setKasseIdentity } from '../lib/kasse'
import { getAuth, hasModul, updateKasseBezeichnung, addKasse } from '../lib/auth'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { TischplanEditor } from '../components/TischplanEditor'

export function EinstellungenPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink">Einstellungen</h1>
        <p className="mt-1 text-sm text-ink-muted">Drucker, Hardware-Anbindung, Belegtext und Tischplan</p>
      </header>
      <KassenVerwaltungSektion />
      <WarengruppenVerteilungSektion />
      <KasseBezeichnungSektion />
      <RechnungslayoutSektion />
      <DruckerSektion />
      <KdsSektion />
      <ZvtSektion />
      <RksvExportSektion />
      <SeeAusfallSektion />
      {hasModul('gastro') && <TischplanSektion />}
      <GastQrCodeSektion />
      <DbBackupSektion />
      <SystemInfoSektion />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kassen-Verwaltung (Umschalter + weitere Kasse anlegen)
// ---------------------------------------------------------------------------

function KassenVerwaltungSektion() {
  const auth        = getAuth()!
  const identity    = getKasseIdentity()
  const queryClient = useQueryClient()

  const [formOffen, setFormOffen] = useState(false)
  const [kassenId, setKassenId]       = useState('')
  const [bezeichnung, setBezeichnung] = useState('')
  const [umgebung, setUmgebung]       = useState<'test' | 'produktion'>('test')
  const [tid, setTid]     = useState('')
  const [benId, setBenId] = useState('')
  const [pin, setPin]     = useState('')
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  // Reichere Kassenliste vom Server (Zertifikatsablauf, FON-Status); Fallback: auth.kassen
  const listeQuery = useQuery({
    queryKey: ['kassen-liste'],
    queryFn:  kasseApi.liste,
  })
  const kassen = listeQuery.data ?? auth.kassen.map(k => ({
    id: k.id, kassenId: k.kassenId, bezeichnung: k.bezeichnung,
    status: 'aktiv', umgebung: k.umgebung, seeGueltigBis: '', beiFoRegistriert: false,
  }))

  function wechsleZu(kasseId: string) {
    if (kasseId === identity?.kasseId) return
    setKasseIdentity({ mandantId: auth.mandant.id, kasseId })
    // Detail-Sektionen lesen die Kassen-ID nicht-reaktiv beim Render → Neuladen.
    window.location.reload()
  }

  const anlegen = useMutation({
    mutationFn: () => {
      const fonComplete = tid.trim() && benId.trim() && pin.trim()
      const input: WeitereKasseInput = {
        kassenId: kassenId.trim(),
        umgebung,
        ...(bezeichnung.trim() && { bezeichnung: bezeichnung.trim() }),
        ...(fonComplete && { finanzOnline: { teilnehmerId: tid.trim(), benutzerkennung: benId.trim(), pin: pin.trim() } }),
      }
      return kasseApi.anlegen(input)
    },
    onSuccess: (res) => {
      if (!res.erfolgreich || !res.kasseId) {
        setMeldung({ typ: 'fehler', text: res.fehler ?? 'Kasse konnte nicht angelegt werden' })
        return
      }
      addKasse({ id: res.kasseId, kassenId: kassenId.trim(), bezeichnung: bezeichnung.trim() || null, umgebung })
      queryClient.invalidateQueries({ queryKey: ['kassen-liste'] })
      setMeldung({ typ: 'ok', text: `Kasse „${kassenId.trim()}" angelegt (Startbeleg #${res.startbelegNummer}).` })
      setKassenId(''); setBezeichnung(''); setTid(''); setBenId(''); setPin(''); setFormOffen(false)
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Kassen</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Zwischen Kassen wechseln oder weitere anlegen. Alle Einstellungen unterhalb
          (Bondrucker, KDS, Kartenterminal, Warengruppen) beziehen sich auf die <strong>aktive</strong> Kasse.
        </p>
      </div>

      {/* Kassenliste + Umschalter */}
      <div className="space-y-2">
        {kassen.map(k => {
          const aktiv = k.id === identity?.kasseId
          return (
            <div
              key={k.id}
              className={`flex items-center justify-between gap-3 rounded-md border p-3 ${
                aktiv ? 'border-brand-500 bg-brand-50' : 'border-line bg-panel-2'
              }`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink truncate">
                  {k.bezeichnung || k.kassenId}
                  {aktiv && <span className="ml-2 text-xs font-semibold text-brand-700">● aktiv</span>}
                </p>
                <p className="text-xs text-ink-muted">
                  ID: {k.kassenId} · {k.umgebung === 'produktion' ? 'Produktion' : 'Test'}
                  {k.beiFoRegistriert ? ' · FinanzOnline registriert' : ' · provisorisch'}
                </p>
              </div>
              {aktiv ? (
                <span className="text-xs text-ink-subtle shrink-0">aktuelle Kasse</span>
              ) : (
                <Button variant="secondary" onClick={() => wechsleZu(k.id)}>Wechseln</Button>
              )}
            </div>
          )
        })}
      </div>

      {meldung && (
        <div className={`rounded-md p-3 text-sm ${
          meldung.typ === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>{meldung.text}</div>
      )}

      {/* Weitere Kasse anlegen */}
      <div className="pt-2 border-t border-line">
        {!formOffen ? (
          <Button variant="secondary" onClick={() => { setMeldung(null); setFormOffen(true) }}>
            + Weitere Kasse anlegen
          </Button>
        ) : (
          <div className="space-y-4">
            <p className="text-sm font-medium text-ink">Neue Registrierkasse</p>
            <p className="text-xs text-ink-muted -mt-2">
              Es wird eine eigene Signatureinheit (SEE-Zertifikat) samt Startbeleg erstellt.
              Firmenname und UID werden vom Mandanten übernommen.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Kassen-ID" hint="Eindeutig, z. B. KASSE-002">
                <Input value={kassenId} onChange={e => { setKassenId(e.target.value); setMeldung(null) }} maxLength={40} placeholder="KASSE-002" />
              </Field>
              <Field label="Bezeichnung (optional)" hint="Anzeigename, z. B. Bar Terrasse">
                <Input value={bezeichnung} onChange={e => setBezeichnung(e.target.value)} maxLength={100} placeholder="Bar Terrasse" />
              </Field>
            </div>
            <Field label="Umgebung">
              <select
                className="block w-full rounded-md border border-line-strong px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                value={umgebung}
                onChange={e => setUmgebung(e.target.value as 'test' | 'produktion')}
              >
                <option value="test">Test (FinanzOnline-Testumgebung)</option>
                <option value="produktion">Produktion (Echtbetrieb)</option>
              </select>
            </Field>

            <details className="rounded-md border border-line bg-panel-2 p-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">FinanzOnline-Registrierung (optional)</summary>
              <p className="mt-2 text-xs text-ink-muted">
                Fehlen die Daten, wird die Kasse provisorisch (ohne FON-Registrierung) angelegt —
                die Registrierung kann später nachgetragen werden. Zugangsdaten werden nicht gespeichert.
              </p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Field label="Teilnehmer-ID"><Input value={tid} onChange={e => setTid(e.target.value)} autoComplete="off" /></Field>
                <Field label="Benutzerkennung"><Input value={benId} onChange={e => setBenId(e.target.value)} autoComplete="off" /></Field>
                <Field label="PIN"><Input type="password" value={pin} onChange={e => setPin(e.target.value)} autoComplete="off" /></Field>
              </div>
            </details>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => { setMeldung(null); anlegen.mutate() }}
                loading={anlegen.isPending}
                disabled={!kassenId.trim()}
              >
                Kasse anlegen
              </Button>
              <Button variant="secondary" onClick={() => { setFormOffen(false); setMeldung(null) }} disabled={anlegen.isPending}>
                Abbrechen
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Warengruppen-Verteilung (Matrix: Warengruppe × Kasse)
// ---------------------------------------------------------------------------

function WarengruppenVerteilungSektion() {
  const qc = useQueryClient()
  const kassenQuery     = useQuery({ queryKey: ['kassen-liste'], queryFn: kasseApi.liste })
  const kategorienQuery = useQuery({ queryKey: ['kategorien'],   queryFn: () => kategorieApi.list(false) })

  const kassen     = kassenQuery.data ?? []
  const kategorien = kategorienQuery.data ?? []

  // POS-Konfig je Kasse (enthält sichtbareKategorieIds)
  const configQueries = useQueries({
    queries: kassen.map(k => ({
      queryKey: ['pos-config', k.id],
      queryFn:  () => posConfigApi.get(k.id),
    })),
  })
  const configByKasse = new Map<string, string[]>()
  kassen.forEach((k, i) => {
    const d = configQueries[i]?.data
    if (d) configByKasse.set(k.id, d.sichtbareKategorieIds)
  })

  const speichern = useMutation({
    mutationFn: ({ kasseId, ids }: { kasseId: string; ids: string[] }) =>
      posConfigApi.update(kasseId, { sichtbareKategorieIds: ids }),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ['pos-config', v.kasseId] }),
  })

  function setzeAuswahl(kasseId: string, ids: string[]) {
    qc.setQueryData<PosKonfig>(['pos-config', kasseId], (old) =>
      old ? { ...old, sichtbareKategorieIds: ids } : old)
    speichern.mutate({ kasseId, ids })
  }

  function toggle(kasseId: string, catId: string) {
    const set = new Set(configByKasse.get(kasseId) ?? [])
    if (set.has(catId)) set.delete(catId); else set.add(catId)
    setzeAuswahl(kasseId, [...set])
  }

  const laden = kassenQuery.isLoading || kategorienQuery.isLoading

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">Warengruppen-Verteilung</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Lege fest, welche Warengruppen an welcher Kasse erscheinen — z. B. eine Kasse „Getränke",
          eine Kasse „Speisen". Ist bei einer Kasse <strong>keine</strong> Gruppe angehakt, werden dort
          (wie bisher) <strong>alle</strong> Warengruppen angezeigt.
        </p>
      </div>

      {laden ? (
        <p className="text-sm text-ink-muted">Wird geladen…</p>
      ) : kategorien.length === 0 ? (
        <p className="text-sm text-ink-subtle">Noch keine Warengruppen angelegt.</p>
      ) : kassen.length === 0 ? (
        <p className="text-sm text-ink-subtle">Keine Kassen vorhanden.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium sticky left-0 bg-panel-2 z-10">Warengruppe</th>
                {kassen.map(k => {
                  const leer = (configByKasse.get(k.id)?.length ?? 0) === 0
                  return (
                    <th key={k.id} className="px-3 py-2 text-center font-medium min-w-[7rem]">
                      <div className="truncate">{k.bezeichnung || k.kassenId}</div>
                      <div className={`text-[10px] font-normal mt-0.5 ${leer ? 'text-brand-700' : 'text-ink-subtle'}`}>
                        {leer ? 'alle sichtbar' : `${configByKasse.get(k.id)?.length} gewählt`}
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {kategorien.map(kat => (
                <tr key={kat.id} className="hover:bg-panel-2/60">
                  <td className="px-3 py-2 text-ink font-medium sticky left-0 bg-panel z-10">{kat.name}</td>
                  {kassen.map(k => {
                    const aktiv = (configByKasse.get(k.id) ?? []).includes(kat.id)
                    return (
                      <td key={k.id} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={aktiv}
                          onChange={() => toggle(k.id, kat.id)}
                          className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line">
                <td className="px-3 py-2 text-xs text-ink-subtle sticky left-0 bg-panel z-10">Zurücksetzen</td>
                {kassen.map(k => {
                  const leer = (configByKasse.get(k.id)?.length ?? 0) === 0
                  return (
                    <td key={k.id} className="px-3 py-2 text-center">
                      <button
                        type="button"
                        disabled={leer}
                        onClick={() => setzeAuswahl(k.id, [])}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-line-strong text-ink-muted hover:bg-panel-2 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Auswahl leeren → alle Warengruppen sichtbar"
                      >alle sichtbar</button>
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Kassenbezeichnung
// ---------------------------------------------------------------------------

function KasseBezeichnungSektion() {
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const queryClient = useQueryClient()
  const kasseInfo   = auth.kassen.find(k => k.id === identity.kasseId)
  const [wert, setWert]       = useState(kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? '')
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const speichern = useMutation({
    mutationFn: () => kasseApi.updateBezeichnung(identity.kasseId, { bezeichnung: wert.trim() }),
    onSuccess: (data) => {
      updateKasseBezeichnung(identity.kasseId, data.bezeichnung ?? '')
      queryClient.invalidateQueries({ queryKey: ['kasse-status', identity.kasseId] })
      setMeldung({ typ: 'ok', text: 'Kassenbezeichnung gespeichert' })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">Kassenbezeichnung</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Anzeigename dieser Kasse (erscheint in PDFs, Berichten und der Navigation).
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Bezeichnung" hint={`Interne ID: ${kasseInfo?.kassenId ?? identity.kasseId}`}>
          <Input
            value={wert}
            onChange={e => { setWert(e.target.value); setMeldung(null) }}
            placeholder={kasseInfo?.kassenId ?? ''}
            maxLength={100}
          />
        </Field>
      </div>

      {meldung && (
        <div className={`rounded-md p-3 text-sm ${
          meldung.typ === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>{meldung.text}</div>
      )}

      <div className="pt-2 border-t border-line">
        <Button
          onClick={() => { setMeldung(null); speichern.mutate() }}
          loading={speichern.isPending}
          disabled={!wert.trim() || wert.trim() === (kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? '')}
        >
          Speichern
        </Button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Mandanten-Stammdaten (Firmeninfo + Belegfußtext)
// ---------------------------------------------------------------------------

/** Kleine Belegvorschau — zeigt wie der Bon aussehen wird */
function BelegVorschau({
  firmenname, uid, kopftext, fusstext, steuertabelle, qr,
}: {
  firmenname: string; uid: string
  kopftext: string; fusstext: string
  steuertabelle: boolean; qr: boolean
}) {
  const line = '─'.repeat(28)
  return (
    <div className="font-mono text-[10px] leading-[1.5] bg-panel border border-line rounded-lg p-4 shadow-inner select-none overflow-hidden">
      {/* Kopf */}
      <p className="text-center font-bold text-[11px]">{firmenname || 'Firmenname'}</p>
      {kopftext && kopftext.split('\n').map((l, i) => (
        <p key={i} className="text-center text-ink-muted">{l}</p>
      ))}
      <p className="text-center text-ink-muted">UID: {uid || 'ATU12345678'}</p>
      <p className="text-ink-subtle my-1">{line}</p>

      {/* Beispiel-Positionen */}
      <div className="space-y-0.5">
        <div className="flex justify-between"><span>2× Espresso</span><span>€ 5,60</span></div>
        <div className="flex justify-between"><span>1× Melange</span><span>€ 3,80</span></div>
        <div className="flex justify-between"><span>1× Apfelstrudel</span><span>€ 4,50</span></div>
      </div>

      <p className="text-ink-subtle my-1">{line}</p>
      <div className="flex justify-between font-bold text-[11px]">
        <span>GESAMT</span><span>€ 13,90</span>
      </div>
      <div className="flex justify-between text-ink-muted mt-0.5">
        <span>Bar</span><span>€ 20,00</span>
      </div>
      <div className="flex justify-between text-ink-muted">
        <span>Rückgeld</span><span>€ 6,10</span>
      </div>

      {/* Steuertabelle */}
      {steuertabelle && (
        <>
          <p className="text-ink-subtle my-1">{line}</p>
          <p className="text-ink-muted">Steuern</p>
          <div className="grid grid-cols-4 gap-x-2 text-ink-muted mt-0.5">
            <span>Satz</span><span className="text-right">Netto</span><span className="text-right">Steuer</span><span className="text-right">Brutto</span>
            <span>A 20%</span><span className="text-right">11,58</span><span className="text-right">2,32</span><span className="text-right">13,90</span>
          </div>
        </>
      )}

      {/* Fußzeile */}
      <p className="text-ink-subtle my-1">{line}</p>
      {fusstext ? fusstext.split('\n').map((l, i) => (
        <p key={i} className="text-center text-ink-muted">{l}</p>
      )) : <p className="text-center text-ink-subtle italic">Fußtext hier</p>}

      {/* QR-Platzhalter */}
      {qr && (
        <div className="flex flex-col items-center mt-2 gap-1">
          <div className="w-12 h-12 bg-panel-2 border border-line rounded flex items-center justify-center text-ink-subtle text-lg">
            ▦
          </div>
          <p className="text-ink-subtle text-[9px]">Digitaler Beleg</p>
        </div>
      )}

      {/* RKSV-Footer (immer sichtbar) */}
      <p className="text-ink-subtle mt-1">{line}</p>
      <p className="text-ink-subtle text-[9px] text-center">_R1_ AT1 2024-06-11T… €13,90 MdGjKs… =</p>
    </div>
  )
}

function RechnungslayoutSektion() {
  const queryClient = useQueryClient()
  const [kopftext,  setKopftext]  = useState('')
  const [fusstext,  setFusstext]  = useState('')
  const [steuertab, setSteuertab] = useState(true)
  const [zeigQr,    setZeigQr]    = useState(false)
  const [meldung,   setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const stammdatenQuery = useQuery({
    queryKey: ['mandant-stammdaten'],
    queryFn:  mandantApi.getStammdaten,
  })

  useEffect(() => {
    const d = stammdatenQuery.data
    if (d) {
      setKopftext(d.belegKopftext ?? '')
      setFusstext(d.belegFusstext ?? '')
      setSteuertab(d.belegZeigeSteuertabelle)
      setZeigQr(d.belegZeigeQr)
    }
  }, [stammdatenQuery.data])

  const speichern = useMutation({
    mutationFn: () => mandantApi.patchStammdaten({
      belegKopftext:           kopftext.trim()  || null,
      belegFusstext:           fusstext.trim()  || null,
      belegZeigeSteuertabelle: steuertab,
      belegZeigeQr:            zeigQr,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mandant-stammdaten'] })
      setMeldung({ typ: 'ok', text: 'Rechnungslayout gespeichert' })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const d = stammdatenQuery.data

  const hatAenderung = d != null && (
    kopftext.trim()  !== (d.belegKopftext  ?? '') ||
    fusstext.trim()  !== (d.belegFusstext  ?? '') ||
    steuertab        !== d.belegZeigeSteuertabelle ||
    zeigQr           !== d.belegZeigeQr
  )

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Rechnungslayout</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Kopf- und Fußtext, Steuertabelle, QR-Code — mit Live-Vorschau.
        </p>
      </div>

      {stammdatenQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Wird geladen…</p>
      ) : d ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Linke Spalte: Editierfelder */}
          <div className="space-y-4">

            {/* Firmenname / UID (nur Anzeige) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-medium text-ink-muted mb-1">Firmenname</p>
                <p className="text-sm font-medium text-ink bg-panel-2 rounded-md px-3 py-2 border border-line truncate">
                  {d.firmenname}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink-muted mb-1">UID-Nummer</p>
                <p className="text-sm font-mono text-ink bg-panel-2 rounded-md px-3 py-2 border border-line">
                  {d.uid}
                </p>
              </div>
            </div>

            <Field
              label="Kopftext"
              hint="Erscheint unter dem Firmennamen — z. B. Adresse, Slogan"
            >
              <textarea
                value={kopftext}
                onChange={e => { setKopftext(e.target.value); setMeldung(null) }}
                rows={2}
                maxLength={300}
                placeholder={'Musterstraße 1, 1010 Wien\nTel: +43 1 234567'}
                className="block w-full rounded-md border border-line-strong px-3 py-2 text-sm
                           placeholder-gray-400 shadow-sm resize-y
                           focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
              <p className="text-xs text-ink-subtle mt-1 text-right">{kopftext.length}/300</p>
            </Field>

            <Field
              label="Fußtext"
              hint="Dankestext, Website, Öffnungszeiten o. ä. — am Ende des Bons"
            >
              <textarea
                value={fusstext}
                onChange={e => { setFusstext(e.target.value); setMeldung(null) }}
                rows={3}
                maxLength={500}
                placeholder={'Vielen Dank für Ihren Besuch!\nwww.beispiel.at'}
                className="block w-full rounded-md border border-line-strong px-3 py-2 text-sm
                           placeholder-gray-400 shadow-sm resize-y
                           focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
              <p className="text-xs text-ink-subtle mt-1 text-right">{fusstext.length}/500</p>
            </Field>

            {/* Schalter */}
            <div className="space-y-3 pt-1">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-ink">Steuertabelle anzeigen</p>
                  <p className="text-xs text-ink-muted">Aufschlüsselung nach Steuersatz am Bonende</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={steuertab}
                  onClick={() => { setSteuertab(v => !v); setMeldung(null) }}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    steuertab ? 'bg-brand-600' : 'bg-panel-2'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-panel shadow transition-transform ${
                    steuertab ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </label>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-ink">QR-Code drucken</p>
                  <p className="text-xs text-ink-muted">Link zum digitalen Beleg als QR am Bonende</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={zeigQr}
                  onClick={() => { setZeigQr(v => !v); setMeldung(null) }}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    zeigQr ? 'bg-brand-600' : 'bg-panel-2'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-panel shadow transition-transform ${
                    zeigQr ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </label>
            </div>

            {meldung && (
              <div className={`rounded-md p-3 text-sm ${
                meldung.typ === 'ok'
                  ? 'bg-green-50 border border-green-200 text-green-700'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}>{meldung.text}</div>
            )}

            <div className="pt-2 border-t border-line">
              <Button
                onClick={() => { setMeldung(null); speichern.mutate() }}
                loading={speichern.isPending}
                disabled={!hatAenderung}
              >
                Layout speichern
              </Button>
            </div>
          </div>

          {/* Rechte Spalte: Live-Vorschau */}
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Vorschau</p>
            <BelegVorschau
              firmenname={d.firmenname}
              uid={d.uid}
              kopftext={kopftext}
              fusstext={fusstext}
              steuertabelle={steuertab}
              qr={zeigQr}
            />
          </div>

        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// RKSV-Export-Sektion (DEP7 + DEP131)
// ---------------------------------------------------------------------------

function RksvExportSektion() {
  const identity = getKasseIdentity()!
  const [vonDatum, setVonDatum] = useState('')
  const [bisDatum, setBisDatum] = useState('')
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const exportieren = async (format: 'dep7' | 'dep131') => {
    setMeldung(null)
    try {
      const { anzahl } = await downloadDepExport({
        kasseId:  identity.kasseId,
        format,
        ...(vonDatum && { vonDatum }),
        ...(bisDatum && { bisDatum }),
      })
      setMeldung({ typ: 'ok', text: `${anzahl} Belege exportiert` })
    } catch (err) {
      setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : 'Export fehlgeschlagen' })
    }
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-base font-semibold text-ink mb-1">RKSV-Datenexport</h2>
      <p className="text-sm text-ink-muted mb-4">
        DEP7 enthält die maschinenlesbaren Codes (Signaturkette). DEP131 enthält alle
        Belege mit Positionen und Beträgen. Ohne Datumsangabe wird der gesamte Bestand exportiert.
      </p>

      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Von (Datum)</label>
          <input
            type="date"
            value={vonDatum}
            onChange={e => setVonDatum(e.target.value)}
            className="rounded-md border border-line-strong px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Bis (Datum)</label>
          <input
            type="date"
            value={bisDatum}
            onChange={e => setBisDatum(e.target.value)}
            min={vonDatum || undefined}
            className="rounded-md border border-line-strong px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => exportieren('dep7')} variant="secondary">
          DEP7 exportieren
        </Button>
        <Button onClick={() => exportieren('dep131')} variant="secondary">
          DEP131 exportieren
        </Button>
      </div>

      {meldung && (
        <p className={`mt-3 text-sm ${meldung.typ === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
          {meldung.text}
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// SEE-Ausfall (Signatureinrichtung)
// ---------------------------------------------------------------------------

function SeeAusfallSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [tid, setTid]       = useState('')
  const [benId, setBenId]   = useState('')
  const [pin, setPin]       = useState('')

  const statusQuery = useQuery({
    queryKey: ['see-status', identity.kasseId],
    queryFn:  () => belegApi.seeStatus(identity.kasseId),
    refetchInterval: 30_000,
  })
  const status = statusQuery.data

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['see-status', identity.kasseId] })

  // FON-Zugangsdaten nur mitschicken, wenn alle drei Felder ausgefüllt sind.
  const fonCreds = () =>
    tid.trim() && benId.trim() && pin.trim()
      ? { teilnehmerId: tid.trim(), benutzerkennung: benId.trim(), pin: pin.trim() }
      : undefined

  const fonText = (fon?: { versucht: boolean; erfolgreich: boolean; fehler?: string }) =>
    !fon?.versucht ? ''
      : fon.erfolgreich ? ' FinanzOnline-Meldung übermittelt.'
      : ` FinanzOnline-Meldung fehlgeschlagen: ${fon.fehler ?? 'unbekannt'}.`

  const melden = useMutation({
    mutationFn: () => belegApi.seeAusfallMelden(identity.kasseId, fonCreds()),
    onSuccess: (res) => { invalidate(); setMeldung({ typ: 'ok', text: `SEE-Ausfall gemeldet — neue Belege tragen den Ausfallmarker.${fonText(res.fonMeldung)}` }) },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const wiederherstellen = useMutation({
    mutationFn: () => belegApi.seeWiederherstellen(identity.kasseId, fonCreds()),
    onSuccess: (res) => {
      invalidate()
      setPin('')
      setMeldung({ typ: 'ok', text: `Wieder in Betrieb. Sammelbeleg #${res.sammelbeleg.belegNummer} signiert.${fonText(res.fonMeldung)}` })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const ausgefallen = status?.ausgefallen ?? false
  const dauer = status?.dauerMinuten != null ? formatAusfallDauer(status.dauerMinuten) : null

  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-base font-semibold text-ink mb-1">Signatureinrichtung (SEE)</h2>
      <p className="text-sm text-ink-muted mb-4">
        Fällt die Signatureinrichtung aus, werden Belege weiter erstellt, aber mit dem RKSV-Marker
        „Sicherheitseinrichtung ausgefallen" statt einer Signatur. Bei Wiederinbetriebnahme wird ein
        signierter Sammelbeleg erstellt.
      </p>

      <div className={`rounded-md border p-3 text-sm mb-4 ${
        ausgefallen ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-700'
      }`}>
        {ausgefallen ? (
          <>
            <strong>Ausgefallen</strong>{dauer && <> seit {dauer}</>}. Belege werden nicht signiert.
            {status?.fonMeldungNoetig && <> Ausfall &gt; 48 h — <strong>FinanzOnline-Meldung erforderlich</strong>.</>}
          </>
        ) : (
          <><strong>In Betrieb</strong> — Belege werden signiert.</>
        )}
      </div>

      {/* Optionale FinanzOnline-Meldung — nur gesendet, wenn alle drei Felder gefüllt sind */}
      <details className="mb-4 rounded-md border border-line bg-panel-2 p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          FinanzOnline-Meldung (optional)
        </summary>
        <p className="mt-2 text-xs text-ink-muted">
          Nur nötig, um den Ausfall bzw. die Wiederinbetriebnahme direkt an FinanzOnline zu übermitteln
          (Ausfall &gt; 48 h ist meldepflichtig). Die Zugangsdaten werden nicht gespeichert.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Field label="Teilnehmer-ID">
            <Input value={tid} onChange={e => setTid(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Benutzerkennung">
            <Input value={benId} onChange={e => setBenId(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="PIN">
            <Input type="password" value={pin} onChange={e => setPin(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
        {!ausgefallen ? (
          <Button
            variant="secondary"
            loading={melden.isPending}
            onClick={() => {
              setMeldung(null)
              if (confirm('SEE-Ausfall melden? Neue Belege werden bis zur Wiederinbetriebnahme NICHT signiert.')) {
                melden.mutate()
              }
            }}
          >
            SEE-Ausfall melden
          </Button>
        ) : (
          <Button
            loading={wiederherstellen.isPending}
            onClick={() => {
              setMeldung(null)
              if (confirm('Signatureinrichtung wieder in Betrieb nehmen? Es wird ein signierter Sammelbeleg erstellt.')) {
                wiederherstellen.mutate()
              }
            }}
          >
            Wieder in Betrieb nehmen
          </Button>
        )}
      </div>

      {meldung && (
        <p className={`mt-3 text-sm ${meldung.typ === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
          {meldung.text}
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Tischplan-Sektion
// ---------------------------------------------------------------------------

function TischplanSektion() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <h2 className="text-base font-semibold text-ink mb-1">Tischplan</h2>
      <p className="text-sm text-ink-muted mb-4">
        Bereiche anlegen und Tische per Drag &amp; Drop positionieren.
        Der fertige Plan erscheint auf der Tische-Seite als grafische Ansicht.
      </p>
      <TischplanEditor />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Gast-QR-Code-Generator
// ---------------------------------------------------------------------------

function GastQrCodeSektion() {
  const auth       = getAuth()!
  const kassen     = auth.kassen

  // Standard-Basis-URL: selber Host, Port 8082 (Produktion) oder 5177 (Dev)
  const defaultBase = window.location.hostname === 'localhost'
    ? `${window.location.protocol}//${window.location.hostname}:5177`
    : `${window.location.protocol}//${window.location.hostname}:8082`

  const [basisUrl, setBasisUrl]       = useState(defaultBase)
  const [kasseId, setKasseId]         = useState(kassen[0]?.id ?? '')
  const [tisch, setTisch]             = useState('')
  const [manuellerTisch, setManuell]  = useState('')
  const svgRef                        = useRef<HTMLDivElement>(null)

  // Tischplan laden wenn Kasse gewählt
  const { data: bereiche } = useQuery({
    queryKey: ['tischplan-bereiche-qr', kasseId],
    queryFn:  () => tischplanApi.listeBereiche(kasseId),
    enabled:  !!kasseId,
  })

  const alleTische = bereiche?.flatMap(b =>
    b.elemente.map(e => ({ bezeichnung: e.bezeichnung, bereich: b.name }))
  ) ?? []

  const aktiverTisch = tisch || manuellerTisch
  const gastUrl = aktiverTisch && kasseId
    ? `${basisUrl}/gast?kasseId=${encodeURIComponent(kasseId)}&tisch=${encodeURIComponent(aktiverTisch)}`
    : ''

  function svgHerunterladen() {
    if (!svgRef.current) return
    const svg = svgRef.current.querySelector('svg')
    if (!svg) return
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `qr-${aktiverTisch.replace(/\s+/g, '-').toLowerCase()}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  function allesDrucken() {
    window.print()
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-5 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Gast-Bestellsystem QR-Codes</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          QR-Codes für Tische generieren — Gäste scannen und bestellen direkt.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Konfiguration */}
        <div className="space-y-4">
          {/* Basis-URL */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">
              Gast-App URL
            </label>
            <input
              type="url"
              value={basisUrl}
              onChange={e => setBasisUrl(e.target.value)}
              placeholder="http://192.168.1.100:8082"
              className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none font-mono"
            />
            <p className="text-xs text-ink-subtle mt-1">
              Produktiv: IP des Servers + Port 8082 · Dev: Port 5177
            </p>
          </div>

          {/* Kasse */}
          {kassen.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">
                Kasse
              </label>
              <select
                value={kasseId}
                onChange={e => { setKasseId(e.target.value); setTisch('') }}
                className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
              >
                {kassen.map(k => (
                  <option key={k.id} value={k.id}>{k.bezeichnung ?? k.kassenId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Tisch aus Tischplan */}
          {alleTische.length > 0 ? (
            <div>
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">
                Tisch
              </label>
              <select
                value={tisch}
                onChange={e => { setTisch(e.target.value); setManuell('') }}
                className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
              >
                <option value="">— Tisch wählen —</option>
                {bereiche?.map(b => (
                  <optgroup key={b.id} label={b.name}>
                    {b.elemente.map(e => (
                      <option key={e.id} value={e.bezeichnung}>{e.bezeichnung}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-xs text-ink-subtle mt-1">oder manuell eingeben:</p>
              <input
                type="text"
                value={manuellerTisch}
                onChange={e => { setManuell(e.target.value); setTisch('') }}
                placeholder="z. B. Tisch 7"
                className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">
                Tischbezeichnung
              </label>
              <input
                type="text"
                value={manuellerTisch}
                onChange={e => setManuell(e.target.value)}
                placeholder="z. B. Tisch 7, Bar, Terrasse"
                className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
              />
            </div>
          )}
        </div>

        {/* QR-Code Vorschau */}
        <div className="flex flex-col items-center justify-center gap-4 bg-panel-2 rounded-xl border border-line p-6">
          {aktiverTisch && gastUrl ? (
            <>
              <div ref={svgRef} className="bg-panel p-4 rounded-xl shadow-sm border border-line">
                <QRCodeSVG
                  value={gastUrl}
                  size={180}
                  level="M"
                  includeMargin={false}
                />
              </div>
              <p className="text-sm font-bold text-ink text-center">{aktiverTisch}</p>
              <p className="text-xs text-ink-subtle text-center break-all font-mono leading-relaxed max-w-full">
                {gastUrl}
              </p>
              <div className="flex gap-2 w-full">
                <button
                  onClick={() => navigator.clipboard.writeText(gastUrl)}
                  className="flex-1 py-2 rounded-lg border border-line-strong text-ink text-xs font-medium hover:bg-panel-2 transition"
                >
                  📋 URL kopieren
                </button>
                <button
                  onClick={svgHerunterladen}
                  className="flex-1 py-2 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 transition"
                >
                  ⬇ SVG laden
                </button>
              </div>
            </>
          ) : (
            <div className="text-center text-ink-subtle space-y-2">
              <div className="text-5xl opacity-30">▦</div>
              <p className="text-sm">Tisch wählen um QR-Code zu generieren</p>
            </div>
          )}
        </div>
      </div>

      {/* Alle Tische auf einmal drucken */}
      {alleTische.length > 0 && basisUrl && kasseId && (
        <div className="border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-ink">Alle Tische drucken</p>
              <p className="text-xs text-ink-muted mt-0.5">{alleTische.length} Tische — öffnet Druckansicht mit allen QR-Codes</p>
            </div>
            <button
              onClick={() => {
                const html = `<!doctype html><html><head><meta charset="utf-8"><title>Tisch QR-Codes</title>
                <style>
                  body{font-family:sans-serif;margin:0}
                  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px}
                  .karte{border:1px solid #e5e7eb;border-radius:12px;padding:16px;text-align:center;break-inside:avoid}
                  .name{font-size:14px;font-weight:700;margin-top:8px;color:#111}
                  .url{font-size:9px;color:#9ca3af;word-break:break-all;margin-top:4px}
                  @media print{@page{margin:12mm}}
                </style></head><body>
                <div class="grid">
                ${alleTische.map(t => {
                  const url = `${basisUrl}/gast?kasseId=${encodeURIComponent(kasseId)}&tisch=${encodeURIComponent(t.bezeichnung)}`
                  // Simple QR-Link via Google Charts API als Fallback (oder canvas in Prod)
                  return `<div class="karte">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}" width="150" height="150" />
                    <div class="name">${t.bezeichnung}</div>
                    <div class="url">${t.bereich}</div>
                  </div>`
                }).join('')}
                </div></body></html>`
                const win = window.open('', '_blank')
                win?.document.write(html)
                win?.document.close()
                win?.print()
              }}
              className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-700 transition"
            >
              🖨 Alle drucken
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Drucker
// ---------------------------------------------------------------------------

function DruckerSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<DruckerConfig>({
    druckerIp: '', druckerPort: 9100, druckerAktiv: false, druckerBreite: 42, druckerTimeoutSek: 5,
  })
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [logOffen, setLogOffen] = useState(false)

  const cfgQuery = useQuery({
    queryKey: ['drucker', identity.kasseId],
    queryFn:  () => druckerApi.get(identity.kasseId),
  })

  const statusQuery = useQuery({
    queryKey:        ['drucker-status', identity.kasseId],
    queryFn:         () => druckerApi.status(identity.kasseId),
    refetchInterval: 30_000,
    enabled:         !!cfgQuery.data?.druckerAktiv && !!cfgQuery.data?.druckerIp,
  })

  const logQuery = useQuery({
    queryKey: ['drucker-log', identity.kasseId],
    queryFn:  () => druckerApi.log(identity.kasseId),
    enabled:  logOffen,
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        druckerIp:         cfgQuery.data.druckerIp ?? '',
        druckerPort:       cfgQuery.data.druckerPort,
        druckerAktiv:      cfgQuery.data.druckerAktiv,
        druckerBreite:     cfgQuery.data.druckerBreite,
        druckerTimeoutSek: cfgQuery.data.druckerTimeoutSek ?? 5,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => druckerApi.patch(identity.kasseId, {
      druckerIp:         form.druckerIp?.trim() || null,
      druckerPort:       form.druckerPort,
      druckerAktiv:      form.druckerAktiv,
      druckerBreite:     form.druckerBreite,
      druckerTimeoutSek: form.druckerTimeoutSek,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'Drucker-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['drucker', identity.kasseId] })
      queryClient.invalidateQueries({ queryKey: ['drucker-status', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const testdruck = useMutation({
    mutationFn: () => druckerApi.test(identity.kasseId),
    onSuccess:  () => {
      setMeldung({ typ: 'ok', text: 'Testdruck gesendet — bitte am Drucker prüfen' })
      queryClient.invalidateQueries({ queryKey: ['drucker-log', identity.kasseId] })
      queryClient.invalidateQueries({ queryKey: ['drucker-status', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  // Status-Dot
  const status = statusQuery.data
  const statusDot = !cfgQuery.data?.druckerAktiv || !cfgQuery.data?.druckerIp ? null
    : statusQuery.isLoading ? '⬜'
    : status?.online === true  ? '🟢'
    : status?.online === false ? '🔴'
    : '⬜'

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Bondrucker (ESC/POS via TCP)</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Netzwerkdrucker (Epson TM-T20, Star TSP100, Bixolon SRP, …)
          </p>
        </div>
        {statusDot && (
          <div className="flex items-center gap-1.5 text-xs text-ink-muted shrink-0">
            <span>{statusDot}</span>
            <span>{status?.online === true ? 'Online' : status?.online === false ? 'Offline' : 'Unbekannt'}</span>
          </div>
        )}
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
              checked={form.druckerAktiv}
              onChange={(e) => setForm({ ...form, druckerAktiv: e.target.checked })}
            />
            Drucker aktiviert
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <Field label="IP-Adresse" hint="z. B. 192.168.1.100">
                <Input
                  value={form.druckerIp ?? ''}
                  onChange={(e) => setForm({ ...form, druckerIp: e.target.value })}
                  placeholder="192.168.1.100"
                />
              </Field>
            </div>
            <Field label="Port">
              <Input
                type="number"
                value={form.druckerPort}
                onChange={(e) => setForm({ ...form, druckerPort: parseInt(e.target.value || '9100', 10) })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Papierbreite" hint="Zeichen pro Zeile">
              <select
                className="block w-full rounded-md border border-line-strong px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                value={form.druckerBreite}
                onChange={(e) => setForm({ ...form, druckerBreite: parseInt(e.target.value, 10) })}
              >
                <option value={32}>58mm (32 Zeichen)</option>
                <option value={42}>80mm Standard (42 Zeichen)</option>
                <option value={48}>80mm Kompakt (48 Zeichen)</option>
              </select>
            </Field>
            <Field label="Timeout" hint="Sekunden bis Verbindungsabbruch (1–30)">
              <Input
                type="number"
                min={1}
                max={30}
                value={form.druckerTimeoutSek}
                onChange={(e) => setForm({ ...form, druckerTimeoutSek: Math.min(30, Math.max(1, parseInt(e.target.value || '5', 10))) })}
              />
            </Field>
          </div>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>Speichern</Button>
            <Button
              variant="secondary"
              onClick={() => { setMeldung(null); testdruck.mutate() }}
              loading={testdruck.isPending}
              disabled={!form.druckerAktiv || !form.druckerIp}
            >
              Testdruck
            </Button>
            <button
              type="button"
              onClick={() => setLogOffen(v => !v)}
              className="ml-auto text-xs text-ink-subtle hover:text-brand-700 underline underline-offset-2"
            >
              {logOffen ? 'Verlauf ausblenden' : 'Druckverlauf anzeigen'}
            </button>
          </div>

          {/* Druckhistorie */}
          {logOffen && (
            <div className="border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-ink mb-2">Druckverlauf (letzte 50)</h3>
              {logQuery.isLoading ? (
                <p className="text-xs text-ink-subtle">Wird geladen…</p>
              ) : !logQuery.data?.length ? (
                <p className="text-xs text-ink-subtle">Noch keine Druckversuche protokolliert.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-panel-2 text-ink-muted uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2 text-left">Zeit</th>
                        <th className="px-3 py-2 text-left">Typ</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-left">Fehler</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {logQuery.data.map(e => (
                        <tr key={e.id} className={`${e.erfolg ? '' : 'bg-red-50'}`}>
                          <td className="px-3 py-1.5 font-mono text-ink-muted whitespace-nowrap">
                            {new Date(e.erstelltAt).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'medium' })}
                          </td>
                          <td className="px-3 py-1.5 capitalize text-ink">{e.druckerTyp}</td>
                          <td className="px-3 py-1.5">
                            {e.erfolg
                              ? <span className="text-green-700 font-medium">✓ OK</span>
                              : <span className="text-red-700 font-medium">✗ Fehler</span>
                            }
                          </td>
                          <td className="px-3 py-1.5 text-ink-muted max-w-xs truncate">{e.fehlerText ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// KDS (Küchen-Display-System)
// ---------------------------------------------------------------------------

function KdsSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<KdsConfig>({
    kdsAktiv: false, kdsPort: 9100, kdsStationen: {},
  })
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const cfgQuery = useQuery({
    queryKey: ['kds', identity.kasseId],
    queryFn:  () => kdsApi.get(identity.kasseId),
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        kdsAktiv:     cfgQuery.data.kdsAktiv,
        kdsPort:      cfgQuery.data.kdsPort,
        kdsStationen: cfgQuery.data.kdsStationen,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => {
      // Leere Strings entfernen
      const bereinigt: Partial<Record<Station, string>> = {}
      for (const s of ALLE_STATIONEN) {
        const ip = form.kdsStationen[s]?.trim()
        if (ip) bereinigt[s] = ip
      }
      return kdsApi.patch(identity.kasseId, {
        kdsAktiv:     form.kdsAktiv,
        kdsPort:      form.kdsPort,
        kdsStationen: bereinigt,
      })
    },
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'KDS-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['kds', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const setStationIp = (s: Station, ip: string): void => {
    setForm({ ...form, kdsStationen: { ...form.kdsStationen, [s]: ip } })
  }

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Küchen-Display-System (KDS)</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Bonierbons werden an die jeweilige Stations-IP gesendet. Das KDS leitet sie
          an die zugehörigen Küchen-Displays weiter (TCP-Port wie bei den Druckern).
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
              checked={form.kdsAktiv}
              onChange={(e) => setForm({ ...form, kdsAktiv: e.target.checked })}
            />
            KDS aktiviert
          </label>

          <Field label="Port" hint="Standard: 9100 (gleicher Port wie Bondrucker)">
            <Input
              type="number"
              value={form.kdsPort}
              onChange={(e) => setForm({ ...form, kdsPort: parseInt(e.target.value || '9100', 10) })}
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">Stations-IPs</p>
            <p className="text-xs text-ink-muted">
              Pro Station eine IP. Leer lassen, wenn die Station nicht verwendet wird.
            </p>
            {ALLE_STATIONEN.map((s) => (
              <div key={s} className="grid grid-cols-[140px_1fr] gap-3 items-center">
                <label className="text-sm font-medium text-ink">{STATION_LABELS[s]}</label>
                <Input
                  placeholder="192.168.192.210"
                  value={form.kdsStationen[s] ?? ''}
                  onChange={(e) => setStationIp(s, e.target.value)}
                />
              </div>
            ))}
          </div>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>
              Speichern
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ZVT (Kartenterminal)
// ---------------------------------------------------------------------------

function ZvtSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ZvtConfig>({
    zvtIp: '', zvtPort: 20007, zvtPasswort: '', zvtAktiv: false,
  })
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [testOffen, setTestOffen] = useState(false)

  const cfgQuery = useQuery({
    queryKey: ['zvt', identity.kasseId],
    queryFn:  () => zvtApi.getConfig(identity.kasseId),
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        zvtIp:       cfgQuery.data.zvtIp       ?? '',
        zvtPort:     cfgQuery.data.zvtPort,
        zvtPasswort: cfgQuery.data.zvtPasswort ?? '',
        zvtAktiv:    cfgQuery.data.zvtAktiv,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => zvtApi.patchConfig(identity.kasseId, {
      zvtIp:       form.zvtIp?.trim() || null,
      zvtPort:     form.zvtPort,
      zvtPasswort: form.zvtPasswort?.trim() || null,
      zvtAktiv:    form.zvtAktiv,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'ZVT-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['zvt', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-ink">Kartenterminal (ZVT)</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Hobex, Payroc und andere ZVT-kompatible Terminals via TCP.
          Für Tests ohne echtes Terminal: IP <code className="text-xs bg-panel-2 px-1 rounded">stub</code>.
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-ink-muted">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
              checked={form.zvtAktiv}
              onChange={(e) => setForm({ ...form, zvtAktiv: e.target.checked })}
            />
            Kartenzahlung aktiviert
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <Field label="Terminal-IP" hint="z. B. 192.168.1.50 oder 'stub' für Tests">
                <Input
                  value={form.zvtIp ?? ''}
                  onChange={(e) => setForm({ ...form, zvtIp: e.target.value })}
                  placeholder="192.168.1.50"
                />
              </Field>
            </div>
            <Field label="Port" hint="Hobex/Payroc: 20007">
              <Input
                type="number"
                value={form.zvtPort}
                onChange={(e) => setForm({ ...form, zvtPort: parseInt(e.target.value || '20007', 10) })}
              />
            </Field>
          </div>

          <Field label="Terminal-Passwort" hint="Optional (6-stellig, falls vom Gerät verlangt)">
            <Input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={form.zvtPasswort ?? ''}
              onChange={(e) => setForm({ ...form, zvtPasswort: e.target.value.replace(/\D/g, '') })}
              placeholder=""
            />
          </Field>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>
              Speichern
            </Button>
            <Button
              variant="secondary"
              onClick={() => setTestOffen(true)}
              disabled={!form.zvtAktiv || !form.zvtIp}
            >
              Test 1 Cent
            </Button>
          </div>
        </>
      )}

      {/* Test-Zahlung: nur Verbindungs- und Protokoll-Check, KEIN Beleg */}
      <KartenzahlungModal
        open={testOffen}
        kasseId={identity.kasseId}
        betragCent={1}
        onErfolg={() => {
          setTestOffen(false)
          setMeldung({ typ: 'ok', text: 'Test-Transaktion erfolgreich' })
        }}
        onAbbruch={() => setTestOffen(false)}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Systeminfo-Sektion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB-Backup
// ---------------------------------------------------------------------------

function DbBackupSektion() {
  const auth = getAuth()!
  if (auth.user.rolle !== 'admin') return null

  const qc = useQueryClient()
  const [fehler, setFehler] = useState<string | null>(null)
  const [erfolg, setErfolg] = useState(false)

  const listeQuery = useQuery({
    queryKey: ['db-sicherungen'],
    queryFn:  dbBackupApi.liste,
    staleTime: 30_000,
  })

  const erstellenMutation = useMutation({
    mutationFn: dbBackupApi.erstellen,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['db-sicherungen'] })
      setErfolg(true)
      setTimeout(() => setErfolg(false), 4000)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : 'Backup fehlgeschlagen'),
  })

  function formatGroesse(bytes: number): string {
    if (bytes < 1024)       return `${bytes} B`
    if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  }

  function formatZeit(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' })
  }

  const liste: DbSicherungRow[] = listeQuery.data ?? []
  const letzter = liste[0]

  return (
    <section className="rounded-xl border border-line bg-panel p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-ink">Datenbank-Backups</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Täglicher PostgreSQL-Dump um 3:00 Uhr · letzten 30 Backups werden aufbewahrt
          </p>
        </div>
        <Button
          onClick={() => { setFehler(null); erstellenMutation.mutate() }}
          disabled={erstellenMutation.isPending}
          variant="secondary"
        >
          {erstellenMutation.isPending ? 'Erstelle Backup…' : '+ Backup jetzt erstellen'}
        </Button>
      </div>

      {fehler && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{fehler}</p>
      )}
      {erfolg && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
          ✓ Backup erfolgreich erstellt
        </p>
      )}

      {/* Letztes Backup-Info */}
      {letzter && (
        <div className={`rounded-lg border px-4 py-3 flex items-center gap-3 ${letzter.erfolgreich ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <span className={`text-xl ${letzter.erfolgreich ? 'text-green-600' : 'text-red-500'}`}>
            {letzter.erfolgreich ? '✓' : '✗'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-ink">
              Letztes Backup: {formatZeit(letzter.erstelltAm)}
            </p>
            <p className="text-xs text-ink-muted">
              {letzter.dateiname} · {formatGroesse(letzter.dateigroesse)} · {letzter.automatisch ? 'automatisch' : 'manuell'}
            </p>
            {letzter.fehler && <p className="text-xs text-red-600 mt-0.5">{letzter.fehler}</p>}
          </div>
          <Button
            variant="secondary"
            onClick={() => void dbBackupApi.download(letzter.id, letzter.dateiname)}
          >
            ↓ Download
          </Button>
        </div>
      )}

      {/* Verlauf */}
      {liste.length > 1 && (
        <details className="group">
          <summary className="text-sm text-brand-600 cursor-pointer hover:text-brand-700 list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform inline-block">›</span>
            Verlauf ({liste.length} Backups)
          </summary>
          <div className="mt-3 rounded-lg border border-line overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-panel-2 text-left text-ink-muted border-b border-line">
                <tr>
                  <th className="px-3 py-2 font-medium">Datum</th>
                  <th className="px-3 py-2 font-medium">Größe</th>
                  <th className="px-3 py-2 font-medium">Typ</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {liste.map(s => (
                  <tr key={s.id} className="hover:bg-panel-2">
                    <td className="px-3 py-2 font-mono text-ink">{formatZeit(s.erstelltAm)}</td>
                    <td className="px-3 py-2 text-ink-muted">{formatGroesse(s.dateigroesse)}</td>
                    <td className="px-3 py-2 text-ink-muted">{s.automatisch ? 'auto' : 'manuell'}</td>
                    <td className="px-3 py-2">
                      {s.erfolgreich
                        ? <span className="text-green-600 font-medium">OK</span>
                        : <span className="text-red-500 font-medium" title={s.fehler ?? ''}>Fehler</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-right">
                      {s.erfolgreich && (
                        <button
                          type="button"
                          onClick={() => void dbBackupApi.download(s.id, s.dateiname)}
                          className="text-brand-600 hover:text-brand-700 hover:underline"
                        >
                          Download
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {listeQuery.isLoading && (
        <p className="text-sm text-ink-subtle">Wird geladen…</p>
      )}
      {!listeQuery.isLoading && liste.length === 0 && (
        <p className="text-sm text-ink-subtle">Noch keine Backups vorhanden. Täglich um 3:00 Uhr wird automatisch eines erstellt.</p>
      )}
    </section>
  )
}

function SystemInfoSektion() {
  const auth = getAuth()!
  const isAdmin = auth.user.rolle === 'admin'

  const health = useQuery({
    queryKey: ['health'],
    queryFn:  healthApi.get,
    refetchInterval: 60_000,
    retry: false,
  })

  const monitoring = useQuery({
    queryKey: ['monitoring'],
    queryFn:  monitoringApi.get,
    refetchInterval: 10_000,
    retry: false,
    enabled: isAdmin,
  })

  const dbOk     = health.data?.checks.db === 'ok'
  const statusOk = health.data?.status === 'ok'

  function formatUptime(sek: number) {
    if (sek < 60)   return `${sek}s`
    if (sek < 3600) return `${Math.floor(sek / 60)}min`
    const h = Math.floor(sek / 3600)
    const m = Math.floor((sek % 3600) / 60)
    return `${h}h ${m}min`
  }

  const m: MonitoringStatus | undefined = monitoring.data

  return (
    <section className="rounded-xl border border-line bg-panel p-6 space-y-5">
      {/* Kopfzeile */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Systeminfo</h2>
        <div className="flex items-center gap-3">
          {health.data && (
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
              statusOk ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusOk ? 'bg-green-500' : 'bg-amber-500'}`} />
              {statusOk ? 'System ok' : 'eingeschränkt'}
            </span>
          )}
          <button
            type="button"
            onClick={() => { void health.refetch(); void monitoring.refetch() }}
            disabled={health.isFetching || monitoring.isFetching}
            className="text-xs text-brand-600 hover:text-brand-700 disabled:text-ink-subtle"
          >
            {(health.isFetching || monitoring.isFetching) ? 'Prüfe…' : '↻ Aktualisieren'}
          </button>
        </div>
      </div>

      {/* Basis-Infos */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 text-sm">
        <div>
          <dt className="text-ink-muted">Frontend</dt>
          <dd className="mt-0.5 font-mono font-medium text-ink">v{__APP_VERSION__}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Backend</dt>
          <dd className="mt-0.5 font-mono font-medium text-ink">
            {health.isLoading ? <span className="text-ink-subtle">…</span>
              : health.data   ? `v${health.data.version}`
              : <span className="text-red-500">nicht erreichbar</span>}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Datenbank</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            {health.isLoading ? <span className="text-ink-subtle text-sm">…</span> : (
              <>
                <span className={`h-2 w-2 rounded-full ${dbOk ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className={`font-medium ${dbOk ? 'text-green-700' : 'text-red-600'}`}>
                  {dbOk ? 'verbunden' : 'getrennt'}
                </span>
                {m?.db.latenzMs != null && (
                  <span className="text-ink-subtle">{m.db.latenzMs} ms</span>
                )}
              </>
            )}
          </dd>
        </div>
        {health.data && (
          <div>
            <dt className="text-ink-muted">Laufzeit</dt>
            <dd className="mt-0.5 font-medium text-ink">{formatUptime(health.data.uptimeSek)}</dd>
          </div>
        )}
        {m && (
          <div>
            <dt className="text-ink-muted">Node.js</dt>
            <dd className="mt-0.5 font-mono text-ink">{m.nodeVersion}</dd>
          </div>
        )}
        {m && (
          <div>
            <dt className="text-ink-muted">Plattform</dt>
            <dd className="mt-0.5 font-mono text-ink">{m.platform}</dd>
          </div>
        )}
      </dl>

      {/* Speicher-Widget (nur Admin, nur wenn Daten vorhanden) */}
      {isAdmin && m && (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Prozess-Speicher</p>

          {/* Heap-Balken */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-ink-muted">
              <span>Heap-Nutzung</span>
              <span className="font-mono">
                {m.memory.heapUsedMb} / {m.memory.heapTotalMb} MB
                <span className="text-ink-subtle ml-1">
                  ({Math.round(m.memory.heapUsedMb / m.memory.heapTotalMb * 100)} %)
                </span>
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-panel-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  m.memory.heapUsedMb / m.memory.heapTotalMb > 0.85
                    ? 'bg-red-500'
                    : m.memory.heapUsedMb / m.memory.heapTotalMb > 0.65
                    ? 'bg-amber-400'
                    : 'bg-brand-500'
                }`}
                style={{ width: `${Math.min(100, m.memory.heapUsedMb / m.memory.heapTotalMb * 100)}%` }}
              />
            </div>
          </div>

          {/* System-Speicher */}
          {m.system.totalMemMb > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-ink-muted">
                <span>System-RAM</span>
                <span className="font-mono">
                  {Math.round(m.system.totalMemMb - m.system.freeMemMb)} / {Math.round(m.system.totalMemMb)} MB
                  <span className="text-ink-subtle ml-1">
                    ({Math.round((m.system.totalMemMb - m.system.freeMemMb) / m.system.totalMemMb * 100)} %)
                  </span>
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-panel-2 overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-400 transition-all"
                  style={{ width: `${Math.min(100, (m.system.totalMemMb - m.system.freeMemMb) / m.system.totalMemMb * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* RSS + Load */}
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="bg-panel-2 rounded-lg px-3 py-2">
              <p className="text-ink-muted">RSS</p>
              <p className="font-mono font-semibold text-ink mt-0.5">{m.memory.rssMb} MB</p>
            </div>
            <div className="bg-panel-2 rounded-lg px-3 py-2">
              <p className="text-ink-muted">CPU (user)</p>
              <p className="font-mono font-semibold text-ink mt-0.5">{m.cpu.userMs} ms</p>
            </div>
            <div className="bg-panel-2 rounded-lg px-3 py-2">
              <p className="text-ink-muted">Load Ø1min</p>
              <p className="font-mono font-semibold text-ink mt-0.5">{m.system.loadAvg1}</p>
            </div>
          </div>

          <p className="text-xs text-ink-subtle">
            Aktualisiert: {new Date(m.timestamp).toLocaleTimeString('de-AT')} · Auto-Refresh alle 10 s
          </p>
        </div>
      )}

      {/* Für Nicht-Admins: nur Letzter-Check-Zeit */}
      {!isAdmin && health.data && (
        <p className="text-xs text-ink-subtle">
          Letzter Check: {new Date(health.data.timestamp).toLocaleTimeString('de-AT')}
        </p>
      )}
    </section>
  )
}
