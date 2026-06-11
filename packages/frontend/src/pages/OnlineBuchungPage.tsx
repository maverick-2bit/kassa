/**
 * OnlineBuchungPage — öffentliche Buchungsseite für Gäste.
 * Erreichbar unter /buchung?kasseId=<uuid> ohne Login.
 */

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { buchungApi } from '../lib/api'

function heuteISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function OnlineBuchungPage() {
  const [params] = useSearchParams()
  const kasseId = params.get('kasseId') ?? ''

  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['buchung-info', kasseId],
    queryFn:  () => buchungApi.getInfo(kasseId),
    enabled:  !!kasseId,
  })

  if (!kasseId) return <FehlerView text="Kein Restaurant angegeben." />
  if (isLoading) return <LadeView />
  if (isError || !info) return <FehlerView text="Restaurant nicht gefunden." />
  if (!info.aktiv) return <FehlerView text="Online-Buchung ist für dieses Restaurant derzeit nicht verfügbar." />

  return <BuchungsFormular kasseId={kasseId} firmenname={info.firmenname} />
}

// ---------------------------------------------------------------------------
// Formular
// ---------------------------------------------------------------------------

function BuchungsFormular({ kasseId, firmenname }: { kasseId: string; firmenname: string }) {
  const [datum,          setDatum]          = useState(heuteISO())
  const [zeitVon,        setZeitVon]        = useState('12:00')
  const [personenAnzahl, setPersonenAnzahl] = useState('2')
  const [name,           setName]           = useState('')
  const [telefon,        setTelefon]        = useState('')
  const [email,          setEmail]          = useState('')
  const [notiz,          setNotiz]          = useState('')
  const [erfolg,         setErfolg]         = useState<{ datum: string; zeitVon: string; name: string; onlineToken: string; id: string } | null>(null)
  const [fehlerText,     setFehlerText]     = useState<string | null>(null)

  const buchungMut = useMutation({
    mutationFn: () => buchungApi.buchen(kasseId, {
      datum,
      zeitVon,
      personenAnzahl: parseInt(personenAnzahl),
      name,
      ...(telefon && { telefon }),
      ...(email   && { email   }),
      ...(notiz   && { notiz   }),
    }),
    onSuccess: (data) => setErfolg(data),
    onError:   (err)  => setFehlerText(err instanceof Error ? err.message : 'Buchung fehlgeschlagen'),
  })

  const storniMut = useMutation({
    mutationFn: () => buchungApi.stornieren(kasseId, erfolg!.onlineToken),
    onSuccess:  () => setErfolg(null),
    onError:    (err) => setFehlerText(err instanceof Error ? err.message : 'Stornierung fehlgeschlagen'),
  })

  if (erfolg) {
    return (
      <Wrapper firmenname={firmenname}>
        <div className="text-center space-y-4">
          <div className="text-5xl">✓</div>
          <h2 className="text-xl font-bold text-gray-900">Anfrage erhalten!</h2>
          <p className="text-gray-600 text-sm">
            Ihre Reservierungsanfrage für <strong>{erfolg.name}</strong> am{' '}
            <strong>{erfolg.datum}</strong> um <strong>{erfolg.zeitVon} Uhr</strong> wurde
            übermittelt. Das Restaurant wird sie baldmöglichst bestätigen.
          </p>
          <hr />
          <button
            type="button"
            onClick={() => storniMut.mutate()}
            disabled={storniMut.isPending}
            className="text-sm text-red-500 hover:underline"
          >
            {storniMut.isPending ? 'Wird storniert…' : 'Anfrage stornieren'}
          </button>
          {fehlerText && (
            <p className="text-sm text-red-600">{fehlerText}</p>
          )}
        </div>
      </Wrapper>
    )
  }

  return (
    <Wrapper firmenname={firmenname}>
      <form
        onSubmit={(e) => { e.preventDefault(); setFehlerText(null); buchungMut.mutate() }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Datum *</label>
            <input type="date" required min={heuteISO()} value={datum}
              onChange={e => setDatum(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Uhrzeit *</label>
            <input type="time" required value={zeitVon}
              onChange={e => setZeitVon(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Personen *</label>
          <select required value={personenAnzahl}
            onChange={e => setPersonenAnzahl(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {Array.from({ length: 20 }, (_, i) => i + 1).map(n => (
              <option key={n} value={n}>{n} Person{n > 1 ? 'en' : ''}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
          <input type="text" required value={name} onChange={e => setName(e.target.value)}
            placeholder="Vor- und Nachname"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Telefon</label>
          <input type="tel" value={telefon} onChange={e => setTelefon(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">E-Mail</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Anmerkungen</label>
          <textarea rows={3} value={notiz} onChange={e => setNotiz(e.target.value)}
            placeholder="z. B. Kinderstuhl, Allergie, Geburtstag…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
        </div>

        {fehlerText && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {fehlerText}
          </div>
        )}

        <button
          type="submit"
          disabled={buchungMut.isPending}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-3 text-sm transition"
        >
          {buchungMut.isPending ? 'Wird gesendet…' : 'Reservierungsanfrage senden'}
        </button>

        <p className="text-center text-xs text-gray-400">
          Ihre Anfrage wird vom Restaurant bestätigt.
        </p>
      </form>
    </Wrapper>
  )
}

// ---------------------------------------------------------------------------
// Layout-Wrapper (kein normales App-Layout)
// ---------------------------------------------------------------------------

function Wrapper({ firmenname, children }: { firmenname: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-start py-10 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-md p-6 space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-900">{firmenname}</h1>
          <p className="text-sm text-gray-500 mt-0.5">Online-Tischreservierung</p>
        </div>
        {children}
      </div>
    </div>
  )
}

function LadeView() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Wird geladen…</p>
    </div>
  )
}

function FehlerView({ text }: { text: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-md p-8 max-w-sm text-center space-y-2">
        <p className="text-2xl">⚠️</p>
        <p className="text-gray-700 text-sm">{text}</p>
      </div>
    </div>
  )
}
