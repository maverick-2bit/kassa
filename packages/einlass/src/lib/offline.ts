/**
 * Offline-Einlass: entscheidet ohne Verbindung anhand der geladenen Liste und
 * reicht die Scans nach, sobald das Netz wieder da ist.
 *
 * Grenze, die bleibt: zwei Eingänge, die GLEICHZEITIG offline sind, sehen
 * gegenseitig nichts — eine Ticket-Kopie kommt dann an beiden rein. Beim
 * Nachreichen meldet der Server das als Konflikt (Protokoll im Backoffice).
 */

import {
  alterAm,
  bandAltersText,
  bandFuerAlter,
  ticketCodeHash,
  wienerTag,
  type EinlassErgebnis,
  type EinlassErgebnisArt,
  type EinlassOfflineTicket,
  type EinlassSyncErgebnis,
  type EinlassTicket,
  type TicketEinlassStand,
} from '@kassa/shared'
import { einlassApi } from './api'
import {
  entferneAusWarteschlange,
  ladeListe,
  reiheEin,
  speichereListe,
  speichereMeta,
  speichereTicket,
  warteschlange,
  type ListenMeta,
  type WartenderScan,
} from './speicher'

/** Beim Abgleich etwas zurückgreifen: was zeitgleich mit der letzten Liste geändert wurde, fehlt sonst */
const UEBERLAPPUNG_MS = 30_000
/** So viele Scans je Nachreich-Anfrage */
const PAKET = 200

export interface OfflineEntscheidung {
  ergebnis: EinlassErgebnisArt
  ticket:   EinlassTicket | null
  /** Hash des Tickets in der Liste (für das Vermerken) */
  h:        string | null
}

/** UUID v4 ohne crypto.randomUUID — das gibt es nur über HTTPS, der Einlass läuft auch über http://<IP>. */
export function neueScanId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class OfflineEinlass {
  meta: ListenMeta | null = null
  private tickets = new Map<string, EinlassOfflineTicket>()
  /** Offline gezählte neue Besucher, die der Server noch nicht kennt */
  offeneBesucher = 0
  wartend = 0

  private constructor(readonly eventId: string) {}

  /** Liste + Warteschlange aus dem Gerätespeicher (leer, wenn noch nie geladen). */
  static async laden(eventId: string): Promise<OfflineEinlass> {
    const o = new OfflineEinlass(eventId)
    const gespeichert = await ladeListe(eventId)
    if (gespeichert) { o.meta = gespeichert.meta; o.tickets = gespeichert.tickets }
    await o.zaehleWarteschlange()
    return o
  }

  get bereit(): boolean { return this.meta !== null }
  get anzahlTickets(): number { return this.tickets.size }

  /** Besucherzahl inkl. offline eingelassener, noch nicht nachgereichter Gäste */
  besucher(serverStand: TicketEinlassStand | null): number | null {
    const basis = serverStand ?? this.meta?.stand ?? null
    return basis ? basis.besucher + this.offeneBesucher : null
  }

  private async zaehleWarteschlange(): Promise<void> {
    const offen = await warteschlange(this.eventId)
    this.wartend = offen.length
    this.offeneBesucher = offen.filter(s => s.neuerBesucher).length
  }

  /** Liste vom Server holen — komplett beim ersten Mal, danach nur Änderungen. */
  async aktualisieren(): Promise<void> {
    const seit = this.meta ? new Date(Date.parse(this.meta.erstelltAt) - UEBERLAPPUNG_MS).toISOString() : undefined
    const liste = await einlassApi.offlineListe(this.eventId, seit)
    if (liste.vollstaendig) this.tickets = new Map()
    for (const t of liste.tickets) this.tickets.set(t.h, t)
    this.meta = { eventId: liste.eventId, erstelltAt: liste.erstelltAt, event: liste.event, baender: liste.baender, stand: liste.stand }
    await speichereListe(liste)
  }

  /** Entscheidung ohne Server — gleiche Regeln wie online. */
  entscheide(code: string | null): OfflineEntscheidung {
    if (!code || !this.meta) return { ergebnis: 'unbekannt', ticket: null, h: null }
    const h = ticketCodeHash(code)
    const t = this.tickets.get(h)
    if (!t) return { ergebnis: 'unbekannt', ticket: null, h: null }
    const ticket = this.anzeige(t)
    if (this.meta.event.status === 'abgesagt') return { ergebnis: 'abgesagt', ticket, h }
    if (this.meta.event.status === 'entwurf')  return { ergebnis: 'nicht_freigegeben', ticket, h }
    if (t.status === 'storniert')              return { ergebnis: 'storniert', ticket, h }
    if (t.typ === 'mehrfach') return { ergebnis: 'mehrfach', ticket: { ...ticket, einlassAnzahl: t.einlassAnzahl + 1 }, h }
    if (t.ersterEinlassAt)    return { ergebnis: 'bereits_eingeloest', ticket, h }
    return { ergebnis: 'zugelassen', ticket: { ...ticket, einlassAnzahl: 1 }, h }
  }

  /** Offline-Entscheidung festhalten: Liste auf dem Gerät nachführen + zum Nachreichen einreihen. */
  async vermerke(inhalt: string, e: OfflineEntscheidung, geraetName: string): Promise<void> {
    const jetzt = new Date().toISOString()
    let neuerBesucher = false
    if (e.h && (e.ergebnis === 'zugelassen' || e.ergebnis === 'mehrfach')) {
      const t = this.tickets.get(e.h)
      if (t) {
        neuerBesucher = t.ersterEinlassAt === null
        const neu: EinlassOfflineTicket = {
          ...t,
          ersterEinlassAt:     t.ersterEinlassAt ?? jetzt,
          ersterEinlassGeraet: t.ersterEinlassGeraet ?? geraetName,
          einlassAnzahl:       t.einlassAnzahl + 1,
        }
        this.tickets.set(e.h, neu)
        await speichereTicket(this.eventId, neu)
      }
    }
    const scan: WartenderScan = { scanId: neueScanId(), eventId: this.eventId, inhalt, zeitpunkt: jetzt, lokal: e.ergebnis, neuerBesucher }
    await reiheEin(scan)
    this.wartend++
    if (neuerBesucher) this.offeneBesucher++
  }

  /** Online-Ergebnis in die Liste übernehmen — sonst ließe sie offline dasselbe Ticket noch einmal durch. */
  async uebernehmeOnline(ergebnis: EinlassErgebnis): Promise<void> {
    if (this.meta) {
      this.meta = { ...this.meta, stand: ergebnis.stand }
      await speichereMeta(this.meta)
    }
    const t = ergebnis.ticket
    if (!t?.code) return
    const h = ticketCodeHash(t.code)
    const vorhanden = this.tickets.get(h)
    if (!vorhanden) return
    const neu: EinlassOfflineTicket = {
      ...vorhanden,
      ersterEinlassAt: t.ersterEinlassAt, ersterEinlassGeraet: t.ersterEinlassGeraet, einlassAnzahl: t.einlassAnzahl,
      ...(ergebnis.ergebnis === 'storniert' ? { status: 'storniert' as const } : {}),
    }
    this.tickets.set(h, neu)
    await speichereTicket(this.eventId, neu)
  }

  /** Warteschlange nachreichen; liefert die Konflikte (offline eingelassen, Server hätte abgewiesen). */
  async nachreichen(): Promise<{ uebertragen: number; konflikte: EinlassSyncErgebnis[] }> {
    const offen = await warteschlange(this.eventId)
    const konflikte: EinlassSyncErgebnis[] = []
    let uebertragen = 0
    for (let i = 0; i < offen.length; i += PAKET) {
      const paket = offen.slice(i, i + PAKET)
      const antwort = await einlassApi.sync(this.eventId, paket.map(s => ({
        scanId: s.scanId, inhalt: s.inhalt, zeitpunkt: s.zeitpunkt, lokal: s.lokal,
      })))
      konflikte.push(...antwort.ergebnisse.filter(e => e.konflikt))
      await entferneAusWarteschlange(paket.map(s => s.scanId))
      uebertragen += paket.length
      if (this.meta) {
        this.meta = { ...this.meta, stand: antwort.stand }
        await speichereMeta(this.meta)
      }
    }
    await this.zaehleWarteschlange()
    return { uebertragen, konflikte }
  }

  private anzeige(t: EinlassOfflineTicket): EinlassTicket {
    const meta = this.meta!
    const alter = t.geburtsdatum ? alterAm(t.geburtsdatum, wienerTag(meta.event.beginn)) : null
    const band  = alter !== null ? bandFuerAlter(meta.baender, alter) : null
    return {
      code:                '',   // der Code steht offline nicht auf dem Gerät
      typ:                 t.typ,
      rolle:               t.rolle,
      bezeichnung:         t.bezeichnung,
      name:                t.name,
      geburtsdatum:        t.geburtsdatum,
      alter,
      band: band ? { bezeichnung: band.bezeichnung, farbe: band.farbe, altersText: bandAltersText(band), hinweis: band.hinweis } : null,
      einlassAnzahl:       t.einlassAnzahl,
      ersterEinlassAt:     t.ersterEinlassAt,
      ersterEinlassGeraet: t.ersterEinlassGeraet,
    }
  }
}
