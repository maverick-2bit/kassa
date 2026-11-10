import { describe, it, expect } from 'vitest'
import { erkenneBefehl } from './befehle'

describe('Sprachbefehle', () => {
  it.each(['ja', 'Ja!', 'jawohl', 'passt', 'stimmt', 'richtig', 'genau', 'okay', 'ja bitte', 'ja genau', 'das passt so', 'in den Korb', 'ab damit', 'abschicken'])(
    '„%s" bestätigt', (t) => expect(erkenneBefehl(t)).toBe('bestaetigen'))

  it.each(['nein', 'Nein!', 'falsch', 'abbrechen', 'stopp', 'nein danke', 'nochmal', 'alles falsch'])(
    '„%s" verwirft', (t) => expect(erkenneBefehl(t)).toBe('verwerfen'))

  it('eine Bestellung ist kein Befehl — auch wenn sie mit „ja" beginnt', () => {
    expect(erkenneBefehl('ja und noch zwei Cola')).toBeNull()
    expect(erkenneBefehl('ja ein Bier')).toBeNull()
    expect(erkenneBefehl('noch ein Bier')).toBeNull()
    expect(erkenneBefehl('zwei Cola')).toBeNull()
  })

  it('widersprüchlich, leer oder zu lang → kein Befehl', () => {
    expect(erkenneBefehl('ja nein')).toBeNull()
    expect(erkenneBefehl('')).toBeNull()
    expect(erkenneBefehl('   ')).toBeNull()
    expect(erkenneBefehl('ja ja ja ja')).toBeNull()
  })

  it('Getränkenamen, die wie Befehle klingen, lösen nichts aus', () => {
    expect(erkenneBefehl('Stopfen')).toBeNull()
    expect(erkenneBefehl('Jägermeister')).toBeNull()
  })
})
