import { describe, it, expect } from 'vitest'
import { ArtikelInputSchema, ArtikelUpdateSchema, type ArtikelInput } from '@kassa/shared'
import { artikelUpdateAusInput, NICHT_IM_UPDATE } from './artikel-update'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Beispieleingabe MIT einem Wert in JEDEM Feld des Formular-Inputs. `satisfies` erzwingt beim Kompilieren,
 * der erste Test zur Laufzeit, dass hier kein Feld fehlt — wer dem Artikel-Input ein Feld hinzufügt,
 * muss es hier eintragen und in artikel-update.ts abbilden (oder dort mit Begründung ausnehmen).
 */
const BEISPIEL = {
  mandantId:              ID(1),
  bezeichnung:            'Testartikel',
  preisBruttoCent:        -200,
  mwstSatz:               'ermaessigt1',
  allergene:              'A,C,G',
  station:                'schank',
  farbe:                  '#336699',
  kategorieId:            ID(2),
  rasterPosition:         4,
  lagerstandAktiv:        true,
  lagerstandMenge:        12,
  mindestbestand:         3,
  seriennummernAktiv:     true,
  istFavorit:             true,
  bonierdruckerId:        ID(3),
  bonierBeiDirektverkauf: true,
  istBestandteil:         true,
  bestandteile:           [{ bestandteilArtikelId: ID(4), menge: 2 }],
  lieferantId:            ID(5),
  terminalSichtbar:       true,
  bild:                   'data:image/jpeg;base64,AAAA',
} satisfies Record<keyof ArtikelInput, unknown>

const eingabe = BEISPIEL as unknown as ArtikelInput
const schemaFelder = Object.keys(ArtikelInputSchema.shape)

describe('artikelUpdateAusInput: kein Formularfeld geht beim Bearbeiten verloren', () => {
  it('die Beispieleingabe deckt jedes Feld des Artikel-Inputs ab (neues Feld → hier und in artikel-update.ts ergänzen)', () => {
    expect(Object.keys(BEISPIEL).sort()).toEqual([...schemaFelder].sort())
    // und die Beispieleingabe ist selbst gültig
    expect(ArtikelInputSchema.safeParse(BEISPIEL).success).toBe(true)
  })

  it('jedes Feld kommt mit seinem Wert im Update-Body an — ausgenommen nur NICHT_IM_UPDATE', () => {
    const body = artikelUpdateAusInput(eingabe) as Record<string, unknown>
    for (const feld of schemaFelder) {
      if (feld in NICHT_IM_UPDATE) continue
      expect(body, `Feld „${feld}" geht beim Bearbeiten eines Artikels verloren`).toHaveProperty(feld)
      expect(body[feld], `Feld „${feld}" wird verändert`).toEqual((BEISPIEL as Record<string, unknown>)[feld])
    }
  })

  it('die bewusst ausgenommenen Felder (mandantId, terminalSichtbar, rasterPosition) stehen NICHT im Update-Body', () => {
    const body = artikelUpdateAusInput(eingabe)
    for (const feld of Object.keys(NICHT_IM_UPDATE)) expect(body).not.toHaveProperty(feld)
    // …und die Ausnahmeliste nennt nur Felder, die es im Input noch gibt (Veraltetes fällt auf)
    for (const feld of Object.keys(NICHT_IM_UPDATE)) expect(schemaFelder).toContain(feld)
  })

  it('die vom Formular bisher vergessenen Felder sind dabei', () => {
    const body = artikelUpdateAusInput(eingabe)
    expect(body).toMatchObject({
      farbe: '#336699', bonierBeiDirektverkauf: true, istBestandteil: true, lieferantId: ID(5),
      mindestbestand: 3, seriennummernAktiv: true, bestandteile: [{ bestandteilArtikelId: ID(4), menge: 2 }],
    })
  })

  it('der Update-Body enthält nur Felder, die das Update-Schema der API kennt, und ist gültig', () => {
    const body = artikelUpdateAusInput(eingabe)
    const erlaubt = Object.keys(ArtikelUpdateSchema.shape)
    for (const feld of Object.keys(body)) expect(erlaubt, `„${feld}" kennt die API nicht`).toContain(feld)
    const geparst = ArtikelUpdateSchema.safeParse(body)
    expect(geparst.success).toBe(true)
    // nichts geht beim Schema-Parsen verloren (zod entfernt unbekannte Felder still)
    expect(geparst.success && Object.keys(geparst.data).sort()).toEqual(Object.keys(body).sort())
  })
})

describe('artikelUpdateAusInput: leere Werte leeren das Feld (null / []), statt es unverändert zu lassen', () => {
  const minimal = ArtikelInputSchema.parse({ mandantId: ID(1), bezeichnung: 'Leer', preisBruttoCent: 100, mwstSatz: 'normal' })

  it('Standardwerte des Formulars → ausdrückliche null/[]/false im Update-Body', () => {
    expect(artikelUpdateAusInput(minimal)).toEqual({
      bezeichnung: 'Leer', preisBruttoCent: 100, mwstSatz: 'normal',
      allergene: null, station: null, farbe: null, kategorieId: null, istFavorit: false, bonierdruckerId: null,
      bonierBeiDirektverkauf: false, istBestandteil: false, bestandteile: [], lieferantId: null,
      lagerstandAktiv: false, lagerstandMenge: null, mindestbestand: null, seriennummernAktiv: false, bild: null,
    })
  })

  it('„Kein Lieferant" / Rezept geleert / Farbe automatisch / Bild entfernt gehen als Leerung mit', () => {
    const body = artikelUpdateAusInput({ ...eingabe, lieferantId: null, bestandteile: [], farbe: null, bild: null, mindestbestand: null })
    expect(body).toMatchObject({ lieferantId: null, bestandteile: [], farbe: null, bild: null, mindestbestand: null })
  })

  it('der leere Update-Body ist ebenfalls gültig', () => {
    expect(ArtikelUpdateSchema.safeParse(artikelUpdateAusInput(minimal)).success).toBe(true)
  })
})
