import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { TischplanBereich, TischTabResponse } from '@kassa/shared'
import { tischTabApi, kellnerKonfigApi, tischplanApi } from '../lib/api'
import { getAuth, clearAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { DruckproblemeBanner } from '../components/DruckproblemeBanner'

function dauerText(geoffnetAm: string): string {
  const minuten = Math.floor((Date.now() - new Date(geoffnetAm).getTime()) / 60_000)
  return minuten < 60 ? `${minuten} min` : `${Math.floor(minuten / 60)}h ${minuten % 60}m`
}

export function TischePage() {
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const [manuellOffen,  setManuellOffen]  = useState(false)
  const [wahlOffen,     setWahlOffen]     = useState(false)
  const [tischNummer, setTischNummer] = useState('')
  const [fehler, setFehler]           = useState<string | null>(null)
  /** Belegter Tisch angetippt → Gruppen-Auswahl (öffnen oder neue Gruppe) */
  const [gruppenWahl, setGruppenWahl] = useState<{ bezeichnung: string; tabs: TischTabResponse[] } | null>(null)

  const tabsQuery = useQuery({
    queryKey:        ['tisch-tabs', identity.kasseId],
    queryFn:         () => tischTabApi.list(identity.kasseId),
    refetchInterval: 8_000,
  })

  const konfigQuery = useQuery({
    queryKey:  ['kellner-konfig', identity.kasseId],
    queryFn:   () => kellnerKonfigApi.get(identity.kasseId),
    staleTime: 30_000,
  })
  const tischwahl = konfigQuery.data?.kellnerTischwahl ?? 'manuell'

  const bereicheQuery = useQuery({
    queryKey:  ['tischplan-bereiche', identity.kasseId],
    queryFn:   () => tischplanApi.listeBereiche(identity.kasseId),
    enabled:   tischwahl !== 'manuell',
    staleTime: 60_000,
  })

  const erstelleMutation = useMutation({
    mutationFn: (nummer: string) => tischTabApi.erstelle({
      kasseId:     identity.kasseId,
      tischNummer: nummer,
      kellner:     auth.user.name,
    }),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      // Direkt in den Bestellmodus — der Kellner öffnet einen Tisch, um zu bestellen
      navigate(`/tab/${tab.id}/artikel`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  function abmelden() {
    clearAuth()
    navigate('/login', { replace: true })
  }

  function neuerTischKlick() {
    setFehler(null)
    if (tischwahl === 'manuell') {
      setTischNummer('')
      setManuellOffen(true)
    } else {
      setWahlOffen(true)
    }
  }

  /** Tisch aus Liste/Plan angetippt: frei → öffnen, belegt → Gruppen-Auswahl. */
  function tischGewaehlt(bezeichnung: string) {
    const offene = tabs.filter(t => t.tischNummer === bezeichnung)
    if (offene.length === 0) {
      erstelleMutation.mutate(bezeichnung)
    } else {
      setGruppenWahl({ bezeichnung, tabs: offene })
    }
  }

  const tabs = tabsQuery.data ?? []

  return (
    <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <h1 className="font-black text-ink text-lg">Tische</h1>
          <p className="text-xs text-ink-subtle">{auth.user.name} · {tabs.length} offen</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={neuerTischKlick}
            className="bg-brand-600 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition"
          >
            + Tisch
          </button>
          <button
            onClick={abmelden}
            className="text-ink-subtle hover:text-ink-muted p-2 rounded-xl hover:bg-panel-2 transition text-sm"
            title="Abmelden"
          >
            ⏏
          </button>
        </div>
      </div>

      {/* Inhalt */}
      <div className="flex-1 p-4 space-y-3">
        {/* Nicht gedruckte Belege — auch hier sichtbar, damit es auffällt,
            wenn der Kellner nach dem Kassieren zur Übersicht zurückkehrt. */}
        <DruckproblemeBanner />

        {tabsQuery.isLoading && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!tabsQuery.isLoading && tabs.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <p className="text-4xl">🪑</p>
            <p className="text-ink-subtle text-sm">Keine offenen Tische</p>
          </div>
        )}

        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => navigate(`/tab/${tab.id}/artikel`)}
            className="w-full bg-panel rounded-2xl border border-line px-4 py-4 flex items-center justify-between gap-4 active:scale-98 transition text-left hover:border-brand-300 hover:shadow-sm"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-black text-sm shrink-0">
                {tab.tischNummer.slice(0, 3)}
              </div>
              <div className="min-w-0">
                <p className="font-bold text-ink truncate">{tab.tischNummer}</p>
                <p className="text-xs text-ink-subtle">{tab.kellner} · {dauerText(tab.geoffnetAm)}</p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="font-black text-ink font-mono">{formatPreis(tab.summeGesamtCent)}</p>
              <p className="text-xs text-ink-subtle">{tab.positionen.length} Pos.</p>
            </div>
          </button>
        ))}
      </div>

      {/* Vollbild: Tischauswahl aus Liste oder Plan */}
      {wahlOffen && (
        <TischwahlOverlay
          modus={tischwahl === 'plan' ? 'plan' : 'liste'}
          bereiche={bereicheQuery.data ?? []}
          laedt={bereicheQuery.isLoading}
          tabs={tabs}
          beschaeftigt={erstelleMutation.isPending}
          fehler={fehler}
          onTisch={tischGewaehlt}
          onManuell={() => { setWahlOffen(false); setTischNummer(''); setManuellOffen(true) }}
          onClose={() => setWahlOffen(false)}
        />
      )}

      {/* Bottom-Sheet: belegter Tisch — Gruppe öffnen oder neue Gruppe */}
      {gruppenWahl && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-end justify-center p-4">
          <div className="bg-panel rounded-3xl w-full max-w-sm p-6 space-y-3">
            <h2 className="font-black text-ink text-lg">Tisch {gruppenWahl.bezeichnung}</h2>
            {gruppenWahl.tabs.map(t => (
              <button
                key={t.id}
                onClick={() => { setGruppenWahl(null); setWahlOffen(false); navigate(`/tab/${t.id}/artikel`) }}
                className="w-full bg-surface rounded-2xl border-2 border-line px-4 py-3 flex items-center justify-between gap-3 text-left active:scale-98 transition hover:border-brand-400"
              >
                <div className="min-w-0">
                  <p className="font-bold text-ink truncate">{t.kellner}</p>
                  <p className="text-xs text-ink-subtle">{t.positionen.length} Pos. · {dauerText(t.geoffnetAm)}</p>
                </div>
                <p className="font-black text-ink font-mono shrink-0">{formatPreis(t.summeGesamtCent)}</p>
              </button>
            ))}
            <button
              onClick={() => { const nr = gruppenWahl.bezeichnung; setGruppenWahl(null); erstelleMutation.mutate(nr) }}
              disabled={erstelleMutation.isPending}
              className="w-full py-3 rounded-xl border-2 border-brand-400 text-brand-700 font-bold text-sm active:scale-95 transition disabled:opacity-50"
            >
              + Neue Gruppe am selben Tisch
            </button>
            <button
              onClick={() => setGruppenWahl(null)}
              className="w-full py-3 rounded-xl border-2 border-line text-ink-muted font-bold text-sm hover:bg-surface transition"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Modal: Tischnummer manuell eingeben */}
      {manuellOffen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end justify-center p-4">
          <div className="bg-panel rounded-3xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-black text-ink text-lg">Neuer Tisch</h2>

            <input
              type="text"
              value={tischNummer}
              onChange={e => setTischNummer(e.target.value)}
              placeholder="z. B. Tisch 3 oder Bar"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && tischNummer.trim() && erstelleMutation.mutate(tischNummer.trim())}
              className="w-full border-2 border-line rounded-xl px-4 py-3 text-base font-medium focus:outline-none focus:border-brand-500"
            />

            {fehler && <p className="text-red-500 text-sm">{fehler}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setManuellOffen(false)}
                className="flex-1 py-3 rounded-xl border-2 border-line text-ink-muted font-bold text-sm hover:bg-surface transition"
              >
                Abbrechen
              </button>
              <button
                onClick={() => erstelleMutation.mutate(tischNummer.trim())}
                disabled={!tischNummer.trim() || erstelleMutation.isPending}
                className="flex-1 py-3 rounded-xl bg-brand-600 text-white font-bold text-sm disabled:opacity-50 active:scale-95 transition"
              >
                {erstelleMutation.isPending ? '…' : 'Öffnen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tischauswahl-Overlay: Bereiche als Reiter, Tische als Liste oder Mini-Plan
// ---------------------------------------------------------------------------

function TischwahlOverlay({
  modus,
  bereiche,
  laedt,
  tabs,
  beschaeftigt,
  fehler,
  onTisch,
  onManuell,
  onClose,
}: {
  modus:        'liste' | 'plan'
  bereiche:     TischplanBereich[]
  laedt:        boolean
  tabs:         TischTabResponse[]
  beschaeftigt: boolean
  fehler:       string | null
  onTisch:      (bezeichnung: string) => void
  onManuell:    () => void
  onClose:      () => void
}) {
  const [bereichIdx, setBereichIdx] = useState(0)
  const bereich = bereiche[Math.min(bereichIdx, Math.max(0, bereiche.length - 1))]

  return (
    <div className="fixed inset-0 bg-surface z-50 flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 flex items-center gap-3">
        <button onClick={onClose} className="text-ink-subtle text-2xl leading-none shrink-0">‹</button>
        <h1 className="font-black text-ink text-lg flex-1">Tisch wählen</h1>
      </div>

      {/* Bereich-Reiter */}
      {bereiche.length > 1 && (
        <div className="bg-panel border-b border-line px-4 py-2 flex gap-1.5 overflow-x-auto scrollbar-none">
          {bereiche.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setBereichIdx(i)}
              className={`shrink-0 px-4 py-1.5 rounded-xl text-sm font-bold whitespace-nowrap transition ${
                i === bereichIdx ? 'bg-brand-600 text-white' : 'text-ink-muted hover:bg-panel-2'
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Inhalt */}
      <div className="flex-1 overflow-y-auto p-4">
        {laedt && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!laedt && (bereiche.length === 0 || !bereich || bereich.elemente.length === 0) && (
          <div className="text-center py-12 space-y-2">
            <p className="text-ink-subtle text-sm">
              {bereiche.length === 0
                ? 'Noch kein Tischplan angelegt — an der Kassa unter Einstellungen → Tischplan Bereiche und Tische anlegen.'
                : 'Keine Tische in diesem Bereich.'}
            </p>
          </div>
        )}

        {fehler && <p className="text-red-500 text-sm text-center mb-3">{fehler}</p>}

        {/* Liste */}
        {!laedt && bereich && modus === 'liste' && bereich.elemente.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {bereich.elemente.map(el => {
              const offene = tabs.filter(t => t.tischNummer === el.bezeichnung)
              const belegt = offene.length > 0
              const summe  = offene.reduce((s, t) => s + t.summeGesamtCent, 0)
              return (
                <button
                  key={el.id}
                  onClick={() => onTisch(el.bezeichnung)}
                  disabled={beschaeftigt}
                  className={`rounded-2xl border-2 px-3 py-4 text-left active:scale-95 transition disabled:opacity-50 ${
                    belegt
                      ? 'bg-orange-50 border-orange-300'
                      : 'bg-panel border-line hover:border-brand-400'
                  }`}
                >
                  <p className={`font-black truncate ${belegt ? 'text-orange-900' : 'text-ink'}`}>
                    {el.bezeichnung}
                  </p>
                  {belegt ? (
                    <p className="text-xs text-orange-700 mt-0.5">
                      {offene.length > 1 ? `${offene.length} Gruppen · ` : `${offene[0]!.kellner} · `}
                      {formatPreis(summe)}
                    </p>
                  ) : (
                    <p className="text-xs text-ink-subtle mt-0.5">frei</p>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Mini-Tischplan */}
        {!laedt && bereich && modus === 'plan' && bereich.elemente.length > 0 && (
          <div className="relative w-full aspect-[4/3] bg-panel-2 rounded-xl border-2 border-line overflow-hidden">
            {bereich.elemente.map(el => {
              const offene = tabs.filter(t => t.tischNummer === el.bezeichnung)
              const belegt = offene.length > 0
              const summe  = offene.reduce((s, t) => s + t.summeGesamtCent, 0)
              return (
                <button
                  key={el.id}
                  onClick={() => onTisch(el.bezeichnung)}
                  disabled={beschaeftigt}
                  style={{
                    position: 'absolute',
                    left:   `${el.x}%`,
                    top:    `${el.y}%`,
                    width:  `${el.breite}%`,
                    height: `${el.hoehe}%`,
                  }}
                  className={`flex flex-col items-center justify-center border-2 transition active:scale-95 overflow-hidden disabled:opacity-50 ${
                    el.form === 'rund' ? 'rounded-full' : 'rounded-lg'
                  } ${
                    belegt
                      ? 'bg-orange-100 border-orange-400 text-orange-900'
                      : 'bg-panel border-line-strong text-ink-muted'
                  }`}
                >
                  <span className="font-bold text-[clamp(0.55rem,3cqw,0.9rem)] leading-tight truncate w-full text-center px-0.5">
                    {el.bezeichnung}
                  </span>
                  {belegt && (
                    <span className="text-[clamp(0.45rem,2.2cqw,0.7rem)] opacity-80 leading-tight">
                      {formatPreis(summe)}
                    </span>
                  )}
                  {offene.length > 1 && (
                    <span className="absolute top-0.5 right-0.5 min-w-[1rem] h-4 rounded-full bg-white/80 border border-current text-[10px] font-bold flex items-center justify-center leading-none px-0.5">
                      {offene.length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Rückfallebene: Tisch, den es im Plan nicht gibt (z. B. Stehtisch) */}
      <div className="bg-panel border-t border-line p-4">
        <button
          onClick={onManuell}
          className="w-full py-3 rounded-xl border-2 border-line text-ink-muted font-bold text-sm hover:bg-surface transition"
        >
          ✎ Tischnummer manuell eingeben
        </button>
      </div>
    </div>
  )
}
