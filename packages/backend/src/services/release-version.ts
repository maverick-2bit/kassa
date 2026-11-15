/**
 * Neueste Release-Version aus den Git-Tags des Repos.
 *
 * Der In-App-Updater (ops/updater/updater.sh) installiert nur signierte Release-Tags der Form vX.Y.Z — nie die Spitze
 * von master. Die Versionsanzeige „Neueste" in der Kassa folgt derselben Regel: Nur das Format vX.Y.Z zählt (Vorabversionen,
 * Test-Tags und anderes bleiben außen vor), verglichen wird zahlenweise (v0.8.100 ist neuer als v0.8.99).
 *
 * Das Backend kann die Signatur nicht prüfen (kein git/ssh-keygen im Backend-Image) — das tut der Updater. Steht hier eine
 * Version, die der Updater ablehnt, zeigt die Kassa beim Klick auf „Jetzt aktualisieren" den Grund (Status des Updaters).
 */

const TAG_REF = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/

/**
 * Tag-Namen aus der Antwort des Git-Protokolls (GET …/info/refs?service=git-upload-pack, Protokoll v0):
 * pkt-lines wie „004f<sha> refs/tags/v0.8.91\n", dazu je annotiertem Tag die aufgelöste Zeile „…refs/tags/v0.8.91^{}".
 * Vorabversionen (v0.9.0-rc1) und Fremdes fallen heraus — der Name muss direkt von Zeilenende, NUL, Leerzeichen
 * oder „^{}" gefolgt sein.
 */
export function tagRefsAusGitAntwort(text: string): string[] {
  return Array.from(text.matchAll(/refs\/tags\/v\d+\.\d+\.\d+(?=\^\{\}|[\n\0 ]|$)/g), (treffer) => treffer[0])
}

/** @param refs Ref-Namen wie „refs/tags/v0.8.91" (z. B. aus der GitHub-Antwort matching-refs/tags/v) → „0.8.91" oder null */
export function neuesteVersionAusTags(refs: readonly string[]): string | null {
  let beste: [number, number, number] | null = null
  for (const ref of refs) {
    const treffer = TAG_REF.exec(ref)
    if (!treffer) continue
    const v: [number, number, number] = [Number(treffer[1]), Number(treffer[2]), Number(treffer[3])]
    if (!beste || v[0] > beste[0] || (v[0] === beste[0] && (v[1] > beste[1] || (v[1] === beste[1] && v[2] > beste[2])))) {
      beste = v
    }
  }
  return beste ? beste.join('.') : null
}
