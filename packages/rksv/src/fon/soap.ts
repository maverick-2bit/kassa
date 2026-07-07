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
