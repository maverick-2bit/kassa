/**
 * Bewertung einer Box: aus der letzten Meldung und dem Zeitpunkt des letzten Kontakts wird ein Status samt Gründen.
 *
 * Rein (ohne Datenbank, ohne Uhr — `jetzt` kommt von außen). Dieselbe Funktion bedient später die Alarme: ein Alarm
 * ist „Status wird schlechter" bzw. „es gibt einen neuen Grund mit Code X".
 *
 * Status:
 *   neu       noch nie gemeldet
 *   offline   zu lange nichts gehört — dann ist der letzte Zustand nichts mehr wert, es zählt nur dieser Grund
 *   kritisch  mindestens ein kritischer Grund (Datenbank, Signatureinheit, Zertifikat abgelaufen, Speicher voll)
 *   warnung   mindestens ein Warn-Grund (Sicherung veraltet, Drucker weg, Speicher knapp, Bons nicht zugestellt …)
 *   ok        nichts davon
 * `info`-Gründe (z. B. Serverfehler seit der letzten Meldung) ändern den Status nicht.
 */

import type { BoxGrund, BoxStatus, PortalMeldung } from '@kassa/shared'

export const ZERTIFIKAT_WARNUNG_TAGE = 30
export const DB_LATENZ_WARNUNG_MS = 1000

export interface BewertungsEingabe {
  meldung:             PortalMeldung | null
  zuletztGesehen:      Date | null
  jetzt:               Date
  offlineNachSekunden: number
}

export interface Bewertung {
  status:  BoxStatus
  gruende: BoxGrund[]
}

/** „vor 5 Minuten" — grob, aber lesbar. */
export function dauerText(sekunden: number): string {
  const s = Math.max(0, Math.round(sekunden))
  if (s < 60)      return `${s} ${s === 1 ? 'Sekunde' : 'Sekunden'}`
  if (s < 3600)    { const m = Math.round(s / 60);    return `${m} ${m === 1 ? 'Minute' : 'Minuten'}` }
  if (s < 86_400)  { const h = Math.round(s / 3600);  return `${h} ${h === 1 ? 'Stunde' : 'Stunden'}` }
  const t = Math.round(s / 86_400)
  return `${t} ${t === 1 ? 'Tag' : 'Tagen'}`
}

const STUFE_REIHENFOLGE: Record<BoxGrund['stufe'], number> = { kritisch: 0, warnung: 1, info: 2 }

/** Schweregrad eines Status — höher = dringender. Für „schlechtester Status eines Betriebs". */
const STATUS_SCHWERE: Record<BoxStatus, number> = { ok: 0, neu: 1, warnung: 2, kritisch: 3, offline: 4 }

export function schlechtesterStatus(liste: readonly BoxStatus[]): BoxStatus {
  let schlechtester: BoxStatus = 'ok'
  for (const s of liste) if (STATUS_SCHWERE[s] > STATUS_SCHWERE[schlechtester]) schlechtester = s
  return schlechtester
}

function sortiere(gruende: BoxGrund[]): BoxGrund[] {
  return [...gruende].sort((a, b) => STUFE_REIHENFOLGE[a.stufe] - STUFE_REIHENFOLGE[b.stufe])
}

function zeitpunkt(text: string): number | null {
  const t = Date.parse(text)
  return Number.isNaN(t) ? null : t
}

export function bewerteBox(e: BewertungsEingabe): Bewertung {
  const { meldung, zuletztGesehen, jetzt } = e

  if (zuletztGesehen === null || meldung === null) {
    return { status: 'neu', gruende: [{ stufe: 'info', code: 'neu', text: 'Noch keine Meldung eingegangen.' }] }
  }

  const stilleSekunden = (jetzt.getTime() - zuletztGesehen.getTime()) / 1000
  if (stilleSekunden > e.offlineNachSekunden) {
    return {
      status:  'offline',
      gruende: [{ stufe: 'kritisch', code: 'offline', text: `Keine Meldung seit ${dauerText(stilleSekunden)}.` }],
    }
  }

  const gruende: BoxGrund[] = []
  const grund = (stufe: BoxGrund['stufe'], code: string, text: string) => gruende.push({ stufe, code, text })

  // ---- Box selbst ----
  if (!meldung.db.ok) {
    grund('kritisch', 'db', 'Die Datenbank der Box ist nicht erreichbar.')
  } else if (meldung.db.latenzMs !== null && meldung.db.latenzMs > DB_LATENZ_WARNUNG_MS) {
    grund('warnung', 'db-langsam', `Die Datenbank antwortet langsam (${Math.round(meldung.db.latenzMs)} ms).`)
  }

  const sicherungen = [
    { code: 'backup-db',  name: 'Datenbank-Sicherung', stand: meldung.backups.dbBackup },
    { code: 'backup-dep', name: 'DEP-Sicherung',       stand: meldung.backups.depBackup },
  ]
  for (const { code, name, stand } of sicherungen) {
    if (stand.zustand === 'fehlt') {
      grund('warnung', code, `${name}: noch keine vorhanden.`)
    } else if (stand.zustand === 'veraltet') {
      grund('warnung', code, stand.alterStunden !== null
        ? `${name} veraltet (zuletzt vor ${dauerText(stand.alterStunden * 3600)}).`
        : `${name} veraltet.`)
    }
  }

  const frei = meldung.speicher.freiGb !== null ? ` (frei: ${meldung.speicher.freiGb.toFixed(1).replace('.', ',')} GB)` : ''
  if (meldung.speicher.zustand === 'kritisch') grund('kritisch', 'speicher', `Speicherplatz fast voll${frei}.`)
  else if (meldung.speicher.zustand === 'knapp') grund('warnung', 'speicher', `Speicherplatz wird knapp${frei}.`)
  else if (meldung.speicher.zustand === 'unbekannt') grund('info', 'speicher-unbekannt', 'Speicherplatz konnte nicht gemessen werden.')

  // ---- Betriebe der Box: nur aktive Kassen zählen, stillgelegte sind kein Fehler ----
  for (const betrieb of meldung.betriebe) {
    for (const kasse of betrieb.kassen) {
      if (kasse.status !== 'aktiv') continue
      const wo = `Kasse ${kasse.kassenId}${meldung.betriebe.length > 1 ? `, ${betrieb.firmenname}` : ''}`

      if (kasse.seeAusgefallenSeit !== null) {
        const seit = zeitpunkt(kasse.seeAusgefallenSeit)
        grund('kritisch', 'see', seit !== null
          ? `Signatureinheit ausgefallen seit ${dauerText((jetzt.getTime() - seit) / 1000)} (${wo}).`
          : `Signatureinheit ausgefallen (${wo}).`)
      }

      const gueltigBis = zeitpunkt(kasse.seeGueltigBis)
      if (gueltigBis !== null) {
        const tage = (gueltigBis - jetzt.getTime()) / 86_400_000
        if (tage < 0) grund('kritisch', 'zertifikat', `Signaturzertifikat abgelaufen (${wo}).`)
        else if (tage < ZERTIFIKAT_WARNUNG_TAGE) {
          const n = Math.ceil(tage)
          grund('warnung', 'zertifikat', `Signaturzertifikat läuft in ${n} ${n === 1 ? 'Tag' : 'Tagen'} ab (${wo}).`)
        }
      }

      if (kasse.offeneBonProbleme > 0) {
        grund('warnung', 'bon-probleme', `${kasse.offeneBonProbleme} ${kasse.offeneBonProbleme === 1 ? 'Bon' : 'Bons'} nicht zugestellt (${wo}).`)
      }
    }

    for (const drucker of betrieb.drucker) {
      if (!drucker.erreichbar) {
        const art = drucker.quelle === 'bonier' ? 'Bonierdrucker' : 'Belegdrucker'
        grund('warnung', 'drucker', `${art} „${drucker.name}" nicht erreichbar${drucker.fehler ? `: ${drucker.fehler}` : ''}.`)
      }
    }
  }

  // ---- Serverfehler seit der letzten Meldung: gut zu wissen, aber kein Status ----
  const fehlerAnzahl = meldung.fehler.reduce((summe, f) => summe + f.anzahl, 0)
  if (fehlerAnzahl > 0) {
    grund('info', 'fehler', `${fehlerAnzahl} Serverfehler seit der letzten Meldung (${meldung.fehler.length} verschiedene).`)
  }

  const status: BoxStatus = gruende.some(g => g.stufe === 'kritisch') ? 'kritisch'
    : gruende.some(g => g.stufe === 'warnung') ? 'warnung'
    : 'ok'
  return { status, gruende: sortiere(gruende) }
}
