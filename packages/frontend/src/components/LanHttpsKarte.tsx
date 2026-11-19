import { QRCodeSVG } from 'qrcode.react'
import { LAN_HTTPS_PORTS } from '../lib/geraeteAdressen'
import { einrichtungsAdresse, type LanHttpsInfo } from '../lib/lanHttps'

/**
 * Einstellungen → Geräte: Stand von „HTTPS im LAN" und der Weg, ein Handy/Tablet
 * einzurichten (QR → Einrichtungsseite der Box → Zertifikat installieren).
 */
export function LanHttpsKarte({ info, geprueft, host, nurHttp, setNurHttp }: {
  info:       LanHttpsInfo | null | undefined
  geprueft:   boolean
  /** Server-Adresse aus dem Feld darüber (für den Abgleich mit der Zertifikats-IP) */
  host:       string
  nurHttp:    boolean
  setNurHttp: (v: boolean) => void
}) {
  if (!geprueft) return null

  if (!info) {
    return (
      <div className="rounded-lg border border-line bg-panel-2 p-4 text-sm text-ink-muted space-y-1">
        <p className="font-semibold text-ink">Gesicherte Verbindung (HTTPS im LAN): aus</p>
        <p>
          Ohne HTTPS erlauben Handys und Tablets kein Mikrofon (Sprachbestellung), keine Kamera
          (Einlass-Scanner) und keinen Offline-Puffer. Eingeschaltet wird HTTPS am Kassen-PC
          (Betriebsanleitung, Abschnitt „HTTPS im LAN"); danach erscheint hier die Einrichtung
          für die Geräte.
        </p>
      </div>
    )
  }

  const seite = einrichtungsAdresse(info.ip)
  const hostWeichtAb = host !== info.ip && host !== 'localhost' && host !== '127.0.0.1' && host !== ''

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-ink">Gesicherte Verbindung (HTTPS im LAN)</p>
        <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">aktiv</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="shrink-0 text-center space-y-1">
          <QRCodeSVG value={seite} size={120} level="M" className="mx-auto rounded bg-white p-1" />
          <p className="font-mono text-xs text-ink">{seite}</p>
        </div>
        <div className="text-sm text-ink-muted space-y-2">
          <p>
            <b className="text-ink">Jedes Handy und Tablet einmal einrichten:</b> QR-Code scannen,
            „Zertifikat laden" und installieren — die Seite führt durch die Schritte (Android
            und iPhone). Danach gelten die QR-Codes unten mit https-Adresse; erst damit gehen
            Mikrofon, Kamera und Offline-Betrieb.
          </p>
          <p className="text-xs">
            Das Zertifikat stammt von diesem Kassen-PC und gilt nur für <b className="text-ink">{info.ip}</b>.
            Weitere gesicherte Adressen: Kasse <span className="font-mono">https://{info.ip}:{LAN_HTTPS_PORTS.kasse}</span>,
            Einlass <span className="font-mono">https://{info.ip}:{LAN_HTTPS_PORTS.einlass}</span> (unter Tickets → Adressen eintragen).
            {' '}<a className="text-brand-700 underline" href={`${seite}kassa-ca.crt`}>Zertifikat herunterladen</a> (Windows-Tablets, PCs).
          </p>
          {hostWeichtAb && (
            <p className="text-xs text-amber-700">
              Oben ist {host} eingetragen, das Zertifikat gilt aber für {info.ip}. Die gesicherten
              QR-Codes verwenden {info.ip}.
            </p>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={nurHttp} onChange={e => setNurHttp(e.target.checked)} />
            QR-Codes mit http-Adressen zeigen (für Geräte ohne Einrichtung)
          </label>
        </div>
      </div>
    </div>
  )
}
