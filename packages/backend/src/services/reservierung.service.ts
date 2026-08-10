import { and, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, mandanten, reservierungen, tischplanBereiche, tischplanElemente } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import type {
  ReservierungInput,
  ReservierungResponse,
  ReservierungStatus,
  ReservierungUpdate,
  OnlineBuchungInfo,
} from '@kassa/shared'

/** Fehler mit HTTP-Status — die Route mappt ihn direkt durch. */
export class ReservierungError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message)
    this.name = 'ReservierungError'
  }
}

// ---------------------------------------------------------------------------
// Kollisionsprüfung: derselbe Tisch darf sich zeitlich nicht überschneiden
// ---------------------------------------------------------------------------

/** "HH:MM" → Minuten seit Mitternacht */
function minuten(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** Stati, die einen Tisch NICHT blockieren (abgesagt bzw. Gast kam nie) */
const FREIGEBENDE_STATI = ['storniert', 'nicht_erschienen'] as const

/**
 * Umrüstzeit des Mandanten: Minuten fürs Neueindecken, die ein Tisch nach dem
 * Ende einer Reservierung zusätzlich blockiert bleibt. 0 = aus.
 */
async function holeUmruestMinuten(db: Db, mandantId: string): Promise<number> {
  const [m] = await db
    .select({ minuten: mandanten.umruestMinuten })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)
  return m?.minuten ?? 0
}

/**
 * Überschneiden sich zwei Belegungen?
 *
 * Die Umrüstzeit hängt an BEIDEN Reservierungen, nicht nur an der bestehenden:
 * gebucht wird [von, von+dauer), belegt ist [von, von+dauer+umruest). Damit muss
 * zwischen zwei Reservierungen am selben Tisch mindestens die Umrüstzeit liegen
 * — egal, welche zuerst angelegt wurde. Der Gast sieht weiterhin nur seine
 * eigene Zeit; die Umrüstzeit ist reine Betriebsplanung.
 */
function ueberschneidet(
  aStart: number, aDauer: number,
  bStart: number, bDauer: number,
  umruest: number,
): boolean {
  return aStart < bStart + bDauer + umruest && bStart < aStart + aDauer + umruest
}

/**
 * Wirft 409, wenn der Tisch im gewünschten Zeitraum schon belegt ist.
 * `ausserId` schließt die eigene Reservierung beim Bearbeiten aus.
 */
export async function pruefeTischFrei(
  db:        Db,
  mandantId: string,
  tischId:   string,
  datum:     string,
  zeitVon:   string,
  dauer:     number,
  ausserId?: string,
): Promise<void> {
  const bedingungen = [
    eq(reservierungen.mandantId, mandantId),
    eq(reservierungen.tischId, tischId),
    eq(reservierungen.datum, datum),
  ]
  if (ausserId) bedingungen.push(ne(reservierungen.id, ausserId))

  const belegungen = await db
    .select({
      id:      reservierungen.id,
      zeitVon: reservierungen.zeitVon,
      dauer:   reservierungen.dauer,
      name:    reservierungen.name,
      status:  reservierungen.status,
    })
    .from(reservierungen)
    .where(and(...bedingungen))

  const umruest = await holeUmruestMinuten(db, mandantId)
  const start   = minuten(zeitVon)

  for (const b of belegungen) {
    if ((FREIGEBENDE_STATI as readonly string[]).includes(b.status)) continue
    const bStart = minuten(b.zeitVon)
    if (ueberschneidet(start, dauer, bStart, b.dauer, umruest)) {
      const bEnde = bStart + b.dauer
      // Die gebuchte Zeit nennen, die Umrüstzeit separat — sonst wundert sich
      // der Kellner, warum 19:30 belegt ist, obwohl die Reservierung 19:00 endet.
      const zusatz = umruest > 0 ? ` + ${umruest} Min. Umrüstzeit` : ''
      throw new ReservierungError(
        409,
        `Tisch ist zu dieser Zeit bereits reserviert (${b.zeitVon}–${hhmm(bEnde)}${zusatz}, ${b.name}).`,
      )
    }
  }
}

/** Minuten seit Mitternacht → "HH:MM" */
function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Tisch gehört zum Mandanten? Liefert Bezeichnung + Online-Freigabe. */
async function ladeTisch(db: Db, mandantId: string, tischId: string) {
  const [t] = await db
    .select({
      id:                 tischplanElemente.id,
      bezeichnung:        tischplanElemente.bezeichnung,
      onlineReservierbar: tischplanElemente.onlineReservierbar,
      plaetze:            tischplanElemente.plaetze,
    })
    .from(tischplanElemente)
    .where(and(eq(tischplanElemente.id, tischId), eq(tischplanElemente.mandantId, mandantId)))
    .limit(1)
  if (!t) throw new ReservierungError(404, 'Tisch nicht gefunden')
  return t
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function erstelleReservierung(
  db:        Db,
  mandantId: string,
  input:     ReservierungInput,
  quelle:    'intern' | 'online' = 'intern',
): Promise<ReservierungResponse> {
  const [kasse] = await db
    .select({ id: kassen.id, mandantId: kassen.mandantId })
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new ReservierungError(404, 'Kasse nicht gefunden')

  const dauer = input.dauer ?? 90

  // Echte Tischbindung: Tisch validieren, Online-Freigabe und Doppelbelegung prüfen
  let tischBezeichnung: string | null = null
  if (input.tischId) {
    const tisch = await ladeTisch(db, mandantId, input.tischId)
    if (quelle === 'online' && !tisch.onlineReservierbar) {
      throw new ReservierungError(409, 'Dieser Tisch ist nicht für Online-Reservierungen freigegeben.')
    }
    await pruefeTischFrei(db, mandantId, input.tischId, input.datum, input.zeitVon, dauer)
    tischBezeichnung = tisch.bezeichnung
  }

  const status = quelle === 'online' ? 'wartend' : 'bestaetigt'

  const [row] = await db
    .insert(reservierungen)
    .values({
      mandantId,
      kasseId:        input.kasseId,
      datum:          input.datum,
      zeitVon:        input.zeitVon,
      dauer,
      personenAnzahl: input.personenAnzahl,
      name:           input.name,
      status,
      quelle,
      ...(input.telefon   && { telefon:   input.telefon   }),
      ...(input.email     && { email:     input.email     }),
      ...(input.notiz     && { notiz:     input.notiz     }),
      ...(input.tischId   && { tischId:   input.tischId }),
      // Label mitschreiben: bleibt lesbar, auch wenn der Tisch später entfällt
      ...((input.tischLabel ?? tischBezeichnung) && { tischLabel: input.tischLabel ?? tischBezeichnung }),
    })
    .returning()

  if (!row) throw new ReservierungError(500, 'Reservierung konnte nicht gespeichert werden')

  if (quelle === 'online') {
    emitKasseEvent(mandantId, {
      typ:          'neue_reservierung',
      reservierungId: row.id,
      kasseId:      input.kasseId,
      datum:        input.datum,
      zeitVon:      input.zeitVon,
      name:         input.name,
    })
  }

  return toDto(row)
}

export async function listeReservierungen(
  db:        Db,
  mandantId: string,
  opts: {
    kasseId?: string
    datumVon?: string
    datumBis?: string
    limit?: number
  } = {},
): Promise<ReservierungResponse[]> {
  const conditions = [eq(reservierungen.mandantId, mandantId)]

  if (opts.kasseId) conditions.push(eq(reservierungen.kasseId, opts.kasseId))
  if (opts.datumVon) conditions.push(gte(reservierungen.datum, opts.datumVon))
  if (opts.datumBis) conditions.push(lte(reservierungen.datum, opts.datumBis))

  const rows = await db
    .select()
    .from(reservierungen)
    .where(and(...conditions))
    .orderBy(reservierungen.datum, reservierungen.zeitVon)
    .limit(opts.limit ?? 500)

  return rows.map(toDto)
}

export async function aktualisiereReservierung(
  db:        Db,
  id:        string,
  mandantId: string,
  input:     ReservierungUpdate,
): Promise<ReservierungResponse> {
  // Für die Kollisionsprüfung den Ist-Zustand kennen — geänderte Felder
  // überschreiben ihn, unveränderte bleiben maßgeblich.
  const [vorher] = await db
    .select()
    .from(reservierungen)
    .where(and(eq(reservierungen.id, id), eq(reservierungen.mandantId, mandantId)))
    .limit(1)
  if (!vorher) throw new ReservierungError(404, 'Reservierung nicht gefunden')

  const zielTischId = input.tischId !== undefined ? input.tischId : vorher.tischId
  let tischBezeichnung: string | null = null
  if (zielTischId) {
    const tisch = await ladeTisch(db, mandantId, zielTischId)
    tischBezeichnung = tisch.bezeichnung
    const zielDatum   = input.datum   ?? vorher.datum
    const zielZeitVon = input.zeitVon ?? vorher.zeitVon
    const zielDauer   = input.dauer   ?? vorher.dauer
    const zielStatus  = input.status  ?? vorher.status
    // Storniert/nicht erschienen belegt keinen Tisch → keine Prüfung nötig
    if (!(FREIGEBENDE_STATI as readonly string[]).includes(zielStatus)) {
      await pruefeTischFrei(db, mandantId, zielTischId, zielDatum, zielZeitVon, zielDauer, id)
    }
  }

  const [row] = await db
    .update(reservierungen)
    .set({
      ...( input.datum          !== undefined && { datum:          input.datum          }),
      ...( input.zeitVon        !== undefined && { zeitVon:        input.zeitVon        }),
      ...( input.dauer          !== undefined && { dauer:          input.dauer          }),
      ...( input.personenAnzahl !== undefined && { personenAnzahl: input.personenAnzahl }),
      ...( input.name           !== undefined && { name:           input.name           }),
      ...( input.telefon        !== undefined && { telefon:        input.telefon        }),
      ...( input.email          !== undefined && { email:          input.email          }),
      ...( input.notiz          !== undefined && { notiz:          input.notiz          }),
      ...( input.tischLabel     !== undefined && { tischLabel:     input.tischLabel     }),
      ...( input.tischId        !== undefined && { tischId:        input.tischId,
                                                   ...(tischBezeichnung ? { tischLabel: tischBezeichnung } : {}) }),
      ...( input.status         !== undefined && { status:         input.status         }),
      updatedAt: new Date(),
    })
    .where(and(eq(reservierungen.id, id), eq(reservierungen.mandantId, mandantId)))
    .returning()

  if (!row) throw new Error('Reservierung nicht gefunden')
  return toDto(row)
}

export async function loescheReservierung(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<void> {
  const result = await db
    .delete(reservierungen)
    .where(and(eq(reservierungen.id, id), eq(reservierungen.mandantId, mandantId)))
    .returning({ id: reservierungen.id })

  if (result.length === 0) throw new Error('Reservierung nicht gefunden')
}

// ---------------------------------------------------------------------------
// Öffentliche Buchung (kein JWT)
// ---------------------------------------------------------------------------

export async function ladeOnlineBuchungInfo(
  db:      Db,
  kasseId: string,
): Promise<OnlineBuchungInfo> {
  const [row] = await db
    .select({
      kasseId:           kassen.id,
      mandantId:         kassen.mandantId,
      onlineBuchungAktiv: kassen.onlineBuchungAktiv,
    })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)

  if (!row) throw new Error('Kasse nicht gefunden')

  const [mandant] = await db
    .select({ firmenname: mandanten.firmenname, modulReservierungenAktiv: mandanten.modulReservierungenAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, row.mandantId))
    .limit(1)

  const aktiv = !!(mandant?.modulReservierungenAktiv && row.onlineBuchungAktiv)

  return {
    kasseId:    row.kasseId,
    firmenname: mandant?.firmenname ?? '',
    aktiv,
  }
}

export async function erstelleOnlineReservierung(
  db:      Db,
  kasseId: string,
  input:   Omit<ReservierungInput, 'kasseId'>,
): Promise<ReservierungResponse> {
  const [kasse] = await db
    .select({ mandantId: kassen.mandantId, onlineBuchungAktiv: kassen.onlineBuchungAktiv })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)

  if (!kasse) throw new Error('Kasse nicht gefunden')
  if (!kasse.onlineBuchungAktiv) throw new Error('Online-Buchung nicht aktiviert')

  const [mandant] = await db
    .select({ modulReservierungenAktiv: mandanten.modulReservierungenAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, kasse.mandantId))
    .limit(1)

  if (!mandant?.modulReservierungenAktiv) throw new Error('Reservierungs-Modul nicht aktiviert')

  return erstelleReservierung(db, kasse.mandantId, { ...input, kasseId }, 'online')
}

// ---------------------------------------------------------------------------
// Stornierung via Online-Token
// ---------------------------------------------------------------------------

export async function storniereViaToken(
  db:          Db,
  kasseId:     string,
  onlineToken: string,
): Promise<void> {
  const [row] = await db
    .select({ id: reservierungen.id, mandantId: reservierungen.mandantId, status: reservierungen.status })
    .from(reservierungen)
    .where(and(eq(reservierungen.kasseId, kasseId), eq(reservierungen.onlineToken, onlineToken)))
    .limit(1)

  if (!row) throw new Error('Reservierung nicht gefunden')
  if (row.status === 'storniert') throw new Error('Bereits storniert')
  if (row.status === 'erschienen') throw new Error('Stornierung nicht mehr möglich')

  await db
    .update(reservierungen)
    .set({ status: 'storniert', updatedAt: new Date() })
    .where(eq(reservierungen.id, row.id))
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function toDto(row: typeof reservierungen.$inferSelect): ReservierungResponse {
  return {
    id:             row.id,
    kasseId:        row.kasseId,
    datum:          row.datum,
    zeitVon:        row.zeitVon,
    dauer:          row.dauer,
    personenAnzahl: row.personenAnzahl,
    name:           row.name,
    status:         row.status as ReservierungStatus,
    quelle:         row.quelle as 'intern' | 'online',
    onlineToken:    row.onlineToken,
    ...(row.telefon   && { telefon:    row.telefon   }),
    ...(row.email     && { email:      row.email     }),
    ...(row.notiz     && { notiz:      row.notiz     }),
    ...(row.tischLabel && { tischLabel: row.tischLabel }),
    ...(row.tischId    && { tischId:    row.tischId }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Freie Tische zu einem Zeitpunkt (interne Auswahl + Online-Buchung)
// ---------------------------------------------------------------------------

export interface TischVerfuegbarkeit {
  id:                 string
  bezeichnung:        string
  bereichName:        string
  plaetze:            number
  onlineReservierbar: boolean
  frei:               boolean
  /** Wenn belegt: durch wen/wann (nur intern angezeigt) */
  belegtDurch?:       string
}

/**
 * Tische einer Kasse mit Verfügbarkeit im gewünschten Zeitraum.
 * `nurOnline` liefert ausschließlich online freigegebene Tische (Gast-Formular),
 * `minPlaetze` filtert zu kleine Tische (0 Plätze = unbekannt, bleibt drin).
 */
export async function listeTischVerfuegbarkeit(
  db:        Db,
  mandantId: string,
  kasseId:   string,
  datum:     string,
  zeitVon:   string,
  dauer:     number,
  opts: { nurOnline?: boolean; minPlaetze?: number; ausserId?: string } = {},
): Promise<TischVerfuegbarkeit[]> {
  const tische = await db
    .select({
      id:                 tischplanElemente.id,
      bezeichnung:        tischplanElemente.bezeichnung,
      plaetze:            tischplanElemente.plaetze,
      onlineReservierbar: tischplanElemente.onlineReservierbar,
      bereichName:        tischplanBereiche.name,
    })
    .from(tischplanElemente)
    .innerJoin(tischplanBereiche, eq(tischplanElemente.bereichId, tischplanBereiche.id))
    .where(and(
      eq(tischplanElemente.mandantId, mandantId),
      eq(tischplanElemente.kasseId, kasseId),
      ...(opts.nurOnline ? [eq(tischplanElemente.onlineReservierbar, true)] : []),
    ))
    .orderBy(tischplanBereiche.reihenfolge, tischplanElemente.bezeichnung)

  if (tische.length === 0) return []

  // Alle Belegungen des Tages in EINER Abfrage (statt pro Tisch)
  const belegungen = await db
    .select({
      tischId: reservierungen.tischId,
      zeitVon: reservierungen.zeitVon,
      dauer:   reservierungen.dauer,
      name:    reservierungen.name,
      status:  reservierungen.status,
      id:      reservierungen.id,
    })
    .from(reservierungen)
    .where(and(
      eq(reservierungen.mandantId, mandantId),
      eq(reservierungen.datum, datum),
      inArray(reservierungen.tischId, tische.map(t => t.id)),
    ))

  const umruest = await holeUmruestMinuten(db, mandantId)
  const start   = minuten(zeitVon)

  return tische
    .filter(t => opts.minPlaetze === undefined || t.plaetze === 0 || t.plaetze >= opts.minPlaetze)
    .map(t => {
      const kollision = belegungen.find(b => {
        if (b.tischId !== t.id) return false
        if (b.id === opts.ausserId) return false
        if ((FREIGEBENDE_STATI as readonly string[]).includes(b.status)) return false
        // Gleiche Regel wie pruefeTischFrei — sonst zeigt die Auswahl einen
        // Tisch als frei an, den das Speichern dann mit 409 ablehnt.
        return ueberschneidet(start, dauer, minuten(b.zeitVon), b.dauer, umruest)
      })
      return {
        id:                 t.id,
        bezeichnung:        t.bezeichnung,
        bereichName:        t.bereichName,
        plaetze:            t.plaetze,
        onlineReservierbar: t.onlineReservierbar,
        frei:               !kollision,
        ...(kollision ? { belegtDurch: `${kollision.zeitVon} · ${kollision.name}` } : {}),
      }
    })
}
