import { useState } from 'react'
import { merkeToken } from './lib/api'

/** Frisches Gerät: Einrichtungs-QR scannen (normaler Weg) oder Token einfügen (Notlösung). */
export function Einrichtung({ hinweis, onFertig }: { hinweis?: string | undefined; onFertig: () => void }) {
  const [token, setToken] = useState('')
  const [zeigeFeld, setZeigeFeld] = useState(false)

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-5 px-6 py-10">
      <div className="text-center">
        <img src="/icon.svg" alt="" className="mx-auto h-16 w-16 rounded-2xl" />
        <h1 className="mt-4 text-2xl font-bold">Einlass einrichten</h1>
      </div>
      {hinweis && (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{hinweis}</p>
      )}
      <ol className="space-y-3 rounded-2xl border border-rand bg-flaeche p-5 text-sm leading-relaxed">
        <li><strong>1.</strong> Im Backoffice: <em>Tickets → Events &amp; Tickets → Einlass-Geräte</em> ein Gerät anlegen.</li>
        <li><strong>2.</strong> Den angezeigten QR-Code mit der <strong>Kamera dieses Handys</strong> scannen.</li>
        <li><strong>3.</strong> Der Link öffnet diese App — das Gerät ist dann verbunden.</li>
      </ol>
      {zeigeFeld ? (
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); if (token.trim()) { merkeToken(token); onFertig() } }}
        >
          <textarea
            value={token} onChange={e => setToken(e.target.value)} rows={4}
            placeholder="Geräte-Token einfügen"
            className="block w-full rounded-xl border border-rand bg-grund px-3 py-2 font-mono text-xs text-text focus:outline-none focus:ring-2 focus:ring-green-500/50"
          />
          <button type="submit" className="w-full rounded-xl bg-green-600 px-4 py-3 font-semibold text-white">Verbinden</button>
        </form>
      ) : (
        <button type="button" onClick={() => setZeigeFeld(true)} className="text-sm text-leise underline">
          Kein QR möglich? Token von Hand einfügen
        </button>
      )}
    </main>
  )
}
