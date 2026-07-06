import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOffline } from '../lib/useOffline'
import type {
  Artikel,
  AngebotResponse,
  BarzahlungsbelegInput,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  GutscheinResponse,
  KundeInput,
  KundeSnapshot,
  ModifikatorAuswahl,
  ModifikatorGruppe,
  MwStSatz,
  RabattInput,
  TischTabErstellenInput,
  TischTabResponse,
} from '@kassa/shared'
import { GUTSCHEIN_STATUS_LABELS, MWST_LABELS, STATION_LABELS, happyHourPreisCent, aktiverRabattProzent } from '@kassa/shared'
import { angebotApi, artikelApi, belegApi, bonierApi, gutscheinApi, kategorieApi, lieferscheinApi, modifikatorApi, offenerPostenApi, posConfigApi, preisregelApi, tischTabApi, zvtApi, displayApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth, hasBerechtigung } from '../lib/auth'
import { formatPreis } from '../lib/format'
import {
  positionsPreisCent,
  warenkorbSummeCent,
  rabattBetragCent,
  preisNachPositionsRabattCent,
  barEingabeCent,
  zahlungsAufteilung,
} from '../lib/warenkorb'
import { druckeAngebot, druckeGutschein, druckeLiferschein } from '../lib/rechnung'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { BonAnzeige } from '../components/BonAnzeige'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { SerialAuswahlModal, type SerialPos } from '../components/SerialAuswahlModal'
import { RabattModal } from '../components/RabattModal'
import { ArtikelGrid } from '../components/ArtikelGrid'
import { KundePicker } from '../components/KundePicker'

// ---------------------------------------------------------------------------
// Warenkorb-Typen
// ---------------------------------------------------------------------------

interface ArtikelKorbPosition {
  typ:               'artikel'
  artikel:           Artikel
  menge:             number
  modifikatoren:     ModifikatorAuswahl[]
  /** Effektiver Einzelpreis (nach eventuellem Artikel-Rabatt) */
  preisCent:         number
  /** Originalpreis vor Artikel-Rabatt (für Durchstreichung); enthält bereits den Happy-Hour-Preis */
  originalPreisCent: number
  /** Angewandter Happy-Hour-Rabatt in % (0 = keiner) — nur für die Anzeige */
  happyHourProzent:  number
}

interface FreieKorbPosition {
  typ:         'frei'
  bezeichnung: string
  menge:       number
  preisCent:   number
  mwstSatz:    MwStSatz
}

type KorbPosition = ArtikelKorbPosition | FreieKorbPosition

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function KassePage() {
  const identity = getKasseIdentity()!
  const queryClient = useQueryClient()
  const { online, queueCount } = useOffline()
  const [offlineBelegGespeichert, setOfflineBelegGespeichert] = useState(false)
  const [searchParams] = useSearchParams()
  const initialKategorieId = searchParams.get('tab') === 'favoriten' ? '__favoriten__' : null

  const [modus, setModus] = useState<'verkauf' | 'angebot'>('verkauf')
  const [korb, setKorb] = useState<KorbPosition[]>([])

  // Display-Push: Warenkorb-Änderungen ans Kundendisplay senden (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      if (!identity.kasseId) return
      if (korb.length === 0) {
        displayApi.push(identity.kasseId, { typ: 'leer' }).catch(() => {})
      } else {
        displayApi.push(identity.kasseId, {
          typ:        'warenkorb',
          positionen: korb.map(p => ({
            bezeichnung: p.typ === 'frei' ? p.bezeichnung : p.artikel.bezeichnung,
            menge:       p.menge,
            preisCent:   p.preisCent,
          })),
          summeCent: korb.reduce((s, p) => s + p.preisCent * p.menge, 0),
        }).catch(() => {})
      }
    }, 200)
    return () => clearTimeout(t)
  }, [korb, identity.kasseId])
  const [rabatt, setRabatt] = useState<RabattInput | null>(null)
  const [rabattOffen, setRabattOffen] = useState(false)
  const [artikelRabattIdx, setArtikelRabattIdx] = useState<number | null>(null)
  const [freiePositionOffen, setFreiePositionOffen] = useState(false)
  const [kunde,     setKunde]     = useState<KundeSnapshot | null>(null)
  const [neuerKunde, setNeuerKunde] = useState<KundeInput | undefined>(undefined)
  const [tisch, setTisch] = useState<string>('1')
  const [kellner, setKellner] = useState<string>('Service')
  const [barEuro, setBarEuro] = useState<string>('')
  const [letzterBon, setLetzterBon] = useState<BelegResponse | null>(null)
  const [letzterAngebot, setLetzterAngebot] = useState<AngebotResponse | null>(null)
  const [bonierungErgebnis, setBonierungErgebnis] = useState<BonierungErgebnis | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const [zvtOffen, setZvtOffen] = useState(false)
  const [zvtBetrag, setZvtBetrag] = useState(0)
  // Seriennummern-Auswahl (serialisierte Artikel) — Ref hält die Zuweisung über den ZVT-Flow hinweg
  const [serialModalOffen, setSerialModalOffen] = useState(false)
  const serialsRef = useRef<Map<number, string[]> | null>(null)
  const [kreditModus,          setKreditModus]          = useState(false)
  const [gutschein,            setGutschein]            = useState<{ id: string; code: string; maxCent: number; einloesungCent: number; erstelleRestgutschein: boolean } | null>(null)
  const [gutscheinModalOffen,  setGutscheinModalOffen]  = useState(false)
  const [restGutschein,        setRestGutschein]        = useState<GutscheinResponse | null>(null)
  // Ref for gutschein — safe to read inside mutation callbacks (before reset() clears state)
  const gutscheinRef = useRef(gutschein)
  useEffect(() => { gutscheinRef.current = gutschein }, [gutschein])
  // Warenkorb geändert → bereits gewählte Seriennummern verwerfen (Indizes könnten veraltet sein)
  useEffect(() => { serialsRef.current = null }, [korb])
  // Angebot-spezifisch
  const [gueltigBis, setGueltigBis] = useState<string>('')
  const [angebotNotiz, setAngebotNotiz] = useState<string>('')

  // ZVT-Config holen — entscheidet ob bei Kartenzahlung Modal nötig ist
  const zvtCfg = useQuery({
    queryKey: ['zvt', identity.kasseId],
    queryFn:  () => zvtApi.getConfig(identity.kasseId),
  })

  const artikelQuery = useQuery({
    queryKey: ['artikel', identity.mandantId, true],
    queryFn:  () => artikelApi.list(identity.mandantId, true),
  })

  const kategorienQuery = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(true),
  })

  const preisregelnQuery = useQuery({
    queryKey: ['preisregeln'],
    queryFn:  preisregelApi.list,
  })

  const modGruppenQuery = useQuery({
    queryKey: ['modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeGruppen(),
  })

  const modZuweisungenQuery = useQuery({
    queryKey: ['artikel-modifikator-gruppen'],
    queryFn:  () => modifikatorApi.listeArtikelZuweisungen(),
  })

  const posConfigQuery = useQuery({
    queryKey: ['pos-config', identity.kasseId],
    queryFn:  () => posConfigApi.get(identity.kasseId),
  })

  // Map: artikelId → ModifikatorGruppe[] (nur aktive Gruppen mit aktiven Optionen)
  const artikelGruppenMap = useMemo<Map<string, ModifikatorGruppe[]>>(() => {
    const gruppen     = modGruppenQuery.data ?? []
    const zuweisungen = modZuweisungenQuery.data ?? []
    const gruppeById  = new Map(gruppen.map(g => [g.id, g]))

    const map = new Map<string, ModifikatorGruppe[]>()
    for (const z of zuweisungen) {
      const gruppe = gruppeById.get(z.gruppeId)
      if (!gruppe || !gruppe.aktiv) continue
      if (!gruppe.modifikatoren.some(m => m.aktiv)) continue
      const list = map.get(z.artikelId) ?? []
      list.push(gruppe)
      map.set(z.artikelId, list)
    }
    return map
  }, [modGruppenQuery.data, modZuweisungenQuery.data])

  const summeCent  = useMemo(() => warenkorbSummeCent(korb), [korb])
  const rabattCent = useMemo(() => rabattBetragCent(summeCent, rabatt), [rabatt, summeCent])

  // Serialisierte Positionen im Warenkorb (Index → Artikel), für die vor dem Bon Seriennummern zu wählen sind
  const serialPositionen = useMemo<SerialPos[]>(
    () => korb.flatMap((p, idx) =>
      p.typ === 'artikel' && p.artikel.seriennummernAktiv
        ? [{ positionIndex: idx, bezeichnung: p.artikel.bezeichnung, menge: p.menge, artikelId: p.artikel.id }]
        : []),
    [korb],
  )

  // artikelId → Gesamtmenge im Warenkorb (für das Mengen-Badge auf den Kacheln)
  const mengenProArtikel = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of korb) {
      if (p.typ === 'artikel') m.set(p.artikel.id, (m.get(p.artikel.id) ?? 0) + p.menge)
    }
    return m
  }, [korb])

  const summeNachRabattCent = summeCent - rabattCent

  // Gutschein-Abzug ----------------------------------------------------------
  const gutscheinCent          = gutschein?.einloesungCent ?? 0
  const summeNachGutscheinCent = Math.max(0, summeNachRabattCent - gutscheinCent)

  // Zahlungsberechnung -------------------------------------------------------
  const barCentEingabe = useMemo(() => barEingabeCent(barEuro), [barEuro])
  // Bar-Anteil (gedeckelt), Karten-Rest und Wechselgeld in einem Schritt.
  const { barCentBeleg, karteCentBeleg, wechselgeldCent: wechselgeld } =
    zahlungsAufteilung(summeNachGutscheinCent, barCentEingabe)

  // ---------------------------------------------------------------------------
  // Warenkorb-Aktionen
  // ---------------------------------------------------------------------------

  const addArtikel = (a: Artikel, modifikatoren: ModifikatorAuswahl[]) => {
    setFehler(null)
    // Happy Hour: den Artikel-Basispreis ggf. rabattieren, Modifikatoren zum vollen Preis dazu
    const regeln    = preisregelnQuery.data ?? []
    const hhProzent = aktiverRabattProzent(regeln, a.id, a.kategorieId, new Date())
    const basisCent = happyHourPreisCent(a.preisBruttoCent, regeln, a.id, a.kategorieId, new Date())
    const preisCent = positionsPreisCent(basisCent, modifikatoren)
    setKorb((prev) => {
      if (modifikatoren.length === 0) {
        const existing = prev.find(
          (p): p is ArtikelKorbPosition => p.typ === 'artikel' && p.artikel.id === a.id && p.modifikatoren.length === 0
        )
        if (existing) {
          return prev.map((p) =>
            p.typ === 'artikel' && p.artikel.id === a.id && p.modifikatoren.length === 0
              ? { ...p, menge: p.menge + 1 }
              : p,
          )
        }
      }
      return [...prev, { typ: 'artikel', artikel: a, menge: 1, modifikatoren, preisCent, originalPreisCent: preisCent, happyHourProzent: hhProzent }]
    })
  }

  const addFreiePosition = (pos: FreieKorbPosition) => {
    setFehler(null)
    setKorb(prev => [...prev, pos])
  }

  const applyArtikelRabatt = (idx: number, r: RabattInput) => {
    setKorb(prev => prev.map((p, i) => {
      if (i !== idx || p.typ !== 'artikel') return p
      return { ...p, preisCent: preisNachPositionsRabattCent(p.originalPreisCent, r) }
    }))
    setArtikelRabattIdx(null)
  }

  const removeArtikelRabatt = (idx: number) => {
    setKorb(prev => prev.map((p, i) => {
      if (i !== idx || p.typ !== 'artikel') return p
      return { ...p, preisCent: p.originalPreisCent }
    }))
  }

  const updateMenge = (idx: number, delta: number) => {
    setKorb((prev) =>
      prev.flatMap((p, i) => {
        if (i !== idx) return [p]
        const neueMenge = p.menge + delta
        if (neueMenge <= 0) return []
        return [{ ...p, menge: neueMenge }]
      }),
    )
  }

  const removeArtikel = (idx: number) => {
    setKorb((prev) => prev.filter((_, i) => i !== idx))
  }

  const reset = () => {
    setKorb([])
    setRabatt(null)
    setBarEuro('')
    setFehler(null)
    setKunde(null)
    setNeuerKunde(undefined)
    setGueltigBis('')
    setAngebotNotiz('')
    setKreditModus(false)
    setGutschein(null)
  }

  // ---------------------------------------------------------------------------
  // Beleg erstellen
  // ---------------------------------------------------------------------------

  const belegMutation = useMutation({
    mutationFn: belegApi.barzahlung,
    onSuccess: async (beleg) => {
      // Offline-Fall: SW gibt 202 + { _offline: true } zurück
      if ((beleg as unknown as { _offline?: boolean })?._offline) {
        setOfflineBelegGespeichert(true)
        setTimeout(() => setOfflineBelegGespeichert(false), 5000)
        reset()
        return
      }
      // Gutschein einlösen — ref hält den Wert noch vor reset()
      const gs = gutscheinRef.current
      if (gs) {
        try {
          const result = await gutscheinApi.einloesen(gs.id, {
            einloesungCent:       gs.einloesungCent,
            erstelleRestgutschein: gs.erstelleRestgutschein,
            belegId:              beleg.id,
          })
          void queryClient.invalidateQueries({ queryKey: ['gutscheine'] })
          // Restgutschein anzeigen und direkt drucken
          if (result.restGutschein) {
            const auth = getAuth()
            if (auth) druckeGutschein(result.restGutschein, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
            setRestGutschein(result.restGutschein)
          }
        } catch (e) {
          // Beleg ist schon erstellt — Fehler nur loggen, nicht blockieren
          console.error('Gutschein-Einlösung fehlgeschlagen:', e)
        }
      }
      // Display: Beleg-Bestätigung anzeigen, dann leer
      const summeCent = (beleg.summeBarCent ?? 0) + (beleg.summeKarteCent ?? 0) + (beleg.summeSonstigeCent ?? 0)
      displayApi.push(identity.kasseId, { typ: 'beleg_erstellt', belegNummer: beleg.belegNummer, summeCent }).catch(() => {})
      setTimeout(() => displayApi.push(identity.kasseId, { typ: 'leer' }).catch(() => {}), 5000)
      setLetzterBon(beleg)
      reset()
      void queryClient.invalidateQueries({ queryKey: ['belege'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const kreditMutation = useMutation({
    mutationFn: async ({ kundeId, betragCent }: { kundeId: string; betragCent: number }) => {
      const input: BarzahlungsbelegInput = {
        kasseId: identity.kasseId,
        positionen: korb.map((p) => {
          if (p.typ === 'frei') {
            return { bezeichnung: p.bezeichnung, preisBruttoCent: p.preisCent, mwstSatz: p.mwstSatz, menge: p.menge }
          }
          return {
            artikelId:              p.artikel.id,
            menge:                  p.menge,
            einzelpreisBreuttoCent: p.preisCent,
            ...(p.modifikatoren.length > 0 ? { bezeichnungZusatz: p.modifikatoren.map(m => m.name).join(', ') } : {}),
          }
        }),
        zahlung: { barCent: 0, karteCent: 0, sonstigeCent: betragCent },
        ...(rabatt && { rabatt }),
        kundeId,
      }
      const beleg = await belegApi.barzahlung(input)
      const op    = await offenerPostenApi.create({ kundeId, belegId: beleg.id, betragCent })
      return { beleg, offenerPosten: op }
    },
    onSuccess: ({ beleg }) => {
      setLetzterBon(beleg)
      reset()
      queryClient.invalidateQueries({ queryKey: ['belege'] })
      queryClient.invalidateQueries({ queryKey: ['offene-posten'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const nullbelegMutation = useMutation({
    mutationFn: () => belegApi.nullbeleg({ kasseId: identity.kasseId }),
    onSuccess: (beleg) => {
      setLetzterBon(beleg)
      queryClient.invalidateQueries({ queryKey: ['belege'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const angebotMutation = useMutation({
    mutationFn: angebotApi.create,
    onSuccess: (angebot) => {
      setLetzterAngebot(angebot)
      reset()
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const handleAngebotErstellen = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Der Warenkorb ist leer.'); return }
    angebotMutation.mutate({
      kasseId:    identity.kasseId,
      positionen: korb.map((p) => ({
        bezeichnung:        p.typ === 'frei' ? p.bezeichnung : p.artikel.bezeichnung,
        menge:              p.menge,
        einzelpreisBreutto: p.preisCent,
        mwstSatz:           p.typ === 'frei' ? p.mwstSatz : p.artikel.mwstSatz,
        ...(p.typ === 'artikel' ? { artikelId: p.artikel.id } : {}),
      })),
      ...(gueltigBis  ? { gueltigBis }              : {}),
      ...(angebotNotiz.trim() ? { notiz: angebotNotiz.trim() } : {}),
      ...(neuerKunde  ? { neuerKunde }              : {}),
      ...(kunde && !neuerKunde ? { kundeId: kunde.id } : {}),
    })
  }

  const bonierMutation = useMutation({
    mutationFn: (input: BonierungInput) => bonierApi.bonieren(input),
    onSuccess: (ergebnis) => {
      setBonierungErgebnis(ergebnis)
      queryClient.invalidateQueries({ queryKey: ['artikel', identity.mandantId] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const handleBonieren = () => {
    setFehler(null)
    if (korb.length === 0) { setFehler('Der Warenkorb ist leer.'); return }
    if (!kellner.trim())   { setFehler('Kellner fehlt.'); return }
    // Tisch ist optional: leer = Direktverkauf an der Schank (Bon-Label „Direkt")

    const artikelPositionen = korb.filter((p): p is ArtikelKorbPosition => p.typ === 'artikel')
    if (artikelPositionen.length === 0) {
      setFehler('Freie Positionen können nicht boniert werden — bitte direkt kassieren.')
      return
    }

    bonierMutation.mutate({
      kasseId:    identity.kasseId,
      ...(tisch.trim() && { tisch: tisch.trim() }),
      kellner:    kellner.trim(),
      positionen: artikelPositionen.map((p) => ({ artikelId: p.artikel.id, menge: p.menge })),
    })
  }

  const erstelleBeleg = (barCent: number, karteCent: number, trinkgeldCent = 0) => {
    const serials = serialsRef.current
    const positionen: BarzahlungsbelegInput['positionen'] = korb.map((p, idx) => {
      if (p.typ === 'frei') {
        return {
          bezeichnung:     p.bezeichnung,
          preisBruttoCent: p.preisCent,
          mwstSatz:        p.mwstSatz,
          menge:           p.menge,
        }
      }
      const gewaehlteSerials = serials?.get(idx)
      return {
        artikelId:              p.artikel.id,
        menge:                  p.menge,
        einzelpreisBreuttoCent: p.preisCent,
        ...(p.modifikatoren.length > 0
          ? { bezeichnungZusatz: p.modifikatoren.map(m => m.name).join(', ') }
          : {}),
        ...(gewaehlteSerials && gewaehlteSerials.length > 0 ? { seriennummern: gewaehlteSerials } : {}),
      }
    })
    serialsRef.current = null
    if (trinkgeldCent > 0) {
      positionen.push({ bezeichnung: 'Trinkgeld', preisBruttoCent: trinkgeldCent, mwstSatz: 'null', menge: 1 })
    }
    const input: BarzahlungsbelegInput = {
      kasseId: identity.kasseId,
      positionen,
      zahlung: {
        barCent,
        karteCent: karteCent + trinkgeldCent,
        sonstigeCent: gutschein?.einloesungCent ?? 0,
      },
      ...(rabatt && { rabatt }),
      ...(neuerKunde ? { neuerKunde }           : {}),
      ...(kunde && !neuerKunde ? { kundeId: kunde.id } : {}),
    }
    belegMutation.mutate(input)
  }

  const handleBonErstellen = () => {
    setFehler(null)
    if (korb.length === 0) {
      setFehler('Der Warenkorb ist leer.')
      return
    }
    // Serialisierte Artikel: zuerst Seriennummern wählen (sofern noch nicht geschehen)
    if (serialPositionen.length > 0 && serialsRef.current === null) {
      setSerialModalOffen(true)
      return
    }
    if (karteCentBeleg > 0 && zvtCfg.data?.zvtAktiv) {
      setZvtBetrag(karteCentBeleg)
      setZvtOffen(true)
      return
    }
    erstelleBeleg(barCentBeleg, karteCentBeleg)
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-7xl px-4 py-4">
      {/* Offline-Beleg-gespeichert Toast */}
      {offlineBelegGespeichert && (
        <div className="mb-3 bg-amber-50 border border-amber-300 text-amber-800
                        rounded-lg px-4 py-3 flex items-center gap-3 text-sm font-medium">
          <span className="text-lg">📥</span>
          <span>
            Beleg offline gespeichert — wird automatisch übermittelt sobald die Verbindung wiederhergestellt ist
          </span>
        </div>
      )}
      {/* Offline-Indikator mit Queue-Stand */}
      {!online && (
        <div className="mb-3 bg-amber-100 border border-amber-400 text-amber-900
                        rounded-lg px-4 py-2 flex items-center gap-2 text-xs">
          <span>📡</span>
          <span>Kasse arbeitet im Offline-Modus</span>
          {queueCount > 0 && (
            <span className="ml-auto font-semibold">
              {queueCount} {queueCount === 1 ? 'Beleg' : 'Belege'} ausstehend
            </span>
          )}
        </div>
      )}
      {/* Kontext-Leiste: Modus + Tisch + Kellner */}
      <div className="mb-3 bg-panel rounded-lg shadow-sm border border-line px-3 py-2 flex flex-wrap items-center gap-3">
        {/* Modus-Toggle */}
        <div className="inline-flex rounded-md border border-line-strong overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => { setModus('verkauf'); reset() }}
            className={`px-3 py-1.5 text-sm font-medium transition ${
              modus === 'verkauf'
                ? 'bg-brand-600 text-white'
                : 'bg-panel text-ink-muted hover:bg-panel-2'
            }`}
          >
            Verkauf
          </button>
          <button
            type="button"
            onClick={() => { setModus('angebot'); reset() }}
            className={`px-3 py-1.5 text-sm font-medium transition border-l border-line-strong ${
              modus === 'angebot'
                ? 'bg-amber-500 text-white'
                : 'bg-panel text-ink-muted hover:bg-panel-2'
            }`}
          >
            Angebot
          </button>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="font-medium text-ink">Tisch</span>
          <Input
            value={tisch}
            onChange={(e) => setTisch(e.target.value)}
            placeholder="Schank"
            title="Leer lassen für Direktverkauf an der Schank"
            className="w-20 text-center"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="font-medium text-ink">Kellner</span>
          <Input
            value={kellner}
            onChange={(e) => setKellner(e.target.value)}
            className="w-40"
          />
        </label>
      </div>

      {hasBerechtigung('tische') && <OffeneTischeLeiste />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* ----- Linke Seite: Artikel-Buttons ----- */}
        <section className="bg-panel rounded-lg shadow-sm border border-line
                            flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
          <div className="px-4 pt-4 pb-2 shrink-0 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Artikel</h2>
            <button
              type="button"
              onClick={() => { setFehler(null); setFreiePositionOffen(true) }}
              className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              + Sonstiges
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
            <ArtikelGrid
              artikel={artikelQuery.data ?? []}
              kategorien={kategorienQuery.data ?? []}
              artikelGruppen={artikelGruppenMap}
              onArtikelClick={addArtikel}
              loading={artikelQuery.isLoading}
              sichtbareKategorieIds={posConfigQuery.data?.sichtbareKategorieIds}
              artikelbilderAktiv={posConfigQuery.data?.artikelbilderAktiv ?? true}
              initialKategorieId={initialKategorieId}
              mengenProArtikel={mengenProArtikel}
            />
          </div>
        </section>

        {/* ----- Rechte Seite: Warenkorb + Zahlung ----- */}
        <section className="bg-panel rounded-lg shadow-sm border border-line flex flex-col h-fit lg:sticky lg:top-20 max-h-[calc(100vh-6rem)]">
          <div className="px-4 py-3 border-b border-line space-y-2">
            <h2 className="text-sm font-semibold text-ink">Warenkorb</h2>
            <KundePicker
              value={kunde}
              onChange={(k, input) => {
                setKunde(k)
                setNeuerKunde(input)
                // Kredit-Modus zurücksetzen wenn Kunde kein Kredit hat
                if (!k?.kreditAktiv) setKreditModus(false)
              }}
            />
          </div>

          {/* Warenkorb-Positionen */}
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-[10rem] max-h-[40vh]">
            {korb.length === 0 ? (
              <p className="text-sm text-ink-subtle text-center py-8">Leer</p>
            ) : (
              <ul className="space-y-2">
                {korb.map((p, idx) => {
                  const hatRabatt = p.typ === 'artikel' && p.preisCent !== p.originalPreisCent
                  return (
                    <li key={idx} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className={`font-medium text-ink truncate ${p.typ === 'frei' ? 'italic' : ''}`}>
                          {p.typ === 'frei' ? p.bezeichnung : p.artikel.bezeichnung}
                        </p>
                        {p.typ === 'artikel' && p.happyHourProzent > 0 && (
                          <span className="inline-block text-[10px] font-bold text-amber-700 bg-amber-100 rounded px-1 py-0.5 mt-0.5">
                            Happy Hour −{p.happyHourProzent}%
                          </span>
                        )}
                        {p.typ === 'artikel' && p.modifikatoren.length > 0 && (
                          <p className="text-xs text-brand-600 truncate">
                            {p.modifikatoren.map(m => m.name).join(', ')}
                          </p>
                        )}
                        <p className="text-xs text-ink-muted flex items-center gap-1.5">
                          {hatRabatt && p.typ === 'artikel' ? (
                            <>
                              <span className="line-through text-ink-subtle">{formatPreis(p.originalPreisCent)}</span>
                              <span className="text-green-700 font-medium">{formatPreis(p.preisCent)}</span>
                            </>
                          ) : (
                            <span>{formatPreis(p.preisCent)}</span>
                          )}
                          <span>× {p.menge}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <MengeButton onClick={() => updateMenge(idx, -1)}>−</MengeButton>
                        <span className="w-6 text-center font-medium">{p.menge}</span>
                        <MengeButton onClick={() => updateMenge(idx, +1)}>+</MengeButton>
                      </div>
                      <span className="w-20 text-right font-mono">
                        {formatPreis(p.preisCent * p.menge)}
                      </span>
                      {p.typ === 'artikel' ? (
                        hatRabatt ? (
                          <button
                            type="button"
                            onClick={() => removeArtikelRabatt(idx)}
                            className="text-green-600 hover:text-red-500 text-xs font-bold px-1"
                            title="Artikel-Rabatt entfernen"
                          >
                            %×
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setArtikelRabattIdx(idx)}
                            className="text-ink-subtle hover:text-brand-500 text-xs font-bold px-1"
                            title="Artikel-Rabatt"
                          >
                            %
                          </button>
                        )
                      ) : (
                        <span className="w-6" />
                      )}
                      <button
                        type="button"
                        onClick={() => removeArtikel(idx)}
                        className="text-ink-subtle hover:text-red-500 px-1"
                        aria-label="Entfernen"
                      >
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Summen + Zahlung / Angebot */}
          <div className="px-4 py-3 border-t border-line space-y-3 bg-panel-2">
            <div className="flex items-center justify-between text-sm text-ink-muted">
              <span>Zwischensumme</span>
              <span>{formatPreis(summeCent)}</span>
            </div>

            {modus === 'verkauf' ? (
              <>
                {/* Rabatt-Zeile */}
                {rabatt ? (
                  <div className="flex items-center justify-between text-sm text-green-700 bg-green-50 rounded px-2 py-1.5 border border-green-200">
                    <span className="flex items-center gap-1.5">
                      <span>
                        {rabatt.typ === 'prozent'
                          ? `${rabatt.bezeichnung ?? 'Rabatt'} (${rabatt.prozent}%)`
                          : (rabatt.bezeichnung ?? 'Rabatt')}
                      </span>
                      <button type="button" onClick={() => setRabatt(null)} className="text-green-500 hover:text-red-500 text-xs px-1">×</button>
                    </span>
                    <span className="font-mono font-medium">−{formatPreis(rabattCent)}</span>
                  </div>
                ) : (
                  korb.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setFehler(null); setRabattOffen(true) }}
                      className="text-xs text-brand-600 hover:underline font-medium"
                    >
                      + Rabatt hinzufügen
                    </button>
                  )
                )}

                {/* Gutschein-Abzug oder Einlösen-Button */}
                {gutschein ? (
                  <div className="flex items-center justify-between text-sm text-teal-700 bg-teal-50 rounded px-2 py-1.5 border border-teal-200">
                    <span className="flex items-center gap-1.5">
                      <span>Gutschein <span className="font-mono font-semibold">{gutschein.code}</span></span>
                      <button type="button" onClick={() => setGutschein(null)} className="text-teal-500 hover:text-red-500 text-xs px-1">×</button>
                    </span>
                    <span className="font-mono font-medium">−{formatPreis(gutschein.einloesungCent)}</span>
                  </div>
                ) : (
                  korb.length > 0 && !kreditModus && (
                    <button
                      type="button"
                      onClick={() => { setFehler(null); setGutscheinModalOffen(true) }}
                      className="text-xs text-teal-600 hover:underline font-medium"
                    >
                      + Gutschein einlösen
                    </button>
                  )
                )}

                <div className="flex items-center justify-between rounded-lg bg-panel-2 px-3 py-2.5">
                  <span className="text-sm font-medium text-ink-muted">Zu zahlen</span>
                  <span className="text-2xl font-bold text-ink tabular-nums">{formatPreis(summeNachGutscheinCent)}</span>
                </div>

                {/* Zahlungsart-Toggle: Normal ↔ Kredit */}
                {kunde && kunde.kreditAktiv && hasBerechtigung('kasse.kredit') && (
                  <div className="flex rounded-md border border-line-strong overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setKreditModus(false)}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium transition ${
                        !kreditModus ? 'bg-brand-600 text-white' : 'bg-panel text-ink-muted hover:bg-panel-2'
                      }`}
                    >
                      Bar / Karte
                    </button>
                    <button
                      type="button"
                      onClick={() => { setKreditModus(true); setBarEuro('') }}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium border-l border-line-strong transition ${
                        kreditModus ? 'bg-orange-500 text-white' : 'bg-panel text-ink-muted hover:bg-panel-2'
                      }`}
                    >
                      Auf Kredit
                    </button>
                  </div>
                )}

                {kreditModus ? (
                  /* Kredit-Modus */
                  <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 space-y-2">
                    <p className="text-sm font-semibold text-orange-900">Kredit-Buchung</p>
                    <p className="text-xs text-orange-700">
                      Der Betrag von <strong>{formatPreis(summeNachRabattCent)}</strong> wird
                      für <strong>{kunde?.bezeichnung}</strong> als offener Posten erfasst.
                    </p>
                    <p className="text-xs text-orange-600">Es wird ein regulärer Beleg erstellt (Zahlungsart: Sonstige).</p>
                  </div>
                ) : (
                  <>
                    {/* Bar-Eingabe */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-ink-muted">Bar (€)</label>
                      <div className="flex gap-1.5">
                        <Input
                          inputMode="decimal"
                          placeholder="0,00"
                          value={barEuro}
                          onChange={(e) => setBarEuro(e.target.value.replace(/[^0-9.,]/g, ''))}
                          className="flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => setBarEuro((summeNachRabattCent / 100).toFixed(2).replace('.', ','))}
                          className="shrink-0 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-panel-2 hover:border-brand-400 transition"
                        >
                          Exakt
                        </button>
                      </div>
                      {/* Schein-Schnellbuttons */}
                      <div className="flex flex-wrap gap-1">
                        {[5_00, 10_00, 20_00, 50_00, 100_00].map(cent => (
                          <button
                            key={cent}
                            type="button"
                            onClick={() => setBarEuro((cent / 100).toFixed(2).replace('.', ','))}
                            className={`rounded border px-2 py-1 text-xs font-medium transition ${
                              barCentEingabe === cent
                                ? 'bg-brand-600 border-brand-600 text-white'
                                : 'border-line-strong bg-panel text-ink-muted hover:border-brand-400 hover:bg-panel-2'
                            }`}
                          >
                            € {cent / 100}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => { setBarEuro(''); }}
                          className="rounded border border-line px-2 py-1 text-xs text-ink-subtle hover:text-red-500 hover:border-red-300 transition"
                          title="Bar-Betrag leeren → alles Karte"
                        >
                          Karte
                        </button>
                      </div>
                    </div>

                    {/* Karte-Rest (auto) */}
                    {karteCentBeleg > 0 && (
                      <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                        <span className="font-medium">Karte</span>
                        <span className="font-mono font-semibold">{formatPreis(karteCentBeleg)}</span>
                      </div>
                    )}

                    {/* Wechselgeld */}
                    {wechselgeld > 0 && (
                      <div className="flex items-center justify-between rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800">
                        <span className="font-semibold">Wechselgeld</span>
                        <span className="font-mono text-base font-bold">{formatPreis(wechselgeld)}</span>
                      </div>
                    )}
                  </>
                )}

                {fehler && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="secondary" onClick={reset} className="flex-1">Leeren</Button>
                  {!kreditModus && (
                    <Button
                      variant="secondary"
                      onClick={handleBonieren}
                      loading={bonierMutation.isPending}
                      className="flex-1"
                      disabled={korb.length === 0}
                    >
                      Bonieren
                    </Button>
                  )}
                  {kreditModus ? (
                    <Button
                      onClick={() => {
                        setFehler(null)
                        if (!kunde) { setFehler('Kein Kunde ausgewählt.'); return }
                        if (korb.length === 0) { setFehler('Der Warenkorb ist leer.'); return }
                        kreditMutation.mutate({ kundeId: kunde.id, betragCent: summeNachRabattCent })
                      }}
                      loading={kreditMutation.isPending}
                      className="flex-1 bg-orange-500 hover:bg-orange-600 focus:ring-orange-400"
                      disabled={korb.length === 0}
                    >
                      Auf Kredit buchen
                    </Button>
                  ) : (
                    <Button
                      onClick={handleBonErstellen}
                      loading={belegMutation.isPending}
                      className="flex-1 bg-green-600 hover:bg-green-700 focus:ring-green-400"
                      disabled={korb.length === 0}
                    >
                      Bon erstellen
                    </Button>
                  )}
                </div>

                <div className="pt-2 border-t border-line text-center">
                  <button
                    type="button"
                    onClick={() => nullbelegMutation.mutate()}
                    disabled={nullbelegMutation.isPending}
                    className="text-xs text-ink-muted hover:text-brand-600 disabled:opacity-50"
                  >
                    {nullbelegMutation.isPending ? 'Wird erstellt…' : 'Nullbeleg erstellen (Tagesschluss ohne Umsatz)'}
                  </button>
                </div>
              </>
            ) : (
              /* Angebot-Modus */
              <>
                <div className="flex items-center justify-between text-base font-bold text-amber-800 bg-amber-50 rounded px-3 py-2 border border-amber-200">
                  <span>Angebotssumme</span>
                  <span>{formatPreis(summeCent)}</span>
                </div>

                <div>
                  <label className="text-xs font-medium text-ink-muted block mb-1">Gültig bis (optional)</label>
                  <Input
                    type="date"
                    value={gueltigBis}
                    onChange={(e) => setGueltigBis(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-ink-muted block mb-1">Notiz / Anmerkung (optional)</label>
                  <textarea
                    value={angebotNotiz}
                    onChange={(e) => setAngebotNotiz(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="z. B. Preise gültig vorbehaltlich Materialverfügbarkeit …"
                    className="w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                  />
                </div>

                {fehler && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="secondary" onClick={reset} className="flex-1">Leeren</Button>
                  <Button
                    onClick={handleAngebotErstellen}
                    loading={angebotMutation.isPending}
                    className="flex-1 bg-amber-500 hover:bg-amber-600 focus:ring-amber-400"
                    disabled={korb.length === 0}
                  >
                    Angebot erstellen
                  </Button>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      {/* Erfolgs-Modal Beleg */}
      <Modal
        open={!!letzterBon}
        onClose={() => setLetzterBon(null)}
        title={`Beleg #${letzterBon?.belegNummer} erstellt`}
        size="lg"
      >
        {letzterBon && <BonAnzeige beleg={letzterBon} />}
      </Modal>

      {/* Erfolgs-Modal Angebot */}
      <Modal
        open={!!letzterAngebot}
        onClose={() => setLetzterAngebot(null)}
        title={`Angebot A-${String(letzterAngebot?.nummer ?? 0).padStart(4, '0')} erstellt`}
        size="lg"
      >
        {letzterAngebot && (
          <div className="space-y-4">
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Angebotsnummer</span>
                <span className="font-mono font-medium">A-{String(letzterAngebot.nummer).padStart(4, '0')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Datum</span>
                <span>{new Date(letzterAngebot.datum).toLocaleDateString('de-AT')}</span>
              </div>
              {letzterAngebot.gueltigBis && (
                <div className="flex justify-between">
                  <span className="text-ink-muted">Gültig bis</span>
                  <span>{letzterAngebot.gueltigBis}</span>
                </div>
              )}
              {letzterAngebot.kunde && (
                <div className="flex justify-between">
                  <span className="text-ink-muted">Kunde</span>
                  <span>{letzterAngebot.kunde.bezeichnung}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-amber-200 pt-1.5 font-bold">
                <span>Angebotssumme</span>
                <span>{formatPreis(letzterAngebot.gesamtbetragCent)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Positionen</p>
              <ul className="divide-y divide-line text-sm">
                {letzterAngebot.positionen.map((p, i) => (
                  <li key={i} className="flex justify-between py-1.5">
                    <span className="text-ink">{p.bezeichnung} × {p.menge}</span>
                    <span className="font-mono text-ink">{formatPreis(p.einzelpreisBreutto * p.menge)}</span>
                  </li>
                ))}
              </ul>
            </div>
            {letzterAngebot.notiz && (
              <p className="text-sm text-ink-muted border-l-2 border-line pl-3">{letzterAngebot.notiz}</p>
            )}
            <div className="flex flex-col gap-2 pt-2">
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    const auth = getAuth()
                    if (auth && letzterAngebot) {
                      druckeAngebot(letzterAngebot, {
                        firmenname: auth.mandant.firmenname,
                        uid:        auth.mandant.uid,
                      })
                    }
                  }}
                >
                  Angebot PDF
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={async () => {
                    const auth = getAuth()
                    if (auth && letzterAngebot) {
                      try {
                        const ls = await lieferscheinApi.create({ angebotId: letzterAngebot.id })
                        druckeLiferschein(ls, {
                          firmenname: auth.mandant.firmenname,
                          uid:        auth.mandant.uid,
                        })
                      } catch {
                        // Lieferschein ggf. bereits vorhanden — Fehler stumm ignorieren
                      }
                    }
                  }}
                >
                  Lieferschein
                </Button>
              </div>
              <Button variant="secondary" className="w-full" onClick={() => setLetzterAngebot(null)}>
                Schließen
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bonierungs-Ergebnis */}
      <Modal
        open={!!bonierungErgebnis}
        onClose={() => setBonierungErgebnis(null)}
        title={`Bonierung ${bonierungErgebnis?.bonNummer ?? ''}`}
      >
        {bonierungErgebnis && (
          <div className="space-y-4">
            {bonierungErgebnis.stationen.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">KDS-Stationen</p>
                <ul className="space-y-1.5">
                  {bonierungErgebnis.stationen.map((s) => (
                    <li
                      key={s.station}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                        s.erfolgreich
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-red-200 bg-red-50 text-red-700'
                      }`}
                    >
                      <span className="font-medium">
                        {STATION_LABELS[s.station]} <span className="font-mono text-xs opacity-60">({s.ip || '—'})</span>
                      </span>
                      <span>
                        {s.erfolgreich
                          ? `${s.positionen} Pos.`
                          : s.fehler ?? 'Fehler'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bonierungErgebnis.drucker.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Bonierdrucker</p>
                <ul className="space-y-1.5">
                  {bonierungErgebnis.drucker.map((d) => (
                    <li
                      key={d.druckerId}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                        d.erfolgreich
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-red-200 bg-red-50 text-red-700'
                      }`}
                    >
                      <span className="font-medium">
                        {d.name}
                        {d.istBackup && <span className="ml-1.5 text-[10px] rounded-full bg-black/10 px-1.5 py-0.5">Backup</span>}
                        {' '}<span className="font-mono text-xs opacity-60">({d.ip})</span>
                      </span>
                      <span>
                        {d.erfolgreich
                          ? `${d.positionen} Pos.`
                          : d.fehler ?? 'Fehler'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {bonierungErgebnis.stationen.length === 0 && bonierungErgebnis.drucker.length === 0 && (
              <p className="text-sm text-ink-muted text-center py-2">Keine Stationen oder Drucker konfiguriert.</p>
            )}
          </div>
        )}
      </Modal>

      {/* Seriennummern wählen (serialisierte Artikel) — vor Zahlung/Beleg */}
      <SerialAuswahlModal
        positionen={serialPositionen}
        open={serialModalOffen}
        loading={false}
        onConfirm={(zuweisungen) => {
          const m = new Map<number, string[]>()
          for (const z of zuweisungen) m.set(z.positionIndex, z.seriennummern)
          serialsRef.current = m
          setSerialModalOffen(false)
          handleBonErstellen()  // erneut — jetzt mit gesetzten Serials weiter zu ZVT/Beleg
        }}
        onClose={() => setSerialModalOffen(false)}
        title="Seriennummern für die Rechnung wählen"
        confirmLabel="Übernehmen & kassieren"
      />

      {/* Kartenzahlung (ZVT) — vor Beleg-Erstellung */}
      <KartenzahlungModal
        open={zvtOffen}
        kasseId={identity.kasseId}
        betragCent={zvtBetrag}
        onErfolg={(_job, trinkgeldCent) => {
          setZvtOffen(false)
          erstelleBeleg(barCentBeleg, karteCentBeleg, trinkgeldCent)
        }}
        onAbbruch={() => {
          setZvtOffen(false)
          setFehler('Kartenzahlung abgebrochen — kein Beleg erstellt')
        }}
      />

      <RabattModal
        open={rabattOffen}
        summeCent={summeCent}
        onSubmit={(r) => { setRabatt(r); setRabattOffen(false) }}
        onClose={() => setRabattOffen(false)}
      />

      {/* Artikel-Rabatt Modal */}
      {artikelRabattIdx !== null && (
        <RabattModal
          open={true}
          titel={`Rabatt: ${korb[artikelRabattIdx]?.typ === 'artikel' ? korb[artikelRabattIdx].artikel.bezeichnung : ''}`}
          summeCent={korb[artikelRabattIdx]?.typ === 'artikel' ? korb[artikelRabattIdx].originalPreisCent : 0}
          modus="artikel"
          onSubmit={(r) => applyArtikelRabatt(artikelRabattIdx, r)}
          onClose={() => setArtikelRabattIdx(null)}
        />
      )}

      {/* Freie Position Modal */}
      <Modal
        open={freiePositionOffen}
        onClose={() => setFreiePositionOffen(false)}
        title="Sonstige Position"
      >
        <FreiePositionModal
          onSubmit={(pos) => { addFreiePosition(pos); setFreiePositionOffen(false) }}
          onClose={() => setFreiePositionOffen(false)}
        />
      </Modal>

      {/* Gutschein einlösen Modal */}
      <Modal
        open={gutscheinModalOffen}
        onClose={() => setGutscheinModalOffen(false)}
        title="Gutschein einlösen"
      >
        <GutscheinEinloesenModal
          summeNachRabattCent={summeNachRabattCent}
          onApply={(gs) => { setGutschein(gs); setGutscheinModalOffen(false) }}
          onClose={() => setGutscheinModalOffen(false)}
        />
      </Modal>

      {/* Restgutschein-Info nach Einlösung */}
      {restGutschein && (
        <Modal
          open={true}
          onClose={() => setRestGutschein(null)}
          title="Restgutschein ausgestellt"
        >
          <div className="space-y-4">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-100">
                  <svg className="h-6 w-6 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-teal-900">Restgutschein wurde automatisch erstellt</p>
                  <p className="text-xs text-teal-700">und wurde bereits gedruckt</p>
                </div>
              </div>
              <div className="rounded-md bg-panel border border-teal-200 px-4 py-3 text-center">
                <p className="font-mono font-bold text-2xl tracking-widest text-brand-700">{restGutschein.code}</p>
                <p className="text-lg font-bold text-green-700 mt-1">{formatPreis(restGutschein.restCent)}</p>
                {restGutschein.kunde && (
                  <p className="text-xs text-ink-muted mt-0.5">Inhaber: {restGutschein.kunde.bezeichnung}</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  const auth = getAuth()
                  if (auth) druckeGutschein(restGutschein, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
                }}
              >
                Nochmal drucken
              </Button>
              <Button className="flex-1" onClick={() => setRestGutschein(null)}>
                Schließen
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Offene-Tische-Leiste
// ---------------------------------------------------------------------------

function OffeneTischeLeiste() {
  const identity  = getKasseIdentity()!
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [modalOffen, setModalOffen] = useState(false)
  const [fehler,     setFehler]     = useState<string | null>(null)

  const tabsQuery = useQuery({
    queryKey:        ['tisch-tabs', identity.kasseId],
    queryFn:         () => tischTabApi.list(identity.kasseId),
    refetchInterval: 30_000,
  })

  const erstelleMutation = useMutation({
    mutationFn: (input: TischTabErstellenInput) => tischTabApi.erstelle(input),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setModalOffen(false)
      navigate(`/tische/${tab.id}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const tabs = tabsQuery.data ?? []

  return (
    <>
      <div className="mb-3 bg-panel rounded-lg shadow-sm border border-line px-3 py-2 flex items-center gap-2 min-h-[48px]">
        <span className="text-xs font-semibold text-ink-muted shrink-0 uppercase tracking-wide">
          Tische
        </span>

        {tabsQuery.isLoading && (
          <span className="text-xs text-ink-subtle">Wird geladen…</span>
        )}

        {!tabsQuery.isLoading && tabs.length === 0 && (
          <span className="text-xs text-ink-subtle">Keine offenen Tische</span>
        )}

        {tabs.length > 0 && (
          <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
            <div className="flex gap-1.5 pr-1">
              {tabs.map((tab) => (
                <TischChip
                  key={tab.id}
                  tab={tab}
                  onClick={() => navigate(`/tische/${tab.id}`)}
                />
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => { setFehler(null); setModalOffen(true) }}
          className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline px-1"
        >
          + Neuer Tisch
        </button>
      </div>

      <Modal
        open={modalOffen}
        onClose={() => setModalOffen(false)}
        title="Neuen Tisch öffnen"
      >
        <NeuerTischFormular
          kasseId={identity.kasseId}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={(input) => { setFehler(null); erstelleMutation.mutate(input) }}
          onAbbrechen={() => setModalOffen(false)}
        />
      </Modal>
    </>
  )
}

function TischChip({ tab, onClick }: { tab: TischTabResponse; onClick: () => void }) {
  const minOffen  = Math.floor((Date.now() - new Date(tab.geoffnetAm).getTime()) / 60_000)
  const dauerText = minOffen < 60
    ? `${minOffen}'`
    : `${Math.floor(minOffen / 60)}h${minOffen % 60 > 0 ? `${minOffen % 60}'` : ''}`

  const farbe = minOffen < 30
    ? 'border-orange-300 bg-orange-50 hover:border-orange-500 hover:bg-orange-100 text-orange-800'
    : minOffen < 60
    ? 'border-amber-400 bg-amber-50 hover:border-amber-600 hover:bg-amber-100 text-amber-900'
    : 'border-red-300 bg-red-50 hover:border-red-500 hover:bg-red-100 text-red-800'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition ${farbe}`}
    >
      <span className="text-base font-bold leading-none">{tab.tischNummer}</span>
      <span className="flex flex-col items-start leading-tight">
        <span className="text-xs font-semibold">{formatPreis(tab.summeGesamtCent)}</span>
        <span className="text-[11px] opacity-70">{tab.kellner} · {dauerText}</span>
      </span>
    </button>
  )
}

interface NeuerTischFormularProps {
  kasseId:     string
  loading:     boolean
  fehler:      string | null
  onSubmit:    (input: TischTabErstellenInput) => void
  onAbbrechen: () => void
}

function NeuerTischFormular({ kasseId, loading, fehler, onSubmit, onAbbrechen }: NeuerTischFormularProps) {
  const [tischNummer, setTischNummer] = useState('')
  const [kellner,     setKellner]     = useState('Service')

  const submit = () => {
    if (!tischNummer.trim()) return
    onSubmit({ kasseId, tischNummer: tischNummer.trim(), kellner: kellner.trim() || 'Service' })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-ink">Tischnummer / -bezeichnung</span>
        <Input
          autoFocus
          value={tischNummer}
          onChange={(e) => setTischNummer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. 1, Terrasse 3, Bar …"
          className="mt-1"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-ink">Kellner</span>
        <Input
          value={kellner}
          onChange={(e) => setKellner(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1"
        />
      </label>
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!tischNummer.trim()}>
          Tisch öffnen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Freie Position Modal
// ---------------------------------------------------------------------------

interface FreiePositionModalProps {
  onSubmit: (p: FreieKorbPosition) => void
  onClose:  () => void
}

function FreiePositionModal({ onSubmit, onClose }: FreiePositionModalProps) {
  const [bezeichnung, setBezeichnung] = useState('')
  const [preisEuro,   setPreisEuro]   = useState('')
  const [mwstSatz,    setMwstSatz]    = useState<MwStSatz>('normal')

  const submit = () => {
    const cents = Math.round(parseFloat(preisEuro.replace(',', '.')) * 100)
    if (!bezeichnung.trim() || isNaN(cents)) return
    onSubmit({ typ: 'frei', bezeichnung: bezeichnung.trim(), preisCent: cents, mwstSatz, menge: 1 })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-ink">Bezeichnung</span>
        <Input
          autoFocus
          value={bezeichnung}
          onChange={(e) => setBezeichnung(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. Tagesspecial, Korrektur …"
          className="mt-1"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-ink">Preis brutto (€)</span>
        <Input
          inputMode="decimal"
          value={preisEuro}
          onChange={(e) => setPreisEuro(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="0,00"
          className="mt-1"
        />
      </label>
      <div>
        <span className="text-sm font-medium text-ink block mb-1.5">MwSt-Satz</span>
        <div className="flex flex-wrap gap-2">
          {(Object.entries(MWST_LABELS) as [MwStSatz, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMwstSatz(key)}
              className={`px-3 py-1.5 rounded-md border text-sm font-medium transition ${
                mwstSatz === key
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'border-line-strong text-ink hover:border-brand-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
        <Button
          onClick={submit}
          className="flex-1"
          disabled={!bezeichnung.trim() || !preisEuro.trim()}
        >
          Hinzufügen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gutschein einlösen Modal
// ---------------------------------------------------------------------------

interface GutscheinEinloesenModalProps {
  summeNachRabattCent: number
  onApply: (gs: { id: string; code: string; maxCent: number; einloesungCent: number; erstelleRestgutschein: boolean }) => void
  onClose: () => void
}

function GutscheinEinloesenModal({ summeNachRabattCent, onApply, onClose }: GutscheinEinloesenModalProps) {
  const [code,           setCode]           = useState('')
  const [gefunden,       setGefunden]       = useState<GutscheinResponse | null>(null)
  const [laden,          setLaden]          = useState(false)
  const [suchFehler,     setSuchFehler]     = useState<string | null>(null)
  const [einloesungEuro, setEinloesungEuro] = useState('')

  const suchen = async () => {
    if (!code.trim()) return
    setLaden(true)
    setSuchFehler(null)
    setGefunden(null)
    try {
      const gs = await gutscheinApi.getByCode(code.trim().toUpperCase())
      setGefunden(gs)
      // Auto-Vorschlag: GS ≥ Rechnung → nur Rechnungsbetrag; GS < Rechnung → ganzer Restwert
      const vorschlag = gs.restCent >= summeNachRabattCent ? summeNachRabattCent : gs.restCent
      setEinloesungEuro((vorschlag / 100).toFixed(2).replace('.', ','))
    } catch (e) {
      setSuchFehler(e instanceof Error ? e.message : 'Gutschein nicht gefunden')
    } finally {
      setLaden(false)
    }
  }

  const einloesungCents = Math.round(parseFloat(einloesungEuro.replace(',', '.')) * 100) || 0

  const isAbgelaufen = gefunden?.gueltigBis
    ? gefunden.gueltigBis < new Date().toISOString().slice(0, 10)
    : false

  const einloesbar = gefunden
    && !isAbgelaufen
    && gefunden.status !== 'eingeloest'
    && gefunden.status !== 'storniert'
    && gefunden.restCent > 0

  // Szenario-Erkennung
  const gsDecktRechnung    = einloesbar && einloesungCents >= summeNachRabattCent
  const restGutscheinWert  = gefunden ? Math.max(0, gefunden.restCent - einloesungCents) : 0
  const wirdRestGutschein  = !!(gsDecktRechnung && restGutscheinWert > 0)
  const offenerRestbetrag  = einloesbar && einloesungCents < summeNachRabattCent
    ? summeNachRabattCent - einloesungCents
    : 0

  const isValid = einloesbar && einloesungCents > 0 && einloesungCents <= gefunden!.restCent

  const apply = () => {
    if (!isValid || !gefunden) return
    onApply({
      id:                   gefunden.id,
      code:                 gefunden.code,
      maxCent:              gefunden.restCent,
      einloesungCent:       einloesungCents,
      erstelleRestgutschein: wirdRestGutschein,
    })
  }

  return (
    <div className="space-y-4">
      {/* Code-Eingabe (Scanner oder manuell) */}
      <div className="flex gap-2">
        <Input
          autoFocus
          placeholder="Code, EAN oder QR scannen …"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && void suchen()}
          className="flex-1 font-mono tracking-wider"
        />
        <Button onClick={() => void suchen()} loading={laden} disabled={!code.trim()}>
          Prüfen
        </Button>
      </div>

      {suchFehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{suchFehler}</div>
      )}

      {gefunden && (
        <div className={`rounded-lg border p-3 space-y-3 ${einloesbar ? 'border-teal-200 bg-teal-50' : 'border-red-200 bg-red-50'}`}>
          {/* Gutschein-Kopf */}
          <div className="flex items-center justify-between">
            <span className="font-mono font-bold text-lg text-teal-800">{gefunden.code}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
              gefunden.status === 'aktiv'          ? 'bg-green-100 text-green-800 border-green-200'
              : gefunden.status === 'teileingeloest' ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
              : 'bg-red-100 text-red-700 border-red-200'
            }`}>
              {GUTSCHEIN_STATUS_LABELS[gefunden.status]}
            </span>
          </div>

          {/* Werte */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-ink-muted">Ausgabewert</span>
            <span className="font-mono text-right">{formatPreis(gefunden.betragCent)}</span>
            <span className="text-ink-muted">Restwert</span>
            <span className={`font-mono text-right font-bold ${gefunden.restCent > 0 ? 'text-teal-700' : 'text-ink-subtle'}`}>
              {formatPreis(gefunden.restCent)}
            </span>
            {gefunden.gueltigBis && (
              <>
                <span className="text-ink-muted">Gültig bis</span>
                <span className={`text-right ${isAbgelaufen ? 'text-red-600 font-semibold' : 'text-ink'}`}>
                  {gefunden.gueltigBis}{isAbgelaufen ? ' (abgelaufen)' : ''}
                </span>
              </>
            )}
            {gefunden.kunde && (
              <>
                <span className="text-ink-muted">Inhaber</span>
                <span className="text-right text-ink">{gefunden.kunde.bezeichnung}</span>
              </>
            )}
          </div>

          {/* Einlösungsbetrag */}
          {einloesbar && (
            <div className="pt-1 border-t border-teal-200 space-y-2">
              <label className="text-xs font-medium text-ink block">Einlösungsbetrag (€)</label>
              <div className="flex gap-2">
                <Input
                  inputMode="decimal"
                  value={einloesungEuro}
                  onChange={e => setEinloesungEuro(e.target.value.replace(/[^0-9.,]/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && apply()}
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = gefunden.restCent >= summeNachRabattCent ? summeNachRabattCent : gefunden.restCent
                    setEinloesungEuro((v / 100).toFixed(2).replace('.', ','))
                  }}
                  className="shrink-0 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-panel-2 transition"
                >
                  Max
                </button>
              </div>
              {einloesungCents > gefunden.restCent && (
                <p className="text-xs text-red-600">Betrag übersteigt den Restwert ({formatPreis(gefunden.restCent)})</p>
              )}
            </div>
          )}

          {/* Szenario-Hinweise */}
          {einloesbar && einloesungCents > 0 && einloesungCents <= gefunden.restCent && (
            <>
              {/* GS > Rechnung → Restgutschein wird erstellt */}
              {wirdRestGutschein && (
                <div className="rounded-md border border-teal-300 bg-teal-100/60 px-3 py-2 text-xs text-teal-800 space-y-0.5">
                  <p className="font-semibold">✓ Gutschein deckt die gesamte Rechnung</p>
                  <p>Restgutschein über <strong>{formatPreis(restGutscheinWert)}</strong> wird automatisch ausgestellt und gedruckt.</p>
                </div>
              )}
              {/* GS = Rechnung → exakt */}
              {gsDecktRechnung && !wirdRestGutschein && (
                <div className="rounded-md border border-green-300 bg-green-100/60 px-3 py-2 text-xs text-green-800 font-medium">
                  ✓ Gutschein deckt die Rechnung exakt — keine Rückgabe
                </div>
              )}
              {/* GS < Rechnung → Restbetrag offen */}
              {offenerRestbetrag > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-0.5">
                  <p className="font-semibold">Gutschein deckt die Rechnung teilweise</p>
                  <p>Verbleibender Restbetrag: <strong>{formatPreis(offenerRestbetrag)}</strong> (Bar / Karte)</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onClose} className="flex-1">Abbrechen</Button>
        <Button
          onClick={apply}
          className="flex-1 bg-teal-600 hover:bg-teal-700 focus:ring-teal-400"
          disabled={!isValid}
        >
          Einlösen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kleine Bausteine
// ---------------------------------------------------------------------------

function MengeButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6 w-6 rounded border border-line-strong bg-panel text-sm font-bold text-ink hover:bg-panel-2"
    >
      {children}
    </button>
  )
}

