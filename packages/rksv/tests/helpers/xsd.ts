/**
 * XSD-Validierung gegen die amtlichen FinanzOnline-Schemas (tests/fixtures/fon-xsd).
 *
 * Verwendet libxml2 als WebAssembly (xmllint-wasm): läuft überall ohne native Abhängigkeit und
 * ohne Netzzugriff — die Schemas liegen als Fixtures im Repo (Quelle und Prüfsummen: fixtures/fon-xsd/README.md).
 *
 * Mehrere Dokumente werden in EINEM Aufruf geprüft (jeder Aufruf startet eine WebAssembly-Instanz in
 * einem Worker — einzeln wäre die Suite spürbar langsamer).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateXML } from 'xmllint-wasm'

export const FON_XSD_ORDNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fon-xsd')

/** Welches Schema ein Dokument erfüllen muss. `session` = Login/Logout, `rkdb` = Registrierkassen-WebService. */
export type FonSchema = 'session' | 'rkdb'

export interface XsdFall {
  /** Eindeutiger Name (Dateiname im Validator, erscheint in den Fehlermeldungen) */
  name:   string
  schema: FonSchema
  xml:    string
}

export interface XsdErgebnis {
  gueltig: boolean
  /** Meldungen von libxml2, ohne Ortsangabe (Zeilennummer) — leer bei gültigen Dokumenten */
  fehler:  string[]
}

const lies = (datei: string): string => readFileSync(join(FON_XSD_ORDNER, datei), 'utf8')

/** Das Hauptschema steht an erster Stelle, `xs:include`-Ziele werden vorab bereitgestellt (kein Netzzugriff). */
const SCHEMEN: Record<FonSchema, { schema: string[]; preload: { fileName: string; contents: string }[] }> = {
  session: {
    schema:  [lies('session.xsd')],
    preload: [],
  },
  rkdb: {
    schema:  [lies('regKasseWs.xsd')],
    preload: [
      { fileName: 'regKasse.xsd',     contents: lies('regKasse.xsd') },
      { fileName: 'verification.xsd', contents: lies('verification.xsd') },
    ],
  },
}

/** Prüft alle Fälle (je Schema ein Aufruf) und liefert das Ergebnis je Fallname. */
export async function validiereGegenXsd(faelle: readonly XsdFall[]): Promise<Map<string, XsdErgebnis>> {
  const ergebnis = new Map<string, XsdErgebnis>()

  for (const schema of Object.keys(SCHEMEN) as FonSchema[]) {
    const dieses = faelle.filter(f => f.schema === schema)
    if (dieses.length === 0) continue

    const res = await validateXML({
      xml:     dieses.map(f => ({ fileName: `${f.name}.xml`, contents: f.xml })),
      schema:  SCHEMEN[schema].schema,
      preload: SCHEMEN[schema].preload,
    })

    // Jedes Dokument bekommt seine eigenen Meldungen; ohne Meldung = gültig.
    for (const f of dieses) {
      const eigene = res.errors
        .filter(e => e.loc?.fileName === `${f.name}.xml`)
        .map(e => e.message.replace(/^[^:]*:\d*:?\s*/, '').trim())
      ergebnis.set(f.name, { gueltig: eigene.length === 0, fehler: eigene })
    }

    // Meldungen ohne Zuordnung (z. B. Schema selbst kaputt) dürfen nie stillschweigend verschwinden.
    // Die Sammelzeile „<Datei> fails to validate", die xmllint je fehlerhaftem Dokument ausgibt, ist keine Meldung.
    const zugeordnet = new Set(dieses.map(f => `${f.name}.xml`))
    const verwaist = res.errors.filter(e =>
      (!e.loc || !zugeordnet.has(e.loc.fileName)) && !/ fails to validate\s*$/.test(e.rawMessage))
    if (verwaist.length > 0) {
      throw new Error(`XSD-Validierung (${schema}): Meldungen ohne zugehöriges Dokument:\n${verwaist.map(e => e.rawMessage).join('\n')}`)
    }
  }
  return ergebnis
}
