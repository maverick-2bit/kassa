/**
 * Sprachbestellung (optionales Modul) — Synonyme eines Artikels pflegen.
 *
 * Synonyme sind die Namen, die Kellner tatsächlich sagen („Seidl", „Krügerl", „Gespritzter"). Die
 * Sprachbestellung erkennt den Artikel dann auch unter diesen Namen. Geändert wird die ganze Liste auf
 * einmal; speichert der Server Namen, die auch einen anderen Artikel meinen, steht eine Warnung da —
 * die Sprache fragt dann bei diesem Namen nach, statt zu raten.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SYNONYME_MAX_JE_ARTIKEL, type ArtikelSynonymeErgebnis } from '@kassa/shared'
import { spracheApi } from '../lib/api'
import { entferneSynonym, fuegeSynonymeHinzu, konfliktText, SYNONYM_MAX_LAENGE, synonymeGeaendert } from '../lib/synonyme'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

/** Gemeinsamer Schlüsselanfang: Liste und Einzelabfragen lassen sich zusammen ungültig machen. */
export const SYNONYME_QUERY_KEY = 'sprache-synonyme'

export function SynonymeModal({ artikelId, artikelName, onClose }: {
  artikelId:   string
  artikelName: string
  onClose:     () => void
}) {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: [SYNONYME_QUERY_KEY, 'artikel', artikelId],
    queryFn:  () => spracheApi.artikelSynonyme(artikelId),
  })

  const [gespeichert, setGespeichert] = useState<string[]>([])
  const [liste, setListe] = useState<string[]>([])
  const [eingabe, setEingabe] = useState('')
  const [eingabeFehler, setEingabeFehler] = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<ArtikelSynonymeErgebnis | null>(null)

  useEffect(() => {
    if (query.data) { setGespeichert(query.data.synonyme); setListe(query.data.synonyme) }
  }, [query.data])

  const speichern = useMutation({
    mutationFn: (zuSpeichern: string[]) => spracheApi.setzeArtikelSynonyme(artikelId, zuSpeichern),
    onSuccess: (antwort) => {
      qc.invalidateQueries({ queryKey: [SYNONYME_QUERY_KEY] })
      // Ohne Warnung: fertig. Mit Warnung: stehen lassen, damit sie gelesen wird.
      if (antwort.konflikte.length === 0) onClose()
      else { setGespeichert(antwort.synonyme); setListe(antwort.synonyme); setErgebnis(antwort) }
    },
  })

  const hinzufuegen = () => {
    const r = fuegeSynonymeHinzu(liste, eingabe, artikelName)
    setListe(r.liste)
    setEingabeFehler(r.fehler)
    // Eingabefeld leeren, wenn etwas übernommen wurde; sonst stehen lassen, damit man korrigieren kann
    if (r.liste.length > liste.length) setEingabe('')
    setErgebnis(null)
  }

  /** Ein getippter, noch nicht hinzugefügter Name geht beim Speichern nicht verloren. */
  const speichernKlick = () => {
    let zuSpeichern = liste
    if (eingabe.trim() !== '') {
      const r = fuegeSynonymeHinzu(liste, eingabe, artikelName)
      if (r.fehler && r.liste.length === liste.length) { setEingabeFehler(r.fehler); return }
      zuSpeichern = r.liste
      setListe(r.liste)
      setEingabe('')
    }
    speichern.mutate(zuSpeichern)
  }

  const geaendert = synonymeGeaendert(gespeichert, liste) || eingabe.trim() !== ''
  const voll = liste.length >= SYNONYME_MAX_JE_ARTIKEL

  return (
    <Modal open onClose={onClose} title={`Sprache: ${artikelName}`} size="md">
      <div className="space-y-4" data-testid="synonyme-modal">
        <p className="text-sm text-ink-muted">
          Namen, die Kellner für diesen Artikel sagen — zum Beispiel „Seidl" oder „Krügerl". Die
          Sprachbestellung erkennt den Artikel dann auch darunter. Der Artikelname selbst gilt immer.
        </p>

        {query.isLoading && <p className="text-sm text-ink-subtle">Wird geladen …</p>}
        {query.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Die Synonyme konnten nicht geladen werden{query.error instanceof Error ? `: ${query.error.message}` : ''}.
          </p>
        )}

        {query.data && (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => { e.preventDefault(); hinzufuegen() }}
            >
              <Input
                value={eingabe}
                onChange={(e) => { setEingabe(e.target.value); setEingabeFehler(null) }}
                placeholder="Name eingeben, z. B. Seidl (mehrere mit Komma)"
                maxLength={SYNONYM_MAX_LAENGE * 4}
                disabled={voll}
                invalid={eingabeFehler !== null}
                aria-label="Neues Synonym"
                data-testid="synonym-eingabe"
                className="flex-1"
                autoFocus
              />
              <Button type="submit" variant="secondary" disabled={voll || eingabe.trim() === ''} data-testid="synonym-hinzufuegen">
                Hinzufügen
              </Button>
            </form>
            {eingabeFehler && <p role="alert" data-testid="synonym-fehler" className="-mt-2 text-xs text-red-600">{eingabeFehler}</p>}

            {liste.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-ink-subtle">
                Noch keine Synonyme. Die Sprache erkennt nur den Artikelnamen „{artikelName}".
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2" data-testid="synonym-liste">
                {liste.map((s, i) => (
                  <li key={`${s}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-3 pr-1 text-sm text-brand-800">
                    <span>{s}</span>
                    <button
                      type="button"
                      onClick={() => { setListe(entferneSynonym(liste, i)); setEingabeFehler(null); setErgebnis(null) }}
                      aria-label={`${s} entfernen`}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-brand-700 hover:bg-brand-100"
                    >×</button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-subtle">{liste.length} von {SYNONYME_MAX_JE_ARTIKEL} Synonymen</p>
          </>
        )}

        {ergebnis && ergebnis.konflikte.length > 0 && (
          <div role="status" data-testid="synonym-konflikte" className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-semibold">Gespeichert — aber bitte beachten:</p>
            <ul className="list-disc space-y-1 pl-5">
              {ergebnis.konflikte.map(k => <li key={`${k.text}-${k.artikelId}`}>{konfliktText(k)}</li>)}
            </ul>
          </div>
        )}

        {speichern.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Speichern fehlgeschlagen{speichern.error instanceof Error ? `: ${speichern.error.message}` : ''}.
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">{ergebnis ? 'Fertig' : 'Abbrechen'}</Button>
          <Button
            onClick={speichernKlick}
            loading={speichern.isPending}
            disabled={!query.data || !geaendert}
            className="flex-1"
            data-testid="synonyme-speichern"
          >Speichern</Button>
        </div>
      </div>
    </Modal>
  )
}
