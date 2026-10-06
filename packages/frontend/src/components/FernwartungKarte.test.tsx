/**
 * Karte „Fernwartung" (Einstellungen → System): ID-Formatierung, Darstellung der drei
 * Zustände (eingerichtet / nicht eingerichtet / lädt bzw. Fehler) und der Kopier-Helfer.
 *
 * Gerendert wird mit react-dom/server (ohne Browser); die Abfrage + der Admin-Check der
 * Hülle FernwartungKarte laufen im E2E (e2e/system-fernwartung.spec.ts).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FernwartungStatus } from '../lib/api'
import { FernwartungAnzeige, datumKurz, formatTeamViewerId, kopiereText } from './FernwartungKarte'

const EINGERICHTET: FernwartungStatus = {
  eingerichtet: true, anbieter: 'teamviewer', id: '123456789',
  alias: 'Kassa Gasthof Mayr', gruppe: 'Mietkassen', installiertAm: '2026-10-06T10:00:00.000Z',
}
const NICHT_EINGERICHTET: FernwartungStatus = {
  eingerichtet: false, anbieter: null, id: null, alias: null, gruppe: null, installiertAm: null,
}

function html(props: Partial<Parameters<typeof FernwartungAnzeige>[0]> = {}) {
  return renderToStaticMarkup(
    <FernwartungAnzeige status={EINGERICHTET} laedt={false} fehler={false} kopiert={false} {...props} />,
  )
}

describe('formatTeamViewerId', () => {
  it('9 Stellen → Dreiergruppen', () => {
    expect(formatTeamViewerId('123456789')).toBe('123 456 789')
  })
  it('10 Stellen → von rechts gruppiert wie in TeamViewer', () => {
    expect(formatTeamViewerId('1234567890')).toBe('1 234 567 890')
  })
  it('Leerzeichen und Müll werden ignoriert', () => {
    expect(formatTeamViewerId(' 123-456 789 ')).toBe('123 456 789')
  })
  it('kurze und leere Eingaben', () => {
    expect(formatTeamViewerId('12')).toBe('12')
    expect(formatTeamViewerId('')).toBe('')
  })
})

describe('datumKurz', () => {
  it('ISO → TT.MM.JJJJ', () => {
    expect(datumKurz('2026-10-06T10:00:00.000Z')).toBe('06.10.2026')
  })
  it('leer/ungültig → leer', () => {
    expect(datumKurz(null)).toBe('')
    expect(datumKurz('gestern')).toBe('')
  })
})

describe('FernwartungAnzeige — eingerichtet', () => {
  it('zeigt Zustand, ID in Dreiergruppen, Gerätename, Anbieter und den Support-Hinweis', () => {
    const h = html()
    expect(h).toContain('Eingerichtet')
    expect(h).not.toContain('Nicht eingerichtet')
    expect(h).toContain('123 456 789')
    expect(h).toContain('Kassa Gasthof Mayr')
    expect(h).toContain('TeamViewer')
    expect(h).toContain('Mietkassen')
    expect(h).toContain('06.10.2026')
    expect(h).toContain('Diese ID dem Support nennen')
  })

  it('hat einen Kopieren-Knopf, der nach dem Kopieren „Kopiert" zeigt', () => {
    expect(html()).toContain('>Kopieren<')
    const h = html({ kopiert: true })
    expect(h).toContain('Kopiert')
    expect(h).not.toContain('>Kopieren<')
  })

  it('Knopf meldet dem Screenreader auch das Ergebnis (kopieren → kopiert)', () => {
    expect(html()).toContain('aria-label="TeamViewer-ID kopieren"')
    expect(html({ kopiert: true })).toContain('aria-label="TeamViewer-ID kopiert"')
  })

  it('Knopf nutzt die Button-Klassen (Utility-Ebene gewinnt, keine Basisklassen-Falle)', () => {
    expect(html()).toMatch(/class="btn btn-sm btn-secondary/)
  })

  it('ohne Gerätename/Gruppe/Datum: Strich statt leerer Felder', () => {
    const h = html({ status: { ...EINGERICHTET, alias: null, gruppe: null, installiertAm: null } })
    expect(h).toContain('—')
    expect(h).not.toContain('Gruppe')
    expect(h).not.toContain('Eingerichtet am')
  })

  it('maskiert HTML im Gerätenamen (kein Einschleusen)', () => {
    const h = html({ status: { ...EINGERICHTET, alias: '<img src=x onerror=alert(1)>' } })
    expect(h).not.toContain('<img')
    expect(h).toContain('&lt;img')
  })

  it('verwendet die Design-Token (hell + dunkel), keine festen Hex-Farben', () => {
    const h = html()
    expect(h).toContain('bg-panel')
    expect(h).toContain('text-ink')
    expect(h).toContain('border-line')
    expect(h).toContain('dark:')
    expect(h).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })
})

describe('FernwartungAnzeige — nicht eingerichtet', () => {
  it('zeigt Zustand und die kurze Anleitung (Installer, fernwartung.json, DEPLOYMENT.md)', () => {
    const h = html({ status: NICHT_EINGERICHTET })
    expect(h).toContain('Nicht eingerichtet')
    expect(h).toContain('keine Fernwartung eingerichtet')
    expect(h).toContain('Kassa-Setup')
    expect(h).toContain('fernwartung.json')
    expect(h).toContain('ops/DEPLOYMENT.md')
  })

  it('zeigt weder ID noch Kopieren-Knopf', () => {
    const h = html({ status: NICHT_EINGERICHTET })
    expect(h).not.toContain('Kopieren')
    expect(h).not.toContain('TeamViewer-ID')
  })

  it('„eingerichtet" ohne ID (widersprüchliche Antwort) gilt als nicht eingerichtet', () => {
    const h = html({ status: { ...EINGERICHTET, id: null } })
    expect(h).toContain('Nicht eingerichtet')
    expect(h).not.toContain('Kopieren')
  })
})

describe('FernwartungAnzeige — Laden und Fehler', () => {
  it('lädt: Platzhalter, noch kein Zustand', () => {
    const h = html({ status: undefined, laedt: true })
    expect(h).toContain('wird geladen')
    expect(h).not.toContain('Eingerichtet')
    expect(h).not.toContain('Nicht eingerichtet')
  })

  it('Fehler: Meldung statt falscher Zustandsanzeige', () => {
    const h = html({ status: undefined, fehler: true })
    expect(h).toContain('konnte nicht geladen werden')
    expect(h).not.toContain('Nicht eingerichtet')
  })
})

describe('kopiereText', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('sicherer Kontext: navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await kopiereText('123456789')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('123456789')
  })

  it('http://<IP> (kein sicherer Kontext): Ersatzweg über ein verstecktes Textfeld', async () => {
    const feld = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() }
    const body = { appendChild: vi.fn(), removeChild: vi.fn() }
    const execCommand = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', { createElement: () => feld, body, execCommand })
    expect(await kopiereText('123456789')).toBe(true)
    expect(feld.value).toBe('123456789')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(body.removeChild).toHaveBeenCalledWith(feld)
  })

  it('clipboard wirft → Ersatzweg; scheitert auch der → false', async () => {
    const feld = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() }
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('verweigert')) } })
    vi.stubGlobal('document', { createElement: () => feld, body: { appendChild: vi.fn(), removeChild: vi.fn() }, execCommand: () => false })
    expect(await kopiereText('1')).toBe(false)
  })

  it('ohne DOM (Ausnahme) → false statt Absturz', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)
    expect(await kopiereText('1')).toBe(false)
  })
})
