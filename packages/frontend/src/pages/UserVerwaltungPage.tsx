import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Berechtigung, MandantPinLaenge, PinLaenge, User, UserCreateInput, UserUpdateInput } from '@kassa/shared'
import {
  ALLE_BERECHTIGUNGEN,
  BERECHTIGUNG_LABELS,
  ROLLE_LABELS,
} from '@kassa/shared'
import { mandantApi, userApi } from '../lib/api'
import { getAuth, pinLaenge as gespeichertePinLaenge, updateMandantPinLaenge } from '../lib/auth'
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

  // PIN-Länge des Betriebs: bis die Abfrage da ist, gilt die aus der Anmeldung
  const pinLaengeQuery = useQuery({
    queryKey: ['mandant-pin-laenge'],
    queryFn:  mandantApi.getPinLaenge,
  })
  const pinLaenge: PinLaenge = pinLaengeQuery.data?.pinLaenge ?? gespeichertePinLaenge()

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
        <h1 className="text-xl font-semibold text-ink">Benutzer</h1>
        <Button onClick={() => { setFehler(null); setNeuerUserOffen(true) }}>+ Neuer Benutzer</Button>
      </div>

      {fehler && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      {pinLaengeQuery.data && (
        <PinLaengeKarte
          stand={pinLaengeQuery.data}
          onGeaendert={(neu) => {
            updateMandantPinLaenge(neu.pinLaenge)
            qc.setQueryData(['mandant-pin-laenge'], neu)
            void qc.invalidateQueries({ queryKey: ['users'] })
          }}
        />
      )}

      {usersQuery.isLoading && <p className="text-sm text-ink-muted">Wird geladen…</p>}

      {usersQuery.data && (
        <div className="rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 border-b border-line">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">Name</th>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">E-Mail</th>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">Rolle</th>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">Berechtigungen</th>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">PIN</th>
                <th className="px-4 py-2.5 text-left font-medium text-ink-muted">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usersQuery.data.map((u) => (
                <tr key={u.id} className={u.aktiv ? '' : 'opacity-50'}>
                  <td className="px-4 py-3 font-medium text-ink">
                    {u.name}
                    {u.id === auth.user.id && (
                      <span className="ml-1.5 text-xs text-ink-subtle">(du)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">
                    {u.email.endsWith('@pin.kellner.lokal')
                      ? <span className="text-ink-subtle italic">nur PIN-Zugang</span>
                      : u.email}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.rolle === 'admin'
                        ? 'bg-purple-100 text-purple-700'
                        : 'bg-panel-2 text-ink-muted'
                    }`}>
                      {ROLLE_LABELS[u.rolle]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {u.rolle === 'admin' ? (
                      <span className="text-xs text-ink-subtle">Alle</span>
                    ) : (
                      <span className="text-xs text-ink-muted">
                        {u.berechtigungen.length === 0
                          ? '—'
                          : u.berechtigungen.map(b => BERECHTIGUNG_LABELS[b]).join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {/* Nach einer Umstellung der PIN-Länge gilt die alte PIN nicht mehr */}
                    {u.hatPin && u.pinLaenge !== pinLaenge && (
                      <span className="mr-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        PIN ungültig ({u.pinLaenge} Ziffern)
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => { setFehler(null); setPinUser(u) }}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {u.hatPin && u.pinLaenge !== pinLaenge ? 'Neue PIN vergeben' : u.hatPin ? 'PIN ändern' : 'PIN setzen'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${u.aktiv ? 'text-green-600' : 'text-ink-subtle'}`}>
                      {u.aktiv ? 'Aktiv' : 'Inaktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => { setFehler(null); setEditUser(u) }}
                        className="text-xs text-ink-muted hover:text-brand-600"
                      >
                        Bearbeiten
                      </button>
                      {u.id !== auth.user.id && u.aktiv && (
                        <button
                          type="button"
                          onClick={() => deactivateMutation.mutate(u.id)}
                          className="text-xs text-ink-subtle hover:text-red-600"
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
          pinLaenge={pinLaenge}
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
            pinLaenge={pinLaenge}
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
            pinLaenge={pinLaenge}
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
  /** Ziffernzahl der PINs dieses Betriebs */
  pinLaenge:           PinLaenge
  loading:             boolean
  fehler:              string | null
  onSubmit:            (input: UserCreateInput | UserUpdateInput) => void
  onAbbrechen:         () => void
}

function UserFormular({
  initialUser, verfuegbareKassen, pinLaenge, loading, fehler, onSubmit, onAbbrechen,
}: UserFormularProps) {
  const istNeu = !initialUser
  const [name,      setName]      = useState(initialUser?.name ?? '')
  const [email,     setEmail]     = useState(initialUser?.email ?? '')
  const [passwort,  setPasswort]  = useState('')
  const [rolle,     setRolle]     = useState<'admin' | 'kellner'>(initialUser?.rolle ?? 'kellner')
  /**
   * Eventpersonal: Kellner ohne E-Mail/Passwort anlegen — Zugang läuft dann
   * ausschließlich über den PIN am Handy. Für Aushilfen, die eine Saison oder
   * einen Abend bleiben, ist ein E-Mail-Konto je Person praxisfremd.
   */
  const [nurPin, setNurPin] = useState(istNeu)
  const [pin,    setPin]    = useState('')
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

  const pinOnly = istNeu && nurPin && rolle === 'kellner'

  const submit = () => {
    if (!name.trim()) return
    if (pinOnly) {
      if (pin.length !== pinLaenge || !/^\d+$/.test(pin)) return
      onSubmit({ name, rolle: 'kellner', berechtigungen, kassenIds, pin } as UserCreateInput)
      return
    }
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
          <span className="text-xs font-medium text-ink-muted">Name *</span>
          <Input value={name} onChange={e => setName(e.target.value)} className="mt-0.5" autoFocus />
        </label>
        {!pinOnly && (
          <label className="block">
            <span className="text-xs font-medium text-ink-muted">E-Mail {istNeu ? '*' : ''}</span>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-0.5" />
          </label>
        )}
      </div>

      {istNeu && rolle === 'kellner' && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={nurPin}
            onChange={e => setNurPin(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong"
          />
          Nur PIN-Zugang (Eventpersonal) — keine E-Mail nötig, Anmeldung nur per PIN am Handy
        </label>
      )}

      {pinOnly ? (
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">PIN * ({pinLaenge} Ziffern — damit meldet sich {name.trim() || 'die Person'} an)</span>
          <Input
            type="text"
            inputMode="numeric"
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, pinLaenge))}
            className="mt-0.5 w-32 text-center tracking-widest font-mono"
            placeholder={pinLaenge === 6 ? 'z. B. 471108' : 'z. B. 4711'}
          />
        </label>
      ) : (
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">
            Passwort {istNeu ? '* (min. 8 Zeichen)' : '(leer lassen = unverändert)'}
          </span>
          <Input type="password" value={passwort} onChange={e => setPasswort(e.target.value)} className="mt-0.5" />
        </label>
      )}

      {istNeu && (
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">Rolle</span>
          <select
            value={rolle}
            onChange={e => setRolle(e.target.value as 'admin' | 'kellner')}
            className="mt-0.5 block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="kellner">Kellner</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
      )}

      {(istNeu ? rolle === 'kellner' : initialUser?.rolle === 'kellner') && (
        <>
          <fieldset>
            <legend className="text-xs font-medium text-ink-muted mb-1.5">Berechtigungen</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {ALLE_BERECHTIGUNGEN.map((b) => (
                <label key={b} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={berechtigungen.includes(b)}
                    onChange={() => toggleBerechtigung(b)}
                    className="rounded border-line-strong text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-sm text-ink">{BERECHTIGUNG_LABELS[b]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {verfuegbareKassen.length > 0 && (
            <fieldset>
              <legend className="text-xs font-medium text-ink-muted mb-1.5">Kassen-Zuordnung</legend>
              <div className="flex flex-wrap gap-2">
                {verfuegbareKassen.map((k) => (
                  <label key={k.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={kassenIds.includes(k.id)}
                      onChange={() => toggleKasse(k.id)}
                      className="rounded border-line-strong text-brand-600 focus:ring-brand-500"
                    />
                    <span className="text-sm text-ink">{k.kassenId}</span>
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
  hatPin, pinLaenge, loading, fehler, onSubmit, onAbbrechen,
}: {
  hatPin:      boolean
  pinLaenge:   PinLaenge
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
      <p className="text-sm text-ink-muted">
        {hatPin
          ? `Neuen ${pinLaenge}-stelligen PIN setzen oder PIN entfernen (Feld leer lassen).`
          : `Einen ${pinLaenge}-stelligen PIN vergeben. Der Kellner kann sich damit am POS anmelden.`}
      </p>
      <label className="block">
        <span className="text-xs font-medium text-ink-muted">Neuer PIN ({pinLaenge} Ziffern)</span>
        <Input
          type="password"
          inputMode="numeric"
          maxLength={pinLaenge}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, pinLaenge))}
          placeholder={hatPin ? 'Leer lassen = PIN entfernen' : ''}
          className="mt-0.5"
          autoFocus
        />
      </label>
      {pin.length > 0 && (
        <label className="block">
          <span className="text-xs font-medium text-ink-muted">PIN wiederholen</span>
          <Input
            type="password"
            inputMode="numeric"
            maxLength={pinLaenge}
            value={confirm}
            onChange={e => setConfirm(e.target.value.replace(/\D/g, '').slice(0, pinLaenge))}
            invalid={confirm.length === pinLaenge && pin !== confirm}
            className="mt-0.5"
          />
          {confirm.length === pinLaenge && pin !== confirm && (
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
          disabled={pin.length > 0 && (pin.length !== pinLaenge || pin !== confirm)}
        >
          {pin.length === 0 ? (hatPin ? 'PIN entfernen' : 'Abbrechen') : 'PIN speichern'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PIN-Länge des Betriebs (4 oder 6 Ziffern)
// ---------------------------------------------------------------------------

/**
 * Umstellen macht alle PINs der anderen Länge ungültig — ein Rest kurzer PINs
 * bliebe sonst ratbar. Deshalb vorher nennen, wen es trifft; die Liste markiert
 * danach, wer eine neue PIN braucht.
 */
function PinLaengeKarte({ stand, onGeaendert }: {
  stand:       MandantPinLaenge
  onGeaendert: (neu: MandantPinLaenge) => void
}) {
  const [bestaetigen, setBestaetigen] = useState(false)
  const [fehler, setFehler]           = useState<string | null>(null)
  const ziel: PinLaenge   = stand.pinLaenge === 4 ? 6 : 4
  const betroffen         = stand.pinLaenge === 4 ? stand.pinsMit4 : stand.pinsMit6
  const veraltet          = stand.pinLaenge === 4 ? stand.pinsMit6 : stand.pinsMit4

  const mutation = useMutation({
    mutationFn: () => mandantApi.patchPinLaenge({ pinLaenge: ziel }),
    onSuccess:  (neu) => { setBestaetigen(false); onGeaendert(neu) },
    onError:    (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div className="mb-5 rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">PIN-Länge: {stand.pinLaenge} Ziffern</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Gilt für alle Benutzer. 6 Ziffern sind rund hundertmal schwerer zu erraten.
            Nach zu vielen falschen PINs sperrt die Kasse die PIN-Eingabe ohnehin kurz.
          </p>
          {veraltet > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-800">
              {veraltet} {veraltet === 1 ? 'Benutzer hat' : 'Benutzer haben'} noch eine PIN mit {ziel} Ziffern — diese gilt nicht, bitte neu vergeben.
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={() => { setFehler(null); setBestaetigen(true) }}>
          Auf {ziel} Ziffern umstellen
        </Button>
      </div>

      <Modal open={bestaetigen} onClose={() => setBestaetigen(false)} title={`PIN-Länge auf ${ziel} Ziffern umstellen?`}>
        <div className="space-y-3 text-sm text-ink">
          {betroffen > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <strong>{betroffen} {betroffen === 1 ? 'PIN gilt' : 'PINs gelten'} danach nicht mehr</strong> (sie haben {stand.pinLaenge} Ziffern).
              Die Betroffenen können sich erst wieder per PIN anmelden, stempeln oder freigeben,
              wenn hier eine neue PIN mit {ziel} Ziffern vergeben ist — die Liste markiert sie.
            </div>
          ) : (
            <p>Es ist noch keine PIN mit {stand.pinLaenge} Ziffern vergeben — niemand ist betroffen.</p>
          )}
          <p className="text-xs text-ink-muted">
            Admins können sich weiterhin mit E-Mail und Passwort anmelden.
          </p>
          {fehler && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => setBestaetigen(false)} className="flex-1">Abbrechen</Button>
            <Button onClick={() => mutation.mutate()} loading={mutation.isPending} className="flex-1">
              Umstellen
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
