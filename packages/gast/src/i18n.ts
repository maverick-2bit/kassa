export type Lang = 'de' | 'en' | 'it'

export const TRANSLATIONS = {
  de: {
    laden:            'Speisekarte wird geladen…',
    fehlerTitel:      'Oops!',
    fehlerHilfe:      'Bitte das Personal um Hilfe bitten.',
    dankeTitel:       'Danke!',
    dankeText:        'Deine Bestellung wurde aufgenommen und wird so bald wie möglich zubereitet.',
    deinTisch:        'Dein Tisch',
    weitereBestellung:'Weitere Bestellung aufgeben',
    bestätigenTitel:  'Bestellung bestätigen',
    tisch:            'Tisch',
    gesamt:           'Gesamt',
    wirdGesendet:     '⏳ Wird gesendet…',
    jetztBestellen:   '✓ Jetzt bestellen',
    keineArtikel:     'Keine Artikel in dieser Kategorie verfügbar.',
    artikelAnzahl:    (n: number) => `${n} Artikel`,
    warenkorbAnsehen: 'Warenkorb ansehen',
    fehlerSenden:     'Fehler beim Senden. Bitte nochmal versuchen.',
    fehlerLaden:      'Fehler beim Laden der Speisekarte.',
    fehlerQr:         'Ungültiger QR-Code — kasseId fehlt.',
  },
  en: {
    laden:            'Loading menu…',
    fehlerTitel:      'Oops!',
    fehlerHilfe:      'Please ask a staff member for help.',
    dankeTitel:       'Thank you!',
    dankeText:        'Your order has been received and will be prepared as soon as possible.',
    deinTisch:        'Your table',
    weitereBestellung:'Place another order',
    bestätigenTitel:  'Confirm order',
    tisch:            'Table',
    gesamt:           'Total',
    wirdGesendet:     '⏳ Sending…',
    jetztBestellen:   '✓ Place order',
    keineArtikel:     'No items available in this category.',
    artikelAnzahl:    (n: number) => `${n} item${n !== 1 ? 's' : ''}`,
    warenkorbAnsehen: 'View cart',
    fehlerSenden:     'Failed to send order. Please try again.',
    fehlerLaden:      'Failed to load menu.',
    fehlerQr:         'Invalid QR code — kasseId missing.',
  },
  it: {
    laden:            'Caricamento menu…',
    fehlerTitel:      'Ops!',
    fehlerHilfe:      'Chiedi aiuto al personale.',
    dankeTitel:       'Grazie!',
    dankeText:        'Il tuo ordine è stato ricevuto e verrà preparato il prima possibile.',
    deinTisch:        'Il tuo tavolo',
    weitereBestellung:'Effettua un altro ordine',
    bestätigenTitel:  'Conferma ordine',
    tisch:            'Tavolo',
    gesamt:           'Totale',
    wirdGesendet:     '⏳ Invio in corso…',
    jetztBestellen:   '✓ Ordina ora',
    keineArtikel:     'Nessun articolo disponibile in questa categoria.',
    artikelAnzahl:    (n: number) => `${n} articol${n !== 1 ? 'i' : 'o'}`,
    warenkorbAnsehen: 'Vedi carrello',
    fehlerSenden:     "Errore durante l'invio. Riprova.",
    fehlerLaden:      'Errore durante il caricamento del menu.',
    fehlerQr:         'QR code non valido — kasseId mancante.',
  },
} satisfies Record<Lang, Record<string, string | ((n: number) => string)>>

export type T = typeof TRANSLATIONS.de

/** Sprache aus URL-Param `lang` oder Browser-Sprache ermitteln */
export function detectLang(): Lang {
  const param = new URLSearchParams(window.location.search).get('lang')?.toLowerCase()
  if (param === 'en' || param === 'it' || param === 'de') return param
  const browser = navigator.language.toLowerCase()
  if (browser.startsWith('it')) return 'it'
  if (browser.startsWith('en')) return 'en'
  return 'de'
}
