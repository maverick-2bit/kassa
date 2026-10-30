/**
 * RKSV-BURN-IN: Dauer- und Rechtssicherheitstest der Kassa gegen echtes PostgreSQL.
 *
 * Die Kassa wird wie im Betrieb benutzt (zufällige Verkäufe, Stornos, Sammel-/Null-/Monats-/Jahresbelege,
 * parallele Zugriffe, SEE-Ausfall, Neustarts, absichtlich fehlerhafte Anfragen). Nach jeder Runde prüft
 * ein UNABHÄNGIGER Prüfer (rksv-pruefer.ts, ohne Code aus @kassa/rksv) den kompletten DEP131-Export so,
 * wie es die Finanzprüfung tun würde: Lückenlosigkeit, Verkettung, ES256-Signatur, Umsatzzähler (AES),
 * Beträge, Zeitverlauf. Zusätzlich gegen die Erwartung des Testtreibers: Storno = exakt das Negativ des
 * Originals, Rundung auf den Cent (exakte Ganzzahlrechnung), Tagesabschluss, DEP7, Signatur-Selbsttest.
 *
 * Steuerung über Umgebungsvariablen:
 *   BURNIN_BELEGE   Ziel-Anzahl Belege (Standard 2000)
 *   BURNIN_MINUTEN  alternativ: Mindestlaufzeit in Minuten (läuft, bis die Zeit um ist; Belege-Ziel entfällt)
 *   BURNIN_SEED     Startwert des Zufallsgenerators (Standard: aus der Uhrzeit; wird ausgegeben → Lauf wiederholbar)
 *   BURNIN_PARALLEL Größe der Parallel-Wellen (Standard 20)
 *
 * Aufruf (im Ordner packages/backend):  pnpm test:burnin
 * Ergebnis: test-results/burnin-<seed>.json und .md
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { FinanzOnlineClient } from '@kassa/rksv'
import type { BelegResponse } from '@kassa/shared'
import { buildTestServer, TEST_MASTER, type TestServer } from '../helpers/testServer.js'
import { erstelleIntegrationsDb, type IntegrationsDb } from '../integration/helpers/integrationsDb.js'
import { kassen } from '../../src/db/schema.js'
import { decryptPrivateKey } from '../../src/crypto/master-key.js'
import {
  pruefeBelegfolge, pruefeDep7, summeBetraege,
  type PrueferBeleg, type Verstoss,
} from './rksv-pruefer.js'

// ---------------------------------------------------------------------------
// Parameter
// ---------------------------------------------------------------------------

const ZIEL_BELEGE = Number(process.env.BURNIN_BELEGE ?? 2000)
const MINUTEN     = process.env.BURNIN_MINUTEN ? Number(process.env.BURNIN_MINUTEN) : null
const SEED        = Number(process.env.BURNIN_SEED ?? (Date.now() % 1_000_000_000))
const WELLE       = Number(process.env.BURNIN_PARALLEL ?? 20)

const ADMIN_EMAIL    = 'admin@burnin.at'
const ADMIN_PASSWORT = 'burnin-passwort-123'
const KASSEN_ID      = 'BURNIN-001'
const AUSFALL_MARKER = Buffer.from('Sicherheitseinrichtung ausgefallen', 'utf8').toString('base64')

type Satz = 'normal' | 'ermaessigt1' | 'ermaessigt2' | 'null' | 'besonders'
const SAETZE: Satz[] = ['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders']

function mockFoClient(): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen:          vi.fn().mockResolvedValue({ erfolgreich: true }),
    startbelegPruefen:             vi.fn().mockResolvedValue({ erfolgreich: true, pruefwert: 'BI-PW' }),
    kasseAusserBetriebNehmen:      vi.fn(),
    seeAusfallMelden:              vi.fn().mockResolvedValue({ erfolgreich: true }),
    seeWiederinbetriebnahmeMelden: vi.fn().mockResolvedValue({ erfolgreich: true }),
  } as unknown as FinanzOnlineClient
}

// ---------------------------------------------------------------------------
// Zufall (reproduzierbar)
// ---------------------------------------------------------------------------

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const zufall = mulberry32(SEED)
const ganz   = (von: number, bis: number): number => von + Math.floor(zufall() * (bis - von + 1))
const wahl   = <T>(liste: readonly T[]): T => liste[Math.floor(zufall() * liste.length)]!

/** Exakte Rundung auf den Cent (Ganzzahlrechnung, halbe Cent von Null weg). tie = genau ein halber Cent. */
function rundeExakt(preisCent: number, mengeMilli: number): { wert: number; tie: boolean } {
  const z  = BigInt(preisCent) * BigInt(mengeMilli)
  const vz = z < 0n ? -1n : 1n
  const a  = z * vz
  let q = a / 1000n
  const r = a % 1000n
  if (r >= 500n) q += 1n
  return { wert: Number(q * vz), tie: r === 500n }
}

// ---------------------------------------------------------------------------
// Artikelstamm für die Verkäufe: alle Steuersätze, krumme Preise, Pfand
// ---------------------------------------------------------------------------

interface TestArtikel { id: string; preis: number; satz: Satz; name: string }
const ARTIKEL_DEFS: { name: string; preis: number; satz: Satz }[] = [
  { name: 'Kaffee',            preis:   350, satz: 'ermaessigt1' },
  { name: 'Cola 0,33',         preis:   395, satz: 'normal' },
  { name: 'Wiener Schnitzel',  preis:  1690, satz: 'ermaessigt1' },
  { name: 'Wein (Glas)',       preis:   490, satz: 'normal' },
  { name: 'Zeitung',           preis:   260, satz: 'ermaessigt2' },
  { name: 'Pfandflasche',      preis:     1, satz: 'normal' },
  { name: 'Krummer Preis A',   preis:   333, satz: 'normal' },
  { name: 'Krummer Preis B',   preis:   999, satz: 'ermaessigt1' },
  { name: 'Krummer Preis C',   preis:  1999, satz: 'ermaessigt2' },
  { name: 'Teurer Posten',     preis: 123456, satz: 'normal' },
  { name: 'Sondersatz-Artikel', preis:  777, satz: 'besonders' },
  { name: 'Steuerfrei',        preis:   450, satz: 'null' },
  { name: 'Pfand Rückgabe',    preis:   -50, satz: 'normal' },
]

// ---------------------------------------------------------------------------
// Protokoll
// ---------------------------------------------------------------------------

interface Meldung { runde: number; regel: string; detail: string }
const fehler:   Meldung[] = []
const hinweise: Meldung[] = []
const zaehlerProRegel = new Map<string, number>()

let aktuelleRunde = 0
function melde(art: 'fehler' | 'hinweis', regel: string, detail: string): void {
  const liste = art === 'fehler' ? fehler : hinweise
  zaehlerProRegel.set(`${art}:${regel}`, (zaehlerProRegel.get(`${art}:${regel}`) ?? 0) + 1)
  if (liste.filter(m => m.regel === regel).length < 20) liste.push({ runde: aktuelleRunde, regel, detail })
}
const pruefe = (bedingung: boolean, regel: string, detail: () => string): void => {
  if (!bedingung) melde('fehler', regel, detail())
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

interface Verkauf {
  response: BelegResponse
  erwartet: Record<Satz, number>
  hatTie:   Record<Satz, boolean>
}

describe('RKSV-Burn-in (Integration, echtes PostgreSQL)', () => {
  let idb: IntegrationsDb
  let srv: TestServer
  let token: string
  let kasseId: string
  let artikel: TestArtikel[] = []

  const auth = () => ({ authorization: `Bearer ${token}` })
  const post = (url: string, payload: unknown) =>
    srv.fastify.inject({ method: 'POST', url, headers: auth(), payload: payload as object })
  const get = (url: string) => srv.fastify.inject({ method: 'GET', url, headers: auth() })

  /** Alle Belege, die der Testtreiber erzeugt hat (Belegnummer → Antwort der Kassa). */
  const lokal = new Map<number, BelegResponse>()
  const verkaeufe: Verkauf[] = []
  const stornierbar: Verkauf[] = []        // noch nicht stornierte Verkäufe
  let zaehlerErwartet = 0n
  const statistik = { verkaeufe: 0, stornos: 0, nullartig: 0, ausfall: 0, abgelehnt: 0, neustarts: 0, parallelWellen: 0 }

  const merke = (b: BelegResponse) => {
    lokal.set(b.belegNummer, b)
    if (b.belegTyp === 'Barzahlungsbeleg' || b.belegTyp === 'Stornobeleg') zaehlerErwartet += BigInt(b.gesamtbetragCent)
  }

  // ---- Verkauf zusammenstellen -------------------------------------------------

  function baueVerkauf(): { payload: object; erwartet: Record<Satz, number>; hatTie: Record<Satz, boolean>; gesamt: number } {
    const erwartet = { normal: 0, ermaessigt1: 0, ermaessigt2: 0, null: 0, besonders: 0 } as Record<Satz, number>
    const hatTie   = { normal: false, ermaessigt1: false, ermaessigt2: false, null: false, besonders: false } as Record<Satz, boolean>
    const positionen: { artikelId: string; menge: number }[] = []
    const n = ganz(1, 6)
    for (let i = 0; i < n; i++) {
      const a = wahl(artikel)
      // Meist ganze Stück, manchmal Gewicht/Teilmengen (Tausendstel) — hier zeigen sich Rundungsfehler
      const mengeMilli = zufall() < 0.8 ? ganz(1, 5) * 1000
        : wahl([500, 1500, 250, 333, 750, 2750, 125, 1005, 3333, 10500])
      const r = rundeExakt(a.preis, mengeMilli)
      // Genau halbe Cent sind kein Rechenfehler, sondern Auslegungssache — sie prüft die Sonde (tieSonde) gesondert.
      // Im Normalbetrieb werden sie vermieden, damit die Erwartung des Testtreibers eindeutig ist.
      if (r.tie) { i--; continue }
      erwartet[a.satz] += r.wert
      positionen.push({ artikelId: a.id, menge: mengeMilli / 1000 })
    }
    let gesamt = SAETZE.reduce((s, k) => s + erwartet[k], 0)
    if (gesamt < 0) {            // nur Pfand-Rückgabe: als Retoure zulässig, aber hier ein normaler Verkauf
      return baueVerkauf()
    }
    const art = zufall()
    const zahlung = art < 0.6 ? { barCent: gesamt, karteCent: 0, sonstigeCent: 0 }
      : art < 0.85 ? { barCent: 0, karteCent: gesamt, sonstigeCent: 0 }
      : art < 0.95 ? (() => { const bar = ganz(0, gesamt); return { barCent: bar, karteCent: gesamt - bar, sonstigeCent: 0 } })()
      : { barCent: 0, karteCent: 0, sonstigeCent: gesamt }
    return { payload: { kasseId, positionen, zahlung }, erwartet, hatTie, gesamt }
  }

  async function verkaufe(): Promise<BelegResponse | null> {
    const v = baueVerkauf()
    const res = await post('/api/belege/barzahlung', v.payload)
    if (res.statusCode !== 201) {
      melde('fehler', 'verkauf-abgelehnt', `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`)
      return null
    }
    return verbuche(res.json() as BelegResponse, v)
  }

  function verbuche(b: BelegResponse, v: { erwartet: Record<Satz, number>; hatTie: Record<Satz, boolean>; gesamt: number }): BelegResponse {
    merke(b)
    statistik.verkaeufe++
    const verkauf: Verkauf = { response: b, erwartet: v.erwartet, hatTie: v.hatTie }
    verkaeufe.push(verkauf)
    stornierbar.push(verkauf)

    // Beträge je Steuersatz gegen die unabhängig gerechnete Erwartung
    for (const s of SAETZE) {
      if (b.betraege[s] !== v.erwartet[s]) {
        const ist = b.betraege[s], soll = v.erwartet[s]
        const nurTie = v.hatTie[s] && Math.abs(ist - soll) <= 1
        melde(nurTie ? 'hinweis' : 'fehler', nurTie ? 'rundung-halber-cent' : 'betrag-je-satz',
          `Beleg ${b.belegNummer} Satz ${s}: Kassa ${ist}, erwartet ${soll}`)
      }
    }
    pruefe(b.gesamtbetragCent === summeBetraege(b.betraege), 'gesamtbetrag', () => `Beleg ${b.belegNummer}: gesamt ${b.gesamtbetragCent} ≠ Summe der Sätze`)
    pruefe(b.summeBarCent + b.summeKarteCent + b.summeSonstigeCent === b.gesamtbetragCent, 'zahlung-summe',
      () => `Beleg ${b.belegNummer}: Zahlung ≠ Gesamtbetrag`)
    pruefe(b.signaturwert !== AUSFALL_MARKER || ausfallLaeuft, 'ausfall-ohne-ausfall', () => `Beleg ${b.belegNummer} trägt den Ausfallmarker ohne gemeldeten Ausfall`)
    return b
  }

  let ausfallLaeuft = false

  // ---- Storno -------------------------------------------------------------------

  async function storniere(v: Verkauf): Promise<void> {
    const res = await post('/api/belege/storno', { kasseId, verweisBelegId: v.response.id })
    if (res.statusCode !== 201) {
      melde('fehler', 'storno-abgelehnt', `Beleg ${v.response.belegNummer}: HTTP ${res.statusCode} ${res.body.slice(0, 160)}`)
      return
    }
    const s = res.json() as BelegResponse
    merke(s)
    statistik.stornos++
    const o = v.response
    // RECHTLICH ZENTRAL: Ein Storno muss den Originalbeleg auf den Cent genau aufheben (je Steuersatz und je Zahlungsart)
    for (const k of SAETZE) {
      pruefe(s.betraege[k] === -o.betraege[k], 'storno-hebt-original-auf',
        () => `Storno ${s.belegNummer} zu ${o.belegNummer}, Satz ${k}: ${s.betraege[k]} statt ${-o.betraege[k]}`)
    }
    pruefe(s.gesamtbetragCent === -o.gesamtbetragCent, 'storno-gesamtbetrag', () => `Storno ${s.belegNummer}: ${s.gesamtbetragCent} statt ${-o.gesamtbetragCent}`)
    pruefe(s.summeBarCent === -o.summeBarCent && s.summeKarteCent === -o.summeKarteCent && s.summeSonstigeCent === -o.summeSonstigeCent,
      'storno-zahlungsart', () => `Storno ${s.belegNummer}: Zahlungsaufteilung nicht das Negativ des Originals`)
    pruefe(s.verweisBelegId === o.id, 'storno-verweis', () => `Storno ${s.belegNummer}: Verweis fehlt/falsch`)
  }

  /**
   * Sonde „halber Cent": Menge × Preis ergibt genau x,5 Cent (z. B. 0,5 kg zu 3,33 €). Der Verkauf wird mit dem
   * Betrag gebucht, den die Kassa selbst rechnet. RECHTLICH ZENTRAL ist, dass sich ein solcher Beleg danach
   * stornieren lässt — ein Storno muss immer gehen und das Original auf den Cent aufheben.
   */
  async function tieSonde(): Promise<void> {
    const a = artikel.find(x => x.name === 'Krummer Preis A')!
    const menge = wahl([0.5, 1.5, 2.5, 4.5])
    const summe = Math.round(menge * a.preis)
    const res = await post('/api/belege/barzahlung', {
      kasseId, positionen: [{ artikelId: a.id, menge }], zahlung: { barCent: summe, karteCent: 0, sonstigeCent: 0 },
    })
    if (res.statusCode !== 201) {
      melde('hinweis', 'halber-cent-verkauf-abgelehnt', `${menge} × ${a.preis} ct: HTTP ${res.statusCode} ${res.body.slice(0, 140)}`)
      return
    }
    const b = res.json() as BelegResponse
    merke(b)
    statistik.verkaeufe++
    const s = await post('/api/belege/storno', { kasseId, verweisBelegId: b.id })
    if (s.statusCode !== 201) {
      melde('fehler', 'storno-bei-halbem-cent-unmoeglich',
        `Beleg ${b.belegNummer} (${menge} × ${a.preis} ct = ${b.gesamtbetragCent} ct): Storno HTTP ${s.statusCode} ${s.body.slice(0, 150)}`)
      return
    }
    const sb = s.json() as BelegResponse
    merke(sb)
    statistik.stornos++
    pruefe(sb.gesamtbetragCent === -b.gesamtbetragCent, 'storno-bei-halbem-cent-betrag',
      () => `Beleg ${b.belegNummer}: Original ${b.gesamtbetragCent} ct, Storno ${sb.gesamtbetragCent} ct`)
  }

  /** Muss abgelehnt werden (4xx) und darf KEINE Belegnummer verbrauchen — das prüft die Lückenlosigkeit am Ende der Runde. */
  async function erwarteAblehnung(name: string, url: string, payload: unknown): Promise<void> {
    const res = await post(url, payload)
    statistik.abgelehnt++
    pruefe(res.statusCode >= 400 && res.statusCode < 500, `ablehnung-${name}`, () => `erwartet 4xx, bekam ${res.statusCode}`)
    if (res.statusCode === 201) {
      // Fälschlich angenommen: trotzdem verbuchen, damit der Umsatzzähler der Kontrolle nicht auseinanderläuft
      merke(res.json() as BelegResponse)
    }
  }

  // ---- Runde ----------------------------------------------------------------------

  async function ausfallZyklus(): Promise<void> {
    const r1 = await post('/api/belege/see-ausfall', { kasseId })
    pruefe(r1.statusCode === 200 && r1.json().ausgefallen === true, 'see-ausfall-melden', () => `HTTP ${r1.statusCode} ${r1.body.slice(0, 120)}`)
    ausfallLaeuft = true
    const st = await get(`/api/belege/see-status?kasseId=${kasseId}`)
    pruefe(st.json().ausgefallen === true, 'see-status-ausgefallen', () => st.body.slice(0, 120))

    const n = ganz(3, 8)
    for (let i = 0; i < n; i++) {
      const b = await verkaufe()
      if (b) {
        statistik.ausfall++
        pruefe(b.signaturwert === AUSFALL_MARKER, 'ausfallbeleg-marker', () => `Beleg ${b.belegNummer} ohne Ausfallmarker während des Ausfalls`)
      }
    }
    const r2 = await post('/api/belege/see-wiederherstellung', { kasseId })
    pruefe(r2.statusCode === 200 || r2.statusCode === 201, 'see-wiederherstellung', () => `HTTP ${r2.statusCode} ${r2.body.slice(0, 160)}`)
    ausfallLaeuft = false
    if (r2.statusCode < 300) {
      const sammel = (r2.json() as { sammelbeleg: BelegResponse }).sammelbeleg
      merke(sammel)
      pruefe(sammel.signaturwert !== AUSFALL_MARKER, 'sammelbeleg-signiert', () => `Sammelbeleg ${sammel.belegNummer} ist nicht signiert`)
    }
    const st2 = await get(`/api/belege/see-status?kasseId=${kasseId}`)
    pruefe(st2.json().ausgefallen === false, 'see-status-nach-wiederherstellung', () => st2.body.slice(0, 120))
  }

  async function nullartig(pfad: 'nullbeleg' | 'monatsbeleg' | 'jahresbeleg'): Promise<void> {
    const res = await post(`/api/belege/${pfad}`, { kasseId })
    if (res.statusCode !== 201) { melde('fehler', `${pfad}-abgelehnt`, `HTTP ${res.statusCode} ${res.body.slice(0, 160)}`); return }
    const b = res.json() as BelegResponse
    merke(b)
    statistik.nullartig++
    pruefe(b.gesamtbetragCent === 0 && b.positionen.length === 0, `${pfad}-ohne-betrag`, () => `Beleg ${b.belegNummer}: Betrag ${b.gesamtbetragCent}`)
  }

  async function neustart(): Promise<void> {
    await srv.close()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    statistik.neustarts++
  }

  // ---- Prüfung des Gesamtbestands ---------------------------------------------------

  async function pruefeBestand(abschliessend: boolean): Promise<void> {
    const [k] = await idb.db.select().from(kassen).where(eq(kassen.id, kasseId))
    const aes = Buffer.from(decryptPrivateKey(k!.aesSchluesselEnc!, TEST_MASTER) as unknown as Buffer)
    const zertDER = Buffer.from(k!.seeZertifikatDer, 'base64')

    const dep131Res = await get(`/api/belege/dep131?kasseId=${kasseId}`)
    pruefe(dep131Res.statusCode === 200, 'dep131-abruf', () => `HTTP ${dep131Res.statusCode}`)
    const dep131 = dep131Res.json() as { Belege: Record<string, any>[]; kassenId: string }
    const belege: PrueferBeleg[] = dep131.Belege.map(b => ({
      belegTyp:                    b.Belegtyp,
      belegNummer:                 b.Belegnummer,
      datumUhrzeit:                b.DatumUhrzeit,
      betraege: { normal: b.Betraege.NormalCent, ermaessigt1: b.Betraege.Ermaessigt1Cent, ermaessigt2: b.Betraege.Ermaessigt2Cent,
                  null: b.Betraege.NullCent, besonders: b.Betraege.BesondersCent },
      zahlung:  { barCent: b.Zahlung.BarCent, karteCent: b.Zahlung.KarteCent, sonstigeCent: b.Zahlung.SonstigeCent },
      maschinenlesbareCode:        b.MaschinenlesbareCode,
      signaturwert:                b.Signaturwert,
      umsatzzaehlerVerschluesselt: b.UmsatzzaehlerVerschluesselt,
      zertifikatSN:                b.ZertifikatSN,
      sigVorbeleg:                 b.SigVorbeleg,
    }))

    // 1) unabhängiger Prüfer über die komplette Kette
    const erg = pruefeBelegfolge(belege, { kassenId: k!.kassenId, zertifikatDER: zertDER, aesSchluessel: aes })
    for (const v of erg.verstoesse) melde('fehler', `pruefer-${v.regel}`, `Beleg ${v.belegNummer}: ${v.detail}`)

    // 2) Bestand der Kassa = alles, was der Testtreiber erzeugt hat (kein Beleg verloren, keiner dazugekommen)
    pruefe(belege.length === lokal.size, 'anzahl-belege', () => `Export ${belege.length}, Testtreiber ${lokal.size}`)
    for (const b of belege) {
      const l = lokal.get(b.belegNummer)
      if (!l) { melde('fehler', 'beleg-unbekannt', `Beleg ${b.belegNummer} im Export, aber nicht vom Testtreiber erzeugt`); continue }
      pruefe(l.maschinenlesbareCode === b.maschinenlesbareCode, 'export-gleich-antwort', () => `Beleg ${b.belegNummer}: Code im Export weicht von der Antwort ab`)
      pruefe(l.belegTyp === b.belegTyp, 'export-typ', () => `Beleg ${b.belegNummer}: ${l.belegTyp} ≠ ${b.belegTyp}`)
    }
    pruefe(erg.zaehlerEnde === zaehlerErwartet, 'umsatzzaehler-summe', () => `Zähler der Kassa ${erg.zaehlerEnde}, Summe aller Antworten ${zaehlerErwartet}`)

    // 3) DEP7
    const dep7Res = await get(`/api/belege/dep7?kasseId=${kasseId}`)
    pruefe(dep7Res.statusCode === 200, 'dep7-abruf', () => `HTTP ${dep7Res.statusCode}`)
    if (dep7Res.statusCode === 200) {
      for (const v of pruefeDep7(dep7Res.json(), belege, k!.seeZertifikatDer)) melde('fehler', `pruefer-${v.regel}`, `Beleg ${v.belegNummer}: ${v.detail}`)
    }

    // 4) Signatur-Selbsttest der Kassa
    const st = await get(`/api/rksv/signatur-selbsttest?kasseId=${kasseId}`)
    if (st.statusCode === 200) {
      const s = st.json()
      pruefe(s.ungueltig === 0 && s.derAltformat === 0, 'selbsttest-signaturen', () => `ungültig ${s.ungueltig}, Altformat ${s.derAltformat}`)
      pruefe(s.ketteOk === true && s.nummernLueckenlos === true, 'selbsttest-kette', () => `Kette ${s.ketteOk}, lückenlos ${s.nummernLueckenlos}`)
      pruefe(s.geprueft === belege.length, 'selbsttest-anzahl', () => `${s.geprueft} ≠ ${belege.length}`)
      pruefe(s.ausfall === erg.ausfallBelege, 'selbsttest-ausfall', () => `Kassa ${s.ausfall} ≠ Prüfer ${erg.ausfallBelege}`)
    } else melde('fehler', 'selbsttest-abruf', `HTTP ${st.statusCode}`)

    // 5) Tagesabschluss (Z-Bon) gegen die Summen des Testtreibers — nur wenn alle Belege am selben Wiener Kalendertag liegen
    const tag = (d: string) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
    const tage = new Set([...lokal.values()].map(b => tag(b.belegDatum)))
    if (tage.size === 1) {
      const datum = [...tage][0]!
      const ta = await get(`/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${datum}`)
      if (ta.statusCode === 200) {
        const z = ta.json()
        const umsatz = [...lokal.values()].filter(b => b.belegTyp === 'Barzahlungsbeleg' || b.belegTyp === 'Stornobeleg')
        const summe = (f: (b: BelegResponse) => number) => umsatz.reduce((s, b) => s + f(b), 0)
        pruefe(z.barCent === summe(b => b.summeBarCent), 'tagesabschluss-bar', () => `${z.barCent} ≠ ${summe(b => b.summeBarCent)}`)
        pruefe(z.karteCent === summe(b => b.summeKarteCent), 'tagesabschluss-karte', () => `${z.karteCent} ≠ ${summe(b => b.summeKarteCent)}`)
        pruefe(z.sonstigCent === summe(b => b.summeSonstigeCent), 'tagesabschluss-sonstig', () => `${z.sonstigCent} ≠ ${summe(b => b.summeSonstigeCent)}`)
        pruefe(z.anzahlBarzahlungsbelege === umsatz.filter(b => b.belegTyp === 'Barzahlungsbeleg').length, 'tagesabschluss-anzahl-bar', () => `${z.anzahlBarzahlungsbelege}`)
        pruefe(z.anzahlStornobelege === umsatz.filter(b => b.belegTyp === 'Stornobeleg').length, 'tagesabschluss-anzahl-storno', () => `${z.anzahlStornobelege}`)
        const brutto = summe(b => b.gesamtbetragCent)
        const mwstBrutto = (z.mwst as { bruttoCent: number }[]).reduce((s, m) => s + m.bruttoCent, 0)
        // Hinweis: Die USt-Zeilen zeigen nur Sätze mit Umsatz ≠ 0, die Summe muss trotzdem der Gesamtsumme entsprechen
        pruefe(mwstBrutto === brutto, 'tagesabschluss-mwst-brutto', () => `USt-Zeilen brutto ${mwstBrutto} ≠ Gesamtumsatz ${brutto}`)
        for (const m of z.mwst as { satzKey: string; nettoCent: number; ustCent: number; bruttoCent: number }[]) {
          pruefe(m.nettoCent + m.ustCent === m.bruttoCent, 'tagesabschluss-netto-steuer', () => `${m.satzKey}: ${m.nettoCent}+${m.ustCent} ≠ ${m.bruttoCent}`)
        }
      } else melde('fehler', 'tagesabschluss-abruf', `HTTP ${ta.statusCode}`)
    }

    if (abschliessend) {
      // Lückenlosigkeit nach allen abgelehnten Anfragen: es darf keine Nummer fehlen (im Prüfer bereits enthalten)
      pruefe(erg.verstoesse.length === 0, 'abschluss-kette-sauber', () => `${erg.verstoesse.length} Verstöße im Gesamtbestand`)
    }
    console.log(`    Bestand geprüft: ${belege.length} Belege, ${erg.signaturGeprueft} Signaturen, ${erg.ausfallBelege} Ausfallbelege, Zähler ${erg.zaehlerEnde} ct, Verstöße ${erg.verstoesse.length}`)
  }

  // ---- Aufbau / Abbau ---------------------------------------------------------------

  beforeAll(async () => {
    idb = await erstelleIntegrationsDb()
    srv = await buildTestServer(idb.db, { finanzOnlineClient: mockFoClient() })
    const setup = await srv.fastify.inject({
      method: 'POST', url: '/api/setup',
      payload: {
        firmenname: 'Burn-in GmbH', uid: 'ATU99999911', kassenId: KASSEN_ID,
        finanzOnline: { teilnehmerId: 'TID-BI', benutzerkennung: 'BID-BI', pin: 'PIN-BI' },
        umgebung: 'test',
        admin: { name: 'BI Admin', email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
      },
    })
    if (setup.statusCode !== 201) throw new Error(`Setup fehlgeschlagen (${setup.statusCode}): ${setup.body}`)
    const login = (await srv.fastify.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: ADMIN_EMAIL, passwort: ADMIN_PASSWORT },
    })).json()
    token   = login.token
    kasseId = login.kassen[0].id

    for (const d of ARTIKEL_DEFS) {
      const res = await post('/api/artikel', { bezeichnung: d.name, preisBruttoCent: d.preis, mwstSatz: d.satz })
      if (res.statusCode !== 201) throw new Error(`Artikel ${d.name}: HTTP ${res.statusCode} ${res.body}`)
      artikel.push({ id: res.json().id, preis: d.preis, satz: d.satz, name: d.name })
    }

    // Startbeleg (Nr. 1) in den Bestand des Testtreibers übernehmen
    const liste = (await get(`/api/belege?kasseId=${kasseId}&limit=500`)).json() as BelegResponse[]
    for (const b of liste) merke(b)
  }, 120_000)

  afterAll(async () => {
    await srv?.close()
    await idb?.zerstoeren()
  })

  it(`läuft ${MINUTEN ? MINUTEN + ' Minuten' : ZIEL_BELEGE + ' Belege'} (Seed ${SEED}) ohne einen RKSV-Verstoß`, async () => {
    const start = Date.now()
    console.log(`\n=== RKSV-BURN-IN  Seed ${SEED}  Ziel ${MINUTEN ? MINUTEN + ' min' : ZIEL_BELEGE + ' Belege'}  Welle ${WELLE} ===`)
    const fertig = () => MINUTEN ? (Date.now() - start) / 60_000 >= MINUTEN : lokal.size >= ZIEL_BELEGE

    let runde = 0
    while (!fertig()) {
      runde++; aktuelleRunde = runde
      const t0 = Date.now()
      const vorher = lokal.size

      // A) nacheinander verkaufen
      for (let i = ganz(30, 60); i > 0; i--) await verkaufe()

      // B) parallele Welle: Verkäufe + Stornos + Nullbeleg gleichzeitig auf derselben Kasse
      statistik.parallelWellen++
      const stornoKandidaten = stornierbar.splice(0, ganz(1, 3))
      await Promise.all([
        ...Array.from({ length: ganz(Math.ceil(WELLE / 2), WELLE) }, () => verkaufe()),
        ...stornoKandidaten.map(v => storniere(v)),
        nullartig('nullbeleg'),
      ])

      // C) Stornos nacheinander + verbotene Stornos
      for (let i = ganz(2, 6); i > 0 && stornierbar.length > 0; i--) {
        const idx = ganz(0, stornierbar.length - 1)
        await storniere(stornierbar.splice(idx, 1)[0]!)
      }
      const schonStorniert = verkaeufe_bereits_storniert()
      if (schonStorniert) {
        await erwarteAblehnung('doppelstorno', '/api/belege/storno', { kasseId, verweisBelegId: schonStorniert.response.id })
      }
      const einStorno = [...lokal.values()].find(b => b.belegTyp === 'Stornobeleg')
      if (einStorno) await erwarteAblehnung('storno-eines-storno', '/api/belege/storno', { kasseId, verweisBelegId: einStorno.id })
      const einNull = [...lokal.values()].find(b => b.belegTyp === 'Nullbeleg')
      if (einNull) await erwarteAblehnung('storno-eines-nullbelegs', '/api/belege/storno', { kasseId, verweisBelegId: einNull.id })

      await tieSonde()

      // D) absichtlich falsche Anfragen — dürfen KEINE Belegnummer verbrauchen
      const a = wahl(artikel)
      await erwarteAblehnung('zahlung-ungleich-betrag', '/api/belege/barzahlung',
        { kasseId, positionen: [{ artikelId: a.id, menge: 1 }], zahlung: { barCent: a.preis + 5, karteCent: 0, sonstigeCent: 0 } })
      await erwarteAblehnung('ohne-positionen', '/api/belege/barzahlung',
        { kasseId, positionen: [], zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 0 } })
      await erwarteAblehnung('unbekannter-artikel', '/api/belege/barzahlung',
        { kasseId, positionen: [{ artikelId: '00000000-0000-4000-8000-000000000999', menge: 1 }], zahlung: { barCent: 100, karteCent: 0, sonstigeCent: 0 } })
      await erwarteAblehnung('menge-null', '/api/belege/barzahlung',
        { kasseId, positionen: [{ artikelId: a.id, menge: 0 }], zahlung: { barCent: 0, karteCent: 0, sonstigeCent: 0 } })

      // E) Null-/Monats-/Jahresbelege
      if (runde % 2 === 0) await nullartig('nullbeleg')
      if (runde % 3 === 0) await nullartig('monatsbeleg')
      if (runde === 4)     await nullartig('jahresbeleg')

      // F) SEE-Ausfall und Wiederinbetriebnahme
      if (runde % 4 === 2) await ausfallZyklus()

      // G) Neustart des Servers mitten im Betrieb (Zustand muss aus der DB kommen)
      if (runde % 5 === 0) { await neustart(); await verkaufe() }

      console.log(`  Runde ${runde}: +${lokal.size - vorher} Belege (gesamt ${lokal.size}) in ${((Date.now() - t0) / 1000).toFixed(1)} s, Fehler bisher ${fehler.length}`)

      // H) Gesamtprüfung
      await pruefeBestand(false)
    }

    // Abschluss: nochmal alles prüfen
    aktuelleRunde = runde + 1
    await pruefeBestand(true)

    // ---- Bericht ----
    const dauerS = Math.round((Date.now() - start) / 1000)
    const ergebnis = {
      seed: SEED, dauerSekunden: dauerS, runden: runde, belege: lokal.size,
      umsatzzaehlerCent: zaehlerErwartet.toString(),
      statistik, fehlerAnzahl: fehler.length, hinweisAnzahl: hinweise.length,
      haeufigkeit: Object.fromEntries(zaehlerProRegel),
      fehler, hinweise,
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync(`test-results/burnin-${SEED}.json`, JSON.stringify(ergebnis, null, 2))
    writeFileSync(`test-results/burnin-${SEED}.md`, bericht(ergebnis))
    console.log(`\n=== ERGEBNIS: ${lokal.size} Belege, ${runde} Runden, ${dauerS} s → ${fehler.length} Fehler, ${hinweise.length} Hinweise ===`)
    console.log(`    Bericht: test-results/burnin-${SEED}.md`)
    for (const m of fehler.slice(0, 25)) console.log(`    FEHLER [${m.regel}] Runde ${m.runde}: ${m.detail}`)

    expect(fehler, `RKSV-Verstöße (siehe test-results/burnin-${SEED}.md)`).toEqual([])
  }, 12 * 60 * 60_000)

  function verkaeufe_bereits_storniert(): Verkauf | undefined {
    const storniert = new Set([...lokal.values()].filter(b => b.belegTyp === 'Stornobeleg').map(b => b.verweisBelegId))
    return verkaeufe.find(v => storniert.has(v.response.id))
  }
})

// ---------------------------------------------------------------------------
// Bericht
// ---------------------------------------------------------------------------

function bericht(e: {
  seed: number; dauerSekunden: number; runden: number; belege: number; umsatzzaehlerCent: string
  statistik: Record<string, number>; fehlerAnzahl: number; hinweisAnzahl: number
  haeufigkeit: Record<string, number>; fehler: Meldung[]; hinweise: Meldung[]
}): string {
  const zeilen: string[] = []
  zeilen.push(`# RKSV-Burn-in – Ergebnis`, '')
  zeilen.push(`**${e.fehlerAnzahl === 0 ? 'BESTANDEN' : 'NICHT BESTANDEN'}** — ${e.fehlerAnzahl} Fehler, ${e.hinweisAnzahl} Hinweise`, '')
  zeilen.push(`| | |`, `|---|---|`)
  zeilen.push(`| Seed (zum Wiederholen) | ${e.seed} |`, `| Dauer | ${e.dauerSekunden} s |`, `| Runden | ${e.runden} |`)
  zeilen.push(`| Belege gesamt | ${e.belege} |`, `| Umsatzzähler am Ende | ${e.umsatzzaehlerCent} ct |`)
  for (const [k, v] of Object.entries(e.statistik)) zeilen.push(`| ${k} | ${v} |`)
  zeilen.push('', '## Geprüft', '',
    '- Belegnummern lückenlos, Zeitstempel nicht rückläufig, Startbeleg als Erster',
    '- Aufbau des maschinenlesbaren Codes, alle Felder = Belegdaten, Zertifikat-Seriennummer',
    '- Verkettung (SHA-256, 8 Byte) über die ganze Kette, auch über Ausfallbelege hinweg',
    '- ES256-Signatur jedes Belegs gegen das Zertifikat (unabhängig nachgerechnet)',
    '- Umsatzzähler (AES-256-CTR) entschlüsselt = laufende Summe; Nullartige Belege ohne Betrag',
    '- Beträge je Steuersatz gegen exakte Ganzzahl-Rechnung; Storno = Negativ des Originals je Satz und Zahlungsart',
    '- Verbotene Stornos (doppelt, Storno eines Stornos, Nullbeleg) und fehlerhafte Anfragen werden abgelehnt, ohne Lücke',
    '- SEE-Ausfall: Marker statt Signatur, Sammelbeleg signiert; Neustart mitten im Betrieb; parallele Zugriffe',
    '- DEP131 und DEP7 (Inhalt = Belege), Signatur-Selbsttest der Kassa, Tagesabschluss gegen Summen des Testtreibers')
  if (e.fehler.length) {
    zeilen.push('', '## Fehler', '', '| Regel | Anzahl | Beispiele (Runde: Detail) |', '|---|---|---|')
    const regeln = [...new Set(e.fehler.map(f => f.regel))]
    for (const r of regeln) {
      const bsp = e.fehler.filter(f => f.regel === r).slice(0, 3).map(f => `R${f.runde}: ${f.detail}`).join(' ; ')
      zeilen.push(`| ${r} | ${e.haeufigkeit['fehler:' + r] ?? '?'} | ${bsp.replace(/\|/g, '/')} |`)
    }
  }
  if (e.hinweise.length) {
    zeilen.push('', '## Hinweise (kein Verstoß gegen eine harte Regel)', '', '| Regel | Anzahl | Beispiele |', '|---|---|---|')
    const regeln = [...new Set(e.hinweise.map(f => f.regel))]
    for (const r of regeln) {
      const bsp = e.hinweise.filter(f => f.regel === r).slice(0, 3).map(f => f.detail).join(' ; ')
      zeilen.push(`| ${r} | ${e.haeufigkeit['hinweis:' + r] ?? '?'} | ${bsp.replace(/\|/g, '/')} |`)
    }
  }
  return zeilen.join('\n') + '\n'
}
