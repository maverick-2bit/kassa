/**
 * Der Python-Zweitprüfer (scripts/rksv/dep7_pruefer.py) — selbst geprüft und auf die Kassa angewendet.
 *
 * 1. Er muss die BMF-Referenzdaten fehlerfrei durchwinken (fremd erzeugt: sonst taugt sein Urteil nichts).
 * 2. Er muss absichtlich veränderte DEP7-Exporte erkennen (Gegenprobe des Prüfers — ein Prüfer, der nie
 *    anschlägt, wäre wertlos).
 * 3. Dann erst wird er auf Belege angewendet, die die Kassa mit ihrer echten Signierlogik erzeugt.
 *
 * Läuft nur, wenn Python 3 gefunden wird (in der CI vorhanden); ohne Python werden die Tests übersprungen.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import type { DEP7Export } from '../src/types.js'
import { verkettungswertFolgebeleg } from '../src/crypto/chain.js'
import { REPO_WURZEL, baueContainer, baueEigenenExport, ladeBmfSzenario, type CryptoContainer } from './helpers/pruef-export.js'

const SKRIPT = join(REPO_WURZEL, 'scripts', 'rksv', 'dep7_pruefer.py')

/** Erster funktionierender Python-3-Aufruf (Windows: Starter `py`; der Microsoft-Store-Platzhalter `python3` zählt nicht). */
function findePython(): string[] | null {
  for (const kandidat of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(kandidat[0]!, [...kandidat.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8' })
    if (r.status === 0) return kandidat
  }
  return null
}
const PYTHON = findePython()

interface Lauf { exit: number; bericht: { geprueft: number; signaturenGeprueft: number; ausfallbelege: number; verstoesseGesamt: number; verstoesseJeRegel: Record<string, number>; verstoesse: { beleg: number; regel: string; detail: string }[] }; ausgabe: string }

function pruefe(dep7: DEP7Export, container: CryptoContainer, extra: string[] = []): Lauf {
  const ordner = mkdtempSync(join(tmpdir(), 'kassa-dep7-'))
  try {
    writeFileSync(join(ordner, 'dep.json'), JSON.stringify(dep7))
    writeFileSync(join(ordner, 'crypto.json'), JSON.stringify(container))
    // -I: isolierter Modus (keine Umgebungsvariablen, kein aktuelles Verzeichnis im Suchpfad)
    const r = spawnSync(PYTHON![0]!, [...PYTHON!.slice(1), '-I', SKRIPT,
      '--dep7', join(ordner, 'dep.json'), '--crypto', join(ordner, 'crypto.json'), '--bericht', join(ordner, 'bericht.json'), ...extra],
      { encoding: 'utf8' })
    let bericht: Lauf['bericht']
    try { bericht = JSON.parse(readFileSync(join(ordner, 'bericht.json'), 'utf8')) } catch { bericht = { geprueft: 0, signaturenGeprueft: 0, ausfallbelege: 0, verstoesseGesamt: -1, verstoesseJeRegel: {}, verstoesse: [] } }
    return { exit: r.status ?? -1, bericht, ausgabe: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(ordner, { recursive: true, force: true })
  }
}

const regeln = (l: Lauf): string[] => Object.keys(l.bericht.verstoesseJeRegel).sort()

/** Bekannter, im Produktivcode noch offener Befund: D = AT0-Seriennummernformat (Befund A, die Verkettung, ist behoben) */
const BEKANNT = 'zksn-format'

describe.skipIf(!PYTHON)('Python-Zweitprüfer', () => {
  it('Selbsttest: AES-256 (FIPS-197) und ECDSA P-256 (von OpenSSL erzeugte Vektoren) sind grün', () => {
    const r = spawnSync(PYTHON![0]!, [...PYTHON!.slice(1), '-I', SKRIPT, '--selbsttest'], { encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('Selbsttest ok')
    expect(r.status).toBe(0)
  })

  // -------------------------------------------------------------------------------------------------------------
  describe('gegen die BMF-Referenzdaten (fremd erzeugt)', () => {
    it('geschlossenes System (AT0, öffentliche Schlüssel): 81 Belege, 57 Signaturen, 24 Ausfallbelege, keine Verstöße', () => {
      const s = ladeBmfSzenario('closed-system-1')
      const l = pruefe(s.dep7, s.container)
      expect(l.ausgabe).toContain('0 Verstöße')
      expect(l.bericht).toMatchObject({ geprueft: 81, signaturenGeprueft: 57, ausfallbelege: 24, verstoesseGesamt: 0 })
      expect(l.exit).toBe(0)
    })

    it('offenes System (AT100, Zertifikate): dasselbe — bis auf die Seriennummer, die das BMF-Beispiel als Zweierkomplement trägt', () => {
      const s = ladeBmfSzenario('open-system-1')
      const l = pruefe(s.dep7, s.container)
      expect(regeln(l)).toEqual(['zertifikat-sn'])
      const ohne = pruefe(s.dep7, s.container, ['--ignoriere', 'zertifikat-sn'])
      expect(ohne.bericht).toMatchObject({ geprueft: 81, signaturenGeprueft: 57, ausfallbelege: 24, verstoesseGesamt: 0 })
      expect(ohne.exit).toBe(0)
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe('erkennt Veränderungen (Gegenprobe des Prüfers; 20 Belege des geschlossenen BMF-Systems als saubere Basis)', () => {
    const basis = (() => {
      const s = ladeBmfSzenario('closed-system-1')
      const gruppe = s.dep7['Belege-Gruppe'][0]!
      return { container: s.container, jws: gruppe['Belege-kompakt'].slice(0, 20), zertifikat: gruppe.Signaturzertifikat }
    })()
    const mitJws = (jws: string[]): DEP7Export => ({ 'Belege-Gruppe': [{ Signaturzertifikat: basis.zertifikat, Zertifizierungsstellen: [], 'Belege-kompakt': jws }] })
    const nutzlast = (jws: string): string => Buffer.from(jws.split('.')[1]!, 'base64url').toString('utf8')
    const mitNutzlast = (jws: string, neu: string): string => { const t = jws.split('.'); t[1] = Buffer.from(neu, 'utf8').toString('base64url'); return t.join('.') }
    const AUSFALL_B64URL = 'U2ljaGVyaGVpdHNlaW5yaWNodHVuZyBhdXNnZWZhbGxlbg'
    /** Erster Beleg mit echter Signatur, einem Betrag im ersten Feld und verschlüsseltem Zähler (kein Ausfall, kein TRA/STO) */
    const k = basis.jws.findIndex(j => {
      const f = nutzlast(j).split('_')
      return j.split('.')[2] !== AUSFALL_B64URL && f[5] !== '0,00' && !['VFJB', 'U1RP'].includes(f[10]!)
    })

    it('Basis: die 20 Belege sind sauber', () => {
      const l = pruefe(mitJws(basis.jws), basis.container)
      expect(l.bericht.verstoesse).toEqual([])
      expect(l.exit).toBe(0)
      expect(l.bericht.geprueft).toBe(20)
      expect(k).toBeGreaterThan(0)
    })

    it('geänderter Betrag → Signatur, Verkettung des Folgebelegs und Umsatzzähler schlagen an', () => {
      const jws = [...basis.jws]
      jws[k] = mitNutzlast(jws[k]!, nutzlast(jws[k]!).replace(/_(\d+),(\d{2})_/, (_m, e, c) => `_${e},${(Number(c) + 1) % 100 === 0 ? '01' : String((Number(c) + 1) % 100).padStart(2, '0')}_`))
      const l = pruefe(mitJws(jws), basis.container)
      expect(regeln(l)).toEqual(expect.arrayContaining(['signatur', 'verkettung', 'umsatzzaehler']))
      expect(l.exit).toBe(1)
    })

    it('vertauschte Signatur → Signatur', () => {
      const jws = [...basis.jws]
      const andere = basis.jws.findIndex((j, i) => i > k && j.split('.')[2] !== AUSFALL_B64URL)
      const t = jws[k]!.split('.'); t[2] = jws[andere]!.split('.')[2]!; jws[k] = t.join('.')
      const l = pruefe(mitJws(jws), basis.container)
      expect(regeln(l)).toContain('signatur')
    })

    it('gelöschter Beleg → Belegnummer und Verkettung', () => {
      const jws = basis.jws.filter((_, i) => i !== 7)
      const l = pruefe(mitJws(jws), basis.container)
      expect(regeln(l)).toEqual(expect.arrayContaining(['belegnummer', 'verkettung']))
    })

    it('vertauschte Reihenfolge → Belegnummer und Verkettung', () => {
      const jws = [...basis.jws]
      ;[jws[8], jws[9]] = [jws[9]!, jws[8]!]
      const l = pruefe(mitJws(jws), basis.container)
      expect(regeln(l)).toEqual(expect.arrayContaining(['belegnummer', 'verkettung']))
    })

    it('verändertes Zählerfeld → Umsatzzähler (und Signatur)', () => {
      const jws = [...basis.jws]
      jws[k] = mitNutzlast(jws[k]!, nutzlast(jws[k]!).split('_').map((f, i) => (i === 10 ? Buffer.from(Buffer.from(f, 'base64').map((b, j) => (j === 5 ? b ^ 1 : b))).toString('base64') : f)).join('_'))
      const l = pruefe(mitJws(jws), basis.container)
      expect(regeln(l)).toEqual(expect.arrayContaining(['umsatzzaehler', 'signatur']))
    })

    it('fremde Kassen-ID in einem Beleg → Kassen-ID', () => {
      const jws = [...basis.jws]
      jws[k] = mitNutzlast(jws[k]!, nutzlast(jws[k]!).replace('CASHBOX-DEMO-1_', 'ANDERE-KASSE_'))
      expect(regeln(pruefe(mitJws(jws), basis.container))).toContain('kassen-id')
    })

    it('Datum rückwärts → Zeit', () => {
      const jws = [...basis.jws]
      jws[k] = mitNutzlast(jws[k]!, nutzlast(jws[k]!).replace(/_(\d{4})-/, (_m, j) => `_${Number(j) - 1}-`))
      expect(regeln(pruefe(mitJws(jws), basis.container))).toContain('zeit-rueckwaerts')
    })

    it('falscher Header-Algorithmus → JWS-Format', () => {
      const jws = [...basis.jws]
      const t = jws[k]!.split('.'); t[0] = Buffer.from('{"alg":"none"}').toString('base64url'); jws[k] = t.join('.')
      expect(regeln(pruefe(mitJws(jws), basis.container))).toContain('jws-format')
    })

    it('abgeschnittenes JWS → JWS-Format', () => {
      const jws = [...basis.jws]
      jws[k] = jws[k]!.split('.').slice(0, 2).join('.')
      expect(regeln(pruefe(mitJws(jws), basis.container))).toContain('jws-format')
    })

    it('falscher AES-Schlüssel → Umsatzzähler', () => {
      const falsch: CryptoContainer = { ...basis.container, base64AESKey: Buffer.alloc(32, 7).toString('base64') }
      expect(regeln(pruefe(mitJws(basis.jws), falsch))).toContain('umsatzzaehler')
    })

    it('fremder öffentlicher Schlüssel → Signatur', () => {
      const andere = ladeBmfSzenario('closed-system-1').container.certificateOrPublicKeyMap
      const ids = Object.keys(andere)
      const getauscht: CryptoContainer = { ...basis.container, certificateOrPublicKeyMap: Object.fromEntries(ids.map((id, i) => [id, { ...andere[id]!, signatureCertificateOrPublicKey: andere[ids[(i + 1) % ids.length]!]!.signatureCertificateOrPublicKey }])) }
      expect(regeln(pruefe(mitJws(basis.jws), getauscht))).toContain('signatur')
    })

    it('unbekannte Schlüsselkennung → Schlüssel fehlt', () => {
      expect(regeln(pruefe(mitJws(basis.jws), { ...basis.container, certificateOrPublicKeyMap: {} }))).toContain('schluessel-fehlt')
    })

    it('--ignoriere nimmt eine Regel aus der Wertung', () => {
      const jws = basis.jws.filter((_, i) => i !== 7)
      const l = pruefe(mitJws(jws), basis.container, ['--ignoriere', 'belegnummer,verkettung'])
      expect(regeln(l)).not.toContain('belegnummer')
      expect(regeln(l)).not.toContain('verkettung')
    })
  })

  // -------------------------------------------------------------------------------------------------------------
  describe('auf Belege der Kassa angewendet (echte Signierlogik, Software-SEE AT0)', () => {
    let eigen: Awaited<ReturnType<typeof baueEigenenExport>>
    beforeAll(async () => { eigen = await baueEigenenExport(40) })

    it('Signaturen (ES256, P1363), Verkettung, Umsatzzähler (AES), Format, Seriennummer, Belegnummern, Zeit: alles sauber — AT0-Seriennummernformat (D) ausgenommen', () => {
      const l = pruefe(eigen.dep7, eigen.container, ['--ignoriere', BEKANNT])
      expect(l.bericht.verstoesse).toEqual([])
      expect(l.bericht.geprueft).toBe(40)
      expect(l.bericht.ausfallbelege).toBeGreaterThan(0)
      expect(l.bericht.signaturenGeprueft + l.bericht.ausfallbelege).toBe(40)
      expect(l.exit).toBe(0)
    })

    it('auch mit nur dem öffentlichen Schlüssel statt des Zertifikats im Container', () => {
      const l = pruefe(eigen.dep7, baueContainer(eigen.see, 'PUBLIC_KEY'), ['--ignoriere', BEKANNT])
      expect(l.bericht.verstoesse).toEqual([])
    })

    it('ohne Container-Eintrag genügt das Zertifikat in der DEP7-Gruppe', () => {
      const l = pruefe(eigen.dep7, { base64AESKey: eigen.container.base64AESKey, certificateOrPublicKeyMap: {} }, ['--ignoriere', BEKANNT])
      expect(l.bericht.verstoesse).toEqual([])
    })

    // BEFUND A (siehe bmf-referenz.test.ts, behoben): Der Prüfer rechnet die Verkettung nach der Spezifikation (JWS-Compact
    // des Vorbelegs); die Kassa hat vor der Korrektur die QR-Form gehasht.
    it('BEFUND A (behoben)  Verkettung der Kassa entspricht der Spezifikation (JWS-Compact des Vorbelegs)', () => {
      const l = pruefe(eigen.dep7, eigen.container)
      expect(l.bericht.verstoesseJeRegel['verkettung'] ?? 0).toBe(0)
    })

    // BEFUND D: Software-SEE = ZDA AT0 = „geschlossenes Gesamtsystem"; dort gehört der Ordnungsbegriff mit Schlüssel-ID in das
    // Feld Seriennummer. Das BMF-Prüftool beanstandet jeden Beleg der Kassa (FORMAT_CLOSED_SYSTEM_SERIAL, CI-Probelauf 2026-11-02).
    it.fails('BEFUND D  AT0-Belege tragen den Ordnungsbegriff mit Schlüssel-ID statt der Zertifikats-Seriennummer', () => {
      const l = pruefe(eigen.dep7, eigen.container)
      expect(l.bericht.verstoesseJeRegel['zksn-format'] ?? 0).toBe(0)
    })

    it('Ist-Zustand zu D: alle Belege verletzen das AT0-Format, sonst nichts (die Verkettung ist sauber)', () => {
      const l = pruefe(eigen.dep7, eigen.container)
      expect(regeln(l)).toEqual(['zksn-format'])
      expect(l.bericht.verstoesseJeRegel['zksn-format']).toBe(40)
      expect(l.exit).toBe(1)
    })

    it('derselbe Export als offenes System (ZDA AT100): keine Verstöße — das AT0-Format betrifft nur geschlossene Systeme', async () => {
      const offen = await baueEigenenExport(40, 'PRUEF-OFFEN', 'AT100')
      const l = pruefe(offen.dep7, offen.container)
      expect(regeln(l)).toEqual([])
      expect(l.exit).toBe(0)
    })

    // Export einer Bestandskasse nach dem Update (Befund A): Belege 2…20 sind noch nach der alten Lesart verkettet (QR-Code gehasht) und
    // lassen sich nicht ändern; der erste Beleg danach hasht die JWS-Form seines alt verketteten Vorgängers und stimmt sofort.
    it('Altkette (Belege 2…20 nach der alten Lesart, danach nach der Spezifikation): beanstandet werden genau die 19 Altbelege, der Übergang besteht', async () => {
      const alt = await baueEigenenExport(40, 'PRUEF-ALT', 'AT100', 20)
      const soll = (i: number): string => verkettungswertFolgebeleg(alt.belege[i - 1]!.maschinenlesbareCode)   // Wert nach der Spezifikation für Beleg i+1
      expect(alt.belege[1]!.sigVorbeleg).not.toBe(soll(1))      // Beleg 2: alte Lesart
      expect(alt.belege[19]!.sigVorbeleg).not.toBe(soll(19))    // Beleg 20: letzter Altbeleg
      expect(alt.belege[20]!.sigVorbeleg).toBe(soll(20))        // Beleg 21: stimmt sofort, obwohl der Vorgänger alt verkettet ist
      const l = pruefe(alt.dep7, alt.container)
      expect(regeln(l)).toEqual(['verkettung'])
      expect(l.bericht.verstoesseJeRegel['verkettung']).toBe(19)
      expect(l.bericht.verstoesse.map(v => v.beleg)).toEqual(Array.from({ length: 19 }, (_, k) => k + 2))
      expect(l.bericht.signaturenGeprueft + l.bericht.ausfallbelege).toBe(40)        // Signaturen und Zähler der Altbelege sind in Ordnung
    })

    it('fehlt der Sammelbeleg (signierter Nullbeleg) nach einem Ausfall, schlägt der Prüfer an', async () => {
      const offen = await baueEigenenExport(40, 'PRUEF-OFFEN', 'AT100')
      const i = offen.belege.findIndex((b, k) => k > 0 && offen.belege[k - 1]!.ausgefallen === true && b.belegTyp === 'Nullbeleg')
      expect(i, 'Muster enthält Ausfall + Sammelbeleg').toBeGreaterThan(0)
      const ohne: DEP7Export = { 'Belege-Gruppe': offen.dep7['Belege-Gruppe'].map(g => ({ ...g, 'Belege-kompakt': g['Belege-kompakt'].filter((_, k) => k !== i) })) }
      const l = pruefe(ohne, offen.container, ['--ignoriere', 'verkettung,belegnummer'])
      expect(regeln(l)).toEqual(['sammelbeleg'])
    })
  })
})
