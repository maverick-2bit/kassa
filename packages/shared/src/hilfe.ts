/**
 * Hilfe-Fenster der Apps: Aufbau der Hilfetexte und die Suche nach dem passenden Thema.
 *
 * Jede App hat ihre eigenen Texte (src/hilfe/texte.ts) und ihr eigenes Fenster; hier steht nur, was alle gemeinsam
 * brauchen: die Form eines Themas und wie zu einer Adresse (oder einem Suchwort) das passende Thema gefunden wird.
 * Die Texte sind für Menschen gedacht, die die Kassa nicht kennen (z. B. Mieter einer Leih-Kassa): kurz, in der
 * Reihenfolge der Handgriffe, mit den Beschriftungen, die auf dem Bildschirm stehen.
 */

export interface HilfeAbschnitt {
  titel:    string
  schritte: string[]
}

export interface HilfeThema {
  /** Eindeutige Kennung, z. B. 'kasse' */
  id:       string
  titel:    string
  /** Ein Satz: wofür ist die Seite da? */
  zweck:    string
  /** Die wichtigsten Handgriffe der Reihe nach */
  schritte: string[]
  /** Weitere Abläufe auf derselben Seite (z. B. „Storno", „Rabatt") */
  abschnitte?: HilfeAbschnitt[]
  /** Kleine Hinweise, was man oft übersieht */
  tipps?: string[]
  /** Adressen, zu denen das Thema gehört; `:name` steht für einen beliebigen Teil (z. B. '/tische/:tabId') */
  pfade?: string[]
  /** Suchwörter zusätzlich zum Titel (z. B. „bon", „rechnung" für Belege) */
  stichworte?: string[]
}

/** Passt die Adresse (ohne Query/Hash) auf das Muster? `:name` = ein beliebiger Abschnitt, `*` am Ende = beliebig viel. */
export function passtPfad(muster: string, pfad: string): boolean {
  const norm = (s: string) => (s.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/'
  const m = norm(muster).split('/')
  const p = norm(pfad).split('/')
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '*') return true
    if (i >= p.length) return false
    if (m[i]!.startsWith(':')) { if (p[i] === '') return false; continue }
    if (m[i] !== p[i]) return false
  }
  return m.length === p.length
}

/** Das Thema zur aktuellen Adresse; ohne Treffer das Thema `fallbackId` (falls angegeben) oder undefined. */
export function findeHilfe(
  themen: readonly HilfeThema[],
  pfad: string,
  fallbackId?: string,
): HilfeThema | undefined {
  return themen.find(t => t.pfade?.some(m => passtPfad(m, pfad)))
    ?? (fallbackId ? themen.find(t => t.id === fallbackId) : undefined)
}

/** Vergleichsform: klein, Umlaute als ae/oe/ue/ss (wer „umsaetze" tippt, findet „Umsätze"), sonstige Akzente weg. */
const klein = (s: string) => s.toLocaleLowerCase('de')
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Themen, die zum Suchtext passen (Titel, Zweck, Stichworte, Schritte); leerer Text = alle. Treffer im Titel zuerst. */
export function suchHilfe(themen: readonly HilfeThema[], text: string): HilfeThema[] {
  const worte = klein(text).split(/\s+/).filter(Boolean)
  if (worte.length === 0) return [...themen]
  const inhalt = (t: HilfeThema) => klein([
    t.titel, t.zweck, ...(t.stichworte ?? []), ...t.schritte,
    ...(t.abschnitte ?? []).flatMap(a => [a.titel, ...a.schritte]), ...(t.tipps ?? []),
  ].join(' '))
  const treffer = themen.filter(t => { const i = inhalt(t); return worte.every(w => i.includes(w)) })
  const imTitel = (t: HilfeThema) => worte.every(w => klein(t.titel + ' ' + (t.stichworte ?? []).join(' ')).includes(w))
  return [...treffer.filter(imTitel), ...treffer.filter(t => !imTitel(t))]
}
