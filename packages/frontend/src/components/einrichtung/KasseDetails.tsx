/**
 * KasseDetails — alles Weitere zu EINER Kasse, aufgeklappt unter ihrer Zeile in der Kassen-Tabelle:
 * Bezeichnung, Zahlungsarten, Gast-Bestellung, KDS-Adressen, Kartenterminal, Einrichtung übernehmen und
 * der Betrieb (DEP-Export, außer Betrieb nehmen). Das Häufige (Drucker, KDS an/aus, Startseite) steht
 * schon in der Zeile.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ALLE_STATIONEN, STATION_LABELS, type EinrichtungKasse, type Station } from '@kassa/shared'
import { downloadDepExport, einrichtungApi, kasseApi } from '../../lib/api'
import { removeKasse } from '../../lib/auth'
import { kassenName } from '../../lib/einrichtung'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { useEinrichtung } from './EinrichtungKontext'
import { ZvtKarte } from './ZvtKarte'

type Meldung = { typ: 'ok' | 'fehler'; text: string }

const ZAHLUNGSARTEN: { wert: 'bar' | 'karte' | 'sonstige'; label: string }[] = [
  { wert: 'bar',      label: 'Bar' },
  { wert: 'karte',    label: 'Karte' },
  { wert: 'sonstige', label: 'Sonstige' },
]

const AUSWAHL = 'mt-1 block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40'

export function KasseDetails({ kasse, istDiesesGeraet, onMeldung }: {
  kasse:           EinrichtungKasse
  istDiesesGeraet: boolean
  onMeldung:       (m: Meldung | null) => void
}) {
  const { aktiveKassen, speichern, neuLaden } = useEinrichtung()
  const queryClient = useQueryClient()
  const name = kassenName(kasse)
  const stillgelegt = kasse.status === 'ausser_betrieb'

  // ---- Bezeichnung ----
  const [bezeichnung, setBezeichnung] = useState(kasse.bezeichnung ?? '')
  useEffect(() => { setBezeichnung(kasse.bezeichnung ?? '') }, [kasse.bezeichnung])
  const bezeichnungSpeichern = () => {
    const neu = bezeichnung.trim()
    if (neu && neu !== (kasse.bezeichnung ?? '')) void speichern(kasse.id, { bezeichnung: neu })
    else setBezeichnung(kasse.bezeichnung ?? '')
  }

  // ---- Zahlungsarten (mindestens eine bleibt erlaubt) ----
  const zahlungsartUmschalten = (wert: 'bar' | 'karte' | 'sonstige') => {
    const an = kasse.erlaubteZahlungsarten.includes(wert)
    const neu = an ? kasse.erlaubteZahlungsarten.filter(z => z !== wert) : [...kasse.erlaubteZahlungsarten, wert]
    if (neu.length === 0) { onMeldung({ typ: 'fehler', text: `${name}: Mindestens eine Zahlungsart muss erlaubt bleiben.` }); return }
    onMeldung(null)
    void speichern(kasse.id, { erlaubteZahlungsarten: neu })
  }

  // ---- Gast-Bestellung ----
  const [gastUrl, setGastUrl] = useState(kasse.gastBasisUrl ?? '')
  useEffect(() => { setGastUrl(kasse.gastBasisUrl ?? '') }, [kasse.gastBasisUrl])
  const gastUrlSpeichern = () => {
    // fehlendes Schema automatisch ergänzen („192.168.1.10:8082" → „http://…")
    let v = gastUrl.trim()
    if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`
    setGastUrl(v)
    if (v !== (kasse.gastBasisUrl ?? '')) void speichern(kasse.id, { gastBasisUrl: v || null })
  }

  // ---- KDS-Adressen (nur TCP-Hardware-Displays) ----
  const [kdsPort, setKdsPort] = useState(String(kasse.kdsPort))
  const [ips, setIps]         = useState<Partial<Record<Station, string>>>(kasse.kdsStationen)
  useEffect(() => { setKdsPort(String(kasse.kdsPort)); setIps(kasse.kdsStationen) }, [kasse.kdsPort, kasse.kdsStationen])
  const kdsAdressenSpeichern = async () => {
    // Leere Strings entfernen
    const bereinigt: Partial<Record<Station, string>> = {}
    for (const s of ALLE_STATIONEN) { const ip = ips[s]?.trim(); if (ip) bereinigt[s] = ip }
    await speichern(kasse.id, { kdsPort: parseInt(kdsPort || '9100', 10) || 9100, kdsStationen: bereinigt })
  }

  // ---- Einrichtung von einer anderen Kasse übernehmen ----
  const quellen = aktiveKassen.filter(k => k.id !== kasse.id)
  const [quelleId, setQuelleId] = useState('')
  const kopieren = useMutation({
    mutationFn: (von: string) => einrichtungApi.kopieren(kasse.id, von),
    onSuccess: async (_r, von) => {
      await neuLaden()
      void queryClient.invalidateQueries({ queryKey: ['pos-config', kasse.id] })
      void queryClient.invalidateQueries({ queryKey: ['drucker', kasse.id] })
      void queryClient.invalidateQueries({ queryKey: ['kds', kasse.id] })
      const vonName = kassenName(aktiveKassen.find(k => k.id === von) ?? kasse)
      onMeldung({ typ: 'ok', text: `Einrichtung von „${vonName}" auf „${name}" übernommen.` })
      setQuelleId('')
    },
    onError: (err) => onMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })
  const uebernehmen = () => {
    const von = quellen.find(k => k.id === quelleId)
    if (!von) return
    if (!window.confirm(
      `Die Einrichtung von „${kassenName(von)}" auf „${name}" übernehmen?\n\n` +
      'Sichtbare Warengruppen, Drucker, KDS, Zahlungsarten, Startseite und alle Zuordnungen von Warengruppen/Artikeln ' +
      `auf Drucker und Stationen von „${name}" werden ersetzt. Das Kartenterminal und die Favoriten bleiben unverändert.`,
    )) return
    onMeldung(null)
    kopieren.mutate(von.id)
  }

  // ---- Betrieb: DEP-Export, außer Betrieb nehmen ----
  const [depLaeuft, setDepLaeuft] = useState<string | null>(null)
  async function depExport(format: 'dep7' | 'dep131') {
    onMeldung(null)
    setDepLaeuft(format)
    try {
      const { anzahl } = await downloadDepExport({ kasseId: kasse.id, format })
      onMeldung({ typ: 'ok', text: `${format.toUpperCase()} von „${name}" exportiert (${anzahl} Belege).` })
    } catch (err) {
      onMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : 'Export fehlgeschlagen' })
    } finally {
      setDepLaeuft(null)
    }
  }

  const [stilllegen, setStilllegen] = useState(false)
  const [abTid, setAbTid]     = useState('')
  const [abBenId, setAbBenId] = useState('')
  const [abPin, setAbPin]     = useState('')
  const ausserBetrieb = useMutation({
    mutationFn: () => {
      const fonComplete = abTid.trim() && abBenId.trim() && abPin.trim()
      return kasseApi.ausserBetrieb(
        kasse.id,
        fonComplete ? { teilnehmerId: abTid.trim(), benutzerkennung: abBenId.trim(), pin: abPin.trim() } : undefined,
      )
    },
    onSuccess: async (res) => {
      removeKasse(kasse.id)  // aus dem lokalen Umschalter entfernen
      await neuLaden()
      const fonText = res.fonMeldung
        ? res.fonMeldung.erfolgreich
          ? ' FinanzOnline-Abmeldung übermittelt.'
          : ` FinanzOnline-Abmeldung fehlgeschlagen: ${res.fonMeldung.fehler ?? 'unbekannt'} — bitte manuell nachholen.`
        : ''
      onMeldung({ typ: 'ok', text: `Kasse außer Betrieb genommen — Schlussbeleg #${res.schlussbeleg.belegNummer} signiert.${fonText}` })
      setStilllegen(false); setAbTid(''); setAbBenId(''); setAbPin('')
    },
    onError: (err) => onMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <div data-testid="kasse-details" className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-6 p-4">
      {/* Bezeichnung + Zahlungsarten */}
      <div className="space-y-4">
        <Field label="Bezeichnung" hint={`Interne ID: ${kasse.kassenId} — erscheint in PDFs, Berichten und der Navigation`}>
          <Input
            aria-label="Bezeichnung der Kasse"
            value={bezeichnung}
            maxLength={100}
            placeholder={kasse.kassenId}
            disabled={stillgelegt}
            onChange={e => setBezeichnung(e.target.value)}
            onBlur={bezeichnungSpeichern}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </Field>

        {!stillgelegt && (
          <div>
            <span className="text-sm font-medium text-ink">Zahlungsarten</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {ZAHLUNGSARTEN.map(z => {
                const an = kasse.erlaubteZahlungsarten.includes(z.wert)
                return (
                  <button
                    key={z.wert}
                    type="button"
                    aria-pressed={an}
                    onClick={() => zahlungsartUmschalten(z.wert)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      an ? 'bg-brand-600 border-brand-600 text-white' : 'bg-panel border-line-strong text-ink hover:border-brand-400'
                    }`}
                  >
                    <span>{an ? '✓' : '+'}</span>{z.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Gast-Bestellung per Tisch-QR */}
      {!stillgelegt && (
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-ink">Gast-Bestellung per Tisch-QR</span>
            <select
              className={AUSWAHL}
              value={kasse.gastModus}
              onChange={e => void speichern(kasse.id, { gastModus: e.target.value as EinrichtungKasse['gastModus'] })}
            >
              <option value="aus">Aus</option>
              <option value="tab">Ohne Zahlung (offener Tisch)</option>
              <option value="online">Mit Online-Zahlung (Stripe)</option>
            </select>
            <span className="mt-1 block text-[11px] text-ink-subtle">
              {kasse.gastModus === 'tab'
                ? 'Die Bestellung erscheint als offener Tisch mit Kellner „Gast"; bezahlt wird beim Personal.'
                : kasse.gastModus === 'online'
                  ? 'Gast zahlt sofort online; Beleg und Bonierung laufen automatisch. Voraussetzung: Stripe-Keys (Einstellungen → Gastro).'
                  : 'Die Tisch-QR-Codes dieser Kasse nehmen keine Bestellungen an.'}
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-ink">Gast-Bestell-Basis-URL (für Tisch-QR)</span>
            <Input
              type="text"
              inputMode="url"
              className="mt-1"
              placeholder="z. B. 192.168.1.10:8082 oder https://bestellen.example.at"
              value={gastUrl}
              onChange={e => setGastUrl(e.target.value)}
              onBlur={gastUrlSpeichern}
            />
            <span className="mt-1 block text-[11px] text-ink-subtle">
              Basis-URL der Gast-Bestellseite. Nur wenn gesetzt, kann beim Tischnummerndruck der QR-Code mitgedruckt werden.
            </span>
          </label>
        </div>
      )}

      {/* KDS-Adressen (nur TCP-Hardware-Displays) */}
      {!stillgelegt && (
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-ink">KDS-Adressen (nur TCP-Hardware-Displays)</h4>
            <p className="text-xs text-ink-muted mt-0.5">
              Für die <strong>Browser-Displays</strong> genügt „KDS" in der Zeile — <strong>hier ist dafür KEINE IP einzutragen</strong>.
              Nur ausfüllen, wenn an einer Station ein eigenes TCP-Empfangsgerät hängt (z. B. Alt-KDS mit ESC/POS-Empfänger); die Bons werden
              dann zusätzlich dorthin gesendet. Für Browser-Displays leer lassen, sonst meldet jede Bonierung eine fehlgeschlagene Zustellung.
            </p>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 items-center">
            {ALLE_STATIONEN.map(s => (
              <div key={s} className="contents">
                <label htmlFor={`kds-ip-${kasse.id}-${s}`} className="text-sm font-medium text-ink">{STATION_LABELS[s]}</label>
                <Input
                  id={`kds-ip-${kasse.id}-${s}`}
                  placeholder="192.168.192.210"
                  value={ips[s] ?? ''}
                  onChange={e => setIps({ ...ips, [s]: e.target.value })}
                />
              </div>
            ))}
            <label htmlFor={`kds-port-${kasse.id}`} className="text-sm font-medium text-ink">Port</label>
            <Input
              id={`kds-port-${kasse.id}`}
              type="number"
              className="w-28"
              value={kdsPort}
              onChange={e => setKdsPort(e.target.value)}
            />
          </div>
          <Button variant="secondary" onClick={() => void kdsAdressenSpeichern()}>KDS-Adressen speichern</Button>
        </div>
      )}

      {/* Kartenterminal */}
      {!stillgelegt && <ZvtKarte kasseId={kasse.id} />}

      {/* Einrichtung übernehmen */}
      {!stillgelegt && quellen.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">Einrichtung übernehmen</h4>
          <p className="text-xs text-ink-muted">
            Übernimmt von einer anderen Kasse die sichtbaren Warengruppen, Drucker, KDS, Zahlungsarten, Startseite und alle
            Zuordnungen von Warengruppen/Artikeln auf Drucker und Stationen.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Einrichtung für ${name} übernehmen von`}
              className="block rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm"
              value={quelleId}
              onChange={e => setQuelleId(e.target.value)}
            >
              <option value="">Kasse wählen …</option>
              {quellen.map(k => <option key={k.id} value={k.id}>{kassenName(k)}</option>)}
            </select>
            <Button variant="secondary" disabled={!quelleId} loading={kopieren.isPending} onClick={uebernehmen}>Übernehmen</Button>
          </div>
        </div>
      )}

      {/* Betrieb */}
      <div className="space-y-3 lg:col-span-2 border-t border-line pt-4">
        <h4 className="text-sm font-semibold text-ink">Betrieb</h4>
        <div className="flex flex-wrap items-center gap-2">
          {/* DEP-Export pro Kasse — auch (gerade!) für stillgelegte Kassen */}
          {(['dep7', 'dep131'] as const).map(format => (
            <button
              key={format}
              type="button"
              disabled={depLaeuft !== null}
              onClick={() => void depExport(format)}
              title={`${format.toUpperCase()}-Export dieser Kasse herunterladen (voller Bestand; datumsgefiltert unter „DEP-Export")`}
              className="text-xs px-2.5 py-1.5 rounded-md border border-line-strong text-ink-muted hover:bg-panel hover:text-ink transition disabled:opacity-50"
            >
              {depLaeuft === format ? '…' : format.toUpperCase()}
            </button>
          ))}
          {!stillgelegt && !istDiesesGeraet && (
            <button
              type="button"
              onClick={() => { onMeldung(null); setStilllegen(v => !v) }}
              className="text-xs text-red-600 hover:text-red-700 hover:underline"
            >
              Außer Betrieb nehmen
            </button>
          )}
          {!stillgelegt && istDiesesGeraet && (
            <span className="text-xs text-ink-subtle">Die Kasse dieses Geräts lässt sich nicht stilllegen — zuerst auf eine andere wechseln.</span>
          )}
        </div>

        {/* Inline-Bestätigung der Außerbetriebnahme */}
        {stilllegen && !stillgelegt && (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
            <p className="text-sm font-semibold text-red-800">
              Kasse „{name}" endgültig außer Betrieb nehmen?
            </p>
            <ul className="text-xs text-red-700 list-disc pl-4 space-y-0.5">
              <li>Es wird ein signierter <strong>Schlussbeleg</strong> erstellt — der letzte Beleg dieser Kasse.</li>
              <li>Danach sind <strong>keine Belege mehr möglich</strong>. Keine Reaktivierung (RKSV) — bei Bedarf neue Kasse anlegen.</li>
              <li>Belege und DEP-Export bleiben erhalten (Aufbewahrungspflicht).</li>
            </ul>

            {kasse.beiFoRegistriert && (
              <details className="rounded-md border border-red-200 bg-panel p-3">
                <summary className="cursor-pointer text-xs font-medium text-ink">
                  FinanzOnline-Abmeldung (optional, empfohlen)
                </summary>
                <p className="mt-2 text-xs text-ink-muted">
                  Meldet die Außerbetriebnahme direkt an FinanzOnline. Ohne Zugangsdaten ist
                  die Abmeldung manuell über FinanzOnline nachzuholen. Daten werden nicht gespeichert.
                </p>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Field label="Teilnehmer-ID"><Input value={abTid} onChange={e => setAbTid(e.target.value)} autoComplete="off" /></Field>
                  <Field label="Benutzerkennung"><Input value={abBenId} onChange={e => setAbBenId(e.target.value)} autoComplete="off" /></Field>
                  <Field label="PIN"><Input type="password" value={abPin} onChange={e => setAbPin(e.target.value)} autoComplete="off" /></Field>
                </div>
              </details>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={ausserBetrieb.isPending} onClick={() => { onMeldung(null); ausserBetrieb.mutate() }}>
                Endgültig außer Betrieb nehmen
              </Button>
              <Button variant="secondary" onClick={() => setStilllegen(false)} disabled={ausserBetrieb.isPending}>
                Abbrechen
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
