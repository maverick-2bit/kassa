// Minimaler ZIP-Leser ohne Abhängigkeiten (Methoden „gespeichert" und „deflate"), für das BMF-Prüftool.
// Läuft überall, wo Node läuft — kein `unzip`/`tar` nötig. Verweigert Einträge, die aus dem Zielordner ausbrechen (Zip-Slip).

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export function sha256Datei(pfad) {
  return createHash('sha256').update(readFileSync(pfad)).digest('hex')
}

/** Einträge des zentralen Verzeichnisses: { name, methode, komprimiert, original, kopf } */
export function zipEintraege(buf) {
  let ende = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { ende = i; break }
  }
  if (ende < 0) throw new Error('Kein ZIP (Ende des zentralen Verzeichnisses fehlt)')
  const anzahl = buf.readUInt16LE(ende + 10)
  let pos = buf.readUInt32LE(ende + 16)
  const liste = []
  for (let i = 0; i < anzahl; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP defekt (zentrales Verzeichnis)')
    const methode = buf.readUInt16LE(pos + 10)
    const komprimiert = buf.readUInt32LE(pos + 20)
    const original = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), kommentarLen = buf.readUInt16LE(pos + 32)
    const kopf = buf.readUInt32LE(pos + 42)
    liste.push({ name: buf.toString('utf8', pos + 46, pos + 46 + nameLen), methode, komprimiert, original, kopf })
    pos += 46 + nameLen + extraLen + kommentarLen
  }
  return liste
}

export function zipInhalt(buf, eintrag) {
  if (buf.readUInt32LE(eintrag.kopf) !== 0x04034b50) throw new Error(`ZIP defekt (lokaler Kopf von ${eintrag.name})`)
  const start = eintrag.kopf + 30 + buf.readUInt16LE(eintrag.kopf + 26) + buf.readUInt16LE(eintrag.kopf + 28)
  const roh = buf.subarray(start, start + eintrag.komprimiert)
  if (eintrag.methode === 0) return roh
  if (eintrag.methode === 8) return inflateRawSync(roh)
  throw new Error(`ZIP-Methode ${eintrag.methode} wird nicht unterstützt (${eintrag.name})`)
}

/** Entpackt `zipPfad` nach `ziel` und gibt die Liste der geschriebenen Dateien zurück. */
export function entpacke(zipPfad, ziel) {
  const buf = readFileSync(zipPfad)
  const wurzel = resolve(ziel) + sep
  const geschrieben = []
  for (const e of zipEintraege(buf)) {
    if (e.name.endsWith('/')) continue
    if (isAbsolute(e.name) || e.name.split(/[\\/]/).includes('..')) throw new Error(`Unzulässiger Pfad im ZIP: ${e.name}`)
    const ziel_ = resolve(join(ziel, e.name))
    if (!ziel_.startsWith(wurzel)) throw new Error(`ZIP-Eintrag bricht aus dem Zielordner aus: ${e.name}`)
    const daten = zipInhalt(buf, e)
    if (daten.length !== e.original) throw new Error(`ZIP-Eintrag ${e.name}: Größe ${daten.length} statt ${e.original}`)
    mkdirSync(dirname(ziel_), { recursive: true })
    writeFileSync(ziel_, daten)
    geschrieben.push(ziel_)
  }
  return geschrieben
}
