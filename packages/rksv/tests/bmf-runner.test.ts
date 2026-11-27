/**
 * Tests für den Lauf des BMF-Prüftools (scripts/rksv/bmf-pruefer.mjs) OHNE Java.
 *
 * Das Prüftool selbst läuft nur im Nacht-Workflow (Java 8). Damit der Rest der Kette trotzdem geprüft ist, stehen hier
 *  - die Auswertung seiner Ausgabe (lib/bmf-ergebnis.mjs),
 *  - der Lauf des Skripts gegen eine Attrappe, die das erwartete Ausgabeformat schreibt,
 *  - der ZIP-Leser (lib/zip.mjs) inklusive Schutz gegen ausbrechende Pfade.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-ignore — reines JavaScript ohne Typen (mit allowJs wäre ts-expect-error ein Fehler)
import { analysiere, istUrteilsdatei, urteilsDateien } from '../../../scripts/rksv/lib/bmf-ergebnis.mjs'
// @ts-ignore — reines JavaScript ohne Typen (mit allowJs wäre ts-expect-error ein Fehler)
import { ladeBytes } from '../../../scripts/rksv/lib/download.mjs'
// @ts-ignore — reines JavaScript ohne Typen (mit allowJs wäre ts-expect-error ein Fehler)
import { entpacke, zipEintraege } from '../../../scripts/rksv/lib/zip.mjs'
import { REPO_WURZEL, ladeBmfSzenario, TESTS_ORDNER } from './helpers/pruef-export.js'

const SKRIPT = join(REPO_WURZEL, 'scripts', 'rksv', 'bmf-pruefer.mjs')
const ATTRAPPE = join(TESTS_ORDNER, 'fixtures', 'fake-bmf-pruefer.mjs')
const temp: string[] = []
const neuerOrdner = (): string => { const o = mkdtempSync(join(tmpdir(), 'kassa-bmf-runner-')); temp.push(o); return o }
afterAll(() => { for (const o of temp) rmSync(o, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------

describe('Auswertung der Ausgabe des Prüftools', () => {
  const datei = (name: string, inhalt: unknown) => ({ name, inhalt: JSON.stringify(inhalt) })
  const pass = (id = 'WURZEL') => ({ verificationId: id, verificationState: 'PASS' })
  /** Wie die echte `_full`-Datei: PASS-Wurzel, darunter verworfene Typ-Hypothesen als FAIL (CI-Probelauf 2026-11-02) */
  const mitHypothesen = { verificationId: 'VERIFICATION_FROM_CASHBOX', verificationState: 'PASS', verificationResultList: [
    { verificationId: 'TYPE_OF_RECEIPT_STANDARD', verificationState: 'FAIL' }, { verificationId: 'TYPE_OF_RECEIPT_TRA', verificationState: 'FAIL' }] }
  const bestanden = [datei('0000_app.json', pass('VERIFICATION_FROM_APP')), datei('0000_cashbox.json', pass()), datei('0000_dep.json', pass()), datei('DEP-global.json', pass())]

  it('welche Dateien zählen: N_app/N_cashbox/N_dep und DEP-global — nicht die „full"-Dateien', () => {
    for (const ja of ['0000_app.json', '0123_cashbox.json', '0007_dep.json', 'DEP-global.json', '/tmp/aus/0001_dep.json', 'C:\\aus\\DEP-global.json']) expect(istUrteilsdatei(ja), ja).toBe(true)
    for (const nein of ['0000_cashbox_full.json', 'DEP-full.json', 'bmf-zusammenfassung.json', 'dep-export.json', 'cryptographicMaterialContainer.json']) expect(istUrteilsdatei(nein), nein).toBe(false)
  })

  it('nur PASS-Wurzeln, Exit 0, saubere Konsole → bestanden', () => {
    const a = analysiere(bestanden, 'RKSV-DEP-EXPORT-validation # 0:  PASS', 0)
    expect(a).toMatchObject({ ok: true, zaehler: { PASS: 4 }, fehlgeschlagen: [], konsolenProbleme: [] })
  })

  it('verworfene Typ-Hypothesen (FAIL unter PASS-Wurzel) in den „full"-Dateien zählen NICHT', () => {
    const a = analysiere([...bestanden, datei('0000_cashbox_full.json', mitHypothesen), datei('DEP-full.json', mitHypothesen)], '', 0)
    expect(a.ok).toBe(true)
    expect(a.fehlgeschlagen).toEqual([])
  })

  it('FAIL: nur die unterste fehlgeschlagene Prüfung wird genannt, mit Meldung', () => {
    const baum = { verificationId: 'DEP', verificationState: 'FAIL', verificationResultList: [
      pass('OK'),
      { verificationId: 'DEP_CHAINING_VALUE', verificationState: 'FAIL', verificationResultDetailedMessage: 'Kette gebrochen' },
    ] }
    const a = analysiere([...bestanden, datei('0001_dep.json', baum)], '', 0)
    expect(a.ok).toBe(false)
    expect(a.fehlgeschlagen).toEqual([{ datei: '0001_dep.json', name: 'DEP_CHAINING_VALUE', meldung: 'Kette gebrochen' }])
    expect(a.zaehler).toEqual({ PASS: 4, FAIL: 1 })
  })

  it('Wurzel FAIL ohne Einzelheiten (so schreibt das Tool N_app.json) wird mit seiner Meldung geführt', () => {
    const a = analysiere([datei('0000_app.json', { verificationId: 'VERIFICATION_FROM_APP', verificationState: 'FAIL', verificationResultDetailedMessage: 'Der vorliegende Beleg weist Fehler auf.' })], '', 0)
    expect(a.ok).toBe(false)
    expect(a.fehlgeschlagen).toEqual([{ datei: '0000_app.json', name: 'VERIFICATION_FROM_APP', meldung: 'Der vorliegende Beleg weist Fehler auf.' }])
  })

  it('NOT_EXECUTED und INFORMATION allein machen nichts rot, ersetzen aber kein PASS', () => {
    const a = analysiere([datei('0000_dep.json', { verificationState: 'INFORMATION' }), datei('0000_app.json', { verificationState: 'NOT_EXECUTED' })], '', 0)
    expect(a.ok).toBe(false)
    expect(a.hinweis).toContain('Kein einziges bestandenes Prüfergebnis')
  })

  it.each([
    'Fatal internal error. Detailed error-stacktrace:',
    'Machine readable code validation # 0: FAIL',
    'RKSV-DEP-EXPORT validation process failed for last receipt, stopping RKSV-DEP-EXPORT-validation.',
  ])('Konsole mit „%s" → nicht bestanden, auch wenn alle Dateien PASS zeigen', zeile => {
    const a = analysiere(bestanden, `Beginn\n${zeile}\nEnde`, 0)
    expect(a.ok).toBe(false)
    expect(a.konsolenProbleme).toHaveLength(1)
  })

  it('Exit-Code ≠ 0 → nicht bestanden', () => {
    expect(analysiere(bestanden, '', 1).ok).toBe(false)
  })

  it('keine auswertbare Urteilsdatei → nicht bestanden (leer ist nicht „bestanden")', () => {
    const a = analysiere([{ name: '0000_dep.json', inhalt: '{nicht json' }, datei('DEP-full.json', pass())], '', 0)
    expect(a.ok).toBe(false)
    expect(a.hinweis).toContain('keine auswertbare Urteilsdatei')
  })

  it('findet Fehler auch tief verschachtelt und in Listen', () => {
    const a = analysiere([datei('0002_cashbox.json', { verificationState: 'FAIL', a: { b: [{ verificationState: 'PASS' }, { verificationState: 'FAIL', verificationId: 'TIEF' }] } })], '', 0)
    expect(a.fehlgeschlagen.map((f: { name: string }) => f.name)).toEqual(['TIEF'])
  })
})

// ---------------------------------------------------------------------------

describe('Lauf des Skripts gegen die Attrappe', () => {
  const s = ladeBmfSzenario('open-system-1')

  function lauf(modus: string, extra: string[] = []) {
    const ordner = neuerOrdner()
    writeFileSync(join(ordner, 'dep.json'), JSON.stringify(s.dep7))
    writeFileSync(join(ordner, 'crypto.json'), JSON.stringify(s.container))
    const r = spawnSync(process.execPath, [SKRIPT, '--dep', join(ordner, 'dep.json'), '--crypto', join(ordner, 'crypto.json'), '--out', join(ordner, 'aus'),
      '--befehl-json', JSON.stringify([process.execPath, ATTRAPPE]), ...extra], { encoding: 'utf8', env: { ...process.env, FAKE_BMF_MODUS: modus } })
    const zusammenfassung = existsSync(join(ordner, 'aus', 'bmf-zusammenfassung.json'))
      ? JSON.parse(readFileSync(join(ordner, 'aus', 'bmf-zusammenfassung.json'), 'utf8')) : null
    return { r, ordner, zusammenfassung }
  }

  it('pass → Exit 0, Zusammenfassung ok', () => {
    const { r, zusammenfassung } = lauf('pass')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(zusammenfassung).toMatchObject({ ok: true, fehlgeschlagen: [] })
    expect(zusammenfassung.zaehler.PASS).toBe(10)             // 3 Belege × (app, cashbox, dep) + DEP-global
  })

  it('fail → Exit 1, die fehlgeschlagene Prüfung steht in der Zusammenfassung', () => {
    const { r, zusammenfassung } = lauf('fail')
    expect(r.status).toBe(1)
    expect(zusammenfassung.ok).toBe(false)
    expect(zusammenfassung.fehlgeschlagen.map((f: { name: string }) => f.name)).toContain('DEP_CHAINING_VALUE')
    expect(r.stdout).toContain('FAIL DEP_CHAINING_VALUE')
  })

  it('Absturz des Tools → Exit 1', () => {
    const { r, zusammenfassung } = lauf('crash')
    expect(r.status).toBe(1)
    expect(zusammenfassung.ok).toBe(false)
  })

  it('Tool ohne Ergebnisdateien → Exit 1 (leer ist nicht bestanden)', () => {
    expect(lauf('leer').r.status).toBe(1)
  })

  it('Tool mit Exit 1, aber PASS-Dateien → Exit 1', () => {
    expect(lauf('exit1').r.status).toBe(1)
  })

  it('beide Container-Varianten: public-key wird aus dem Zertifikat abgeleitet', () => {
    const { r, ordner, zusammenfassung } = lauf('pass', ['--varianten', 'certificate,public-key'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(zusammenfassung.laeufe.map((l: { szenario: string }) => l.szenario)).toEqual(['certificate', 'public-key'])
    const abgeleitet = JSON.parse(readFileSync(join(ordner, 'aus', 'eingabe-container-public-key.json'), 'utf8'))
    for (const eintrag of Object.values(abgeleitet.certificateOrPublicKeyMap) as { signatureDeviceType: string; signatureCertificateOrPublicKey: string }[]) {
      expect(eintrag.signatureDeviceType).toBe('PUBLIC_KEY')
      expect(Buffer.from(eintrag.signatureCertificateOrPublicKey, 'base64')[0]).toBe(0x30)       // SubjectPublicKeyInfo ist eine SEQUENCE
    }
  })

  it('Aufruf ohne --out → Exit ≠ 0', () => {
    const r = spawnSync(process.execPath, [SKRIPT, '--befehl-json', '["x"]'], { encoding: 'utf8' })
    expect(r.status).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('ZIP-Leser', () => {
  /** Minimales ZIP (Methode „gespeichert"), genug für den Leser — Prüfsummen werden nicht gebraucht. */
  function baueZip(eintraege: { name: string; daten: string }[]): Buffer {
    const teile: Buffer[] = [], zentral: Buffer[] = []
    let versatz = 0
    for (const e of eintraege) {
      const name = Buffer.from(e.name), daten = Buffer.from(e.daten)
      const kopf = Buffer.alloc(30); kopf.writeUInt32LE(0x04034b50, 0); kopf.writeUInt16LE(20, 4); kopf.writeUInt32LE(daten.length, 18); kopf.writeUInt32LE(daten.length, 22); kopf.writeUInt16LE(name.length, 26)
      const z = Buffer.alloc(46); z.writeUInt32LE(0x02014b50, 0); z.writeUInt16LE(20, 4); z.writeUInt16LE(20, 6); z.writeUInt32LE(daten.length, 20); z.writeUInt32LE(daten.length, 24); z.writeUInt16LE(name.length, 28); z.writeUInt32LE(versatz, 42)
      teile.push(kopf, name, daten); zentral.push(z, name)
      versatz += 30 + name.length + daten.length
    }
    const zentralBuf = Buffer.concat(zentral)
    const ende = Buffer.alloc(22); ende.writeUInt32LE(0x06054b50, 0); ende.writeUInt16LE(eintraege.length, 8); ende.writeUInt16LE(eintraege.length, 10); ende.writeUInt32LE(zentralBuf.length, 12); ende.writeUInt32LE(versatz, 16)
    return Buffer.concat([...teile, zentralBuf, ende])
  }

  it('entpackt Dateien in Unterordner', () => {
    const o = neuerOrdner()
    writeFileSync(join(o, 'a.zip'), baueZip([{ name: 'tool/lib/x.jar', daten: 'JAR' }, { name: 'tool/y.txt', daten: 'Y' }]))
    const geschrieben = entpacke(join(o, 'a.zip'), join(o, 'aus'))
    expect(geschrieben).toHaveLength(2)
    expect(readFileSync(join(o, 'aus', 'tool', 'lib', 'x.jar'), 'utf8')).toBe('JAR')
  })

  it('verweigert Pfade, die aus dem Zielordner ausbrechen (Zip-Slip)', () => {
    const o = neuerOrdner()
    writeFileSync(join(o, 'boese.zip'), baueZip([{ name: '../draussen.txt', daten: 'X' }]))
    expect(() => entpacke(join(o, 'boese.zip'), join(o, 'aus'))).toThrow(/Unzulässiger Pfad/)
    expect(existsSync(join(o, 'draussen.txt'))).toBe(false)
  })

  it('verweigert absolute Pfade', () => {
    const o = neuerOrdner()
    writeFileSync(join(o, 'abs.zip'), baueZip([{ name: '/etc/passwd', daten: 'X' }]))
    expect(() => entpacke(join(o, 'abs.zip'), join(o, 'aus'))).toThrow(/Unzulässiger Pfad/)
  })

  it('erkennt Nicht-ZIP-Dateien', () => {
    expect(() => zipEintraege(Buffer.from('das ist kein zip'))).toThrow(/Kein ZIP/)
  })
})

// ---------------------------------------------------------------------------

describe('Ausgabe langer Läufe (Nachtlauf 2026-11-08: Abbruch bei rund 19 000 Belegen)', () => {
  const pass = '{"verificationId":"X","verificationState":"PASS"}'

  it('liefert nur die Urteilsdateien — auch ab Beleg 10000 (fünfstellig) — und liest die „full"-Dateien nicht', () => {
    const o = neuerOrdner()
    for (const n of ['0000', '9999', '10000']) {
      for (const art of ['app', 'cashbox', 'dep', 'cashbox_full']) writeFileSync(join(o, `${n}_${art}.json`), pass)
    }
    for (const sonst of ['DEP-global.json', 'DEP-full.json', 'bmf-konsole-x.txt', 'dep-export.json']) writeFileSync(join(o, sonst), pass)
    const namen = [...urteilsDateien(o)].map((d: { name: string }) => basename(d.name)).sort()
    expect(namen).toEqual(['0000_app.json', '0000_cashbox.json', '0000_dep.json', '10000_app.json', '10000_cashbox.json', '10000_dep.json',
      '9999_app.json', '9999_cashbox.json', '9999_dep.json', 'DEP-global.json'])
    // Ohne \d{4,} wären die Belege ab 10000 nie ausgewertet worden
    expect(istUrteilsdatei('10000_app.json')).toBe(true)
  })

  it('liest nacheinander statt alles vorab (sonst belegt jeder Beleg Speicher, bis der Lauf abbricht)', () => {
    const o = neuerOrdner()
    for (const n of ['0000', '0001', '0002']) writeFileSync(join(o, `${n}_app.json`), '{"alt":true}')
    const lauf = urteilsDateien(o)
    expect(basename(lauf.next().value.name)).toBe('0000_app.json')
    writeFileSync(join(o, '0002_app.json'), '{"spaeter":true}')          // nach dem ersten Schritt geändert
    const rest = [...lauf] as { name: string; inhalt: string }[]
    expect(rest.find(d => d.name.endsWith('0002_app.json'))?.inhalt).toBe('{"spaeter":true}')
  })

  it('die Auswertung nimmt den Generator an und zählt alle Belege', () => {
    const o = neuerOrdner()
    for (const n of ['0000', '0001', '10000']) for (const art of ['app', 'cashbox', 'dep']) writeFileSync(join(o, `${n}_${art}.json`), pass)
    const a = analysiere(urteilsDateien(o), '', 0)
    expect(a.ok).toBe(true)
    expect(a.zaehler.PASS).toBe(9)
  })
})

// ---------------------------------------------------------------------------

describe('Download mit Wiederholung (Nachtlauf 2026-11-09: HTTP 504 auf das ZIP mit den Beispielen)', () => {
  const antwort = (status: number, text = 'inhalt'): Response => ({
    ok: status >= 200 && status < 300, status, arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }) as unknown as Response
  /** Liefert die Antworten der Reihe nach; hält fest, wie oft gerufen und wie lange gewartet wurde. */
  const aufbau = (folge: (Response | Error)[]) => {
    const warten: number[] = []
    const protokoll: string[] = []
    let aufrufe = 0
    const fetchFn = async () => { const e = folge[Math.min(aufrufe++, folge.length - 1)]!; if (e instanceof Error) throw e; return e }
    return { fetchFn, optionen: { fetchFn, wartenMs: [10, 20, 30], schlafe: async (ms: number) => { warten.push(ms) }, log: (z: string) => protokoll.push(z) }, warten, protokoll, aufrufe: () => aufrufe }
  }

  it('gelingt beim ersten Versuch ohne Wartezeit', async () => {
    const t = aufbau([antwort(200, 'zip')])
    expect((await ladeBytes('https://beispiel.test/a.zip', t.optionen)).toString()).toBe('zip')
    expect(t.aufrufe()).toBe(1)
    expect(t.warten).toEqual([])
  })

  it('wiederholt 5xx mit den vorgesehenen Wartezeiten und gelingt danach', async () => {
    const t = aufbau([antwort(504), antwort(502), antwort(200, 'zip')])
    expect((await ladeBytes('https://beispiel.test/a.zip', t.optionen)).toString()).toBe('zip')
    expect(t.aufrufe()).toBe(3)
    expect(t.warten).toEqual([10, 20])
    expect(t.protokoll[0]).toContain('HTTP 504')
  })

  it('wiederholt auch 408 und 429', async () => {
    for (const status of [408, 429]) {
      const t = aufbau([antwort(status), antwort(200)])
      await ladeBytes('https://beispiel.test/a.zip', t.optionen)
      expect(t.aufrufe(), `HTTP ${status}`).toBe(2)
    }
  })

  it('gibt nach der festgelegten Zahl von Versuchen auf und nennt den letzten Grund', async () => {
    const t = aufbau([antwort(504)])
    await expect(ladeBytes('https://beispiel.test/a.zip', { ...t.optionen, versuche: 3 })).rejects.toThrow(/Download fehlgeschlagen: HTTP 504 \(https:\/\/beispiel\.test\/a\.zip\)/)
    expect(t.aufrufe()).toBe(3)
    expect(t.warten).toEqual([10, 20])
  })

  it('ein 404 ist endgültig — kein zweiter Versuch', async () => {
    const t = aufbau([antwort(404)])
    await expect(ladeBytes('https://beispiel.test/a.zip', t.optionen)).rejects.toThrow(/HTTP 404/)
    expect(t.aufrufe()).toBe(1)
  })

  it('Netzwerkfehler werden wiederholt; der Grund steht im Protokoll', async () => {
    const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    const t = aufbau([reset, antwort(200, 'zip')])
    expect((await ladeBytes('https://beispiel.test/a.zip', t.optionen)).toString()).toBe('zip')
    expect(t.protokoll[0]).toContain('ECONNRESET')
  })
})
