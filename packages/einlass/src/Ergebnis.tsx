import { EINLASS_ERGEBNIS_TITEL, type EinlassErgebnis } from '@kassa/shared'
import { datumZeit, geburtsdatumText, schriftAuf, uhrzeit } from './lib/format'

export type Anzeige =
  | { art: 'ergebnis'; ergebnis: EinlassErgebnis }
  | { art: 'keineVerbindung' }
  | { art: 'fehler'; text: string }

/**
 * Großes Ergebnisfeld über dem ganzen Bildschirm — aus zwei Metern lesbar.
 * Zugelassen: Fläche in der BANDFARBE (das Personal greift sofort zum richtigen
 * Band), dazu Alter + Geburtsdatum für den Ausweisabgleich. Abgewiesen: rot.
 */
export function Ergebnis({ anzeige, onWeiter }: { anzeige: Anzeige; onWeiter: () => void }) {
  if (anzeige.art !== 'ergebnis') {
    return (
      <Flaeche farbe="#991b1b" onWeiter={onWeiter}>
        <p className="text-4xl font-black">✗ NICHT GEPRÜFT</p>
        <p className="mt-3 text-xl">
          {anzeige.art === 'keineVerbindung' ? 'Keine Verbindung zum Server.' : anzeige.text}
        </p>
        <p className="mt-2 opacity-80">Ticket wurde nicht eingelöst — erneut scannen.</p>
      </Flaeche>
    )
  }

  const { ergebnis: e } = anzeige
  const t = e.ticket

  if (e.ergebnis === 'zugelassen' || e.ergebnis === 'mehrfach') {
    const mehrfach = e.ergebnis === 'mehrfach'
    const farbe = mehrfach ? '#4338ca' : (t?.band?.farbe ?? '#15803d')
    return (
      <Flaeche farbe={farbe} onWeiter={onWeiter}>
        <p className="text-3xl font-black">✓ {mehrfach ? 'MEHRFACHTICKET' : 'EINLASS'}</p>
        {mehrfach && t?.rolle && <p className="mt-3 text-6xl font-black uppercase leading-none">{t.rolle}</p>}
        {!mehrfach && t?.band && (
          <>
            <p className="mt-4 text-6xl font-black uppercase leading-none">Band {t.band.bezeichnung}</p>
            <p className="mt-2 text-2xl font-semibold">{t.band.altersText}</p>
          </>
        )}
        {mehrfach && t?.band && (
          <p className="mt-4 inline-block rounded-full px-4 py-1.5 text-xl font-bold"
            style={{ background: t.band.farbe, color: schriftAuf(t.band.farbe) }}>
            Band {t.band.bezeichnung} · {t.band.altersText}
          </p>
        )}
        {t?.alter !== null && t?.alter !== undefined && (
          <p className="mt-5 text-3xl font-bold">
            {t.alter} Jahre
            {t.geburtsdatum && <span className="ml-2 text-xl font-medium opacity-90">geb. {geburtsdatumText(t.geburtsdatum)}</span>}
          </p>
        )}
        {t?.band?.hinweis && (
          <p className="mt-4 rounded-xl bg-black/25 px-4 py-2 text-xl font-bold">{t.band.hinweis}</p>
        )}
        {t?.name && <p className="mt-4 text-2xl">{t.name}</p>}
        {/* Bei Mehrfachtickets ist die Bezeichnung meist die Rolle — nicht doppelt zeigen */}
        {t && !(mehrfach && t.bezeichnung === t.rolle) && <p className="mt-2 text-lg opacity-90">{t.bezeichnung}</p>}
        {mehrfach && t && (
          <p className="mt-4 text-lg opacity-90">
            {t.einlassAnzahl}. Eintritt{t.einlassAnzahl > 1 ? ' · zählt nicht erneut als Besucher' : ''}
          </p>
        )}
        {!t?.band && !mehrfach && t?.geburtsdatum === null && (
          <p className="mt-4 text-lg opacity-90">Kein Geburtsdatum am Ticket — Alter ggf. per Ausweis prüfen.</p>
        )}
      </Flaeche>
    )
  }

  let detail: string | null = null
  if (e.ergebnis === 'bereits_eingeloest' && t?.ersterEinlassAt) {
    detail = `um ${uhrzeit(t.ersterEinlassAt)} Uhr${t.ersterEinlassGeraet ? ` · ${t.ersterEinlassGeraet}` : ''}`
  } else if (e.ergebnis === 'falsches_event' && e.anderesEvent) {
    detail = `Gilt für: ${e.anderesEvent.titel}, ${datumZeit(e.anderesEvent.beginn)}`
  }
  return (
    <Flaeche farbe="#b91c1c" onWeiter={onWeiter}>
      <p className="text-4xl font-black">✗ KEIN EINLASS</p>
      <p className="mt-4 text-5xl font-black leading-tight">{EINLASS_ERGEBNIS_TITEL[e.ergebnis]}</p>
      {detail && <p className="mt-3 text-2xl font-semibold">{detail}</p>}
      {t && <p className="mt-5 text-xl opacity-90">{t.bezeichnung}{t.name ? ` · ${t.name}` : ''}</p>}
    </Flaeche>
  )
}

function Flaeche({ farbe, onWeiter, children }: { farbe: string; onWeiter: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onWeiter}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center"
      style={{ background: farbe, color: schriftAuf(farbe) }}
      aria-live="assertive"
    >
      <div>{children}</div>
      <p className="absolute bottom-6 left-0 right-0 text-sm opacity-70">Tippen für den nächsten Gast</p>
    </button>
  )
}
