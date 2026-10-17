/**
 * BepreisteVariantenAnsicht — Artikel, deren Preis an der Option hängt.
 *
 * Aus dem Altsystem kommen Artikel wie „Bier" mit Basispreis 0,00 und den Varianten „0,33l" (+4,00) und
 * „0,5l" (+5,00). Solange die Kasse nach Optionen fragt, passt das. Ist die Abfrage abgeschaltet (Artikel →
 * Warengruppe → Kasse), fällt die Preisauswahl weg und es wird 0,00 boniert. Hier sieht der Benutzer genau
 * diese Artikel und entscheidet je Variante: eigener Artikel („Bier 0,5l" für 5,00) oder verwerfen.
 *
 * Gelistet werden ALLE Artikel mit Preis-Varianten; die akuten (Abfrage schon aus) stehen oben und sind
 * rot markiert — so sieht man auch die, die beim nächsten Abschalten falsch bonieren würden.
 *
 * Erkennung und Umrechnung stehen in @kassa/shared (bepreiste-varianten.ts) — der Server rechnet beim
 * Anlegen mit denselben Funktionen, die Vorschau hier kann also nicht auseinanderlaufen.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  findeBepreisteVarianten, istAkut, kategoriePfad, planeVariantenArtikel, ursprungDeaktivieren,
  type BetroffeneGruppe, type BetroffenerArtikel, type ModifikatorGruppe,
  type VariantenAufloesenErgebnis,
} from '@kassa/shared'
import { artikelApi, einrichtungApi, kategorieApi, modifikatorApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { kassenName } from '../lib/einrichtung'
import { formatPreis } from '../lib/format'
import { Button } from './ui/Button'

const aufschlag = (cent: number): string => `${cent > 0 ? '+' : ''}${formatPreis(cent)}`

/**
 * Die betroffenen Artikel samt Nebendaten. Als Hook, weil die Seite die Anzahl schon am Umschalter zeigt,
 * bevor die Ansicht offen ist — React Query teilt die Abfragen, es kostet also keinen zweiten Aufruf.
 */
export function useBepreisteVarianten(gruppen: readonly ModifikatorGruppe[]) {
  const identity = getKasseIdentity()!

  // Alle Artikel (auch deaktivierte): die Vorschau „gibt es schon" muss dasselbe sehen wie der Server
  const artikelQuery     = useQuery({ queryKey: ['artikel', identity.mandantId, false], queryFn: () => artikelApi.list(identity.mandantId, false) })
  const kategorienQuery  = useQuery({ queryKey: ['kategorien', 'alle'], queryFn: () => kategorieApi.list(false) })
  const zuweisungenQuery = useQuery({ queryKey: ['artikel-modifikator-gruppen'], queryFn: () => modifikatorApi.listeArtikelZuweisungen() })
  const erledigtQuery    = useQuery({ queryKey: ['artikel-varianten-erledigt'], queryFn: () => modifikatorApi.listeVariantenErledigt() })
  const einrichtungQuery = useQuery({ queryKey: ['einrichtung'], queryFn: () => einrichtungApi.get() })

  const alleArtikel = artikelQuery.data ?? []
  const kategorien  = kategorienQuery.data ?? []

  const treffer = useMemo(() => findeBepreisteVarianten({
    artikel:     alleArtikel,
    kategorien,
    gruppen,
    zuweisungen: zuweisungenQuery.data ?? [],
    kassen:      (einrichtungQuery.data?.kassen ?? [])
      .filter(k => k.ausserBetriebAm === null)
      .map(k => ({ name: kassenName(k), optionenAbfrage: k.optionenAbfrage })),
    erledigt:    erledigtQuery.data ?? [],
  }), [alleArtikel, kategorien, gruppen, zuweisungenQuery.data, einrichtungQuery.data, erledigtQuery.data])

  return {
    treffer,
    alleArtikel,
    kategorien,
    /** Anzahl offener Varianten — die Zahl am Umschalter */
    anzahl: treffer.reduce((n, a) => n + a.gruppen.reduce((m, g) => m + g.optionen.length, 0), 0),
    laedt:  artikelQuery.isLoading || zuweisungenQuery.isLoading || erledigtQuery.isLoading,
  }
}

// ---------------------------------------------------------------------------

export function BepreisteVariantenAnsicht({ gruppen }: { gruppen: readonly ModifikatorGruppe[] }) {
  const qc = useQueryClient()

  const [meldung, setMeldung] = useState<string | null>(null)
  const [fehler,  setFehler]  = useState<string | null>(null)

  const { treffer, alleArtikel, kategorien, laedt } = useBepreisteVarianten(gruppen)

  const aufloesen = useMutation({
    mutationFn: ({ artikelId, gruppeId, anlegen, verwerfen }: {
      artikelId: string; gruppeId: string; anlegen: string[]; verwerfen: string[]
    }) => modifikatorApi.loeseVariantenAuf(artikelId, { gruppeId, anlegen, verwerfen }),
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: ['artikel'] })
      qc.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
      qc.invalidateQueries({ queryKey: ['artikel-varianten-erledigt'] })
      setFehler(null)
      setMeldung(ergebnisText(e))
    },
    onError: (e) => setFehler(e instanceof Error ? e.message : 'Fehler beim Anlegen'),
  })

  if (laedt) {
    return <div className="flex-1 flex items-center justify-center text-ink-subtle text-sm">Wird geladen…</div>
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="max-w-3xl rounded-xl border border-line bg-panel-2 px-4 py-3">
        <p className="text-sm text-ink">
          Bei diesen Artikeln steckt der Preis in der Option — „Bier" 0,00 mit „0,5l" +5,00. Wird die
          Optionen-Abfrage abgeschaltet, fällt die Preisauswahl weg und der Artikel wird mit dem Basispreis
          boniert. Mach aus jeder Variante einen eigenen Artikel oder verwirf sie.
        </p>
        <p className="text-xs text-ink-muted mt-1.5">
          Verworfen heißt: kein eigener Artikel. Die Option selbst bleibt — sie hängt meist auch an anderen
          Artikeln. Ist eine Gruppe für diesen Artikel fertig, wird sie nur von ihm gelöst.
        </p>
      </div>

      {meldung && (
        <div className="max-w-3xl px-4 py-2 bg-green-50 border border-green-200 text-green-800 rounded-lg text-sm flex items-start justify-between gap-2">
          <span>{meldung}</span>
          <button onClick={() => setMeldung(null)} className="text-green-500 hover:text-green-700 shrink-0">✕</button>
        </div>
      )}
      {fehler && (
        <div className="max-w-3xl px-4 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-start justify-between gap-2">
          <span>{fehler}</span>
          <button onClick={() => setFehler(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
        </div>
      )}

      {treffer.length === 0 ? (
        <div className="max-w-3xl rounded-xl border-2 border-dashed border-line py-10 text-center">
          <p className="text-sm text-ink">Kein Artikel, dessen Preis an einer Option hängt.</p>
          <p className="text-xs text-ink-subtle mt-1">
            Die Optionen-Abfrage kann hier also überall abgeschaltet werden, ohne dass ein Preis verloren geht.
          </p>
        </div>
      ) : (
        treffer.map(a => (
          <ArtikelKarte
            key={a.artikelId}
            artikel={a}
            warengruppe={a.kategorieId ? kategoriePfad(kategorien, a.kategorieId) : 'Ohne Warengruppe'}
            alleArtikel={alleArtikel}
            laeuft={aufloesen.isPending}
            onAnlegen={(gruppeId, modIds) => aufloesen.mutate({ artikelId: a.artikelId, gruppeId, anlegen: modIds, verwerfen: [] })}
            onVerwerfen={(gruppeId, modId) => aufloesen.mutate({ artikelId: a.artikelId, gruppeId, anlegen: [], verwerfen: [modId] })}
          />
        ))
      )}
    </div>
  )
}

/** Was nach dem Auflösen gemeldet wird — knapp und vollständig, damit man es nicht nachprüfen muss. */
function ergebnisText(e: VariantenAufloesenErgebnis): string {
  const teile: string[] = []
  if (e.angelegt.length > 0) {
    teile.push(`${e.angelegt.length} Artikel angelegt: ${e.angelegt.map(a => `${a.bezeichnung} (${formatPreis(a.preisBruttoCent)})`).join(', ')}`)
  }
  if (e.uebersprungen.length > 0) {
    teile.push(`${e.uebersprungen.length} schon vorhanden: ${e.uebersprungen.map(u => u.bezeichnung).join(', ')}`)
  }
  if (e.verworfen > 0)         teile.push(`${e.verworfen} Variante${e.verworfen === 1 ? '' : 'n'} verworfen`)
  if (e.gruppeGeloest)         teile.push('Optionsgruppe von diesem Artikel gelöst')
  if (e.ursprungDeaktiviert)   teile.push('Ursprungsartikel deaktiviert (Basispreis 0,00)')
  return teile.join(' · ')
}

// ---------------------------------------------------------------------------

function ArtikelKarte({
  artikel, warengruppe, alleArtikel, laeuft, onAnlegen, onVerwerfen,
}: {
  artikel:     BetroffenerArtikel
  warengruppe: string
  alleArtikel: readonly { bezeichnung: string; kategorieId: string | null }[]
  laeuft:      boolean
  onAnlegen:   (gruppeId: string, modIds: string[]) => void
  onVerwerfen: (gruppeId: string, modId: string) => void
}) {
  const akut = istAkut(artikel)

  return (
    <div className={`max-w-3xl rounded-xl border bg-panel overflow-hidden ${akut ? 'border-red-300' : 'border-line'}`}>
      <div className="px-4 py-3 border-b border-line flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-ink">{artikel.bezeichnung}</h3>
            <span className="text-sm text-ink-muted">Basispreis {formatPreis(artikel.preisBruttoCent)}</span>
            {akut && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                boniert mit {formatPreis(artikel.preisBruttoCent)}
              </span>
            )}
          </div>
          <p className="text-xs text-ink-subtle mt-0.5">{warengruppe}</p>
          <p className={`text-xs mt-1 ${akut ? 'text-red-600' : 'text-ink-muted'}`}>
            {akut
              ? `Abfrage aus an: ${artikel.kassenOhneAbfrage.join(', ')}`
              : 'Abfrage überall an — der Preis wird derzeit richtig gewählt.'}
          </p>
        </div>
      </div>

      {artikel.gruppen.map(gruppe => (
        <GruppenBlock
          key={gruppe.gruppeId}
          gruppe={gruppe}
          artikel={artikel}
          alleArtikel={alleArtikel}
          laeuft={laeuft}
          onAnlegen={onAnlegen}
          onVerwerfen={onVerwerfen}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

function GruppenBlock({
  gruppe, artikel, alleArtikel, laeuft, onAnlegen, onVerwerfen,
}: {
  gruppe:      BetroffeneGruppe
  artikel:     BetroffenerArtikel
  alleArtikel: readonly { bezeichnung: string; kategorieId: string | null }[]
  laeuft:      boolean
  onAnlegen:   (gruppeId: string, modIds: string[]) => void
  onVerwerfen: (gruppeId: string, modId: string) => void
}) {
  // Dieselbe Rechnung wie auf dem Server: Bezeichnung, Preis und ob der Artikel schon existiert
  const plan = useMemo(
    () => planeVariantenArtikel(artikel, gruppe.optionen, alleArtikel),
    [artikel, gruppe.optionen, alleArtikel],
  )
  const planVon = new Map(plan.map(p => [p.modifikatorId, p] as const))
  const nochAnzulegen = plan.filter(p => !p.vorhanden)

  return (
    <div className="px-4 py-3 border-b border-line last:border-b-0">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{gruppe.gruppeName}</div>
          {gruppe.weitereArtikel > 0 && (
            <p className="text-xs text-ink-subtle mt-0.5">
              Hängt auch an {gruppe.weitereArtikel} weiteren Artikel{gruppe.weitereArtikel === 1 ? '' : 'n'} —
              dort bleibt sie unverändert.
            </p>
          )}
        </div>
        {gruppe.optionen.length > 1 && (
          <Button
            variant="secondary"
            disabled={laeuft || nochAnzulegen.length === 0}
            title={`Für alle ${gruppe.optionen.length} Varianten eigene Artikel anlegen`}
            onClick={() => onAnlegen(gruppe.gruppeId, gruppe.optionen.map(o => o.id))}
          >
            Alle {gruppe.optionen.length} anlegen
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-line divide-y divide-line">
        {gruppe.optionen.map(option => {
          const eintrag = planVon.get(option.id)
          return (
            <div key={option.id} className="px-3 py-2 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {option.name} <span className="text-ink-muted">{aufschlag(option.aufschlagCent)}</span>
                </div>
                <div className="text-xs text-ink-subtle mt-0.5">
                  wird <span className="font-medium text-ink-muted">{eintrag?.bezeichnung}</span>
                  {' '}für {formatPreis(eintrag?.preisBruttoCent ?? 0)}
                  {eintrag?.vorhanden && <span className="text-amber-600"> — gibt es in dieser Warengruppe schon</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  disabled={laeuft}
                  title={eintrag?.vorhanden
                    ? 'Artikel ist schon vorhanden — die Variante wird nur als erledigt vermerkt'
                    : `„${eintrag?.bezeichnung}" für ${formatPreis(eintrag?.preisBruttoCent ?? 0)} anlegen`}
                  onClick={() => onAnlegen(gruppe.gruppeId, [option.id])}
                >
                  Eigener Artikel
                </Button>
                <button
                  disabled={laeuft}
                  onClick={() => {
                    const hinweis = ursprungDeaktivieren(artikel.preisBruttoCent, gruppe.optionen.length === 1)
                      ? `\n\nAchtung: „${artikel.bezeichnung}" hat Basispreis 0,00 — ohne Variante bleibt ein Artikel für 0,00 übrig.`
                      : ''
                    if (confirm(`Variante „${option.name}" verwerfen? Es entsteht kein eigener Artikel.${hinweis}`)) {
                      onVerwerfen(gruppe.gruppeId, option.id)
                    }
                  }}
                  className="text-sm text-ink-muted hover:text-red-600 px-2 py-1 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  Verwerfen
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
