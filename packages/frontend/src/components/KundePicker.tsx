import { useEffect, useRef, useState } from 'react'
import type { KundeInput, KundeSnapshot } from '@kassa/shared'
import { kundeApi } from '../lib/api'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Modal } from './ui/Modal'

// ---------------------------------------------------------------------------
// Haupt-Picker
// ---------------------------------------------------------------------------

interface Props {
  /** Aktuell gewählter Kunde — null = kein Kunde */
  value:    KundeSnapshot | null
  onChange: (k: KundeSnapshot | null, neuerKunde?: KundeInput) => void
}

export function KundePicker({ value, onChange }: Props) {
  const [suche,      setSuche]      = useState('')
  const [ergebnisse, setErgebnisse] = useState<KundeSnapshot[]>([])
  const [offen,      setOffen]      = useState(false)
  const [laedt,      setLaedt]      = useState(false)
  const [neuOffen,   setNeuOffen]   = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Außen-Klick → Dropdown schließen
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOffen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Suche mit 200 ms Debounce
  useEffect(() => {
    if (!offen) return
    const timer = setTimeout(async () => {
      setLaedt(true)
      try {
        const treffer = await kundeApi.list({ ...(suche ? { suche } : {}), limit: 10 })
        setErgebnisse(treffer.map(k => ({
          id: k.id, nummer: k.nummer, bezeichnung: k.bezeichnung,
          firma: k.firma, vorname: k.vorname, nachname: k.nachname,
          email: k.email, telefon: k.telefon,
          strasse: k.strasse, plz: k.plz, ort: k.ort, land: k.land, uid: k.uid,
          kreditAktiv: k.kreditAktiv,
        })))
      } finally {
        setLaedt(false)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [suche, offen])

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-brand-800 truncate">{value.bezeichnung}</p>
          {value.email && <p className="text-xs text-brand-600 truncate">{value.email}</p>}
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-brand-400 hover:text-red-500 shrink-0 text-lg leading-none px-1"
          title="Kunde entfernen"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex gap-1.5">
        <div className="flex-1 relative">
          <Input
            placeholder="Kunde suchen…"
            value={suche}
            onChange={e => { setSuche(e.target.value); setOffen(true) }}
            onFocus={() => setOffen(true)}
            className="text-sm"
          />
          {offen && (
            <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-gray-200 bg-white shadow-lg max-h-48 overflow-y-auto">
              {laedt ? (
                <p className="px-3 py-2 text-xs text-gray-400">Suche…</p>
              ) : ergebnisse.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400">Keine Kunden gefunden</p>
              ) : (
                ergebnisse.map(k => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => { onChange(k); setOffen(false); setSuche('') }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm border-b border-gray-100 last:border-0"
                  >
                    <span className="font-medium text-gray-900">{k.bezeichnung}</span>
                    {k.email && <span className="ml-2 text-xs text-gray-500">{k.email}</span>}
                    <span className="ml-2 text-xs text-gray-400">#{k.nummer}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setOffen(false); setNeuOffen(true) }}
          className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 border border-brand-300 rounded-md px-2 hover:bg-brand-50 transition"
          title="Neuen Kunden anlegen"
        >
          + Neu
        </button>
      </div>

      <Modal open={neuOffen} onClose={() => setNeuOffen(false)} title="Neuer Kunde">
        <NeuerKundeFormular
          onSubmit={(snapshot, input) => {
            onChange(snapshot, input)
            setNeuOffen(false)
          }}
          onAbbrechen={() => setNeuOffen(false)}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schnell-Anlegen-Formular (inline in der Kasse — Pflichtfelder)
// ---------------------------------------------------------------------------

interface NeuerKundeFormularProps {
  onSubmit:    (snapshot: KundeSnapshot, input: KundeInput) => void
  onAbbrechen: () => void
}

function NeuerKundeFormular({ onSubmit, onAbbrechen }: NeuerKundeFormularProps) {
  const [firma,    setFirma]    = useState('')
  const [vorname,  setVorname]  = useState('')
  const [nachname, setNachname] = useState('')
  const [email,    setEmail]    = useState('')
  const [telefon,  setTelefon]  = useState('')
  const [strasse,  setStrasse]  = useState('')
  const [plz,      setPlz]      = useState('')
  const [ort,      setOrt]      = useState('')
  const [uid,      setUid]      = useState('')
  const [fehler,   setFehler]   = useState<string | null>(null)

  const submit = () => {
    if (!firma.trim() && !nachname.trim()) {
      setFehler('Firma oder Nachname ist erforderlich')
      return
    }
    const input: KundeInput = {
      ...(firma.trim()    && { firma:    firma.trim()    }),
      ...(vorname.trim()  && { vorname:  vorname.trim()  }),
      ...(nachname.trim() && { nachname: nachname.trim() }),
      ...(email.trim()    && { email:    email.trim()    }),
      ...(telefon.trim()  && { telefon:  telefon.trim()  }),
      ...(strasse.trim()  && { strasse:  strasse.trim()  }),
      ...(plz.trim()      && { plz:      plz.trim()      }),
      ...(ort.trim()      && { ort:      ort.trim()      }),
      ...(uid.trim()      && { uid:      uid.trim()      }),
      land:        'AT',
      kreditAktiv: false,
    }
    const bezeichnungTeile: string[] = []
    if (firma.trim()) bezeichnungTeile.push(firma.trim())
    const name = [vorname.trim(), nachname.trim()].filter(Boolean).join(' ')
    if (name) bezeichnungTeile.push(name)
    const bezeichnung = bezeichnungTeile.join(' / ') || '(Unbekannt)'

    const snapshot: KundeSnapshot = {
      id:          '00000000-0000-0000-0000-000000000000',
      nummer:      0,
      bezeichnung,
      ...(input.firma    && { firma:    input.firma    }),
      ...(input.vorname  && { vorname:  input.vorname  }),
      ...(input.nachname && { nachname: input.nachname }),
      ...(input.email    && { email:    input.email    }),
      ...(input.telefon  && { telefon:  input.telefon  }),
      ...(input.strasse  && { strasse:  input.strasse  }),
      ...(input.plz      && { plz:      input.plz      }),
      ...(input.ort      && { ort:      input.ort      }),
      ...(input.uid      && { uid:      input.uid      }),
      land: 'AT',
    }
    onSubmit(snapshot, input)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="text-xs font-medium text-gray-700">Firma</span>
          <Input autoFocus value={firma} onChange={e => setFirma(e.target.value)} placeholder="Muster GmbH" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Vorname</span>
          <Input value={vorname} onChange={e => setVorname(e.target.value)} placeholder="Max" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Nachname</span>
          <Input value={nachname} onChange={e => setNachname(e.target.value)} placeholder="Mustermann" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">E-Mail</span>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="max@muster.at" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Telefon</span>
          <Input value={telefon} onChange={e => setTelefon(e.target.value)} placeholder="+43 …" className="mt-0.5" />
        </label>
        <label className="block col-span-2">
          <span className="text-xs font-medium text-gray-700">Straße</span>
          <Input value={strasse} onChange={e => setStrasse(e.target.value)} placeholder="Musterstraße 1" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">PLZ</span>
          <Input value={plz} onChange={e => setPlz(e.target.value)} placeholder="1010" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Ort</span>
          <Input value={ort} onChange={e => setOrt(e.target.value)} placeholder="Wien" className="mt-0.5" />
        </label>
        <label className="block col-span-2">
          <span className="text-xs font-medium text-gray-700">UID (USt-ID, optional)</span>
          <Input value={uid} onChange={e => setUid(e.target.value)} placeholder="ATU12345678" className="mt-0.5" />
        </label>
      </div>
      {fehler && <p className="text-xs text-red-600">{fehler}</p>}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} className="flex-1">Hinzufügen</Button>
      </div>
    </div>
  )
}
