/**
 * Mandanten-Transfer: einen Mandanten samt allen Daten aus einer Kassa-Datenbank
 * exportieren und in eine andere (bereits laufende, auch befüllte) Kassa einspielen.
 *
 * Schema-getrieben statt Tabellenliste von Hand: Der Datenbankkatalog sagt, welche
 * Tabellen dem Mandanten gehören — Tabellen mit Spalte `mandant_id` direkt, alle
 * übrigen (Verknüpfungs-/Positionstabellen) über Fremdschlüssel auf bereits
 * erfasste Zeilen. Neue Tabellen sind damit automatisch dabei.
 *
 * Verschlüsselte Spalten (`*_enc`, RKSV-Schlüssel, A-Trust-/Stripe-Geheimnisse) sind mit
 * der MASTER_PASSPHRASE der Quelle verschlüsselt. Im Export stehen sie im Klartext
 * (`klar:<base64>`), die Datei muss daher selbst verschlüsselt transportiert werden
 * (ops/uebergabe.ps1 tut das), und der Import verschlüsselt sie mit der Passphrase des
 * Ziels neu.
 *
 * Der Import schreibt in EINER Transaktion, Eltern vor Kindern (Schleifen werden nachträglich gesetzt),
 * alle Fremdschlüssel der Datenbank bleiben aktiv; jeder Verstoß rollt alles zurück.
 */

import type postgres from 'postgres'
import { decryptPrivateKey, encryptPrivateKey } from '../crypto/master-key.js'

type Sql = postgres.Sql<Record<string, unknown>>
type Zeile = Record<string, unknown>

export const MANDANT_EXPORT_FORMAT  = 'kassa-mandant'
export const MANDANT_EXPORT_VERSION = 1

/** Gehören nicht in die Übertragung: Sicherungs-Verzeichnisse (Dateien reisen nicht mit) und Druck-Protokoll. */
const AUSGENOMMEN = new Set(['db_sicherungen', 'dep_sicherungen', 'druck_log'])

const KLAR = 'klar:'

export interface MandantExport {
  format:     typeof MANDANT_EXPORT_FORMAT
  version:    number
  erstellt:   string
  mandantId:  string
  name:       string
  tabellen:   Record<string, Zeile[]>
  /** Tabellen der Quelle, die ohne Mandantenbezug sind und daher nicht mitgenommen wurden */
  uebersprungen: string[]
}

interface Fk { kind: string; spalte: string; eltern: string; elternSpalte: string }
interface Katalog {
  spalten:    Map<string, string[]>
  mitMandant: Set<string>
  /** 'tabelle.spalte' der Spalten ohne NOT NULL */
  nullable:   Set<string>
  fks:        Fk[]
}

const IDENT = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unzulässiger Bezeichner: ${name}`)
  return `"${name}"`
}

async function ladeKatalog(sql: Sql): Promise<Katalog> {
  const cols = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
    SELECT c.table_name, c.column_name, c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
    ORDER BY c.table_name, c.ordinal_position`
  const spalten  = new Map<string, string[]>()
  const nullable = new Set<string>()
  for (const c of cols) {
    if (c.is_nullable === 'YES') nullable.add(`${c.table_name}.${c.column_name}`)
    const liste = spalten.get(c.table_name) ?? []
    liste.push(c.column_name)
    spalten.set(c.table_name, liste)
  }
  const mitMandant = new Set([...spalten].filter(([, s]) => s.includes('mandant_id')).map(([t]) => t))

  // Nur einspaltige Fremdschlüssel (alle in diesem Schema)
  const fkRows = await sql<{ kind: string; spalte: string; eltern: string; eltern_spalte: string }[]>`
    SELECT cl.relname AS kind, ca.attname AS spalte, pl.relname AS eltern, pa.attname AS eltern_spalte
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class pl ON pl.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`
  const fks = fkRows.map(r => ({ kind: r.kind, spalte: r.spalte, eltern: r.eltern, elternSpalte: r.eltern_spalte }))
  return { spalten, mitMandant, nullable, fks }
}

function klarText(s: string, passphrase: string): string {
  return KLAR + decryptPrivateKey(s, passphrase).toString('base64')
}

/** Geheimnis-Spalten (`*_enc`) entschlüsseln — bei falscher Passphrase klarer Fehler statt Datenmüll. */
function entschluesseleZeile(tabelle: string, z: Zeile, passphrase: string): Zeile {
  const neu: Zeile = { ...z }
  for (const [k, v] of Object.entries(z)) {
    if (!k.endsWith('_enc') || typeof v !== 'string') continue
    try {
      neu[k] = klarText(v, passphrase)
    } catch {
      throw new Error(`${tabelle}.${k} lässt sich mit der MASTER_PASSPHRASE dieser Kassa nicht entschlüsseln.`)
    }
  }
  return neu
}

export async function listeMandanten(sql: Sql): Promise<{ id: string; name: string }[]> {
  return sql<{ id: string; name: string }[]>`SELECT id, firmenname AS name FROM mandanten ORDER BY firmenname`
}

export async function exportiereMandant(sql: Sql, mandantId: string, passphrase: string): Promise<MandantExport> {
  const kat = await ladeKatalog(sql)
  const [mandant] = await sql<{ id: string; name: string }[]>`SELECT id, firmenname AS name FROM mandanten WHERE id = ${mandantId}`
  if (!mandant) throw new Error(`Mandant ${mandantId} nicht gefunden.`)

  const tabellen: Record<string, Zeile[]> = {}
  const lade = async (tabelle: string, bedingung: string, werte: unknown[]) => {
    const zeilen = await sql.unsafe<{ z: Zeile }[]>(
      `SELECT to_jsonb(t) AS z FROM ${ident(tabelle)} t WHERE ${bedingung}`, werte as never[],
    )
    return zeilen.map(r => r.z)
  }

  tabellen['mandanten'] = await lade('mandanten', 'id = $1', [mandantId])
  for (const t of kat.mitMandant) {
    if (AUSGENOMMEN.has(t) || t === 'mandanten') continue
    tabellen[t] = await lade(t, 'mandant_id = $1', [mandantId])
  }

  // Tabellen ohne mandant_id: über Fremdschlüssel auf schon erfasste Zeilen, bis nichts Neues dazukommt
  let neu = true
  while (neu) {
    neu = false
    const kandidaten = new Set(kat.fks.map(f => f.kind))
    for (const t of kandidaten) {
      if (t in tabellen || AUSGENOMMEN.has(t) || kat.mitMandant.has(t)) continue
      const eltern = kat.fks.filter(f => f.kind === t && f.eltern in tabellen)
      if (eltern.length === 0) continue
      const gesehen = new Set<string>()
      const treffer: Zeile[] = []
      for (const f of eltern) {
        const ids = [...new Set(tabellen[f.eltern]!.map(z => z[f.elternSpalte]).filter(v => v != null))]
        if (ids.length === 0) continue
        for (const z of await lade(t, `${ident(f.spalte)} = ANY(ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb))::uuid[])`, [JSON.stringify(ids)])) {
          const schluessel = JSON.stringify(z)
          if (!gesehen.has(schluessel)) { gesehen.add(schluessel); treffer.push(z) }
        }
      }
      tabellen[t] = treffer
      neu = true
    }
  }

  for (const [t, zeilen] of Object.entries(tabellen)) {
    tabellen[t] = zeilen.map(z => entschluesseleZeile(t, z, passphrase))
  }
  const uebersprungen = [...kat.spalten.keys()].filter(t => !(t in tabellen)).sort()

  return {
    format: MANDANT_EXPORT_FORMAT, version: MANDANT_EXPORT_VERSION,
    erstellt: new Date().toISOString(), mandantId: mandant.id, name: mandant.name,
    tabellen, uebersprungen,
  }
}

/**
 * Einfüge-Reihenfolge: Eltern vor Kindern. Verweise, die eine Schleife bilden (Selbstbezug,
 * mandanten ↔ kassen …), werden — sofern die Spalte NULL erlaubt — erst nachträglich gesetzt
 * ("spaeter" = 'tabelle.spalte'). So bleiben alle Fremdschlüssel der Datenbank aktiv.
 */
export function planeReihenfolge(kat: Pick<Katalog, 'fks' | 'nullable'>, tabellen: Set<string>): { reihenfolge: string[]; spaeter: Set<string> } {
  const kanten = kat.fks.filter(f => tabellen.has(f.kind) && tabellen.has(f.eltern))
  const key    = (f: Fk) => `${f.kind}.${f.spalte}`
  const spaeter = new Set<string>()
  for (const f of kanten) if (f.kind === f.eltern) spaeter.add(key(f))

  const offen = new Set(tabellen)
  const reihenfolge: string[] = []
  while (offen.size > 0) {
    const bereit = [...offen].filter(t =>
      kanten.every(f => f.kind !== t || spaeter.has(key(f)) || !offen.has(f.eltern) || f.eltern === t))
    if (bereit.length > 0) {
      for (const t of bereit.sort()) { reihenfolge.push(t); offen.delete(t) }
      continue
    }
    const loesbar = kanten.find(f => offen.has(f.kind) && offen.has(f.eltern) && !spaeter.has(key(f)) && kat.nullable.has(key(f)))
    if (!loesbar) throw new Error('Zyklische Abhängigkeit ohne NULL-fähige Spalte — Import nicht möglich.')
    spaeter.add(key(loesbar))
  }
  return { reihenfolge, spaeter }
}

export interface ImportBericht { mandantId: string; name: string; zeilen: Record<string, number> }

export async function importiereMandant(sql: Sql, daten: MandantExport, passphrase: string): Promise<ImportBericht> {
  if (daten.format !== MANDANT_EXPORT_FORMAT) throw new Error('Keine Mandanten-Exportdatei.')
  if (daten.version !== MANDANT_EXPORT_VERSION) throw new Error(`Exportversion ${daten.version} wird nicht unterstützt.`)

  const kat = await ladeKatalog(sql)

  // Vorabprüfungen: Ziel muss das Schema der Quelle kennen und den Mandanten noch nicht haben
  for (const [t, zeilen] of Object.entries(daten.tabellen)) {
    const zielSpalten = kat.spalten.get(t)
    if (!zielSpalten) throw new Error(`Tabelle '${t}' gibt es in dieser Kassa nicht — Ziel-Kassa zuerst auf die Version der Quelle aktualisieren.`)
    const fremd = new Set(zeilen.flatMap(z => Object.keys(z)).filter(k => !zielSpalten.includes(k)))
    if (fremd.size > 0) throw new Error(`Spalte(n) ${[...fremd].map(k => `${t}.${k}`).join(', ')} gibt es in dieser Kassa nicht — Ziel-Kassa zuerst aktualisieren.`)
  }
  const [vorhanden] = await sql`SELECT 1 FROM mandanten WHERE id = ${daten.mandantId}`
  if (vorhanden) throw new Error(`Der Mandant '${daten.name}' existiert in dieser Kassa bereits (gleiche ID). Es wird nichts überschrieben.`)

  const bericht: ImportBericht = { mandantId: daten.mandantId, name: daten.name, zeilen: {} }

  const { reihenfolge, spaeter } = planeReihenfolge(kat, new Set(Object.entries(daten.tabellen).filter(([, z]) => z.length > 0).map(([t]) => t)))

  await sql.begin(async (tx) => {
    const verschluesselt: Record<string, Zeile[]> = {}
    for (const t of reihenfolge) {
      verschluesselt[t] = daten.tabellen[t]!.map(z => {
        const neu: Zeile = { ...z }
        for (const [k, v] of Object.entries(z)) {
          if (k.endsWith('_enc') && typeof v === 'string' && v.startsWith(KLAR)) {
            neu[k] = encryptPrivateKey(Buffer.from(v.slice(KLAR.length), 'base64'), passphrase)
          }
        }
        // Zyklische Verweise erst nach dem Einfügen aller Tabellen setzen
        for (const key of spaeter) {
          const [kt, kc] = key.split('.') as [string, string]
          if (kt === t && kc in neu) neu[kc] = null
        }
        return neu
      })
    }

    for (const t of reihenfolge) {
      const zeilen = verschluesselt[t]!
      // Nur die Spalten schreiben, die der Export kennt — Spalten, die nur das Ziel hat, bekommen ihren Default
      const spalten = [...new Set(zeilen.flatMap(z => Object.keys(z)))]
      const liste   = spalten.map(ident).join(', ')
      const befehl  = `INSERT INTO ${ident(t)} (${liste}) SELECT ${liste} FROM jsonb_populate_recordset(null::${ident(t)}, $1::text::jsonb)`
      for (let i = 0; i < zeilen.length; i += 500) {
        await tx.unsafe(befehl, [JSON.stringify(zeilen.slice(i, i + 500))] as never[])
      }
      bericht.zeilen[t] = zeilen.length
    }

    // Zyklische Verweise nachtragen (Quelle: unveränderte Exportzeilen)
    for (const key of spaeter) {
      const [t, c] = key.split('.') as [string, string]
      const quelle = (daten.tabellen[t] ?? []).filter(z => z[c] != null).map(z => ({ id: z['id'], [c]: z[c] }))
      for (let i = 0; i < quelle.length; i += 500) {
        await tx.unsafe(
          `UPDATE ${ident(t)} t SET ${ident(c)} = s.${ident(c)}
           FROM jsonb_populate_recordset(null::${ident(t)}, $1::text::jsonb) s WHERE t.id = s.id`,
          [JSON.stringify(quelle.slice(i, i + 500))] as never[],
        )
      }
    }
  })

  return bericht
}
