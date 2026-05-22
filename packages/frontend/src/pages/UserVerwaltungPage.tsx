import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Berechtigung, User, UserCreateInput, UserUpdateInput } from '@kassa/shared'
import {
  ALLE_BERECHTIGUNGEN,
  BERECHTIGUNG_LABELS,
  ROLLE_LABELS,
} from '@kassa/shared'
import { userApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'

// ---------------------------------------------------------------------------
// Haupt-Seite
// ---------------------------------------------------------------------------

export function UserVerwaltungPage() {
  const qc       = useQueryClient()
  const auth     = getAuth()!
  const identity = getKasseIdentity()!

  const [neuerUserOffen, setNeuerUserOffen]   = useState(false)
  const [editUser, setEditUser]               = useState<User | null>(null)
  const [pinUser, setPinUser]                 = useState<User | null>(null)
  const [fehler, setFehler]                   = useState<string | null>(null)

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn:  userApi.list,
  })

  // Alle Kassen aus Login-Response (Admin sieht alle)
  const verfuegbareKassen = auth.kassen

  const erstelleMutation = useMutation({
    mutationFn: userApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setNeuerUserOffen(false) },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UserUpdateInput }) => userApi.update(id, input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEditUser(null); setPinUser(null) },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const deactivateMutation = useMutation({
    mutationFn: userApi.deactivate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Benutzer</h1>
        <Button onClick={() => { setFehler(null); setNeuerUserOffen(true) }}>+ Neuer Benutzer</Button>
      </div>

      {fehler && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      {usersQuery.isLoading && <p className="text-sm text-gray-500">Wird geladen…</p>}

      {usersQuery.data && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">Name</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">E-Mail</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">Rolle</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">Berechtigungen</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">PIN</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-600">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {usersQuery.data.map((u) => (
                <tr key={u.id} className={u.aktiv ? '' : 'opacity-50'}>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {u.name}
                    {u.id === auth.user.id && (
                      <span className="ml-1.5 text-xs text-gray-400">(du)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.rolle === 'admin'
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {ROLLE_LABELS[u.rolle]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {u.rolle === 'admin' ? (
                      <span className="text-xs text-gray-400">Alle</span>
                    ) : (
                      <span className="text-xs text-gray-600">
                        {u.berechtigungen.length === 0
                          ? '—'
                          : u.berechtigungen.map(b => BERECHTIGUNG_LABELS[b]).join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => { setFehler(null); setPinUser(u) }}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {u.hatPin ? 'PIN ändern' : 'PIN setzen'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${u.aktiv ? 'text-green-600' : 'text-gray-400'}`}>
                      {u.aktiv ? 'Aktiv' : 'Inaktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => { setFehler(null); setEditUser(u) }}
                        className="text-xs text-gray-500 hover:text-brand-600"
                      >
                        Bearbeiten
                      </button>
                      {u.id !== auth.user.id && u.aktiv && (
                        <button
                          type="button"
                          onClick={() => deactivateMutation.mutate(u.id)}
                          className="text-xs text-gray-400 hover:text-red-600"
                        >
                          Deaktivieren
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Neuen User anlegen */}
      <Modal
        open={neuerUserOffen}
        onClose={() => setNeuerUserOffen(false)}
        title="Neuen Benutzer anlegen"
        size="lg"
      >
        <UserFormular
          verfuegbareKassen={verfuegbareKassen}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={(input) => { setFehler(null); erstelleMutation.mutate(input as UserCreateInput) }}
          onAbbrechen={() => setNeuerUserOffen(false)}
        />
      </Modal>

      {/* User bearbeiten */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`${editUser?.name} bearbeiten`}
        size="lg"
      >
        {editUser && (
          <UserFormular
            initialUser={editUser}
            verfuegbareKassen={verfuegbareKassen}
            loading={updateMutation.isPending}
            fehler={fehler}
            onSubmit={(input) => {
              setFehler(null)
              updateMutation.mutate({ id: editUser.id, input: input as UserUpdateInput })
            }}
            onAbbrechen={() => setEditUser(null)}
          />
        )}
      </Modal>

      {/* PIN setzen */}
      <Modal
        open={!!pinUser}
        onClose={() => setPinUser(null)}
        title={`PIN für ${pinUser?.name}`}
      >
        {pinUser && (
          <PinFormular
            hatPin={pinUser.hatPin}
            loading={updateMutation.isPending}
            fehler={fehler}
            onSubmit={(pin) => {
              setFehler(null)
              updateMutation.mutate({ id: pinUser.id, input: { pin: pin ?? null } })
            }}
            onAbbrechen={() => setPinUser(null)}
          />
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// User-Formular (Create + Edit)
// ---------------------------------------------------------------------------

interface UserFormularProps {
  initialUser?:        User
  verfuegbareKassen:   { id: string; kassenId: string }[]
  loading:             boolean
  fehler:              string | null
  onSubmit:            (input: UserCreateInput | UserUpdateInput) => void
  onAbbrechen:         () => void
}

function UserFormular({
  initialUser, verfuegbareKassen, loading, fehler, onSubmit, onAbbrechen,
}: UserFormularProps) {
  const istNeu = !initialUser
  const [name,      setName]      = useState(initialUser?.name ?? '')
  const [email,     setEmail]     = useState(initialUser?.email ?? '')
  const [passwort,  setPasswort]  = useState('')
  const [rolle,     setRolle]     = useState<'admin' | 'kellner'>(initialUser?.rolle ?? 'kellner')
  const [berechtigungen, setBerechtigungen] = useState<Berechtigung[]>(
    initialUser?.rolle === 'admin' ? [] : (initialUser?.berechtigungen ?? []),
  )
  const [kassenIds, setKassenIds] = useState<string[]>(initialUser?.kassenIds ?? [])

  const toggleBerechtigung = (b: Berechtigung) => {
    setBerechtigungen(prev =>
      prev.includes(b) ? prev.filter(x => x !== b) : [...prev, b],
    )
  }

  const toggleKasse = (id: string) => {
    setKassenIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const submit = () => {
    if (!name.trim()) return
    if (istNeu && !email.trim()) return
    if (istNeu && passwort.length < 8) return

    if (istNeu) {
      onSubmit({ name, email, passwort, rolle, berechtigungen, kassenIds } as UserCreateInput)
    } else {
      const input: UserUpdateInput = { name, berechtigungen, kassenIds }
      if (email !== initialUser?.email) input.email = email
      if (passwort.length >= 8) input.passwort = passwort
      onSubmit(input)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Name *</span>
          <Input value={name} onChange={e => setName(e.target.value)} className="mt-0.5" autoFocus />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">E-Mail {istNeu ? '*' : ''}</span>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-0.5" />
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-gray-600">
          Passwort {istNeu ? '* (min. 8 Zeichen)' : '(leer lassen = unverändert)'}
        </span>
        <Input type="password" value={passwort} onChange={e => setPasswort(e.target.value)} className="mt-0.5" />
      </label>

      {istNeu && (
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Rolle</span>
          <select
            value={rolle}
            onChange={e => setRolle(e.target.value as 'admin' | 'kellner')}
            className="mt-0.5 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="kellner">Kellner</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
      )}

      {(istNeu ? rolle === 'kellner' : initialUser?.rolle === 'kellner') && (
        <>
          <fieldset>
            <legend className="text-xs font-medium text-gray-600 mb-1.5">Berechtigungen</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {ALLE_BERECHTIGUNGEN.map((b) => (
                <label key={b} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={berechtigungen.includes(b)}
                    onChange={() => toggleBerechtigung(b)}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-gray-700">{BERECHTIGUNG_LABELS[b]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {verfuegbareKassen.length > 0 && (
            <fieldset>
              <legend className="text-xs font-medium text-gray-600 mb-1.5">Kassen-Zuordnung</legend>
              <div className="flex flex-wrap gap-2">
                {verfuegbareKassen.map((k) => (
                  <label key={k.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={kassenIds.includes(k.id)}
                      onChange={() => toggleKasse(k.id)}
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="text-sm text-gray-700">{k.kassenId}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1">
          {istNeu ? 'Anlegen' : 'Speichern'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PIN-Formular
// ---------------------------------------------------------------------------

function PinFormular({
  hatPin, loading, fehler, onSubmit, onAbbrechen,
}: {
  hatPin:      boolean
  loading:     boolean
  fehler:      string | null
  onSubmit:    (pin: string | null) => void
  onAbbrechen: () => void
}) {
  const [pin, setPin]         = useState('')
  const [confirm, setConfirm] = useState('')

  const submit = () => {
    if (pin && pin !== confirm) return
    onSubmit(pin || null)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        {hatPin
          ? 'Neuen 4-stelligen PIN setzen oder PIN entfernen (Feld leer lassen).'
          : 'Einen 4-stelligen PIN vergeben. Der Kellner kann sich damit am POS anmelden.'}
      </p>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Neuer PIN (4 Ziffern)</span>
        <Input
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder={hatPin ? 'Leer lassen = PIN entfernen' : ''}
          className="mt-0.5"
          autoFocus
        />
      </label>
      {pin.length > 0 && (
        <label className="block">
          <span className="text-xs font-medium text-gray-600">PIN wiederholen</span>
          <Input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={confirm}
            onChange={e => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
            invalid={confirm.length === 4 && pin !== confirm}
            className="mt-0.5"
          />
          {confirm.length === 4 && pin !== confirm && (
            <p className="mt-0.5 text-xs text-red-600">PINs stimmen nicht überein.</p>
          )}
        </label>
      )}
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button
          onClick={submit}
          loading={loading}
          className="flex-1"
          disabled={pin.length > 0 && (pin.length !== 4 || pin !== confirm)}
        >
          {pin.length === 0 ? (hatPin ? 'PIN entfernen' : 'Abbrechen') : 'PIN speichern'}
        </Button>
      </div>
    </div>
  )
}
