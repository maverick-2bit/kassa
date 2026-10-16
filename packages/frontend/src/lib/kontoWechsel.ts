/**
 * kontoWechsel.ts — dieses Gerät auf einen anderen Mandanten umschalten (die Logik dazu: lib/konten.ts).
 *
 * Hat der andere Mandant eine noch gültige, zur Seite gelegte Sitzung (nur Konten mit Einstellungs-Recht, solange
 * man angemeldet bleibt), wird sie aktiv — ein Klick, keine Anmeldung. Sonst endet die aktuelle Sitzung (sie bleibt
 * zur Seite gelegt), das Gerät stellt sich auf die Kasse des anderen Mandanten und zeigt die Anmeldeseite: PIN-Pad
 * bzw. E-Mail und Passwort DIESES Mandanten.
 *
 * Danach wird die Seite neu geladen — die Seiten lesen Token und Kasse nicht-reaktiv, und nichts aus dem einen
 * Betrieb darf in der Oberfläche des anderen stehen bleiben.
 */

import type { LoginResponse } from '@kassa/shared'
import { aktiveSitzung, aktiviereSitzung, getAuth, hasBerechtigung, setGeraetToken, verlasseSitzung } from './auth'
import { getKasseIdentity, setKasseIdentity } from './kasse'
import { entferneKonto, kasseFuerAnmeldung, ladeKonten, nimmAuf, speichereKonten, wechsle } from './konten'
import { leseStartseitePfad } from './startseite'

/**
 * Das gerade angemeldete Konto in die Liste aufnehmen — für Geräte, die schon vor dem Merken angemeldet waren.
 * Läuft beim Start der App; ändert nichts, wenn das Konto schon richtig dasteht.
 */
export function sichereAktivesKonto(): void {
  const aktiv = aktiveSitzung()
  if (!aktiv) return
  const konten = ladeKonten()
  const neu = nimmAuf(konten, aktiv.sitzung, aktiv.kasseId)
  // Zur Seite gelegte Sitzungen anderer Konten bleiben unberührt (nimmAuf ändert nur das aktive Konto)
  if (JSON.stringify(neu) !== JSON.stringify(konten)) speichereKonten(neu)
}

/** Nach der Anmeldung die Kasse dieses Geräts sichern: die gewählte, wenn der Benutzer sie hat — sonst die zuletzt benutzte dieses Mandanten, sonst die erste. */
export function sichereKasseNachAnmeldung(login: LoginResponse): void {
  const aktuelle = getKasseIdentity()
  if (aktuelle && login.kassen.some(k => k.id === aktuelle.kasseId)) return
  const konto  = ladeKonten().find(k => k.mandantId === login.mandant.id)
  const kasse  = (konto ? kasseFuerAnmeldung(konto) : null) ?? login.kassen[0]
  if (kasse) setKasseIdentity({ mandantId: login.mandant.id, kasseId: kasse.id })
}

/** Auf einen anderen Mandanten dieses Geräts wechseln (nur mit Einstellungs-Recht). Lädt die Seite neu. */
export function wechsleKonto(mandantId: string): void {
  const aktiv = aktiveSitzung()
  if (!aktiv || !hasBerechtigung('einstellungen')) return
  const { konten, ziel } = wechsle(ladeKonten(), aktiv, mandantId, Date.now())
  if (!ziel) return
  speichereKonten(konten)

  if (ziel.art === 'sitzung') {
    aktiviereSitzung(ziel.sitzung)
    setGeraetToken(ziel.geraetToken)
    const kasseId = ziel.kasseId ?? ziel.sitzung.kassen[0]?.id ?? null
    if (kasseId) setKasseIdentity({ mandantId, kasseId })
    // Mit dem neuen Token: die Startseite der Kasse dort (Einstellung je Kasse)
    void (kasseId ? leseStartseitePfad(kasseId) : Promise.resolve('/')).then(pfad => window.location.assign(pfad))
    return
  }

  // Keine gültige Sitzung: Anmeldung am Ziel — die aktuelle Sitzung liegt zur Seite, das Gerät zeigt dessen PIN-Pad
  verlasseSitzung()
  setGeraetToken(ziel.konto.geraetToken)
  const kasse = kasseFuerAnmeldung(ziel.konto)
  if (kasse) setKasseIdentity({ mandantId, kasseId: kasse.id })
  window.location.assign('/login')
}

/** Einen weiteren Mandanten anmelden, ohne die aktuelle Sitzung zu beenden (sie wird dabei zur Seite gelegt). */
export function meldeWeiterenMandantenAn(): void {
  window.location.assign('/login?konto=neu')
}

/** Einen Mandanten aus der Merkliste dieses Geräts entfernen (nicht den aktiven). */
export function entferneKontoVonGeraet(mandantId: string): void {
  if (getAuth()?.mandant.id === mandantId) return
  speichereKonten(entferneKonto(ladeKonten(), mandantId))
}

/**
 * Anmeldeseite: das PIN-Pad auf einen anderen Mandanten dieses Geräts umstellen — Kasse und Geräte-Merkmal des Kontos.
 * Liefert false, wenn das Konto keine Kasse kennt (dann gibt es dort kein PIN-Pad).
 */
export function waehleKontoFuerAnmeldung(mandantId: string): boolean {
  const konto = ladeKonten().find(k => k.mandantId === mandantId)
  const kasse = konto ? kasseFuerAnmeldung(konto) : null
  if (!konto || !kasse) return false
  setGeraetToken(konto.geraetToken)
  setKasseIdentity({ mandantId, kasseId: kasse.id })
  return true
}
