/**
 * AllergenAuswahl — die 14 Allergene (Buchstabencodes A–R, österreichische Allergeninformationsverordnung) zum
 * Antippen statt Buchstaben tippen. Der Wert ist derselbe kommagetrennte, sortierte String wie in der Datenbank
 * ("A,C,G"); leer = keine Angabe.
 */

import { ALLERGEN_CODES, ALLERGEN_LABELS, parseAllergene, type AllergenCode } from '@kassa/shared'

interface Props {
  /** Gespeicherter Wert ("A,C,G") bzw. lockere Eingabe ("a, c g") */
  wert:     string
  onChange: (wert: string) => void
}

export function AllergenAuswahl({ wert, onChange }: Props) {
  const geparst = parseAllergene(wert)
  const gewaehlt = new Set<string>(geparst.ok && geparst.wert ? geparst.wert.split(',') : [])

  const umschalten = (code: AllergenCode) => {
    const neu = new Set(gewaehlt)
    if (neu.has(code)) neu.delete(code); else neu.add(code)
    onChange([...neu].sort().join(','))
  }

  return (
    <div role="group" aria-label="Allergene" data-testid="allergen-auswahl" className="flex flex-wrap gap-1.5">
      {ALLERGEN_CODES.map(code => {
        const an = gewaehlt.has(code)
        return (
          <button
            key={code}
            type="button"
            aria-pressed={an}
            title={`${code} = ${ALLERGEN_LABELS[code]}`}
            data-testid={`allergen-${code}`}
            onClick={() => umschalten(code)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
              an
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-line-strong bg-panel text-ink-muted hover:border-brand-400 hover:text-ink'
            }`}
          >
            <span className="font-bold">{code}</span>
            <span>{ALLERGEN_LABELS[code]}</span>
          </button>
        )
      })}
    </div>
  )
}
