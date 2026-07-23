import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { inventurApi, type InventurDetail, type InventurListeEintrag } from '../lib/api'

// ---------------------------------------------------------------------------
// Inventur — Liste + Detail (Zählung / Protokoll)
// ---------------------------------------------------------------------------

export function InventurPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return selectedId
    ? <InventurDetailView id={selectedId} onBack={() => setSelectedId(null)} />
    : <InventurListe onOpen={setSelectedId} />
}

function statusBadge(status: string) {
  return status === 'abgeschlossen'
    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">abgeschlossen</span>
    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">offen</span>
}

// ── Liste ────────────────────────────────────────────────────────────────

function InventurListe({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const { data: liste, isLoading } = useQuery({ queryKey: ['inventuren'], queryFn: inventurApi.list })

  const anlegen = useMutation({
    mutationFn: () => inventurApi.create(window.prompt('Bezeichnung (optional):')?.trim() || undefined),
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: ['inventuren'] }); onOpen(res.id) },
    onError: (e: unknown) => alert(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen'),
  })

  const loeschen = useMutation({
    mutationFn: (id: string) => inventurApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventuren'] }),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-black text-ink">Inventur</h1>
          <p className="text-sm text-ink-muted">Bestandsaufnahme: zählen, Differenzen prüfen, auf den Lagerstand buchen.</p>
        </div>
        <button
          onClick={() => anlegen.mutate()}
          disabled={anlegen.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {anlegen.isPending ? 'Wird angelegt…' : '+ Neue Inventur'}
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-ink-subtle">Wird geladen…</p>
      ) : (liste?.length ?? 0) === 0 ? (
        <p className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-subtle">
          Noch keine Inventur. Lege eine an, um den aktuellen Bestand zu zählen.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2">Bezeichnung</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Fortschritt</th>
                <th className="px-4 py-2">Angelegt</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {liste!.map((iv: InventurListeEintrag) => (
                <tr key={iv.id} className="border-t border-line hover:bg-panel-2">
                  <td className="px-4 py-2">
                    <button onClick={() => onOpen(iv.id)} className="font-medium text-brand-700 hover:underline">
                      {iv.bezeichnung}
                    </button>
                    {iv.erstelltVon && <span className="ml-2 text-xs text-ink-subtle">· {iv.erstelltVon}</span>}
                  </td>
                  <td className="px-4 py-2">{statusBadge(iv.status)}</td>
                  <td className="px-4 py-2 text-ink-muted">{iv.anzahlGezaehlt}/{iv.anzahlPositionen} gezählt</td>
                  <td className="px-4 py-2 text-ink-subtle">{new Date(iv.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => onOpen(iv.id)} className="text-xs font-medium text-brand-700 hover:underline">öffnen</button>
                    {iv.status === 'offen' && (
                      <button
                        onClick={() => { if (window.confirm('Diese offene Inventur verwerfen?')) loeschen.mutate(iv.id) }}
                        className="ml-3 text-xs font-medium text-red-600 hover:underline"
                      >verwerfen</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Detail (Zählung / Protokoll) ───────────────────────────────────────────

function InventurDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient()
  const { data: inv, isLoading } = useQuery({ queryKey: ['inventur', id], queryFn: () => inventurApi.get(id) })

  const [entwurf, setEntwurf] = useState<Record<string, string>>({})
  const [suche, setSuche]     = useState('')
  const [nurUngezaehlt, setNurUngezaehlt] = useState(false)

  // Server-Ist als Startwert; lokale Eingaben (entwurf) haben Vorrang.
  const istWert = (artikelId: string, serverIst: number | null): string =>
    artikelId in entwurf ? entwurf[artikelId]! : (serverIst === null ? '' : String(serverIst))

  const positionen = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return (inv?.positionen ?? []).filter(p => {
      if (q && !p.bezeichnung.toLowerCase().includes(q)) return false
      if (nurUngezaehlt && (istWert(p.artikelId, p.istMenge) !== '')) return false
      return true
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv, suche, nurUngezaehlt, entwurf])

  const speichern = useMutation({
    mutationFn: () => inventurApi.patchZaehlung(id, (inv?.positionen ?? []).map(p => ({
      artikelId: p.artikelId,
      istMenge:  istWert(p.artikelId, p.istMenge) === '' ? null : Math.max(0, Math.trunc(Number(istWert(p.artikelId, p.istMenge)))),
    }))),
    onSuccess: () => { setEntwurf({}); qc.invalidateQueries({ queryKey: ['inventur', id] }); qc.invalidateQueries({ queryKey: ['inventuren'] }) },
    onError: (e: unknown) => alert(e instanceof Error ? e.message : 'Speichern fehlgeschlagen'),
  })

  const abschliessen = useMutation({
    mutationFn: async () => { await speichern.mutateAsync(); return inventurApi.abschliessen(id) },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['inventur', id] }); qc.invalidateQueries({ queryKey: ['inventuren'] })
      alert(`Inventur abgeschlossen: ${r.gebucht} Position(en) gebucht, ${r.ungezaehlt} nicht gezählt (unverändert).`)
    },
    onError: (e: unknown) => alert(e instanceof Error ? e.message : 'Abschließen fehlgeschlagen'),
  })

  if (isLoading || !inv) return <div className="p-4 text-sm text-ink-subtle">Wird geladen…</div>

  const offen        = inv.status === 'offen'
  const dirty        = Object.keys(entwurf).length > 0
  const gezaehlt     = inv.positionen.filter(p => istWert(p.artikelId, p.istMenge) !== '').length

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-ink-subtle hover:text-ink">‹ Zurück</button>
          <div>
            <h1 className="text-lg font-black text-ink">{inv.bezeichnung}</h1>
            <p className="text-xs text-ink-subtle">
              {statusBadge(inv.status)} · {gezaehlt}/{inv.positionen.length} gezählt
              {inv.abgeschlossenAm && ` · abgeschlossen ${new Date(inv.abgeschlossenAm).toLocaleString()}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void inventurApi.downloadProtokoll(id, `${inv.bezeichnung.replace(/\s+/g, '-')}.csv`)}
            className="rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-panel-2"
          >CSV</button>
          {offen && (
            <>
              <button
                onClick={() => speichern.mutate()}
                disabled={!dirty || speichern.isPending}
                className="rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-panel-2 disabled:opacity-50"
              >{speichern.isPending ? 'Speichern…' : 'Speichern'}</button>
              <button
                onClick={() => { if (window.confirm('Inventur abschließen? Die gezählten Ist-Mengen werden auf den Lagerstand gebucht.')) abschliessen.mutate() }}
                disabled={abschliessen.isPending}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >{abschliessen.isPending ? 'Wird gebucht…' : 'Abschließen'}</button>
            </>
          )}
        </div>
      </div>

      {offen && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={suche} onChange={e => setSuche(e.target.value)} placeholder="Artikel suchen…"
            className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input type="checkbox" checked={nurUngezaehlt} onChange={e => setNurUngezaehlt(e.target.checked)} />
            nur ungezählte
          </label>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-4 py-2">Artikel</th>
              <th className="px-4 py-2 text-right">Soll</th>
              <th className="px-4 py-2 text-right">Ist</th>
              <th className="px-4 py-2 text-right">Differenz</th>
            </tr>
          </thead>
          <tbody>
            {positionen.map(p => {
              const roh  = istWert(p.artikelId, p.istMenge)
              const ist  = roh === '' ? null : Number(roh)
              const diff = ist === null || Number.isNaN(ist) ? null : ist - p.sollMenge
              return (
                <tr key={p.artikelId} className="border-t border-line">
                  <td className="px-4 py-2 text-ink">{p.bezeichnung}</td>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">{p.sollMenge}</td>
                  <td className="px-4 py-2 text-right">
                    {offen ? (
                      <input
                        type="number" min={0} inputMode="numeric"
                        value={roh}
                        onChange={e => setEntwurf(prev => ({ ...prev, [p.artikelId]: e.target.value }))}
                        className="w-20 rounded-md border border-line-strong px-2 py-1 text-right font-mono focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                        placeholder="—"
                      />
                    ) : (
                      <span className="font-mono text-ink">{p.istMenge ?? '—'}</span>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${diff === null ? 'text-ink-subtle' : diff === 0 ? 'text-ink-muted' : diff > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
                  </td>
                </tr>
              )
            })}
            {positionen.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-ink-subtle">Keine Positionen{suche || nurUngezaehlt ? ' (Filter aktiv)' : ''}.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
