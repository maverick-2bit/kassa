/**
 * TischplanAnsicht — operativer Blick auf den Tischplan.
 *
 * Pro Tischelement werden alle offenen Tabs mit gleicher tischNummer zusammengefasst:
 *   0 Gruppen  → frei (grau)
 *   1 Gruppe   → besetzt, Tap öffnet den Tab
 *   2+ Gruppen → mehrfach belegt, Tap öffnet Gruppen-Auswahl-Dialog
 *
 * Aus dem Dialog heraus kann auch eine neue Gruppe am selben Tisch geöffnet werden.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TischplanBereich, TischTabResponse, TischTabErstellenInput } from '@kassa/shared'
import { tischTabApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from './ui/Modal'
import { Input } from './ui/Input'
import { Button } from './ui/Button'

interface Props {
  bereiche: TischplanBereich[]
  tabs:     TischTabResponse[]
}

export function TischplanAnsicht({ bereiche, tabs }: Props) {
  const [aktiverBereichIdx, setAktiverBereichIdx] = useState(0)

  // Zustand für Dialoge
  const [gruppenAuswahl, setGruppenAuswahl] = useState<{ bezeichnung: string; tabs: TischTabResponse[] } | null>(null)
  const [neueGruppeFuer,  setNeueGruppeFuer]  = useState<string | null>(null)
  const [kellner,         setKellner]         = useState('Service')
  const [fehler,          setFehler]          = useState<string | null>(null)

  const identity = getKasseIdentity()!
  const navigate = useNavigate()
  const qc       = useQueryClient()

  const aktiveBereich = bereiche[aktiverBereichIdx]

  const erstelleMutation = useMutation({
    mutationFn: (input: TischTabErstellenInput) => tischTabApi.erstelle(input),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setNeueGruppeFuer(null)
      setGruppenAuswahl(null)
      navigate(`/tische/${tab.id}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const handleElementClick = (bezeichnung: string) => {
    const offeneTabs = tabs.filter((t) => t.tischNummer === bezeichnung)
    if (offeneTabs.length === 0) {
      // Frei → direkt neue Gruppe öffnen
      setNeueGruppeFuer(bezeichnung)
      setKellner('Service')
      setFehler(null)
    } else if (offeneTabs.length === 1) {
      // Eine Gruppe → direkt zum Tab
      navigate(`/tische/${offeneTabs[0]!.id}`)
    } else {
      // Mehrere Gruppen → Auswahl-Dialog
      setGruppenAuswahl({ bezeichnung, tabs: offeneTabs })
      setFehler(null)
    }
  }

  const handleNeueGruppe = (bezeichnung: string) => {
    setGruppenAuswahl(null)
    setNeueGruppeFuer(bezeichnung)
    setKellner('Service')
    setFehler(null)
  }

  const handleGruppeErstellen = (bezeichnung: string) => {
    erstelleMutation.mutate({
      kasseId:     identity.kasseId,
      tischNummer: bezeichnung,
      kellner:     kellner.trim() || 'Service',
    })
  }

  if (bereiche.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
        <p className="text-gray-500">Noch kein Tischplan angelegt.</p>
        <p className="mt-1 text-sm text-gray-400">
          Unter Einstellungen → Tischplan einen Bereich und Tische hinzufügen.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Bereich-Tabs */}
      {bereiche.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
          {bereiche.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setAktiverBereichIdx(i)}
              className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition ${
                i === aktiverBereichIdx
                  ? 'bg-brand-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* Planfläche */}
      {aktiveBereich && (
        <div className="relative w-full aspect-[4/3] bg-gray-50 rounded-xl border-2 border-gray-200 overflow-hidden">
          {aktiveBereich.elemente.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-gray-400">Keine Tische in diesem Bereich.</p>
            </div>
          )}
          {aktiveBereich.elemente.map((el) => {
            const offeneTabs = tabs.filter((t) => t.tischNummer === el.bezeichnung)
            return (
              <TischSymbol
                key={el.id}
                bezeichnung={el.bezeichnung}
                form={el.form}
                x={el.x}
                y={el.y}
                breite={el.breite}
                hoehe={el.hoehe}
                tabs={offeneTabs}
                onClick={() => handleElementClick(el.bezeichnung)}
              />
            )
          })}
        </div>
      )}

      {/* Dialog: Gruppen-Auswahl (mehrere Gruppen am selben Tisch) */}
      <Modal
        open={gruppenAuswahl !== null}
        onClose={() => setGruppenAuswahl(null)}
        title={`Tisch ${gruppenAuswahl?.bezeichnung ?? ''} — Gruppen`}
      >
        {gruppenAuswahl && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              {gruppenAuswahl.tabs.length} Gruppen an diesem Tisch — bitte auswählen:
            </p>
            <ul className="space-y-2">
              {gruppenAuswahl.tabs.map((t, i) => {
                const min = Math.floor((Date.now() - new Date(t.geoffnetAm).getTime()) / 60_000)
                const dauer = min < 60 ? `${min} Min.` : `${Math.floor(min / 60)}h ${min % 60}m`
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => { setGruppenAuswahl(null); navigate(`/tische/${t.id}`) }}
                      className="w-full flex items-center justify-between rounded-lg border border-orange-300 bg-orange-50 hover:bg-orange-100 px-4 py-3 text-left transition"
                    >
                      <div>
                        <p className="font-semibold text-orange-900">
                          Gruppe {i + 1} · {t.kellner}
                        </p>
                        <p className="text-xs text-orange-700">
                          {t.positionen.reduce((n, p) => n + p.menge, 0)} Pos. · geöffnet {dauer}
                        </p>
                      </div>
                      <p className="font-bold text-orange-800 shrink-0 ml-4">
                        {formatPreis(t.summeGesamtCent)}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => handleNeueGruppe(gruppenAuswahl.bezeichnung)}
            >
              + Neue Gruppe am selben Tisch
            </Button>
          </div>
        )}
      </Modal>

      {/* Dialog: neue Gruppe öffnen */}
      <Modal
        open={neueGruppeFuer !== null}
        onClose={() => setNeueGruppeFuer(null)}
        title={`Tisch ${neueGruppeFuer ?? ''} — Neue Gruppe`}
      >
        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Kellner / Bezeichnung</span>
            <Input
              autoFocus
              value={kellner}
              onChange={(e) => setKellner(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && neueGruppeFuer) handleGruppeErstellen(neueGruppeFuer)
              }}
              className="mt-1"
            />
          </label>
          {fehler && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
          )}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => setNeueGruppeFuer(null)} className="flex-1">
              Abbrechen
            </Button>
            <Button
              loading={erstelleMutation.isPending}
              onClick={() => neueGruppeFuer && handleGruppeErstellen(neueGruppeFuer)}
              className="flex-1"
            >
              Gruppe öffnen
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tisch-Symbol auf der Planfläche
// ---------------------------------------------------------------------------

interface TischSymbolProps {
  bezeichnung: string
  form:        'rechteck' | 'rund'
  x:           number
  y:           number
  breite:      number
  hoehe:       number
  tabs:        TischTabResponse[]
  onClick:     () => void
}

function TischSymbol({ bezeichnung, form, x, y, breite, hoehe, tabs, onClick }: TischSymbolProps) {
  const count    = tabs.length
  const summeCent = tabs.reduce((s, t) => s + t.summeGesamtCent, 0)

  // Ältester Tab bestimmt die Farbstufe
  const aeltestMin = count > 0
    ? Math.max(...tabs.map((t) => Math.floor((Date.now() - new Date(t.geoffnetAm).getTime()) / 60_000)))
    : 0

  const { bg, border, text } = count === 0
    ? { bg: 'bg-white',      border: 'border-gray-300',  text: 'text-gray-500'  }
    : aeltestMin < 30
    ? { bg: 'bg-orange-100', border: 'border-orange-400', text: 'text-orange-900' }
    : aeltestMin < 60
    ? { bg: 'bg-amber-100',  border: 'border-amber-500',  text: 'text-amber-900'  }
    : { bg: 'bg-red-100',    border: 'border-red-500',    text: 'text-red-900'    }

  const rund = form === 'rund'

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'absolute',
        left:   `${x}%`,
        top:    `${y}%`,
        width:  `${breite}%`,
        height: `${hoehe}%`,
      }}
      className={`
        flex flex-col items-center justify-center border-2 transition
        hover:shadow-md active:scale-95 overflow-hidden
        ${rund ? 'rounded-full' : 'rounded-lg'}
        ${bg} ${border} ${text}
      `}
    >
      {/* Tischname */}
      <span className="font-bold text-[clamp(0.6rem,1.4cqw,1rem)] leading-tight truncate w-full text-center px-1">
        {bezeichnung}
      </span>

      {/* Belegt: Summe + ggf. Gruppen-Badge */}
      {count > 0 && (
        <span className="text-[clamp(0.5rem,1cqw,0.75rem)] opacity-80 leading-tight">
          {formatPreis(summeCent)}
        </span>
      )}

      {/* Gruppen-Badge bei mehreren Parteien */}
      {count > 1 && (
        <span
          className="absolute top-0.5 right-0.5 min-w-[1.1rem] h-[1.1rem] rounded-full
                     bg-white/80 border border-current text-[10px] font-bold
                     flex items-center justify-center leading-none px-0.5"
        >
          {count}
        </span>
      )}
    </button>
  )
}
