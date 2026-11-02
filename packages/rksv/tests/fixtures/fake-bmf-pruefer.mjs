// Attrappe für das BMF-Prüftool — NUR für bmf-runner.test.ts. Nimmt dieselben Argumente wie das echte Tool
// (-v -f -i <dep> -c <container> -o <ordner>) und schreibt Ergebnisdateien in dem Layout, das wir vom echten Tool
// erwarten (verificationState / verificationResultList). Verhalten über FAKE_BMF_MODUS: pass | fail | crash | leer | exit1.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const a = process.argv.slice(2)
const wert = flag => a[a.indexOf(flag) + 1]
const ausgabe = wert('-o')
const modus = process.env.FAKE_BMF_MODUS ?? 'pass'
mkdirSync(ausgabe, { recursive: true })

if (modus === 'crash') {
  console.error('Fatal internal error. Detailed error-stacktrace:\njava.lang.NoClassDefFoundError: javax/xml/bind/annotation/XmlElement')
  process.exit(1)
}
if (modus === 'leer') {
  console.log('Step 1: DETAILED MACHINE-READABLE CODE VALIDATION complete.')
  process.exit(0)
}

const pruefung = (id, zustand, meldung = '', kinder = []) => ({
  verificationId: id, version: 1, verificationState: zustand,
  ...(meldung ? { verificationResultDetailedMessage: meldung } : {}),
  ...(kinder.length ? { verificationResultList: kinder } : {}),
})
const kaputt = modus === 'fail'
const belege = [0, 1, 2].map(i => ({
  verificationResultList: [
    pruefung('SIGNATURE_VALID', 'PASS'),
    pruefung('DEP_CHAINING_VALUE', i > 0 && kaputt ? 'FAIL' : 'PASS', i > 0 && kaputt ? 'Verkettungswert stimmt nicht mit dem Vorbeleg überein' : ''),
  ],
}))
writeFileSync(join(ausgabe, 'DEP-full.json'), JSON.stringify({ verificationResultList: [pruefung('RKSV_DEP_EXPORT', kaputt ? 'FAIL' : 'PASS', '', belege.flatMap(b => b.verificationResultList))] }, null, 2))
writeFileSync(join(ausgabe, '0000_cashbox.json'), JSON.stringify({ verificationResultList: belege[0].verificationResultList }))
console.log(`RKSV-DEP-EXPORT-validation # 0:  ${kaputt ? 'FAIL' : 'PASS'}`)
if (kaputt) console.log('RKSV-DEP-EXPORT validation process failed for last receipt, stopping RKSV-DEP-EXPORT-validation.')
process.exit(modus === 'exit1' ? 1 : 0)
