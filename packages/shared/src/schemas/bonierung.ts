/**
 * Bonierung = Bestellaufnahme.
 * Wird VOR der Rechnungserstellung an das KDS gesendet (Küche/Schank/...).
 * Erzeugt KEINEN RKSV-Beleg, sondern Bonierbons im Asello-Klartextformat.
 */

import { z } from 'zod'
import { StationSchema, STATION_LABELS } from './station.js'

export const BonierungPositionSchema = z.object({
  artikelId: z.string().uuid(),
  menge:     z.number().int().positive(),
  details:   z.string().trim().max(120).optional(),
  /** Gang-Nummer (Coursing) — nur zur Sortierung/Gruppierung auf dem Bon */
  gang:      z.number().int().min(0).max(9).optional(),
})

export const BonierungInputSchema = z.object({
  kasseId: z.string().uuid(),
  /** Optionaler Verweis auf den Tisch-Tab — wenn gesetzt, wird das Ereignis im Verlauf protokolliert */
  tabId:   z.string().uuid().optional(),
  /** Tischbezeichnung. Optional: leer = Direktverkauf an der Schank (Bon-Label „Direkt"). */
  tisch:   z.string().trim().max(40).optional(),
  bereich: z.string().trim().max(60).optional(),
  kellner: z.string().trim().min(1).max(60),
  positionen: z.array(BonierungPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  /**
   * Nur drucken (KDS + Bonierdrucker), KEIN Lagerabzug. Für Tisch-Bonierungen
   * (Parken/Sofort-Kassieren) — dort zieht aktualisiereStockDeltas den Lagerstand
   * bereits ab; ohne dieses Flag käme es zum Doppel-Abzug.
   */
  ohneLagerabzug: z.boolean().optional(),
  /**
   * Korrekturbon statt Bestellbon: invertierter „*** STORNO *** / NICHT
   * ZUBEREITEN"-Kopf. Wird gebraucht, um einen nicht zugestellten Storno-Bon
   * gezielt nachzusenden.
   */
  storno:         z.boolean().optional(),
  /**
   * Eindeutige ID dieser Bestellung (vom Gerät erzeugt, bei „Nochmal senden“ unverändert
   * wieder mitgeschickt). Der Server merkt sich pro ID, was schon zugestellt ist: ein
   * zweiter Aufruf mit derselben ID legt NICHT noch einmal einen KDS-Bon an, bucht den
   * Lagerstand nicht ein zweites Mal ab und sendet nur an die Ziele, die vorher scheiterten.
   * Fehlt sie, verhält sich die Bonierung wie bisher (jeder Aufruf ist eine neue Bestellung).
   */
  bestellId:      z.string().uuid().optional(),
})
export type BonierungInput = z.infer<typeof BonierungInputSchema>

export const BonierungErgebnisSchema = z.object({
  bonNummer:    z.string(),
  stationen: z.array(z.object({
    station:     StationSchema,
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
  })),
  /** Ergebnisse für ESC/POS Bonierdrucker (inkl. Zweitdrucker; bei einer Umleitung auf den Backup-Drucker steht der Hinweis in `fehler`) */
  drucker: z.array(z.object({
    druckerId:   z.string().uuid(),
    name:        z.string(),
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
    istBackup:   z.boolean(),
    /**
     * Nur bei einer Umleitung (`erfolgreich` bleibt true): der Bon liegt NICHT am vorgesehenen Drucker.
     * `von` = vorgesehener Drucker (nicht erreichbar), `an` = Drucker, der ihn bekommen hat — dessen
     * Backup-Drucker bzw. der feste Fallback-Drucker. `ip` ist dann die des Ersatzes, `name` lautet „von → an“.
     */
    umleitung:   z.object({ von: z.string(), an: z.string() }).optional(),
  })).default([]),
})
export type BonierungErgebnis = z.infer<typeof BonierungErgebnisSchema>

/** Ein Ziel (KDS-Station oder Bonierdrucker), das den Bon NICHT bekommen hat. */
export interface BonierZielFehler {
  /** Anzeigename: Stations-Label bzw. Druckername */
  ziel:      string
  ip:        string
  fehler:    string
  /** Zweitdrucker (bekommt eine Kopie aller Positionen) statt Hauptziel */
  istBackup: boolean
}

/**
 * Ziele, die den Bonierbon nicht erhalten haben.
 *
 * Einzige Quelle für die Frage „ist der Küchenbon angekommen?" — Backend
 * (HTTP-Status), Kassen-Oberfläche und Kellner-App bewerten damit dasselbe.
 * Vorher prüfte der Server nur die KDS-Stationen: ein toter Bonierdrucker,
 * also der Drucker in der Küche, lieferte glatte 200.
 *
 * Zweitdrucker bekommen eine Kopie ALLER Positionen (nicht erst, wenn der
 * Hauptdrucker ausfällt) — ein stummer Zweitdrucker ist deshalb ebenfalls ein
 * echter Fehlschlag, nur ein weniger dringender. `istBackup` macht das für die
 * Anzeige unterscheidbar.
 */
export function bonierFehlschlaege(ergebnis: BonierungErgebnis): BonierZielFehler[] {
  const fehlend: BonierZielFehler[] = []

  for (const s of ergebnis.stationen) {
    if (s.erfolgreich) continue
    fehlend.push({
      ziel:      STATION_LABELS[s.station] ?? s.station,
      ip:        s.ip,
      fehler:    s.fehler ?? 'unbekannter Fehler',
      istBackup: false,
    })
  }

  for (const d of ergebnis.drucker) {
    if (d.erfolgreich) continue
    fehlend.push({
      ziel:      d.name,
      ip:        d.ip,
      fehler:    d.fehler ?? 'unbekannter Fehler',
      istBackup: d.istBackup,
    })
  }

  return fehlend
}

/** Ein Bon, der zugestellt wurde — aber an einem anderen Drucker als vorgesehen. */
export interface BonierUmleitung {
  /** Vorgesehener Bonierdrucker, der nicht erreichbar war */
  von:     string
  /** Drucker, an dem der Bon jetzt liegt (Backup-Drucker bzw. fester Fallback-Drucker) */
  an:      string
  /** IP des Druckers, an dem der Bon liegt */
  ip:      string
  /** Fertiger Satz für das Personal, z. B. „Küchendrucker nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.“ */
  hinweis: string
}

/**
 * Bons, die zwar ankamen, aber NICHT am vorgesehenen Bonierdrucker: dessen Backup-Drucker
 * bzw. der feste Fallback-Drucker ist eingesprungen. Das Gegenstück zu `bonierFehlschlaege`
 * für den Fall „zugestellt, aber woanders" — der Bon liegt am falschen Gerät, und ohne
 * Hinweis holt ihn in der Küche niemand ab.
 *
 * Zählt nur Hauptdrucker, die den Bon bekommen haben. Fehlschläge (`erfolgreich: false`)
 * gehören zu `bonierFehlschlaege`; der Zweitdrucker (`istBackup`) bekommt immer eine Kopie
 * und wird nie ersetzt — seine Kopie ist keine Umleitung.
 */
export function bonierUmleitungen(ergebnis: BonierungErgebnis): BonierUmleitung[] {
  const umleitungen: BonierUmleitung[] = []

  for (const d of ergebnis.drucker) {
    if (!d.erfolgreich || d.istBackup || !d.umleitung) continue
    umleitungen.push({
      von:     d.umleitung.von,
      an:      d.umleitung.an,
      ip:      d.ip,
      hinweis: `${d.umleitung.von} nicht erreichbar — Bon kam an ${d.umleitung.an}. Bitte weitergeben.`,
    })
  }

  return umleitungen
}

/**
 * Rückmeldung zu einem Bon, den ein Tisch-Vorgang SELBST an Küche/Schank geschickt hat: Gang abrufen und
 * eine Position nachschicken. Dort löst der Kellner keine Bonierung aus (die Oberfläche sieht das
 * Bonierergebnis nie), der Server boniert für ihn — ohne diese Rückmeldung bliebe sowohl ein ganz
 * gescheiterter Abruf als auch ein Bon am Backup-Drucker stumm.
 *
 * Die Antwort des Vorgangs trägt sie nur, wenn es etwas zu melden gibt (wie `stornoBon` beim Storno):
 * `fehler` → rote Leiste „Bon NICHT angekommen“, `umleitungen` → bernsteinfarbener Hinweis.
 */
export interface BonRueckmeldung {
  /** Ziele, die den Bon NICHT bekommen haben */
  fehler:      BonierZielFehler[]
  /** Bons, die ankamen, aber am Backup-Drucker statt am vorgesehenen Drucker liegen */
  umleitungen: BonierUmleitung[]
  /**
   * Die Bonierung, wie sie an POST /api/bestellung/bonieren geht — für „Nochmal senden“. Sie trägt die Bestell-ID
   * des ersten Versuchs: der Server bedient dann nur noch die Ziele, die den Bon nicht haben (kein zweiter
   * KDS-Bon, kein zweiter Ausdruck dort, wo er schon liegt, kein Lagerabzug).
   */
  nachsenden:  BonierungInput
}

/**
 * Wertet das Bonierergebnis eines Tisch-Vorgangs aus: `null`, wenn der Bon überall am vorgesehenen Gerät
 * ankam (bzw. es nichts zu bonieren gab) — dann steht nichts in der Antwort, und ältere Oberflächen
 * bemerken keinen Unterschied.
 */
export function bonRueckmeldung(ergebnis: BonierungErgebnis | null, nachsenden: BonierungInput): BonRueckmeldung | null {
  if (!ergebnis) return null
  const fehler      = bonierFehlschlaege(ergebnis)
  const umleitungen = bonierUmleitungen(ergebnis)
  return fehler.length === 0 && umleitungen.length === 0 ? null : { fehler, umleitungen, nachsenden }
}

/**
 * Stand eines Bonierergebnisses als Meldung für das Personal: `null`, wenn der Bon überall am vorgesehenen
 * Gerät ankam. Der Teil von `bonRueckmeldung`, der ohne „Nochmal senden“-Bonierung auskommt — die
 * serverseitig ausgelösten Bons (Direktverkauf-Beleg, Gast-, SB-Bestellung) merkt sich der Server selbst
 * (Tabelle `bon_probleme`), die Oberfläche schickt nichts zurück.
 */
export function bonStand(ergebnis: BonierungErgebnis): { fehler: BonierZielFehler[]; umleitungen: BonierUmleitung[] } | null {
  const fehler      = bonierFehlschlaege(ergebnis)
  const umleitungen = bonierUmleitungen(ergebnis)
  return fehler.length === 0 && umleitungen.length === 0 ? null : { fehler, umleitungen }
}

/** Wo der Server selbst geboniert hat, ohne dass jemand an der Kasse darauf wartet. */
export const BonProblemQuelleSchema = z.enum(['direktverkauf', 'gast', 'sb'])
export type BonProblemQuelle = z.infer<typeof BonProblemQuelleSchema>

/**
 * Überschrift einer Meldung: woher der Bon stammt. Für den Gast- und SB-Fall steht die Tischbezeichnung bzw.
 * die Bestellnummer dabei — das Personal muss wissen, WELCHE Bestellung in der Küche fehlt.
 */
export function bonProblemTitel(quelle: BonProblemQuelle, tisch: string): string {
  switch (quelle) {
    case 'direktverkauf': return 'Direktverkauf'
    case 'gast':          return `Gast-Bestellung · Tisch ${tisch}`
    case 'sb':            return `SB-Bestellung · ${tisch}`
  }
}

/**
 * Eine offene Meldung zu einem Bon, den der Server selbst ausgelöst hat (Direktverkauf-Beleg mit Küchenartikeln,
 * Gast-Bestellung, SB-Terminal). Dort wartet niemand auf die Antwort der Bonierung, und der Gast hat schon
 * bezahlt — ohne diese Liste bliebe ein toter Küchendrucker bzw. ein Bon am Backup-Drucker stumm.
 *
 * Bleibt offen, bis „Verstanden“ gedrückt wird oder „Nochmal senden“ alles zugestellt hat. Kommt der Bon bei
 * „Nochmal senden“ nur über den Backup-Drucker an, wandelt sich die rote Meldung in den bernsteinfarbenen Hinweis.
 */
export interface BonProblem {
  id:          string
  quelle:      BonProblemQuelle
  /** Tisch bzw. SB-Nummer, soweit die Bestellung eine hat („Direkt“ beim Direktverkauf) */
  tisch:       string
  titel:       string
  /** Ziele, die den Bon NICHT bekommen haben (leer = nur ein Hinweis auf Umleitung) */
  fehler:      BonierZielFehler[]
  /** Bons, die am Backup-Drucker statt am vorgesehenen Drucker liegen */
  umleitungen: BonierUmleitung[]
  /** ISO-Zeitpunkt */
  erstelltAt:  string
}

/**
 * Fügt neue Umleitungen zu den schon angezeigten hinzu, ohne etwas doppelt aufzuführen.
 *
 * Der Hinweis bleibt stehen, bis das Personal „Verstanden“ drückt: Ein späterer Bon, der wieder
 * normal ankam, darf ihn nicht wegnehmen — der frühere liegt ja weiter am falschen Drucker.
 */
export function vereinigeUmleitungen(vorhanden: BonierUmleitung[], neu: BonierUmleitung[]): BonierUmleitung[] {
  const zusaetzlich = neu.filter((u, i) =>
    !vorhanden.some(v => v.hinweis === u.hinweis) && neu.findIndex(x => x.hinweis === u.hinweis) === i)
  return zusaetzlich.length === 0 ? vorhanden : [...vorhanden, ...zusaetzlich]
}
