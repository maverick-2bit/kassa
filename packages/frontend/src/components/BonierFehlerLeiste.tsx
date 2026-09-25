/**
 * Rote Leiste: Ein Küchen- oder Korrekturbon hat ein Ziel NICHT erreicht.
 *
 * Bleibt stehen, bis nachgesendet oder weggeklickt — eine Bestellung, die nicht
 * in der Küche ankommt, darf nicht nach 3 Sekunden verschwinden wie die grüne
 * Bestätigung. Beim Korrekturbon genauso: Ohne ihn bereitet die Station das
 * Stornierte weiter zu.
 */

import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { BonierungInput, BonierZielFehler } from '@kassa/shared'
import { bonierFehlschlaege } from '@kassa/shared'
import { bonierApi, type TabPositionenAntwort } from '../lib/api'
import { Button } from './ui/Button'

/** Nicht erreichte Ziele samt der Bonierung zum Nachsenden. */
export interface BonierFehler {
  ziele:      BonierZielFehler[]
  nachsenden: BonierungInput
}

/**
 * Korrekturbon nach einem Storno (Position korrigiert oder Tisch verworfen): Das
 * Backend schickt ihn selbst an Küche/Schank und meldet in `stornoBon` nur, was
 * NICHT ankam. Nachsenden braucht Kasse, Tisch und Positionen, keinen offenen
 * Tab — die `tabId` trägt den Nachdruck nur in dessen Verlauf ein.
 */
export function korrekturbonFehler(antwort: TabPositionenAntwort, tabId?: string): BonierFehler | null {
  if (!antwort.stornoBon) return null
  return {
    ziele: antwort.stornoBon.fehler,
    nachsenden: {
      kasseId:    antwort.kasseId,
      ...(tabId ? { tabId } : {}),
      tisch:      antwort.tischNummer,
      kellner:    antwort.kellner,
      positionen: antwort.stornoBon.positionen,
      ohneLagerabzug: true,
      storno:     true,   // Korrekturbon, kein Bestellbon
    },
  }
}

export function BonierFehlerLeiste({ fehler, onAenderung }: {
  fehler:      BonierFehler
  /** Nach dem Nachsenden die verbliebenen Ziele; null = alles angekommen oder weggeklickt */
  onAenderung: (fehler: BonierFehler | null) => void
}) {
  const nachsenden = useMutation({
    mutationFn: (input: BonierungInput) => bonierApi.bonieren(input),
    // Erneut bewerten: klappt es jetzt, verschwindet die Leiste; klappt nur ein
    // Teil, bleibt sie mit den verbliebenen Zielen stehen.
    onSuccess: (ergebnis, input) => {
      const ziele = bonierFehlschlaege(ergebnis)
      onAenderung(ziele.length > 0 ? { ziele, nachsenden: input } : null)
    },
  })
  // Neuer Fehlschlag → die Meldung eines früheren Nachsendeversuchs gilt nicht mehr
  const { reset } = nachsenden
  useEffect(() => { reset() }, [fehler, reset])

  const korrekturbon = fehler.nachsenden.storno === true

  return (
    <div className="rounded border-2 border-red-400 bg-red-50 p-3 space-y-2">
      <p className="text-xs font-bold text-red-800">
        {korrekturbon
          ? `⚠ Korrekturbon für Tisch ${fehler.nachsenden.tisch} NICHT angekommen — bitte prüfen`
          : '⚠ Bon NICHT angekommen — bitte prüfen'}
      </p>
      <ul className="space-y-1 text-xs text-red-700">
        {fehler.ziele.map((z, i) => (
          <li key={`${z.ziel}-${i}`}>
            <span className="font-semibold">{z.ziel}</span>
            {z.istBackup && ' (Zweitdrucker)'}
            {z.ip && ` · ${z.ip}`}
            <span className="block text-red-600">{z.fehler}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-red-700">
        {korrekturbon
          ? 'Der Storno ist gebucht, die Station weiß aber noch nichts davon und bereitet sonst weiter zu. Nachsenden oder in der Küche Bescheid geben.'
          : 'Die Artikel sind am Tisch gebucht. Nachsenden oder in der Küche Bescheid geben.'}
      </p>
      {nachsenden.isError && (
        <p className="text-xs font-semibold text-red-700">
          Nachsenden fehlgeschlagen: {nachsenden.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1 text-xs"
          loading={nachsenden.isPending}
          onClick={() => nachsenden.mutate(fehler.nachsenden)}
        >
          Nochmal senden
        </Button>
        <Button
          variant="secondary"
          className="text-xs"
          onClick={() => onAenderung(null)}
        >
          Verstanden
        </Button>
      </div>
    </div>
  )
}
