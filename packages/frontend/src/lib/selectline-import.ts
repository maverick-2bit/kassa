/**
 * selectline-import.ts — Zeilen aus den Excel-Exporten einer SelectLine-WaWi (Lieferanten, Kunden, Artikel)
 * in Kassa-Eingaben umwandeln.
 *
 * Reine Funktionen ohne Netzwerk/Excel-Zugriff (die Datei wird in der Seite mit `xlsx` gelesen und als
 * Zeilen-Objekte {Spaltenüberschrift: Wert} hierher gegeben) — dadurch testbar.
 *
 * Doppelte Übernahme wird über eine Markierung verhindert, die in Notiz/Notizen steht:
 *   Lieferant: „SelectLine-Nr. 70001"        Kunde: „SelectLine Kd.-Nr. 5053"
 *   Artikel:   Artikelnummer beim Lieferanten = SelectLine-Artikelnummer
 */

import { MWST_PROZENT_SATZ } from '@kassa/shared'
import type { ArtikelInput, KundeInput, LieferantInput, MwStSatz } from '@kassa/shared'

export type Zeile = Record<string, unknown>

/** Überschrift normalisieren: Kleinbuchstaben, ohne Leer-/Sonderzeichen („Straße" ≙ „strasse"). */
function norm(s: string): string {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z0-9]/g, '')
}

/** Text einer Spalte (erste vorhandene Überschrift gewinnt); leer → ''. */
export function text(z: Zeile, ...namen: string[]): string {
  const gesucht = namen.map(norm)
  for (const [k, v] of Object.entries(z)) {
    if (!gesucht.includes(norm(k))) continue
    if (v === null || v === undefined) continue
    const t = String(v).trim()
    if (t !== '') return t
  }
  return ''
}

/** Zahl aus Zelle (Zahl oder „12,50"); nicht lesbar → null. */
export function zahl(z: Zeile, ...namen: string[]): number | null {
  const t = text(z, ...namen)
  if (t === '') return null
  const n = Number(t.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const eurZuCent = (eur: number) => Math.round(eur * 100)

/** SelectLine-Länderkennzeichen (kfz-artig: D, A, CH …) → ISO-3166-Alpha-2. */
const LAND_MAP: Record<string, string> = {
  D: 'DE', A: 'AT', L: 'LU', F: 'FR', I: 'IT', E: 'ES', B: 'BE', H: 'HU', S: 'SE', N: 'NO', P: 'PT', V: 'VA',
  CZ: 'CZ', SK: 'SK', SLO: 'SI', NL: 'NL', PL: 'PL', GB: 'GB', IRL: 'IE', HR: 'HR', RO: 'RO', BG: 'BG', DK: 'DK',
}
export function landCode(roh: string): string {
  const t = roh.trim().toUpperCase()
  if (!t) return 'AT'
  if (LAND_MAP[t]) return LAND_MAP[t]!
  return /^[A-Z]{2}$/.test(t) ? t : 'AT'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const gueltigeEmail = (e: string): string | null => (EMAIL_RE.test(e) ? e : null)

// ---------------------------------------------------------------------------
// Lieferanten
// ---------------------------------------------------------------------------

export interface ParsedLieferant {
  /** SelectLine-Lieferantennummer (z. B. „70001") */
  nummer: string
  input:  LieferantInput
}

export const lieferantMarke = (nummer: string) => `SelectLine-Nr. ${nummer}`

export function parseLieferanten(zeilen: Zeile[]): { eintraege: ParsedLieferant[]; uebersprungen: string[] } {
  const eintraege: ParsedLieferant[] = []
  const uebersprungen: string[] = []
  for (const z of zeilen) {
    const nummer = text(z, 'Nummer')
    const name = text(z, 'Firma') || [text(z, 'Vorname'), text(z, 'Name')].filter(Boolean).join(' ')
    if (!name) { uebersprungen.push(`Nr. ${nummer || '?'}: ohne Name`); continue }
    if (text(z, 'Inaktiv').toLowerCase() === 'ja') { uebersprungen.push(`${name}: inaktiv in SelectLine`); continue }
    const zb = text(z, 'Zahlungsbed.', 'Zahlungsbedingung')
    const notizTeile = [nummer ? lieferantMarke(nummer) : '', text(z, 'Notiz')].filter(Boolean)
    eintraege.push({
      nummer,
      input: {
        name:    name.slice(0, 200),
        kontakt: [text(z, 'Vorname'), text(z, 'Name')].filter(Boolean).join(' ').slice(0, 200) || null,
        email:   gueltigeEmail(text(z, 'E-Mail')),
        telefon: (text(z, 'Telefon') || text(z, 'Telefon 2')).slice(0, 50) || null,
        notiz:   notizTeile.join('\n') || null,
        strasse: text(z, 'Straße').slice(0, 200) || null,
        plz:     text(z, 'PLZ').slice(0, 20) || null,
        ort:     text(z, 'Ort').slice(0, 100) || null,
        land:    landCode(text(z, 'Land')),
        uid:     text(z, 'UID').replace(/\s/g, '').slice(0, 30) || null,
        // Reine Zahlen sind interne SelectLine-Codes, keine lesbare Bedingung
        zahlungsbedingung: zb && !/^\d+$/.test(zb) ? zb.slice(0, 200) : null,
      },
    })
  }
  return { eintraege, uebersprungen }
}

// ---------------------------------------------------------------------------
// Kunden
// ---------------------------------------------------------------------------

export interface ParsedKunde {
  nummer: string
  input:  KundeInput
}

export const kundeMarke = (nummer: string) => `SelectLine Kd.-Nr. ${nummer}`

export function parseKunden(zeilen: Zeile[]): { eintraege: ParsedKunde[]; uebersprungen: string[] } {
  const eintraege: ParsedKunde[] = []
  const uebersprungen: string[] = []
  for (const z of zeilen) {
    const nummer = text(z, 'Nummer')
    const firma = text(z, 'Firma')
    const name = text(z, 'Name')
    const vorname = text(z, 'Vorname')
    // Kassa verlangt Firma ODER Nachname
    const nachname = name || (!firma ? vorname : '')
    if (!firma && !nachname) { uebersprungen.push(`Kd.-Nr. ${nummer || '?'}: ohne Name`); continue }
    if (text(z, 'Inaktiv').toLowerCase() === 'ja') { uebersprungen.push(`${firma || nachname}: inaktiv in SelectLine`); continue }
    const zusatz = [text(z, 'Zusatz'), text(z, 'Zusatz2')].filter(Boolean).join(', ')
    const notizen = [nummer ? kundeMarke(nummer) : '', zusatz, text(z, 'Notiz')].filter(Boolean).join('\n').slice(0, 2000)
    const input: KundeInput = {
      land:  landCode(text(z, 'Land')),
      kreditAktiv: false,
      rechnungPerMail: false,
      notizen: notizen || null,
    }
    if (firma)    input.firma    = firma.slice(0, 200)
    if (nachname) input.nachname = nachname.slice(0, 100)
    if (firma && vorname && name) input.vorname = vorname.slice(0, 100)
    else if (!firma && name && vorname) input.vorname = vorname.slice(0, 100)
    const email = gueltigeEmail(text(z, 'E-Mail'))
    if (email) input.email = email.slice(0, 200)
    const tel = (text(z, 'Telefon') || text(z, 'Telefon 2') || text(z, 'Telefon 3')).slice(0, 50)
    if (tel) input.telefon = tel
    const strasse = text(z, 'Straße'); if (strasse) input.strasse = strasse.slice(0, 200)
    const plz = text(z, 'PLZ');        if (plz) input.plz = plz.slice(0, 20)
    const ort = text(z, 'Ort');        if (ort) input.ort = ort.slice(0, 100)
    const uid = text(z, 'UID').replace(/\s/g, ''); if (uid) input.uid = uid.slice(0, 30)
    eintraege.push({ nummer, input })
  }
  return { eintraege, uebersprungen }
}

// ---------------------------------------------------------------------------
// Artikel
// ---------------------------------------------------------------------------

export interface ParsedArtikel {
  /** SelectLine-Artikelnummer */
  nummer: string
  /** Warengruppe (Name) — die Seite löst sie in eine Kategorie-ID auf */
  warengruppe: string
  /** SelectLine-Lieferantennummer — die Seite löst sie über die Notiz-Markierung auf */
  lieferantNummer: string
  hatVerkaufspreis: boolean
  input: Omit<ArtikelInput, 'mandantId' | 'kategorieId' | 'lieferantId'>
}

/** Steuersatz in % → Kassa-Code; unbekannt → null. */
export function mwstAusProzent(pct: number | null): MwStSatz | null {
  if (pct === null) return null
  if (pct === 20) return 'normal'
  if (pct === 10) return 'ermaessigt1'
  if (pct === 13) return 'ermaessigt2'
  if (pct === 4.9) return 'ermaessigt3'
  if (pct === 0)  return 'null'
  return null
}

export function parseArtikel(zeilen: Zeile[]): { eintraege: ParsedArtikel[]; uebersprungen: string[]; ohnePreis: number } {
  const eintraege: ParsedArtikel[] = []
  const uebersprungen: string[] = []
  let ohnePreis = 0
  for (const z of zeilen) {
    const nummer = text(z, 'Artikelnummer')
    const bezeichnung = text(z, 'Bezeichnung')
    if (!bezeichnung) { uebersprungen.push(`Art. ${nummer || '?'}: ohne Bezeichnung`); continue }
    if (text(z, 'Inaktiv').toLowerCase() === 'ja') { uebersprungen.push(`${bezeichnung}: inaktiv in SelectLine`); continue }

    const pct = zahl(z, 'Steuer %', 'Steuer')
    const mwst = mwstAusProzent(pct) ?? 'normal'
    const brutto = zahl(z, 'VK brutto')
    const netto = zahl(z, 'VK netto (Listenpreis)', 'VK netto')
    let preisCent = 0
    let hatPreis = false
    if (brutto !== null && brutto > 0) { preisCent = eurZuCent(brutto); hatPreis = true }
    else if (netto !== null && netto > 0 && pct !== null) { preisCent = eurZuCent(netto * (1 + pct / 100)); hatPreis = true }
    if (!hatPreis) ohnePreis++

    const ek = zahl(z, 'Einkaufspreis (letzter)', 'Einkaufspreis')
    const ean = text(z, 'EAN').replace(/\.0+$/, '')
    const hersteller = text(z, 'Hersteller')
    const hstNr = text(z, 'Hersteller-Art.Nr.', 'Hersteller-Artikelnummer')

    eintraege.push({
      nummer,
      warengruppe: text(z, 'Warengruppe'),
      lieferantNummer: text(z, 'Lieferant'),
      hatVerkaufspreis: hatPreis,
      input: {
        bezeichnung:     bezeichnung.slice(0, 200),
        preisBruttoCent: preisCent,
        mwstSatz:        mwst,
        ean:             ean ? ean.slice(0, 20) : null,
        einkaufspreisCent: ek !== null && ek > 0 ? eurZuCent(ek) : null,
        // Die SelectLine-Artikelnummer ist die Nummer, unter der beim Lieferanten bestellt wird
        lieferantenArtikelnummer: nummer ? nummer.slice(0, 60) : null,
        hersteller:      hersteller ? hersteller.slice(0, 100) : null,
        herstellerArtikelnummer: hstNr ? hstNr.slice(0, 60) : null,
        lagerstandAktiv: false,
        lagerstandMenge: null,
        mindestbestand:  null,
        seriennummernAktiv: false,
        istFavorit:      false,
        bonierBeiDirektverkauf: false,
        istBestandteil:  false,
        bestandteile:    [],
        terminalSichtbar: null,
      },
    })
  }
  return { eintraege, uebersprungen, ohnePreis }
}

// ---------------------------------------------------------------------------
// Preisgruppen (Sonderpreise) → Preislisten
// ---------------------------------------------------------------------------

export interface ParsedPreisgruppe {
  /** SelectLine-Preisgruppe (z. B. „2") */
  nummer:    string
  /** Name aus der Spaltenüberschrift (z. B. „Tersus"), sonst „Preisgruppe 2" */
  name:      string
  eintraege: { artikelNr: string; nettoEuro: number }[]
}

const PREISGRUPPE_SPALTE = /^preisgruppe\s*(\d+)\s*(?:[\u2013\u2014-]\s*(.+?))?\s*\(netto\)\s*$/i

/**
 * Spalten „Preisgruppe 2 – Tersus (netto)" der Artikel-Datei → je Gruppe die Artikel mit Sonderpreis.
 * Gruppen ohne einen einzigen Preis werden ausgelassen. Preise sind NETTO (SelectLine); die Umrechnung auf
 * brutto braucht den Steuersatz des Kassa-Artikels (siehe `nettoZuBruttoCent`).
 */
export function parsePreisgruppen(zeilen: Zeile[]): ParsedPreisgruppe[] {
  const spalten = new Map<string, { nummer: string; name: string }>()
  for (const z of zeilen) {
    for (const k of Object.keys(z)) {
      if (spalten.has(k)) continue
      const m = PREISGRUPPE_SPALTE.exec(k.trim())
      if (m) spalten.set(k, { nummer: m[1]!, name: (m[2] ?? '').trim() || `Preisgruppe ${m[1]}` })
    }
  }
  const gruppen: ParsedPreisgruppe[] = []
  for (const [spalte, info] of spalten) {
    const eintraege: ParsedPreisgruppe['eintraege'] = []
    for (const z of zeilen) {
      const artikelNr = text(z, 'Artikelnummer')
      if (!artikelNr || text(z, 'Inaktiv').toLowerCase() === 'ja') continue
      const roh = z[spalte]
      const netto = typeof roh === 'number' ? roh : Number(String(roh ?? '').replace(',', '.'))
      if (roh === null || roh === undefined || String(roh).trim() === '' || !Number.isFinite(netto) || netto < 0) continue
      eintraege.push({ artikelNr, nettoEuro: netto })
    }
    if (eintraege.length > 0) gruppen.push({ ...info, eintraege })
  }
  return gruppen.sort((a, b) => Number(a.nummer) - Number(b.nummer))
}

/** Nettopreis in Euro → Bruttopreis in Cent (kaufmännisch gerundet) für den Steuersatz des Kassa-Artikels. */
export function nettoZuBruttoCent(nettoEuro: number, mwstSatz: MwStSatz): number {
  const prozent = MWST_PROZENT_SATZ[mwstSatz] ?? 20
  return Math.round(nettoEuro * 100 * (1 + prozent / 100))
}
