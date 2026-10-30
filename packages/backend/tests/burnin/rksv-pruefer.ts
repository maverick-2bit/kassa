/**
 * Unabhängiger RKSV-Prüfer für den Burn-in-Test.
 *
 * Bewusst OHNE Import aus @kassa/rksv: Die Kassa prüft sich sonst mit ihrem eigenen Code selbst —
 * ein Denkfehler in der Signierung wäre dann auch in der Prüfung und bliebe unentdeckt. Dieser Prüfer
 * rechnet die Vorgaben der BMF-Detailspezifikation (RKSV) mit node:crypto frisch nach:
 *
 *  - maschinenlesbarer Code: _R1-<ZDA>_<KID>_<BNR>_<BDT>_<N>_<E1>_<E2>_<0>_<B>_<Umsatzzähler>_<ZSN>_<Vorbeleg>_<Signatur>
 *  - Verkettung: erste 8 Byte SHA-256 (Start: Kassen-ID, sonst kompletter Vorbeleg-Code), Base64
 *  - Signatur: ES256-JWS (r‖s, 64 Byte) über base64url({"alg":"ES256"}) + "." + base64url(Code ohne Signatur)
 *  - Umsatzzähler: AES-256-CTR, IV = erste 16 Byte SHA-256(Kassen-ID ‖ Belegnummer), Klartext Int64 big-endian
 *  - Belegnummern lückenlos, Zeitstempel nicht rückläufig
 *
 * Eingabe sind die Daten des DEP131-Exports, also genau das, was eine Finanzprüfung bekommt.
 */

import { createDecipheriv, createHash, verify, X509Certificate } from 'node:crypto'

export interface PrueferBeleg {
  belegTyp:                    string
  belegNummer:                 number
  datumUhrzeit:                string   // ISO
  betraege:                    { normal: number; ermaessigt1: number; ermaessigt2: number; null: number; besonders: number }
  zahlung:                     { barCent: number; karteCent: number; sonstigeCent: number }
  maschinenlesbareCode:        string
  signaturwert:                string
  umsatzzaehlerVerschluesselt: string
  zertifikatSN:                string
  sigVorbeleg:                 string
}

export interface PrueferKontext {
  kassenId:      string
  zertifikatDER: Buffer
  aesSchluessel: Buffer
}

export interface Verstoss {
  belegNummer: number | null
  regel:       string
  detail:      string
}

export interface PrueferErgebnis {
  verstoesse:       Verstoss[]
  geprueft:         number
  signaturGeprueft: number
  ausfallBelege:    number
  zaehlerEnde:      bigint
}

/** Belegtypen, die den Umsatzzähler verändern (RKSV: alle Umsätze mit Vorzeichen). */
const ZAEHLT = new Set(['Barzahlungsbeleg', 'Stornobeleg'])

const AUSFALL_SIGNATUR = Buffer.from('Sicherheitseinrichtung ausgefallen', 'utf8').toString('base64')

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest()

export function verkettung(eingabe: string): string {
  return sha256(eingabe).subarray(0, 8).toString('base64')
}

/** 1050 → "10,50", -5 → "-0,05", -500 → "-5,00" */
export function betragText(cent: number): string {
  const abs = Math.abs(cent)
  return `${cent < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}

export function summeBetraege(b: PrueferBeleg['betraege']): number {
  return b.normal + b.ermaessigt1 + b.ermaessigt2 + b.null + b.besonders
}

function entschluesseleZaehler(base64: string, schluessel: Buffer, kassenId: string, belegNummer: number): bigint {
  const iv = sha256(kassenId + String(belegNummer)).subarray(0, 16)
  const d  = createDecipheriv('aes-256-ctr', schluessel, iv)
  const klar = Buffer.concat([d.update(Buffer.from(base64, 'base64')), d.final()])
  return klar.readBigInt64BE(0)
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

export function pruefeBelegfolge(belege: readonly PrueferBeleg[], ctx: PrueferKontext): PrueferErgebnis {
  const verstoesse: Verstoss[] = []
  const fehler = (belegNummer: number | null, regel: string, detail: string) => {
    if (verstoesse.length < 500) verstoesse.push({ belegNummer, regel, detail })
  }

  const zert    = new X509Certificate(ctx.zertifikatDER)
  const zertSn  = BigInt('0x' + zert.serialNumber)
  let zaehler   = 0n
  let signaturGeprueft = 0
  let ausfallBelege    = 0
  let vorher: PrueferBeleg | undefined

  for (const b of belege) {
    const nr = b.belegNummer

    // Belegnummer lückenlos aufsteigend (Startbeleg = 1)
    if (!vorher ? nr !== 1 : nr !== vorher.belegNummer + 1) {
      fehler(nr, 'belegnummer-lueckenlos', `erwartet ${vorher ? vorher.belegNummer + 1 : 1}, gefunden ${nr}`)
    }
    // Zeitstempel nicht rückläufig
    if (vorher && Date.parse(b.datumUhrzeit) < Date.parse(vorher.datumUhrzeit) - 1000) {
      fehler(nr, 'zeit-rueckwaerts', `${b.datumUhrzeit} liegt vor ${vorher.datumUhrzeit}`)
    }

    // Start-/Folgebeleg: erster Beleg muss der Startbeleg sein
    if (!vorher && b.belegTyp !== 'Startbeleg') fehler(nr, 'startbeleg', `erster Beleg ist ${b.belegTyp}`)
    if (vorher && b.belegTyp === 'Startbeleg') fehler(nr, 'startbeleg', 'zweiter Startbeleg in derselben Kette')

    // --- Code zerlegen ---
    const code   = b.maschinenlesbareCode
    const teile  = code.split('_')
    if (teile.length !== 14 || teile[0] !== '' || !teile[1]?.startsWith('R1-')) {
      fehler(nr, 'code-format', `unerwartete Struktur (${teile.length} Teile): ${code.slice(0, 80)}`)
    } else {
      const [, , kid, bnr, bdt, n, e1, e2, e0, bes, zaehlerB64, zsn, vor] = teile as string[]
      if (kid !== ctx.kassenId)                  fehler(nr, 'code-kassenid', `${kid} ≠ ${ctx.kassenId}`)
      if (bnr !== String(nr))                    fehler(nr, 'code-belegnummer', `${bnr} ≠ ${nr}`)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(bdt!)) fehler(nr, 'code-datumformat', String(bdt))
      else if (Math.abs(new Date(bdt!).getTime() - Date.parse(b.datumUhrzeit)) > 1500) {
        fehler(nr, 'code-datum', `${bdt} passt nicht zu ${b.datumUhrzeit}`)
      }
      const soll = [b.betraege.normal, b.betraege.ermaessigt1, b.betraege.ermaessigt2, b.betraege.null, b.betraege.besonders].map(betragText)
      const ist  = [n, e1, e2, e0, bes]
      if (soll.join('|') !== ist.join('|'))      fehler(nr, 'code-betraege', `Code ${ist.join('|')} ≠ Beleg ${soll.join('|')}`)
      if (zaehlerB64 !== b.umsatzzaehlerVerschluesselt) fehler(nr, 'code-umsatzzaehler', 'Feld im Code ≠ Beleg')
      if (vor !== b.sigVorbeleg)                 fehler(nr, 'code-vorbeleg', 'Feld im Code ≠ Beleg')
      if (!/^[0-9A-Fa-f]+$/.test(zsn!) || BigInt('0x' + zsn!) !== zertSn) {
        fehler(nr, 'code-zertifikat-sn', `${zsn} ≠ Seriennummer des Zertifikats ${zert.serialNumber}`)
      }
      if (b.zertifikatSN !== zsn)                fehler(nr, 'code-zertifikat-sn', 'Feld im Code ≠ Beleg')
    }

    // --- Verkettung ---
    const sollVor = vorher ? verkettung(vorher.maschinenlesbareCode) : verkettung(ctx.kassenId)
    if (b.sigVorbeleg !== sollVor) fehler(nr, 'verkettung', `sigVorbeleg ${b.sigVorbeleg} ≠ ${sollVor}`)

    // --- Signatur (ES256-JWS) ---
    const letzterStrich = code.lastIndexOf('_')
    const codeOhneSig   = code.slice(0, letzterStrich)
    const sigB64        = code.slice(letzterStrich + 1)
    if (sigB64 !== b.signaturwert) fehler(nr, 'signatur-feld', 'Signatur im Code ≠ Signaturwert')
    if (b.signaturwert === AUSFALL_SIGNATUR) {
      ausfallBelege++
    } else {
      const sig = Buffer.from(b.signaturwert, 'base64')
      if (sig.length !== 64) {
        fehler(nr, 'signatur-laenge', `${sig.length} Byte statt 64 (r‖s)`)
      } else {
        const eingabe = `${b64url(JSON.stringify({ alg: 'ES256' }))}.${b64url(codeOhneSig)}`
        const ok = verify('sha256', Buffer.from(eingabe, 'ascii'), { key: zert.publicKey, dsaEncoding: 'ieee-p1363' }, sig)
        if (!ok) fehler(nr, 'signatur-ungueltig', 'ES256-Signatur passt nicht zum Zertifikat')
        signaturGeprueft++
      }
    }

    // --- Umsatzzähler ---
    if (ZAEHLT.has(b.belegTyp)) zaehler += BigInt(summeBetraege(b.betraege))
    else if (summeBetraege(b.betraege) !== 0) fehler(nr, 'betrag-bei-nullartigem-beleg', `${b.belegTyp} mit Betrag ${summeBetraege(b.betraege)}`)
    try {
      const echt = entschluesseleZaehler(b.umsatzzaehlerVerschluesselt, ctx.aesSchluessel, ctx.kassenId, nr)
      if (echt !== zaehler) fehler(nr, 'umsatzzaehler', `entschlüsselt ${echt}, erwartet ${zaehler} (Differenz ${echt - zaehler})`)
      // Der Prüfer folgt ab hier dem Wert der Kasse, damit EIN Fehler nicht alle Folgebelege rot färbt
      zaehler = echt
    } catch (e) {
      fehler(nr, 'umsatzzaehler', `nicht entschlüsselbar: ${e instanceof Error ? e.message : e}`)
    }

    // --- Zahlung = Betrag (nur bei Umsatzbelegen) ---
    if (ZAEHLT.has(b.belegTyp)) {
      const z = b.zahlung.barCent + b.zahlung.karteCent + b.zahlung.sonstigeCent
      if (z !== summeBetraege(b.betraege)) fehler(nr, 'zahlung-ungleich-betrag', `Zahlung ${z} ≠ Betrag ${summeBetraege(b.betraege)}`)
    }

    vorher = b
  }

  return { verstoesse, geprueft: belege.length, signaturGeprueft, ausfallBelege, zaehlerEnde: zaehler }
}

/** DEP7 (Belege-kompakt): jeder Eintrag muss die JWS-Form des Codes sein. */
export function pruefeDep7(
  dep7: { 'Belege-Gruppe': { Signaturzertifikat: string; 'Belege-kompakt': string[] }[] },
  belege: readonly PrueferBeleg[],
  zertifikatBase64: string,
): Verstoss[] {
  const v: Verstoss[] = []
  const gruppen = dep7['Belege-Gruppe']
  const alle    = gruppen.flatMap(g => g['Belege-kompakt'])
  if (alle.length !== belege.length) v.push({ belegNummer: null, regel: 'dep7-anzahl', detail: `${alle.length} im DEP7, ${belege.length} Belege` })
  for (const g of gruppen) {
    if (g.Signaturzertifikat !== zertifikatBase64) v.push({ belegNummer: null, regel: 'dep7-zertifikat', detail: 'Signaturzertifikat weicht vom Zertifikat der Kasse ab' })
  }
  belege.forEach((b, i) => {
    const jws = alle[i]
    if (!jws) return
    const teile = jws.split('.')
    if (teile.length !== 3) { v.push({ belegNummer: b.belegNummer, regel: 'dep7-jws', detail: 'kein JWS Compact' }); return }
    const idx = b.maschinenlesbareCode.lastIndexOf('_')
    const soll = [
      b64url(JSON.stringify({ alg: 'ES256' })),
      b64url(b.maschinenlesbareCode.slice(0, idx)),
      Buffer.from(b.maschinenlesbareCode.slice(idx + 1), 'base64').toString('base64url'),
    ]
    if (teile.join('.') !== soll.join('.')) v.push({ belegNummer: b.belegNummer, regel: 'dep7-inhalt', detail: 'JWS im DEP7 ≠ Code des Belegs' })
  })
  return v
}
