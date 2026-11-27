#!/usr/bin/env node
// Lässt das BMF-Prüftool (regkassen-verification, Java) über einen DEP7-Export der Kassa laufen.
//
//   node scripts/rksv/bmf-pruefer.mjs --dep dep-export.json --crypto cryptographicMaterialContainer.json --out <ordner>
//   node scripts/rksv/bmf-pruefer.mjs --beispiele [<entpacktes example-output-1.0.0>] --out <ordner>   (Kontrolllauf mit den BMF-Beispieldaten;
//                                                                                                      ohne Ordner wird das Release-ZIP geladen)
//   node scripts/rksv/bmf-pruefer.mjs --nur-vorbereiten                                                (Tool laden + prüfen, sonst nichts)
//
// Optionen
//   --varianten certificate,public-key   Wie der öffentliche Schlüssel im cryptographicMaterialContainer steht (Standard: certificate).
//                                        „public-key" leitet den SubjectPublicKeyInfo aus dem Zertifikat ab. Beides probieren hilft zu
//                                        erkennen, ob ein Fehler am Container oder an den Belegen liegt.
//   --tool-ordner <ordner>               entpacktes Prüftool; sonst $BMF_PRUEFTOOL_DIR; sonst wird die festgelegte Version geladen
//                                        (SHA-256 geprüft) und in $BMF_CACHE bzw. <tmp>/kassa-bmf-pruefer abgelegt
//   --java <programm>                    Standard: $JAVA oder „java" (Java 8 ist die sicherste Wahl: das Tool stammt von 2018)
//   --befehl-json '["node","attrappe.mjs"]'  Testhilfe: Startbefehl statt „java -jar <jar>"
//
// Ausgabe im Ordner --out: bmf-konsole-<variante>.txt, die JSON-Ergebnisse des Tools, bmf-zusammenfassung.json.
// Exit-Code 0 = bestanden, 1 = Prüftool meldet Fehler oder lief nicht, 2 = falscher Aufruf.
//
// Das Prüftool ist laut BMF „primär auf korrekte Implementierung ausgerichtet" und nicht verbindlich; ein Fehler dort ist
// ein Grund zum Nachsehen, kein Gerichtsurteil — und umgekehrt ersetzt ein Bestehen weder die Belegprüfung in FinanzOnline
// noch die BMF-Belegcheck-App.

import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { analysiere, urteilsDateien } from './lib/bmf-ergebnis.mjs'
import { ladeBytes } from './lib/download.mjs'
import { entpacke, sha256Datei } from './lib/zip.mjs'

// ---------------------------------------------------------------------------
// Festgelegte Versionen (Prüfsumme gegen Unterschieben schützt: das ZIP enthält ausführbaren Code)
// ---------------------------------------------------------------------------

const RELEASES = 'https://github.com/BMF-RKSV-Technik/at-registrierkassen-mustercode/releases/download'
const PRUEFTOOL = {
  url:    `${RELEASES}/V1.1.1/regkassen-verification-1.1.1.zip`,
  sha256: '2c1d65b7b0024262e36ebbfba296c47773c68c7000a6f33c36f80b1215e414b6',
  ordner: 'regkassen-verification-1.1.1',
  jar:    'regkassen-verification-depformat-1.1.1.jar',
}
const BEISPIELE = {
  url:    `${RELEASES}/V1.0.0/example-output-1.0.0.zip`,
  sha256: 'b5d50c0c8258595327c431ebcb6613d98cbf584b945676bdc9376d2cf42d5473',
}

// ---------------------------------------------------------------------------
// Aufruf lesen
// ---------------------------------------------------------------------------

function liesAufruf(argv) {
  const opt = { varianten: ['certificate'] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const wert = () => { if (i + 1 >= argv.length) throw new Error(`${a} braucht einen Wert`); return argv[++i] }
    switch (a) {
      case '--dep': opt.dep = resolve(wert()); break
      case '--crypto': opt.crypto = resolve(wert()); break
      case '--out': opt.out = resolve(wert()); break
      case '--beispiele': opt.beispiele = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? resolve(argv[++i]) : 'laden'; break
      case '--varianten': opt.varianten = wert().split(',').map(s => s.trim()).filter(Boolean); break
      case '--tool-ordner': opt.toolOrdner = resolve(wert()); break
      case '--java': opt.java = wert(); break
      case '--befehl-json': opt.befehl = JSON.parse(wert()); break
      case '--nur-vorbereiten': opt.nurVorbereiten = true; break
      case '-h': case '--help': opt.hilfe = true; break
      default: throw new Error(`Unbekannte Option: ${a}`)
    }
  }
  return opt
}

// ---------------------------------------------------------------------------
// Prüftool beschaffen
// ---------------------------------------------------------------------------

const cacheOrdner = () => resolve(process.env.BMF_CACHE ?? join(tmpdir(), 'kassa-bmf-pruefer'))

async function ladeUndEntpacke(quelle, unterordner) {
  const ziel = join(cacheOrdner(), unterordner)
  const zipPfad = join(cacheOrdner(), `${unterordner}.zip`)
  mkdirSync(cacheOrdner(), { recursive: true })
  if (!existsSync(zipPfad) || sha256Datei(zipPfad) !== quelle.sha256) {
    console.log(`Lade ${quelle.url}`)
    writeFileSync(zipPfad, await ladeBytes(quelle.url))
  }
  const ist = sha256Datei(zipPfad)
  if (ist !== quelle.sha256) throw new Error(`Prüfsumme von ${basename(zipPfad)} stimmt nicht: ${ist} statt ${quelle.sha256} — nicht entpackt, nichts ausgeführt`)
  entpacke(zipPfad, ziel)
  return ziel
}

async function findeTool(opt) {
  let ordner = opt.toolOrdner ?? process.env.BMF_PRUEFTOOL_DIR
  if (!ordner) ordner = join(await ladeUndEntpacke(PRUEFTOOL, 'pruefer'), PRUEFTOOL.ordner)
  // Das ZIP bringt den Unterordner mit; wer den Ordner direkt angibt, darf auch dessen Elternordner meinen.
  if (!existsSync(join(ordner, PRUEFTOOL.jar)) && existsSync(join(ordner, PRUEFTOOL.ordner, PRUEFTOOL.jar))) ordner = join(ordner, PRUEFTOOL.ordner)
  const jar = join(ordner, PRUEFTOOL.jar)
  if (!existsSync(jar)) throw new Error(`Prüftool nicht gefunden: ${jar}`)
  return jar
}

// ---------------------------------------------------------------------------
// Container-Varianten
// ---------------------------------------------------------------------------

/** „public-key": jede Zertifikat-Angabe durch den öffentlichen Schlüssel (SubjectPublicKeyInfo) ersetzen. */
function containerAlsPublicKey(container) {
  const kopie = JSON.parse(JSON.stringify(container))
  for (const eintrag of Object.values(kopie.certificateOrPublicKeyMap ?? {})) {
    if (eintrag.signatureDeviceType !== 'CERTIFICATE') continue
    const zert = new X509Certificate(Buffer.from(eintrag.signatureCertificateOrPublicKey, 'base64'))
    eintrag.signatureDeviceType = 'PUBLIC_KEY'
    eintrag.signatureCertificateOrPublicKey = zert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
  return kopie
}

// ---------------------------------------------------------------------------
// Ein Lauf
// ---------------------------------------------------------------------------

function fuehreAus({ jar, opt, dep, crypto, ausgabe, name }) {
  mkdirSync(ausgabe, { recursive: true })
  const befehl = opt.befehl ?? [opt.java ?? process.env.JAVA ?? 'java', '-jar', jar]
  const args = [...befehl.slice(1), '-v', '-f', '-i', dep, '-c', crypto, '-o', ausgabe]
  console.log(`> ${[befehl[0], ...args].join(' ')}`)
  const r = spawnSync(befehl[0], args, { cwd: ausgabe, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 })
  const konsole = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`
  writeFileSync(join(ausgabe, `bmf-konsole-${name}.txt`), konsole)
  const a = analysiere(urteilsDateien(ausgabe), konsole, r.error ? -1 : r.status)
  return { name, ...a }
}

async function main() {
  const opt = liesAufruf(process.argv.slice(2))
  if (opt.hilfe) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 26).map(z => z.replace(/^\/\/ ?/, '')).join('\n')); return 0 }

  const jar = opt.befehl ? '(Attrappe)' : await findeTool(opt)
  console.log(`BMF-Prüftool: ${jar}`)
  if (opt.nurVorbereiten) {
    // In GitHub Actions den Ordner für die folgenden Schritte bereitstellen
    if (process.env.GITHUB_ENV && !opt.befehl) appendFileSync(process.env.GITHUB_ENV, `BMF_PRUEFTOOL_DIR=${dirname(jar)}\n`)
    console.log('Vorbereitet.')
    return 0
  }
  if (!opt.out) throw new Error('--out <ordner> fehlt')
  mkdirSync(opt.out, { recursive: true })
  if (opt.beispiele === 'laden') opt.beispiele = join(await ladeUndEntpacke(BEISPIELE, 'beispiele'), 'example-output-1.0.0')

  /** @type {{ szenario: string, ergebnis: object }[]} */
  const laeufe = []

  if (opt.beispiele) {
    // Kontrolllauf: das Tool muss seine EIGENEN Beispieldaten bestehen, sonst sagt ein Fehler bei unseren Daten nichts aus.
    for (const system of ['closed system', 'open system']) {
      for (let n = 1; n <= 8; n++) {
        const ordner = join(opt.beispiele, system, `TESTSUITE_TEST_SZENARIO_${n}`)
        const e = fuehreAus({ jar, opt, dep: join(ordner, 'dep-export.json'), crypto: join(ordner, 'cryptographicMaterialContainer.json'),
          ausgabe: join(opt.out, `${system.replace(' ', '-')}-${n}`), name: 'beispiel' })
        laeufe.push({ szenario: `${system} ${n}`, ergebnis: e })
        console.log(`  ${system} ${n}: ${e.ok ? 'bestanden' : 'NICHT bestanden'} ${JSON.stringify(e.zaehler)}${e.hinweis ? ' — ' + e.hinweis : ''}`)
      }
    }
  } else {
    if (!opt.dep || !opt.crypto) throw new Error('--dep und --crypto (oder --beispiele) fehlen')
    const container = JSON.parse(readFileSync(opt.crypto, 'utf8'))
    for (const variante of opt.varianten) {
      let cryptoDatei = opt.crypto
      if (variante === 'public-key') {
        cryptoDatei = join(opt.out, 'eingabe-container-public-key.json')
        writeFileSync(cryptoDatei, JSON.stringify(containerAlsPublicKey(container), null, 2))
      } else if (variante !== 'certificate') {
        throw new Error(`Unbekannte Variante: ${variante}`)
      }
      const e = fuehreAus({ jar, opt, dep: opt.dep, crypto: cryptoDatei, ausgabe: join(opt.out, variante), name: variante })
      laeufe.push({ szenario: variante, ergebnis: e })
      console.log(`  Variante ${variante}: ${e.ok ? 'bestanden' : 'NICHT bestanden'} ${JSON.stringify(e.zaehler)}${e.hinweis ? ' — ' + e.hinweis : ''}`)
      for (const f of e.fehlgeschlagen.slice(0, 12)) console.log(`    FAIL ${f.name}: ${f.meldung}`)
      for (const k of e.konsolenProbleme.slice(0, 6)) console.log(`    Konsole: ${k}`)
    }
  }

  // Gesamturteil: Kontrolllauf = alle; eigene Daten = mindestens eine Container-Variante
  const ok = opt.beispiele ? laeufe.every(l => l.ergebnis.ok) : laeufe.some(l => l.ergebnis.ok)
  const massgeblich = opt.beispiele ? laeufe.filter(l => !l.ergebnis.ok) : laeufe.filter(l => !ok || l.ergebnis.ok)
  const zusammenfassung = {
    ok,
    tool: PRUEFTOOL.jar,
    modus: opt.beispiele ? 'beispiele' : 'eigene-daten',
    laeufe: laeufe.map(l => ({ szenario: l.szenario, ok: l.ergebnis.ok, zaehler: l.ergebnis.zaehler, hinweis: l.ergebnis.hinweis,
      fehlgeschlagen: l.ergebnis.fehlgeschlagen.length, konsolenProbleme: l.ergebnis.konsolenProbleme })),
    // flach für die Burn-in-/Test-Helfer: die Fehler des ersten massgeblichen Laufs
    fehlgeschlagen: (massgeblich[0]?.ergebnis.fehlgeschlagen ?? []).slice(0, 200),
    zaehler: massgeblich[0]?.ergebnis.zaehler ?? {},
    hinweis: massgeblich[0]?.ergebnis.hinweis ?? '',
  }
  writeFileSync(join(opt.out, 'bmf-zusammenfassung.json'), JSON.stringify(zusammenfassung, null, 2))

  if (process.env.GITHUB_STEP_SUMMARY) {
    const zeilen = [`### BMF-Prüftool (${zusammenfassung.modus}): ${ok ? '✅ bestanden' : '❌ NICHT bestanden'}`, '',
      '| Lauf | Ergebnis | PASS | FAIL | Hinweis |', '|---|---|---|---|---|',
      ...laeufe.map(l => `| ${l.szenario} | ${l.ergebnis.ok ? '✅' : '❌'} | ${l.ergebnis.zaehler.PASS ?? 0} | ${l.ergebnis.fehlgeschlagen.length} | ${(l.ergebnis.hinweis || l.ergebnis.konsolenProbleme[0] || '').replace(/\|/g, '/')} |`), '']
    for (const l of laeufe.filter(x => !x.ergebnis.ok).slice(0, 3)) {
      zeilen.push(`**${l.szenario}** – erste Fehler:`, '', ...l.ergebnis.fehlgeschlagen.slice(0, 10).map(f => `- \`${f.name}\` ${f.meldung}`), '')
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, zeilen.join('\n') + '\n')
  }
  return ok ? 0 : 1
}

main().then(code => process.exit(code), fehler => { console.error(`Fehler: ${fehler.message}`); process.exit(fehler.message?.startsWith('Unbekannte') || fehler.message?.includes('fehlt') ? 2 : 1) })
