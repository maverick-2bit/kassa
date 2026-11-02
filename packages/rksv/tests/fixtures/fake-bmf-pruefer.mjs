// Attrappe für das BMF-Prüftool — NUR für bmf-runner.test.ts. Nimmt dieselben Argumente wie das echte Tool
// (-v -f -i <dep> -c <container> -o <ordner>) und schreibt Ergebnisdateien im Layout des echten Tools (aus dem CI-Probelauf
// 2026-11-02 abgelesen): N_app/N_cashbox/N_dep/DEP-global als Urteil, N_cashbox_full/DEP-full mit den verworfenen Typ-Hypothesen
// (TYPE_OF_RECEIPT_* als FAIL unter einer PASS-Wurzel — darf das Urteil nicht beeinflussen).
// Verhalten über FAKE_BMF_MODUS: pass | fail | crash | leer | exit1.
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

const kaputt = modus === 'fail'
const pruefung = (id, zustand, meldung = '', kinder = []) => ({
  verificationId: id, version: 1, verificationState: zustand,
  ...(meldung ? { verificationResultDetailedMessage: meldung } : {}),
  ...(kinder.length ? { verificationResultList: kinder } : {}),
})
const schreibe = (name, inhalt) => writeFileSync(join(ausgabe, name), JSON.stringify(inhalt, null, 2))
const hypothesen = ['STANDARD', 'TRA', 'STO', 'NULL', 'START'].map(t => pruefung(`TYPE_OF_RECEIPT_${t}`, 'FAIL', 'Hypothese trifft nicht zu'))

for (let n = 0; n < 3; n++) {
  const nr = String(n).padStart(4, '0')
  const dep = n > 0 && kaputt
    ? pruefung('RKSV_DEP_EXPORT', 'FAIL', '', [pruefung('DEP_CHAINING_VALUE', 'FAIL', 'Verkettungswert stimmt nicht mit dem Vorbeleg überein')])
    : pruefung('RKSV_DEP_EXPORT', 'PASS', '', [pruefung('DEP_CHAINING_VALUE', 'PASS')])
  schreibe(`${nr}_app.json`, pruefung('VERIFICATION_FROM_APP', 'PASS'))
  schreibe(`${nr}_cashbox.json`, pruefung('VERIFICATION_FROM_CASHBOX', 'PASS'))
  schreibe(`${nr}_cashbox_full.json`, pruefung('VERIFICATION_FROM_CASHBOX', 'PASS', '', [pruefung('SIGNATURE_VALID', 'PASS'), ...hypothesen]))
  schreibe(`${nr}_dep.json`, dep)
}
schreibe('DEP-global.json', pruefung('DEP_GLOBAL', kaputt ? 'FAIL' : 'PASS', '', [pruefung('DEP_JSON_FORMAT', 'PASS')]))
schreibe('DEP-full.json', pruefung('DEP_FULL', 'PASS', '', hypothesen))
console.log(`RKSV-DEP-EXPORT-validation # 0:  ${kaputt ? 'FAIL' : 'PASS'}`)
if (kaputt) console.log('RKSV-DEP-EXPORT validation process failed for last receipt, stopping RKSV-DEP-EXPORT-validation.')
process.exit(modus === 'exit1' ? 1 : 0)
