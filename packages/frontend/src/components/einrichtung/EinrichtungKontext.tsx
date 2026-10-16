/**
 * EinrichtungKontext — Daten und Schreibzugriffe der Einrichtungs-Übersicht (Einstellungen → Kassen).
 *
 * EINE Abfrage (GET /api/einrichtung) liefert alle Kassen mit Druckern, Warengruppen und KDS plus alle
 * Kassen-Ausnahmen — statt vier Abfragen je Kasse. Geschrieben wird weiter über die Endpunkte je Kasse
 * (Drucker, KDS, POS-Konfiguration) bzw. den neuen Stapel für die Ausnahmen.
 *
 * Änderungen erscheinen sofort (optimistisch); danach wird der Serverstand nachgeladen — aber erst, wenn
 * kein weiterer Schreibzugriff mehr läuft, sonst flackert eine schnelle Folge von Klicks zurück. Schlägt
 * ein Schreibzugriff fehl, gilt wieder der Serverstand und die Seite meldet den Fehler.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Einrichtung, EinrichtungKasse, RoutingAenderung } from '@kassa/shared'
import { druckerApi, einrichtungApi, kasseApi, kdsApi, posConfigApi, type DruckerConfig, type KdsConfig } from '../../lib/api'
import { hasModul, updateKasseBezeichnung } from '../../lib/auth'
import { wendeAenderungenAn } from '../../lib/einrichtung'

export const EINRICHTUNG_KEY = ['einrichtung'] as const

/** Die je Kasse änderbaren Felder der Übersicht. */
export type KassePatch = Partial<Pick<EinrichtungKasse,
  | 'bezeichnung'
  | 'belegModus' | 'druckerId' | 'gastModus' | 'gastBasisUrl'
  | 'kdsAktiv' | 'kdsPort' | 'kdsStationen'
  | 'startseite' | 'startFavoriten' | 'startKategorieId'
  | 'erlaubteZahlungsarten' | 'sichtbareKategorieIds' | 'sichtbareBonierdruckerIds'
>>

/** Verteilt die geänderten Felder auf die Endpunkte, die sie speichern (parallel). */
async function schreibeKassenPatch(kasseId: string, p: KassePatch): Promise<void> {
  const aufgaben: Promise<unknown>[] = []

  const drucker: Partial<DruckerConfig> = {}
  if (p.druckerId    !== undefined) drucker.druckerId    = p.druckerId
  if (p.belegModus   !== undefined) drucker.belegModus   = p.belegModus
  if (p.gastModus    !== undefined) drucker.gastModus    = p.gastModus
  if (p.gastBasisUrl !== undefined) drucker.gastBasisUrl = p.gastBasisUrl
  if (Object.keys(drucker).length > 0) aufgaben.push(druckerApi.patch(kasseId, drucker))

  const kds: Partial<KdsConfig> = {}
  if (p.kdsAktiv     !== undefined) kds.kdsAktiv     = p.kdsAktiv
  if (p.kdsPort      !== undefined) kds.kdsPort      = p.kdsPort
  if (p.kdsStationen !== undefined) kds.kdsStationen = p.kdsStationen
  if (Object.keys(kds).length > 0) aufgaben.push(kdsApi.patch(kasseId, kds))

  const pos: Parameters<typeof posConfigApi.update>[1] = {}
  if (p.startseite                !== undefined) pos.startseite                = p.startseite
  if (p.startFavoriten            !== undefined) pos.startFavoriten            = p.startFavoriten
  if (p.startKategorieId          !== undefined) pos.startKategorieId          = p.startKategorieId
  if (p.erlaubteZahlungsarten     !== undefined) pos.erlaubteZahlungsarten     = p.erlaubteZahlungsarten
  if (p.sichtbareKategorieIds     !== undefined) pos.sichtbareKategorieIds     = p.sichtbareKategorieIds
  if (p.sichtbareBonierdruckerIds !== undefined) pos.sichtbareBonierdruckerIds = p.sichtbareBonierdruckerIds
  if (Object.keys(pos).length > 0) aufgaben.push(posConfigApi.update(kasseId, pos))

  if (p.bezeichnung !== undefined) {
    aufgaben.push(kasseApi.updateBezeichnung(kasseId, { bezeichnung: p.bezeichnung ?? '' })
      .then(r => updateKasseBezeichnung(kasseId, r.bezeichnung ?? '')))
  }

  await Promise.all(aufgaben)
}

interface Kontext {
  daten:        Einrichtung | undefined
  laedt:        boolean
  /** Alle Kassen, auch außer Betrieb genommene (in der Reihenfolge der Anlage) */
  kassen:       EinrichtungKasse[]
  /** Nur Kassen in Betrieb */
  aktiveKassen: EinrichtungKasse[]
  istGastro:    boolean
  /** Speichert Felder einer Kasse; wirft bei einem Fehler (der Aufrufer meldet ihn selbst) */
  speichereKasse: (kasseId: string, patch: KassePatch) => Promise<void>
  /** Wie speichereKasse, meldet einen Fehler aber selbst oben auf der Seite */
  speichern:      (kasseId: string, patch: KassePatch) => Promise<void>
  /** Kassen-Ausnahmen ändern; meldet einen Fehler selbst oben auf der Seite */
  ausnahmenSetzen: (aenderungen: RoutingAenderung[]) => Promise<void>
  /** Den Serverstand neu laden (z. B. nach dem Anlegen oder Kopieren einer Kasse) */
  neuLaden:       () => Promise<void>
  fehler:         string | null
  meldeFehler:    (text: string | null) => void
}

const EinrichtungCtx = createContext<Kontext | null>(null)

export function useEinrichtung(): Kontext {
  const k = useContext(EinrichtungCtx)
  if (!k) throw new Error('useEinrichtung nur innerhalb von EinrichtungProvider')
  return k
}

export function EinrichtungProvider({ children }: { children: ReactNode }) {
  const qc        = useQueryClient()
  const istGastro = hasModul('gastro')
  const query     = useQuery({ queryKey: EINRICHTUNG_KEY, queryFn: einrichtungApi.get })
  const [fehler, meldeFehler] = useState<string | null>(null)

  // Laufende Schreibzugriffe: erst wenn alle durch sind, wird der Serverstand nachgeladen
  const laufend  = useRef(0)
  const beruehrt = useRef(new Set<string>())

  const abgeschlossen = useCallback(() => {
    laufend.current -= 1
    if (laufend.current > 0) return
    const ids = [...beruehrt.current]
    beruehrt.current.clear()
    void qc.invalidateQueries({ queryKey: EINRICHTUNG_KEY })
    // Andere Seiten (Kasse, POS-Konfiguration, Kassen-Umschalter) lesen dieselben Daten unter eigenen Schlüsseln
    for (const id of ids) {
      for (const key of [['pos-config', id], ['drucker', id], ['kds', id], ['kasse-status', id]] as const) {
        void qc.invalidateQueries({ queryKey: key })
      }
    }
    void qc.invalidateQueries({ queryKey: ['kassen-liste'] })
    void qc.invalidateQueries({ queryKey: ['kassen'] })
  }, [qc])

  const speichereKasse = useCallback(async (kasseId: string, patch: KassePatch) => {
    laufend.current += 1
    beruehrt.current.add(kasseId)
    qc.setQueryData<Einrichtung>(EINRICHTUNG_KEY, old =>
      old && { ...old, kassen: old.kassen.map(k => (k.id === kasseId ? { ...k, ...patch } : k)) })
    try {
      await schreibeKassenPatch(kasseId, patch)
    } finally {
      abgeschlossen()
    }
  }, [qc, abgeschlossen])

  const melde = useCallback(async (aufgabe: () => Promise<void>) => {
    try {
      await aufgabe()
      meldeFehler(null)
    } catch (err) {
      meldeFehler(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const speichern = useCallback((kasseId: string, patch: KassePatch) => melde(() => speichereKasse(kasseId, patch)), [melde, speichereKasse])

  const ausnahmenSetzen = useCallback((aenderungen: RoutingAenderung[]) => {
    if (aenderungen.length === 0) return Promise.resolve()
    return melde(async () => {
      laufend.current += 1
      qc.setQueryData<Einrichtung>(EINRICHTUNG_KEY, old =>
        old && { ...old, ausnahmen: wendeAenderungenAn(old.ausnahmen, aenderungen) })
      try {
        await einrichtungApi.ausnahmenSetzen(aenderungen)
      } finally {
        abgeschlossen()
      }
    })
  }, [melde, qc, abgeschlossen])

  const neuLaden = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: EINRICHTUNG_KEY })
    void qc.invalidateQueries({ queryKey: ['kassen-liste'] })
    void qc.invalidateQueries({ queryKey: ['kassen'] })
  }, [qc])

  const kassen = useMemo(() => query.data?.kassen ?? [], [query.data])
  const wert = useMemo<Kontext>(() => ({
    daten: query.data,
    laedt: query.isLoading,
    kassen,
    aktiveKassen: kassen.filter(k => k.status === 'aktiv'),
    istGastro,
    speichereKasse, speichern, ausnahmenSetzen, neuLaden,
    fehler, meldeFehler,
  }), [query.data, query.isLoading, kassen, istGastro, speichereKasse, speichern, ausnahmenSetzen, neuLaden, fehler])

  return <EinrichtungCtx.Provider value={wert}>{children}</EinrichtungCtx.Provider>
}
