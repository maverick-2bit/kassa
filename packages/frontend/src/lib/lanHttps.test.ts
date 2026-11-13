import { afterEach, describe, expect, it, vi } from 'vitest'
import { einrichtungsAdresse, ladeLanHttpsInfo, lanInfoAdresse, leseLanInfo } from './lanHttps'

const ort = (protocol: string, hostname: string, port = '') => ({ protocol, hostname, port })

describe('lanInfoAdresse', () => {
  it('Kasse über http (auch localhost am Kassen-PC): Einrichtungsseite derselben Box', () => {
    expect(lanInfoAdresse(ort('http:', 'localhost'))).toBe('http://localhost:9079/kassa-lan.json')
    expect(lanInfoAdresse(ort('http:', '192.168.1.50', '80'))).toBe('http://192.168.1.50:9079/kassa-lan.json')
  })

  it('Kasse über https im LAN: derselbe Ursprung (http wäre gemischter Inhalt)', () => {
    expect(lanInfoAdresse(ort('https:', '192.168.1.50', '8443'))).toBe('/kassa-lan.json')
  })

  it('https unter Domainnamen (Proxy-Modus) oder fremdem Port: gar nicht fragen', () => {
    expect(lanInfoAdresse(ort('https:', 'kasse.example.at'))).toBeNull()
    expect(lanInfoAdresse(ort('https:', '192.168.1.50', '4443'))).toBeNull()
    expect(lanInfoAdresse(ort('file:', ''))).toBeNull()
  })
})

describe('leseLanInfo', () => {
  it('nimmt nur eine plausible IPv4', () => {
    expect(leseLanInfo({ ip: '192.168.1.50', ports: {} })).toEqual({ ip: '192.168.1.50' })
    expect(leseLanInfo({ ip: '' })).toBeNull()
    expect(leseLanInfo({ ip: '{$KASSA_LAN_IP}' })).toBeNull()
    expect(leseLanInfo({ ip: 'kassa.lan' })).toBeNull()
    expect(leseLanInfo(null)).toBeNull()
    expect(leseLanInfo('192.168.1.50')).toBeNull()
  })

  it('Einrichtungsseite', () => {
    expect(einrichtungsAdresse('10.0.0.7')).toBe('http://10.0.0.7:9079/')
  })
})

describe('ladeLanHttpsInfo', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('Antwort des Dienstes → Info', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ip: '192.168.1.50' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await ladeLanHttpsInfo(ort('http:', 'localhost'))).toEqual({ ip: '192.168.1.50' })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9079/kassa-lan.json', expect.objectContaining({ cache: 'no-store' }))
  })

  it('Dienst aus (Netzwerkfehler), Fehlerstatus oder kein JSON → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await ladeLanHttpsInfo(ort('http:', 'localhost'))).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nicht da', { status: 404 })))
    expect(await ladeLanHttpsInfo(ort('http:', 'localhost'))).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    expect(await ladeLanHttpsInfo(ort('http:', 'localhost'))).toBeNull()
  })

  it('hängt die Anfrage, gibt die Zeitgrenze null zurück', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('abgebrochen', 'AbortError')))
    })))
    expect(await ladeLanHttpsInfo(ort('http:', 'localhost'), 20)).toBeNull()
  })

  it('Proxy-Modus: keine Anfrage', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await ladeLanHttpsInfo(ort('https:', 'kasse.example.at'))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
