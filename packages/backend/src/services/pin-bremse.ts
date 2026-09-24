/**
 * PIN-Bremse — gemeinsame Fehlversuchs-Sperre für ALLE PIN-Prüfungen:
 * PIN-Login, Stempeluhr und Freigabe-PIN (Storno/Rabatt).
 *
 * Warum: PINs haben nur 4 bzw. 6 Ziffern, und jede Prüfung vergleicht gegen die
 * PINs ALLER Benutzer des Betriebs — ein Treffer bei irgendwem genügt. Bei 20
 * Benutzern mit 4-stelliger PIN ist im Schnitt jeder 500. Versuch ein Treffer;
 * über die Stempeluhr (ohne Anmeldung, 300 Anfragen/min) war das früher in
 * Minuten geschafft.
 *
 * Die Client-IP taugt als Schlüssel nicht (Docker Desktop: alle LAN-Clients
 * haben dieselbe Gateway-Adresse). Gezählt wird deshalb in Töpfen:
 *
 *  - Fremde Geräte (ohne gültiges Geräte-Merkmal, siehe auth/geraet-vertrauen):
 *    je Kasse + gemeinsam je Mandant (fängt Angriffe über mehrere Kassen).
 *  - Vertraute Geräte (dort war schon jemand erfolgreich angemeldet): je Gerät
 *    + ein gemeinsamer Mandanten-Topf aller vertrauten Geräte. Ein Fremder ohne
 *    Merkmal kann sie also nicht aussperren.
 *  - Freigabe-PIN (die Anfrage kommt angemeldet): je anfragendem Benutzer +
 *    derselbe Mandanten-Topf wie die vertrauten Geräte.
 *
 * Regeln je Topf (Leaky Bucket mit steigender Sperre):
 *  - Jeder Fehlversuch zählt +1, alle `abbauMs` wird einer vergessen — einzelne
 *    Tippfehler über einen Abend summieren sich nicht auf.
 *  - Erreicht der Stand `frei`, wird gesperrt: 30 s, danach 1, 2, 5, 10, 15 min
 *    — jeder weitere Fehlversuch eine Stufe länger. Während einer Sperre ruht
 *    der Abbau (sonst pendelte sich ein Dauerangriff bei der Stufe ein, die dem
 *    Abbau-Intervall entspricht); auf Dauer bleibt so ein Versuch je 15 min.
 *    Der Stand ist bei der obersten Stufe gedeckelt: nach einem Angriff ist der
 *    Topf spätestens nach einer Stunde wieder im freien Bereich.
 *  - Erfolge zählen nicht und setzen NICHT zurück — sonst könnte ein
 *    Mitarbeiter den Zähler mit der eigenen PIN immer wieder leeren.
 *  - Während einer Sperre wird gar keine PIN geprüft, auch keine richtige.
 *  - Laufende Prüfungen sind vorab gebucht: ein Schwall gleichzeitiger Anfragen
 *    bekommt nicht mehr Versuche als der Stand erlaubt (bcrypt braucht je
 *    Benutzer rund 70 ms — Zeit genug für hunderte parallele Anfragen).
 *
 * Bewusst im Speicher: es läuft genau ein Backend-Prozess, und die Prüfung muss
 * vor dem ersten await gebucht sein. Ein Neustart (Update) setzt nur Zähler
 * zurück; jede ausgelöste Sperre steht im Audit-Log (`pin.gesperrt`).
 */

import type { FastifyBaseLogger, FastifyReply } from 'fastify'
import { PIN_GESPERRT_CODE } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { GeraetVertrauen } from '../auth/geraet-vertrauen.js'
import { logAudit } from './audit.service.js'

// ---------------------------------------------------------------------------
// Töpfe und Regeln
// ---------------------------------------------------------------------------

export type TopfArt =
  | 'kasse'      // fremde Geräte an einer Kasse
  | 'mandant'    // alle fremden Geräte eines Mandanten
  | 'geraet'     // ein vertrautes Gerät
  | 'benutzer'   // Freigabe-Anfragen eines angemeldeten Benutzers
  | 'vertraut'   // alle vertrauten Geräte + Freigaben eines Mandanten

export interface Topf {
  art: TopfArt
  /** Kassen-, Mandanten-, Geräte- bzw. Benutzer-ID */
  id:  string
}

interface Regel {
  /** Ab diesem Stand wird gesperrt */
  frei:    number
  /** Alle so viele ms wird ein Fehlversuch vergessen */
  abbauMs: number
}

const MINUTE = 60_000

export const PIN_BREMSE_REGELN: Readonly<Record<TopfArt, Regel>> = {
  kasse:    { frei: 8,  abbauMs: 10 * MINUTE },
  geraet:   { frei: 8,  abbauMs: 10 * MINUTE },
  benutzer: { frei: 8,  abbauMs: 10 * MINUTE },
  // Mandanten-Töpfe sammeln mehrere Kassen/Geräte — großzügiger, damit ein
  // Schichtwechsel mit ein paar Tippfehlern an jeder Kasse nichts auslöst.
  mandant:  { frei: 20, abbauMs: 5 * MINUTE },
  vertraut: { frei: 20, abbauMs: 5 * MINUTE },
}

/** Sperrdauer je Stufe: Stand = frei → Stufe 0, jeder weitere Fehlversuch +1. */
export const PIN_SPERR_STUFEN_MS: readonly number[] = [
  30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE,
]

/** Wartezeit, wenn nur eine noch laufende Prüfung im Weg ist (keine Sperre). */
const LAEUFT_NOCH_MS = 2_000

/** Ab so vielen Einträgen werden abgebaute Konten weggeräumt. */
const AUFRAEUMEN_AB = 5_000

/** Töpfe einer PIN-Eingabe am Gerät (PIN-Login, Stempeln). */
export function toepfeFuerGeraet(
  mandantId:  string,
  kasseId:    string,
  vertrauen:  GeraetVertrauen | null,
): Topf[] {
  return vertrauen
    ? [{ art: 'geraet', id: vertrauen.geraetId }, { art: 'vertraut', id: mandantId }]
    : [{ art: 'kasse', id: kasseId }, { art: 'mandant', id: mandantId }]
}

/** Töpfe einer Freigabe-PIN (angemeldete Anfrage). */
export function toepfeFuerFreigabe(mandantId: string, anfragerId: string | null): Topf[] {
  const mandantTopf: Topf = { art: 'vertraut', id: mandantId }
  return anfragerId ? [{ art: 'benutzer', id: anfragerId }, mandantTopf] : [mandantTopf]
}

// ---------------------------------------------------------------------------
// Bremse
// ---------------------------------------------------------------------------

interface Konto {
  /** Fehlversuche (nach Abbau bis `abbauAb`) */
  stand:       number
  /** Ab hier läuft der nächste Abbau-Schritt */
  abbauAb:     number
  gesperrtBis: number
  /** Vorab gebuchte, noch nicht beendete Prüfungen */
  laufend:     number
}

export interface Sperre {
  topf:         Topf
  fehlversuche: number
  dauerMs:      number
  bis:          number
}

export interface PinVersuch {
  /** PIN war richtig — zählt nicht. */
  erfolg():     void
  /** PIN war falsch — zählt; liefert die dadurch ausgelösten Sperren. */
  fehlschlag(): Sperre[]
  /** Prüfung ist unterwegs gescheitert (z. B. DB-Fehler) — zählt nicht. */
  abbrechen():  void
}

export type PinStart =
  | { ok: true;  versuch: PinVersuch }
  | { ok: false; wartenMs: number }

const schluessel = (t: Topf) => `${t.art}:${t.id}`

export class PinBremse {
  private readonly konten = new Map<string, Konto>()

  /** Uhr — in Tests austauschbar, um Abbau und Sperrablauf ohne Warten zu prüfen. */
  constructor(public jetzt: () => number = Date.now) {}

  /**
   * Bucht einen Versuch in allen Töpfen vor — synchron, also ohne Lücke für
   * parallele Anfragen. Gesperrt, sobald EIN Topf gesperrt ist.
   */
  beginne(toepfe: Topf[]): PinStart {
    const t = this.jetzt()
    if (this.konten.size > AUFRAEUMEN_AB) this.aufraeumen(t)

    let wartenMs = 0
    for (const topf of toepfe) {
      const konto = this.konten.get(schluessel(topf))
      if (!konto) continue
      this.abbauen(konto, t, PIN_BREMSE_REGELN[topf.art])
      if (konto.gesperrtBis > t) {
        wartenMs = Math.max(wartenMs, konto.gesperrtBis - t)
      } else if (konto.laufend > 0 && konto.stand + konto.laufend >= PIN_BREMSE_REGELN[topf.art].frei) {
        // Die noch laufenden Prüfungen könnten den Stand bereits an die Grenze
        // bringen — erst deren Ergebnis abwarten, sonst gäbe es Gratisversuche.
        wartenMs = Math.max(wartenMs, LAEUFT_NOCH_MS)
      }
    }
    if (wartenMs > 0) return { ok: false, wartenMs }

    const gebucht = toepfe.map(topf => {
      const k = schluessel(topf)
      let konto = this.konten.get(k)
      if (!konto) {
        konto = { stand: 0, abbauAb: t, gesperrtBis: 0, laufend: 0 }
        this.konten.set(k, konto)
      }
      konto.laufend++
      return { topf, konto }
    })

    let beendet = false
    const freigeben = () => {
      if (beendet) return false
      beendet = true
      for (const { konto } of gebucht) konto.laufend = Math.max(0, konto.laufend - 1)
      return true
    }

    return {
      ok: true,
      versuch: {
        erfolg:    () => { freigeben() },
        abbrechen: () => { freigeben() },
        fehlschlag: () => {
          if (!freigeben()) return []
          const jetzt = this.jetzt()
          const sperren: Sperre[] = []
          for (const { topf, konto } of gebucht) {
            const regel = PIN_BREMSE_REGELN[topf.art]
            this.abbauen(konto, jetzt, regel)
            if (konto.stand === 0) konto.abbauAb = jetzt
            // Gedeckelt bei der obersten Stufe — mehr Stand verlängert nichts,
            // würde aber die Erholung nach einem Angriff hinauszögern
            konto.stand = Math.min(konto.stand + 1, regel.frei + PIN_SPERR_STUFEN_MS.length - 1)
            if (konto.stand < regel.frei) continue
            const stufe = Math.min(konto.stand - regel.frei, PIN_SPERR_STUFEN_MS.length - 1)
            const dauerMs = PIN_SPERR_STUFEN_MS[stufe]!
            const bis = jetzt + dauerMs
            if (bis > konto.gesperrtBis) {
              konto.gesperrtBis = bis
              // Während der Sperre ruht der Abbau — er läuft erst danach weiter
              konto.abbauAb = Math.max(konto.abbauAb, bis)
              sperren.push({ topf, fehlversuche: konto.stand, dauerMs, bis })
            }
          }
          return sperren
        },
      },
    }
  }

  /** Aktueller Stand eines Topfs — für Tests und Diagnose. */
  stand(topf: Topf): { fehlversuche: number; gesperrtBis: number; laufend: number } {
    const konto = this.konten.get(schluessel(topf))
    if (!konto) return { fehlversuche: 0, gesperrtBis: 0, laufend: 0 }
    this.abbauen(konto, this.jetzt(), PIN_BREMSE_REGELN[topf.art])
    return { fehlversuche: konto.stand, gesperrtBis: konto.gesperrtBis, laufend: konto.laufend }
  }

  /** Alles vergessen — nur für Tests. */
  zuruecksetzen(): void {
    this.konten.clear()
  }

  private abbauen(konto: Konto, t: number, regel: Regel): void {
    if (konto.stand === 0) return
    const schritte = Math.floor((t - konto.abbauAb) / regel.abbauMs)
    if (schritte <= 0) return
    konto.stand = Math.max(0, konto.stand - schritte)
    konto.abbauAb += schritte * regel.abbauMs
  }

  private aufraeumen(t: number): void {
    for (const [k, konto] of this.konten) {
      this.abbauen(konto, t, PIN_BREMSE_REGELN[k.slice(0, k.indexOf(':')) as TopfArt])
      if (konto.stand === 0 && konto.laufend === 0 && konto.gesperrtBis <= t) this.konten.delete(k)
    }
  }
}

/** Die eine Bremse des Backends — alle PIN-Prüfungen teilen sie. */
export const pinBremse = new PinBremse()

// ---------------------------------------------------------------------------
// Prüfen unter der Bremse
// ---------------------------------------------------------------------------

/** HTTP 429: zu viele Fehlversuche — bis zum Ablauf wird keine PIN geprüft. */
export class PinGesperrtError extends Error {
  readonly httpStatus = 429
  readonly code = PIN_GESPERRT_CODE
  constructor(message: string, public readonly wartenSekunden: number) {
    super(message)
    this.name = 'PinGesperrtError'
  }
}

/** „30 Sekunden" / „2 Minuten" — die Meldung steht direkt am PIN-Feld. */
function wartezeitText(ms: number): string {
  const sekunden = Math.max(1, Math.ceil(ms / 1000))
  if (sekunden < 90) return sekunden === 1 ? '1 Sekunde' : `${sekunden} Sekunden`
  const minuten = Math.ceil(sekunden / 60)
  return `${minuten} Minuten`
}

/** Antwort für eine gesperrte PIN-Eingabe — mit Retry-After und Restzeit für den Countdown. */
export function sendePinGesperrt(reply: FastifyReply, err: PinGesperrtError): FastifyReply {
  return reply
    .status(err.httpStatus)
    .header('retry-after', String(err.wartenSekunden))
    .send({ fehler: err.message, code: err.code, wartenSekunden: err.wartenSekunden })
}

export type PinQuelle = 'pin_login' | 'stempeln' | 'freigabe'

export interface PinPruefKontext {
  quelle:     PinQuelle
  mandantId:  string
  toepfe:     Topf[]
  /** Anfang der Meldung, wenn dieser Fehlversuch die Sperre auslöst („PIN ungültig.") */
  meldungFalsch: string
  /** Fürs Audit-Log */
  kasseId?:   string | null
  userId?:    string | null
  ipAdresse?: string | null
  userAgent?: string | null
  log?:       FastifyBaseLogger
}

/**
 * Führt eine PIN-Prüfung unter der Bremse aus.
 *
 * @param pruefe vergleicht die PIN; null = PIN falsch
 * @returns das Ergebnis von `pruefe` (null = PIN falsch, noch keine Sperre)
 * @throws  PinGesperrtError, wenn gesperrt ist — oder wenn DIESER Fehlversuch
 *          die Sperre auslöst (die Oberfläche zeigt dann sofort den Countdown)
 */
export async function pruefeMitBremse<T>(
  db:      Db,
  kontext: PinPruefKontext,
  pruefe:  () => Promise<T | null>,
): Promise<T | null> {
  const start = pinBremse.beginne(kontext.toepfe)
  if (!start.ok) {
    throw new PinGesperrtError(
      `Zu viele falsche PIN-Eingaben — bitte in ${wartezeitText(start.wartenMs)} erneut versuchen.`,
      Math.ceil(start.wartenMs / 1000),
    )
  }

  let ergebnis: T | null
  try {
    ergebnis = await pruefe()
  } catch (err) {
    start.versuch.abbrechen()
    throw err
  }
  if (ergebnis !== null) {
    start.versuch.erfolg()
    return ergebnis
  }

  const sperren = start.versuch.fehlschlag()
  if (sperren.length === 0) return null

  for (const s of sperren) {
    kontext.log?.warn({
      quelle: kontext.quelle, bereich: s.topf.art, fehlversuche: s.fehlversuche,
      sperreSekunden: s.dauerMs / 1000,
    }, 'PIN-Eingabe nach Fehlversuchen gesperrt')
    await logAudit(db, {
      mandantId: kontext.mandantId,
      userId:    kontext.userId ?? null,
      aktion:    'pin.gesperrt',
      details:   {
        quelle:         kontext.quelle,
        bereich:        s.topf.art,
        ...(kontext.kasseId ? { kasseId: kontext.kasseId } : {}),
        ...(s.topf.art === 'geraet' ? { geraetId: s.topf.id } : {}),
        fehlversuche:   s.fehlversuche,
        sperreSekunden: s.dauerMs / 1000,
        gesperrtBis:    new Date(s.bis).toISOString(),
      },
      ipAdresse: kontext.ipAdresse ?? null,
      userAgent: kontext.userAgent ?? null,
    }, kontext.log)
  }

  const wartenMs = Math.max(...sperren.map(s => s.bis)) - pinBremse.jetzt()
  throw new PinGesperrtError(
    `${kontext.meldungFalsch} Zu viele Fehlversuche — bitte in ${wartezeitText(wartenMs)} erneut versuchen.`,
    Math.ceil(wartenMs / 1000),
  )
}
