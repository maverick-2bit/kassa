/**
 * Minimale SOAP-Hilfen für die FinanzOnline-WebServices (fetch, kein node-soap).
 */

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Gegenstück zu `xmlEscape` für Antworttexte (z. B. `msg`): die fünf Standard-Entitäten und
 * numerische Zeichenverweise. In EINEM Durchgang — `&amp;lt;` wird zu `&lt;`, nicht zu `<`.
 */
export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (treffer: string, name: string) => {
    switch (name) {
      case 'lt':   return '<'
      case 'gt':   return '>'
      case 'amp':  return '&'
      case 'quot': return '"'
      case 'apos': return "'"
    }
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : treffer
  })
}

/** Erstes Vorkommen eines (ggf. präfixierten) Elements — Textinhalt, getrimmt. */
export function extractValue(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:[^:>\\s]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>\\s]+:)?${tag}>`)
  return regex.exec(xml)?.[1]?.trim()
}

/** Alle Vorkommen eines Elements (z. B. mehrere `result`/`rkdbMessage`). */
export function extractAll(xml: string, tag: string): string[] {
  const regex = new RegExp(`<(?:[^:>\\s]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>\\s]+:)?${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

export function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>${body}</soap:Body>` +
    `</soap:Envelope>`
}

export class FonSoapError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
  }
}

export async function soapRequest(
  endpoint: string,
  soapAction: string,
  body: string,
  timeoutMs = 20_000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction':   `"${soapAction}"`,
      },
      body:   soapEnvelope(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      // SOAP-Fault-Text herausziehen, falls vorhanden
      const fault = extractValue(text, 'faultstring') ?? text.slice(0, 300)
      throw new FonSoapError(`FinanzOnline ${soapAction} → HTTP ${res.status}: ${fault}`, res.status)
    }
    return text
  } catch (err) {
    if (err instanceof FonSoapError) throw err
    const grund = err instanceof Error && err.name === 'AbortError'
      ? `Timeout nach ${timeoutMs} ms`
      : err instanceof Error ? err.message : String(err)
    throw new FonSoapError(`FinanzOnline ${soapAction} nicht erreichbar: ${grund}`)
  } finally {
    clearTimeout(timer)
  }
}
