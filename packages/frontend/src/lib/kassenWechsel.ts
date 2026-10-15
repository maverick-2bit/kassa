/**
 * kassenWechsel.ts — dieses Gerät auf eine andere Kasse umschalten.
 *
 * Welche Kasse ein Browser/PC bedient, steht als „Kassen-Identität" im LocalStorage (lib/kasse.ts). Der
 * Wechsel setzt sie neu und lädt die Seite neu — die Seiten lesen die Kasse nicht-reaktiv beim Aufbau.
 * Genutzt vom Schnellumschalter in der Kopfleiste und vom „Wechseln"-Knopf in den Einstellungen.
 */

import { addKasse, getAuth } from './auth'
import { setKasseIdentity } from './kasse'

/**
 * Kassier-Ansichten (Kasse, offener Tisch): hier ginge beim Umschalten ein offener Warenkorb bzw.
 * eine laufende Eingabe verloren — der Schnellumschalter fragt dort vorher nach. Auch das Layout
 * (Bildschirm-Aufteilung) kennt diese Ansichten.
 */
export const KASSEN_ANSICHT = /^\/(kasse|tische\/[^/]+)\/?$/

export interface WechselKasse {
  id:          string
  kassenId:    string
  bezeichnung: string | null
  umgebung?:   string
}

/** Anzeigename einer Kasse: die Bezeichnung, sonst die Kassen-ID. */
export const kasseName = (k: { bezeichnung: string | null; kassenId: string }): string => k.bezeichnung || k.kassenId

/**
 * Die Kassen, zwischen denen dieses Gerät umschalten darf. Wer Einstellungen ändern darf, sieht alle
 * Kassen in Betrieb (frisch vom Server — auch solche, die nach der Anmeldung angelegt wurden); alle
 * anderen nur die ihnen zugeordneten Kassen aus der Anmeldung. Solange die Serverliste noch lädt,
 * gilt die Liste aus der Anmeldung.
 */
export function umschaltKassen(opts: {
  alleErlaubt: boolean
  serverListe: readonly (WechselKasse & { status?: string })[] | undefined
  authKassen:  readonly WechselKasse[]
}): WechselKasse[] {
  if (opts.alleErlaubt && opts.serverListe) {
    return opts.serverListe.filter(k => k.status === undefined || k.status === 'aktiv')
  }
  return [...opts.authKassen]
}

/**
 * Wohin geht es nach dem Wechsel? Ein einzelner offener Tisch gehört zur bisherigen Kasse — zur neuen
 * führt die Tischübersicht. Alles andere bleibt auf derselben Seite.
 */
export function zielNachWechsel(pfad: string, suche = '', hash = ''): string {
  if (/^\/tische\/[^/]+\/?$/.test(pfad)) return '/tische'
  return `${pfad}${suche}${hash}`
}

/** Schaltet dieses Gerät auf die Kasse um und lädt die Seite neu. */
export function wechsleKasse(k: WechselKasse): void {
  const auth = getAuth()
  if (!auth) return
  // Nach der Anmeldung angelegte Kassen stehen noch nicht in der gespeicherten Liste
  addKasse({ id: k.id, kassenId: k.kassenId, bezeichnung: k.bezeichnung, umgebung: k.umgebung ?? 'test' })
  setKasseIdentity({ mandantId: auth.mandant.id, kasseId: k.id })
  const { pathname, search, hash } = window.location
  const ziel = zielNachWechsel(pathname, search, hash)
  if (ziel === `${pathname}${search}${hash}`) window.location.reload()
  else window.location.assign(ziel)
}
