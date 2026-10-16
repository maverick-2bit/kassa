/**
 * konten.ts — die Mandanten („Konten"), mit denen dieses Gerät angemeldet war, und die zur Seite gelegten Sitzungen.
 *
 * Ein Gerät wird nacheinander für mehrere Betriebe (Mandanten) benutzt. Damit der Wechsel kein Abmelden und Eintippen
 * braucht, merkt sich das Gerät
 *  - die Konten: Firmenname, Kassen, zuletzt benutzte Kasse, Geräte-Merkmal — ohne Geheimnisse, bleibt auch nach dem
 *    Abmelden (die Anmeldeseite bietet damit den Mandanten zur Wahl an);
 *  - die Sitzung eines Kontos NUR, solange ein Konto mit Einstellungs-Recht angemeldet ist („zur Seite gelegt", wenn man
 *    zu einem anderen Mandanten wechselt). Abmelden, ein abgelaufenes Token (401) und jede Anmeldung ohne
 *    Einstellungs-Recht verwerfen alle gemerkten Sitzungen — ein Kassier kommt so nie an die Sitzung eines Admins.
 *
 * Die aktive Sitzung steht wie immer in lib/auth.ts. Hier: reine Funktionen auf Daten (testbar) plus dünne
 * Speicher-Funktionen. Diese Datei importiert nichts aus auth.ts/kasse.ts — die rufen hierher.
 */

import type { LoginResponse } from '@kassa/shared'

const KEY = 'kassa:konten'

/** Eine Sitzung ist genau die Anmeldeantwort: Token, Benutzer, Mandant und Kassen. */
export type Sitzung = LoginResponse

export interface KontoKasse {
  id:          string
  kassenId:    string
  bezeichnung: string | null
}

export interface Konto {
  mandantId:   string
  firmenname:  string
  kassen:      KontoKasse[]
  /** Zuletzt benutzte Kasse dieses Mandanten an diesem Gerät */
  kasseId:     string | null
  /** Wer zuletzt angemeldet war — nur zur Orientierung in der Liste */
  benutzer:    string | null
  /** Geräte-Merkmal dieses Mandanten (PIN-Bremse); kein Anmelde-Token */
  geraetToken: string | null
  /** Zur Seite gelegte Sitzung — nur solange ein Konto mit Einstellungs-Recht angemeldet ist */
  sitzung:     Sitzung | null
}

/** Die gerade angemeldete Sitzung samt der Kasse dieses Geräts. */
export interface AktiveSitzung {
  sitzung: Sitzung
  kasseId: string | null
}

/** Wer Einstellungen ändern darf (Admin oder Recht „einstellungen") — nur deren Sitzungen werden gemerkt. */
export function hatEinstellungsRecht(user: Pick<Sitzung['user'], 'rolle' | 'berechtigungen'>): boolean {
  return user.rolle === 'admin' || user.berechtigungen.includes('einstellungen')
}

// ---------------------------------------------------------------------------
// Gültigkeit einer Sitzung
// ---------------------------------------------------------------------------

/** Ablaufzeit (ms seit 1970) aus dem Token; null, wenn sie sich nicht lesen lässt. */
export function tokenAblauf(token: string): number | null {
  try {
    const nutzlast = token.split('.')[1]
    if (!nutzlast) return null
    const exp = (JSON.parse(atob(nutzlast.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

/** Mindestrestlaufzeit: eine Sitzung, die gleich abläuft, wird nicht mehr als „angemeldet" angeboten. */
const PUFFER_MS = 60_000

/** Gilt die Sitzung noch? Ohne lesbares Ablaufdatum entscheidet der Server (dann zählt sie als gültig). */
export function sitzungGueltig(sitzung: Sitzung | null, jetzt: number): sitzung is Sitzung {
  if (!sitzung) return false
  const ablauf = tokenAblauf(sitzung.token)
  return ablauf === null || ablauf - PUFFER_MS > jetzt
}

// ---------------------------------------------------------------------------
// Reine Funktionen auf der Konten-Liste
// ---------------------------------------------------------------------------

function ersetze(konten: readonly Konto[], konto: Konto): Konto[] {
  return konten.some(k => k.mandantId === konto.mandantId)
    ? konten.map(k => (k.mandantId === konto.mandantId ? konto : k))
    : [...konten, konto]
}

/** Das Konto zu einer Sitzung — behält, was das Gerät schon wusste (zuletzt benutzte Kasse, Geräte-Merkmal). */
function kontoAus(sitzung: Sitzung, bisher: Konto | undefined, kasseId: string | null): Konto {
  const kassen = sitzung.kassen.map(k => ({ id: k.id, kassenId: k.kassenId, bezeichnung: k.bezeichnung }))
  // Die Kasse dieses Geräts, wenn sie zu diesem Mandanten gehört — sonst die zuletzt benutzte, sonst die erste
  const gewaehlt = [kasseId, bisher?.kasseId].find(id => id && kassen.some(k => k.id === id))
  return {
    mandantId:   sitzung.mandant.id,
    firmenname:  sitzung.mandant.firmenname,
    kassen,
    kasseId:     gewaehlt ?? kassen[0]?.id ?? null,
    benutzer:    sitzung.user.name,
    geraetToken: sitzung.geraetToken ?? bisher?.geraetToken ?? null,
    sitzung:     null,
  }
}

/** Alle gemerkten Sitzungen verwerfen; die Konten (ohne Geheimnisse) bleiben. */
export function ohneSitzungen(konten: readonly Konto[]): Konto[] {
  return konten.map(k => (k.sitzung ? { ...k, sitzung: null } : k))
}

/** Die aktive Sitzung zur Seite legen (unter ihrem Konto). */
export function legeZurSeite(konten: readonly Konto[], aktiv: AktiveSitzung): Konto[] {
  const bisher = konten.find(k => k.mandantId === aktiv.sitzung.mandant.id)
  return ersetze(konten, { ...kontoAus(aktiv.sitzung, bisher, aktiv.kasseId), sitzung: aktiv.sitzung })
}

/** Das gerade angemeldete Konto in die Liste aufnehmen bzw. auffrischen (ohne Sitzung: die ist ja aktiv). */
export function nimmAuf(konten: readonly Konto[], sitzung: Sitzung, kasseId: string | null): Konto[] {
  return ersetze(konten, kontoAus(sitzung, konten.find(k => k.mandantId === sitzung.mandant.id), kasseId))
}

/**
 * Nach einer Anmeldung: das Konto merken und die bisher angemeldete Sitzung eines ANDEREN Mandanten zur Seite legen —
 * aber nur, wenn beide Einstellungs-Recht haben. Wer keins hat (Kassier), lässt nichts liegen: alle gemerkten
 * Sitzungen werden verworfen.
 */
export function nachAnmeldung(
  konten:  readonly Konto[],
  login:   Sitzung,
  bisher:  AktiveSitzung | null,
  kasseId: string | null,
): Konto[] {
  const darf = hatEinstellungsRecht(login.user)
  let neu = nimmAuf(konten, login, kasseId)
  if (bisher && darf && bisher.sitzung.mandant.id !== login.mandant.id && hatEinstellungsRecht(bisher.sitzung.user)) {
    neu = legeZurSeite(neu, bisher)
  }
  return darf ? neu : ohneSitzungen(neu)
}

export type WechselZiel =
  /** Das Ziel hat eine noch gültige Sitzung: sie wird aktiv, ohne Anmeldung */
  | { art: 'sitzung'; sitzung: Sitzung; kasseId: string | null; geraetToken: string | null }
  /** Keine (gültige) Sitzung: Anmeldung nötig — PIN der Kasse bzw. E-Mail und Passwort */
  | { art: 'anmeldung'; konto: Konto }

/**
 * Zu einem anderen Konto wechseln: die aktive Sitzung wird zur Seite gelegt (wenn sie Einstellungs-Recht hat).
 * ziel = null: das Konto ist unbekannt oder schon aktiv — nichts zu tun.
 */
export function wechsle(
  konten:        readonly Konto[],
  aktiv:         AktiveSitzung,
  zielMandantId: string,
  jetzt:         number,
): { konten: Konto[]; ziel: WechselZiel | null } {
  const ziel = konten.find(k => k.mandantId === zielMandantId)
  if (!ziel || ziel.mandantId === aktiv.sitzung.mandant.id) return { konten: [...konten], ziel: null }

  const mitAktiver = hatEinstellungsRecht(aktiv.sitzung.user) ? legeZurSeite(konten, aktiv) : [...konten]
  // Das Ziel wird aktiv bzw. muss sich neu anmelden: seine zur Seite gelegte Sitzung hat hier nichts mehr zu suchen
  const neu = mitAktiver.map(k => (k.mandantId === zielMandantId ? { ...k, sitzung: null } : k))
  return sitzungGueltig(ziel.sitzung, jetzt)
    ? { konten: neu, ziel: { art: 'sitzung', sitzung: ziel.sitzung, kasseId: ziel.kasseId, geraetToken: ziel.geraetToken } }
    : { konten: neu, ziel: { art: 'anmeldung', konto: { ...ziel, sitzung: null } } }
}

export function entferneKonto(konten: readonly Konto[], mandantId: string): Konto[] {
  return konten.filter(k => k.mandantId !== mandantId)
}

/** Die zuletzt benutzte Kasse eines Kontos merken (nur eine Kasse, die das Konto kennt). */
export function mitKasse(konten: readonly Konto[], mandantId: string, kasseId: string): Konto[] {
  return konten.map(k => (k.mandantId === mandantId && k.kasseId !== kasseId && k.kassen.some(x => x.id === kasseId)
    ? { ...k, kasseId }
    : k))
}

/** Die Kasse eines Kontos für die Anmeldung dort: die zuletzt benutzte, sonst die erste. */
export function kasseFuerAnmeldung(konto: Konto): KontoKasse | null {
  return konto.kassen.find(k => k.id === konto.kasseId) ?? konto.kassen[0] ?? null
}

// ---------------------------------------------------------------------------
// Speicher (LocalStorage)
// ---------------------------------------------------------------------------

function alsKasse(x: unknown): KontoKasse | null {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.kassenId !== 'string') return null
  return { id: o.id, kassenId: o.kassenId, bezeichnung: typeof o.bezeichnung === 'string' ? o.bezeichnung : null }
}

function alsKonto(x: unknown): Konto | null {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  if (typeof o.mandantId !== 'string' || typeof o.firmenname !== 'string') return null
  const sitzung = o.sitzung as Sitzung | null | undefined
  return {
    mandantId:   o.mandantId,
    firmenname:  o.firmenname,
    kassen:      (Array.isArray(o.kassen) ? o.kassen : []).map(alsKasse).filter((k): k is KontoKasse => k !== null),
    kasseId:     typeof o.kasseId === 'string' ? o.kasseId : null,
    benutzer:    typeof o.benutzer === 'string' ? o.benutzer : null,
    geraetToken: typeof o.geraetToken === 'string' ? o.geraetToken : null,
    sitzung:     sitzung && typeof sitzung.token === 'string' && sitzung.mandant && sitzung.user ? sitzung : null,
  }
}

/** Die Konten dieses Geräts (leer, wenn nichts gemerkt oder der Speicher unlesbar ist). */
export function ladeKonten(): Konto[] {
  try {
    const roh = localStorage.getItem(KEY)
    const daten: unknown = roh ? JSON.parse(roh) : []
    return Array.isArray(daten) ? daten.map(alsKonto).filter((k): k is Konto => k !== null) : []
  } catch {
    return []
  }
}

export function speichereKonten(konten: readonly Konto[]): void {
  try {
    if (konten.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(konten))
  } catch { /* Speicher gesperrt: dann gilt die Liste nur bis zum Neuladen nicht — der Wechsel bleibt ohne Merken möglich */ }
}

/** Beim Anmelden (aus setAuth): Konto merken, die bisherige Admin-Sitzung zur Seite legen — oder alle verwerfen. */
export function merkeAnmeldung(login: Sitzung, bisher: AktiveSitzung | null, kasseId: string | null): void {
  speichereKonten(nachAnmeldung(ladeKonten(), login, bisher, kasseId))
}

/** Beim Abmelden und bei abgelaufenem Token (aus clearAuth): alle gemerkten Sitzungen löschen. */
export function verwirfSitzungen(): void {
  const konten = ladeKonten()
  if (konten.some(k => k.sitzung)) speichereKonten(ohneSitzungen(konten))
}

/** Wenn sich die Kasse dieses Geräts ändert (aus setKasseIdentity): im Konto vermerken. */
export function merkeKasse(mandantId: string, kasseId: string): void {
  const konten = ladeKonten()
  const neu = mitKasse(konten, mandantId, kasseId)
  if (neu.some((k, i) => k !== konten[i])) speichereKonten(neu)
}
