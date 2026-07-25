/**
 * TischEtikettenModal — Tischnummern-Etiketten aus der Kassa auf den Bondrucker
 * drucken, je Tisch optional mit Gast-Bestell-QR.
 *
 * Tischquelle: aus dem Tischplan gewählte Tische (Chips) UND/ODER freie Eingabe
 * (Liste/Bereich, z. B. „1-20, Bar, Terrasse 3").
 */

import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { druckerApi, druckerPoolApi, tischplanApi } from '../lib/api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

/** Parst freie Eingabe („1-20", „Bar, Terrasse 3") in eine Tischliste. */
export function parseTischEingabe(text: string): string[] {
  const out: string[] = []
  for (const teil of text.split(',')) {
    const t = teil.trim()
    if (!t) continue
    const m = t.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      let a = parseInt(m[1]!, 10)
      let b = parseInt(m[2]!, 10)
      if (a > b) [a, b] = [b, a]
      if (b - a <= 200) for (let i = a; i <= b; i++) out.push(String(i))
    } else {
      out.push(t)
    }
  }
  return out
}

export function TischEtikettenModal({
  kasseId,
  open,
  onClose,
}: {
  kasseId: string
  open:    boolean
  onClose: () => void
}) {
  const bereicheQuery = useQuery({
    queryKey: ['tischplan-bereiche', kasseId],
    queryFn:  () => tischplanApi.listeBereiche(kasseId),
    enabled:  open,
  })
  const cfgQuery = useQuery({
    queryKey: ['drucker', kasseId],
    queryFn:  () => druckerApi.get(kasseId),
    enabled:  open,
  })
  const poolQuery = useQuery({
    queryKey: ['drucker-pool'],
    queryFn:  () => druckerPoolApi.list(),
    enabled:  open,
  })

  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set())
  const [manuell,  setManuell]  = useState('')
  const [mitQr,    setMitQr]    = useState(false)
  /** Zieldrucker: 'kasse' = Kassen-Bondrucker, 'a4' = A4-Bogen (Browser/PDF), sonst Pool-Drucker-ID */
  const [ziel,     setZiel]     = useState<string>('kasse')
  const [erfolg,   setErfolg]   = useState<string | null>(null)
  const [fehler,   setFehler]   = useState<string | null>(null)
  const a4GridRef = useRef<HTMLDivElement>(null)

  // Bereiche mit ihren (bereinigten) Tischnamen — für Gruppen-Chips + „Alle je Bereich"
  const bereichGruppen = useMemo(
    () => (bereicheQuery.data ?? [])
      .map(b => ({
        id:     b.id,
        name:   b.name,
        tische: [...new Set(b.elemente.map(e => e.bezeichnung.trim()).filter(Boolean))],
      }))
      .filter(b => b.tische.length > 0),
    [bereicheQuery.data],
  )
  const planTische = useMemo(
    () => [...new Set(bereichGruppen.flatMap(b => b.tische))],
    [bereichGruppen],
  )
  const gastUrlGesetzt = !!cfgQuery.data?.gastBasisUrl

  // Ergebnis-Tischliste: gewählte Plan-Tische + geparste manuelle Eingabe, dedupliziert.
  const alleTische = useMemo(() => {
    const s = new Set<string>(gewaehlt)
    for (const t of parseTischEingabe(manuell)) s.add(t)
    return [...s]
  }, [gewaehlt, manuell])

  const gastUrlFuer = (t: string): string =>
    `${cfgQuery.data?.gastBasisUrl ?? ''}?kasseId=${encodeURIComponent(kasseId)}&tisch=${encodeURIComponent(t)}`

  /** A4-Bogen: Druckfenster mit den LOKAL gerenderten QR-Karten öffnen. */
  function a4BogenOeffnen() {
    if (!a4GridRef.current) return
    const win = window.open('', '_blank')
    if (!win) { setFehler('Popup blockiert — bitte Popups für die Kassa erlauben'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tisch-QR-Codes</title>
      <style>
        body{font-family:sans-serif;margin:0}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px}
        .karte{border:1px dashed #9ca3af;border-radius:12px;padding:16px;text-align:center;break-inside:avoid}
        .karte .name{font-size:22px;font-weight:800;margin-top:8px;color:#111}
        .karte .brand{font-size:9px;color:#9ca3af;margin-top:6px}
        @media print{@page{margin:12mm}}
      </style></head><body><div class="grid">${a4GridRef.current.innerHTML}</div></body></html>`)
    win.document.close()
    win.focus()
    win.print()
    setErfolg(`${alleTische.length} Karte(n) im Druckdialog (A4-Drucker oder „Als PDF speichern")`)
    setFehler(null)
  }

  const druckMutation = useMutation({
    mutationFn: () => druckerApi.druckeTischEtiketten(kasseId, {
      tische: alleTische,
      mitQr:  mitQr && gastUrlGesetzt,
      ...(ziel !== 'kasse' && ziel !== 'a4' ? { druckerId: ziel } : {}),
    }),
    onSuccess: (r) => { setErfolg(`${r.anzahl} Etikett(en) gedruckt`); setFehler(null) },
    onError:   (e) => { setFehler(e instanceof Error ? e.message : String(e)); setErfolg(null) },
  })

  const drucken = () => { ziel === 'a4' ? a4BogenOeffnen() : druckMutation.mutate() }

  const toggle = (t: string) =>
    setGewaehlt(prev => {
      const s = new Set(prev)
      if (s.has(t)) s.delete(t); else s.add(t)
      return s
    })

  return (
    <Modal open={open} onClose={onClose} title="Tischnummern drucken">
      <div className="space-y-4">
        {/* Tischplan-Chips — je Bereich mit „Alle"-Schnellwahl */}
        {planTische.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-ink">Aus dem Tischplan</span>
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={() => setGewaehlt(new Set(gewaehlt.size === planTische.length ? [] : planTische))}
              >
                {gewaehlt.size === planTische.length ? 'Keine' : 'Alle Bereiche'}
              </button>
            </div>
            <div className="space-y-2">
              {bereichGruppen.map(b => {
                const alleGewaehlt = b.tische.every(t => gewaehlt.has(t))
                return (
                  <div key={b.id}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-semibold text-ink-subtle">{b.name}</span>
                      <button
                        type="button"
                        className="text-[11px] text-brand-600 hover:underline"
                        onClick={() => setGewaehlt(prev => {
                          const s = new Set(prev)
                          if (alleGewaehlt) b.tische.forEach(t => s.delete(t))
                          else b.tische.forEach(t => s.add(t))
                          return s
                        })}
                      >
                        {alleGewaehlt ? 'keine' : 'alle'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {b.tische.map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => toggle(t)}
                          className={`px-3 py-1.5 rounded-full text-sm border transition ${
                            gewaehlt.has(t)
                              ? 'bg-brand-600 text-white border-brand-600'
                              : 'bg-panel border-line text-ink hover:bg-panel-2'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Manuelle Eingabe */}
        <label className="block">
          <span className="text-sm font-medium text-ink">Oder Nummern eingeben</span>
          <Input
            value={manuell}
            onChange={(e) => setManuell(e.target.value)}
            placeholder="z. B. 1-20, Bar, Terrasse 3"
            className="mt-1"
          />
          <span className="mt-1 block text-[11px] text-ink-subtle">Bereiche mit „-", mehrere mit Komma trennen.</span>
        </label>

        {/* QR-Schalter */}
        <label className={`flex items-center gap-3 ${gastUrlGesetzt ? 'cursor-pointer' : 'opacity-60'}`}>
          <input
            type="checkbox"
            disabled={!gastUrlGesetzt}
            checked={mitQr && gastUrlGesetzt}
            onChange={(e) => setMitQr(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-ink">QR-Code mitdrucken</p>
            <p className="text-xs text-ink-subtle">
              {gastUrlGesetzt
                ? 'Gast scannt zum Bestellen (tischindividuelle URL).'
                : 'Zuerst die Gast-Bestell-Basis-URL in Einstellungen → Hardware setzen.'}
            </p>
          </div>
        </label>

        {/* Zieldrucker: Kassen-Bondrucker · Drucker aus der Bibliothek · A4-Bogen */}
        <div>
          <p className="text-sm font-medium text-ink mb-1.5">Drucken auf</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setZiel('kasse')}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${
                ziel === 'kasse' ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel border-line text-ink hover:bg-panel-2'
              }`}
            >
              🖨 Kassen-Bondrucker
            </button>
            {(poolQuery.data ?? []).filter(d => d.aktiv).map(d => (
              <button
                key={d.id}
                type="button"
                onClick={() => setZiel(d.id)}
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  ziel === d.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel border-line text-ink hover:bg-panel-2'
                }`}
              >
                🖨 {d.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setZiel('a4')}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${
                ziel === 'a4' ? 'bg-brand-600 text-white border-brand-600' : 'bg-panel border-line text-ink hover:bg-panel-2'
              }`}
            >
              📄 A4-Bogen / PDF
            </button>
          </div>
          {ziel === 'a4' && (
            <p className="mt-1 text-[11px] text-ink-subtle">
              Öffnet den Browser-Druckdialog — dort A4-Drucker wählen oder „Als PDF speichern".
            </p>
          )}
        </div>

        {/* Unsichtbares A4-Karten-Grid (Quelle für das Druckfenster; QRs lokal gerendert) */}
        {ziel === 'a4' && (
          <div ref={a4GridRef} style={{ display: 'none' }}>
            {alleTische.map(t => (
              <div key={t} className="karte">
                {gastUrlGesetzt && <QRCodeSVG value={gastUrlFuer(t)} size={150} level="M" includeMargin={false} />}
                <div className="name">{t}</div>
                <div className="brand">powered by s/e smarte events</div>
              </div>
            ))}
          </div>
        )}

        {erfolg && <p className="text-sm text-green-600 font-medium">✓ {erfolg}</p>}
        {fehler && <p className="text-sm text-red-600">{fehler}</p>}

        <div className="flex items-center justify-between pt-2 border-t border-line">
          <span className="text-xs text-ink-subtle">{alleTische.length} Etikett(en)</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Schließen</Button>
            <Button
              onClick={drucken}
              loading={druckMutation.isPending}
              disabled={alleTische.length === 0}
            >
              {ziel === 'a4' ? 'A4-Bogen öffnen' : 'Drucken'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
