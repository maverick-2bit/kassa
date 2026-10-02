/**
 * artikel-update.ts — Abbildung Artikel-Formular → Update-Body (PUT /api/artikel/:id).
 *
 * Das Formular liefert ein vollständiges `ArtikelInput`. Beim BEARBEITEN muss jedes bearbeitbare Feld
 * mitgeschickt werden — fehlt eines hier, geht die Änderung stillschweigend verloren (so wurden
 * „Eigene Farbe", Lieferant, Mindestbestand, Rohstoff-Flag, Bonierbon-Option, Seriennummern und das
 * Rezept beim Bearbeiten eines bestehenden Artikels nie gespeichert).
 *
 * Leere Werte gehen als `null` (bzw. `[]` beim Rezept) mit — das LEERT das Feld, statt es unverändert
 * zu lassen: wer „Kein Lieferant" wählt oder das Rezept leert, will genau das.
 *
 * Absichtlich NICHT im Update-Body (siehe NICHT_IM_UPDATE): Der Test `artikel-update.test.ts` wird rot,
 * sobald ein neues Feld im Formular-Input weder hier ankommt noch dort mit Begründung ausgenommen ist.
 */

import type { ArtikelInput, ArtikelUpdate } from '@kassa/shared'

/** Felder des Formular-Inputs, die NICHT in den Update-Body übernommen werden — mit Begründung. */
export const NICHT_IM_UPDATE = {
  mandantId:        'kommt serverseitig aus dem Login, nie aus dem Body',
  terminalSichtbar: 'wird zentral im SB-Terminal-Bereich der Einstellungen gepflegt — das Formular erhält den Wert nur und darf ihn nicht (mit altem Stand) zurückschreiben',
  rasterPosition:   'Kachel-Position im Raster — kommt nur aus dem Layout-Import, das Formular bearbeitet sie nicht',
} as const satisfies Partial<Record<keyof ArtikelInput, string>>

/** Update-Body für `artikelApi.update(id, …)` aus der Eingabe des Artikel-Formulars. */
export function artikelUpdateAusInput(input: ArtikelInput): ArtikelUpdate {
  return {
    bezeichnung:            input.bezeichnung,
    preisBruttoCent:        input.preisBruttoCent,
    mwstSatz:               input.mwstSatz,
    station:                input.station         ?? null,
    farbe:                  input.farbe           ?? null,
    kategorieId:            input.kategorieId     ?? null,
    istFavorit:             input.istFavorit,
    bonierdruckerId:        input.bonierdruckerId ?? null,
    bonierBeiDirektverkauf: input.bonierBeiDirektverkauf,
    istBestandteil:         input.istBestandteil,
    // Ersetzt das Rezept vollständig (Server: schreibeRezept) — das Formular startet mit dem bestehenden Rezept
    bestandteile:           input.bestandteile,
    lieferantId:            input.lieferantId     ?? null,
    lagerstandAktiv:        input.lagerstandAktiv,
    lagerstandMenge:        input.lagerstandMenge ?? null,
    mindestbestand:         input.mindestbestand  ?? null,
    seriennummernAktiv:     input.seriennummernAktiv,
    bild:                   input.bild            ?? null,
  }
}
