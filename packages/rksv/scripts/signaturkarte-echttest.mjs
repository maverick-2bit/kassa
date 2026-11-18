#!/usr/bin/env node
/**
 * Echttest der Signaturkarte über die Kartenbrücke — von einem Menschen am Kassen-/Dev-PC auszuführen.
 *
 *   node packages/rksv/scripts/signaturkarte-echttest.mjs <brücken-url> <schlüsseldatei>
 *
 * Ablauf:
 *   1. Leser und Karte finden, Zertifikat lesen (ohne PIN)
 *   2. PIN verdeckt abfragen — EIN Versuch; ist sie falsch, bricht das Skript sofort ab
 *   3. drei Testsignaturen über einen Probe-Code (KEIN Beleg, nichts wird gespeichert) auf demselben Weg wie
 *      die Kassa (Identitätsprüfung der Karte in derselben Sitzung), jede gegen das Kartenzertifikat geprüft
 *   4. Gegenprobe: Signieren ohne PIN-Prüfung muss die Karte verweigern (6982) — das kostet
 *      keinen PIN-Versuch
 *
 * Braucht `pnpm build` (liest @kassa/rksv aus dist/).
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const dist = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')).href
const {
  KartenbrueckeTransport, KartenError, SignaturkartenEinheit, APDU, findeKarte,
  jwsSigningInput, verifiziere, statuswort,
} = await import(dist)

const [url = 'http://127.0.0.1:47110', schluesselDatei] = process.argv.slice(2)
if (!schluesselDatei) {
  console.error('Aufruf: node signaturkarte-echttest.mjs <brücken-url> <schlüsseldatei>')
  process.exit(2)
}
const transport = new KartenbrueckeTransport({ url, schluessel: readFileSync(schluesselDatei, 'utf8').trim(), timeoutMs: 10_000 })

function frageVerdeckt(frage) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.startsWith(frage)) process.stdout.write(frage) }
    rl.question(frage, (antwort) => { rl.close(); process.stdout.write('\n'); resolve(antwort.trim()) })
  })
}

try {
  console.log(`Kartenbrücke: ${url}`)
  const einheit = new SignaturkartenEinheit({ transport })
  const { karte, zertifikatDer } = await einheit.karte()
  const zert = new X509Certificate(zertifikatDer)
  console.log(`Karte:        ${karte.typ.bezeichnung} im Leser „${karte.leser}"${karte.typ.tauschpflichtig ? '  (!) bis Mai 2027 tauschen' : ''}`)
  console.log(`Zertifikat:   SN ${zert.serialNumber}, gültig bis ${zert.validTo}`)
  console.log(`              ${zert.subject.replace(/\n/g, ', ')}`)
  console.log('')
  console.log('Jetzt EINEN PIN-Versuch. Ist die PIN falsch, bricht der Test sofort ab (die Karte zählt Fehlversuche).')
  const pin = await frageVerdeckt('Karten-PIN: ')
  if (!pin) { console.log('Keine PIN eingegeben — Abbruch, die Karte wurde nicht berührt.'); process.exit(1) }

  const probe = `_R1-AT1_ECHTTEST_${Date.now()}_2026-11-18T00:00:00_0,00_0,00_0,00_0,00_0,00_AAAAAAAAAAA=_${zert.serialNumber}_AAAAAAAAAAA=`
  const wieKassa = new SignaturkartenEinheit({ transport, pin, erwartetesZertifikat: zertifikatDer })
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now()
    const input = jwsSigningInput(`${probe}-${i}`)
    const sig = await wieKassa.signiereBelegzeile(`${probe}-${i}`)
    const ok = verifiziere(input, sig, zertifikatDer)
    console.log(`Signatur ${i}:   ${sig.length} Byte, ${ok ? 'passt zum Zertifikat' : 'PASST NICHT ZUM ZERTIFIKAT'}, ${Date.now() - t0} ms`)
    if (!ok) process.exit(1)
  }

  const k = await findeKarte(transport)
  const ohnePin = await transport.sende(k.leser, [APDU.selectMf, APDU.selectDfSig, APDU.signiere(Buffer.alloc(32))])
  const sw = statuswort(ohnePin[ohnePin.length - 1])
  console.log(`Ohne PIN:     Statuswort ${sw} ${sw === '6982' ? '(Karte verweigert, wie erwartet)' : '(UNERWARTET — bitte melden)'}`)
  console.log('\nEchttest bestanden.')
} catch (err) {
  if (err instanceof KartenError) {
    console.error(`\nAbbruch: ${err.message}  [${err.art}${err.restVersuche !== undefined ? `, Restversuche ${err.restVersuche}` : ''}]`)
  } else {
    console.error('\nAbbruch:', err)
  }
  process.exit(1)
}
