import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { SetupServiceDeps } from './services/setup.service.js'
import type { BelegServiceDeps } from './services/beleg.service.js'
import { registerAuth } from './auth/plugin.js'
import { setupRoute } from './routes/setup.route.js'
import { healthRoute } from './routes/health.route.js'
import { authRoute } from './routes/auth.route.js'
import { artikelRoute } from './routes/artikel.route.js'
import { belegRoute } from './routes/beleg.route.js'
import { druckerRoute } from './routes/drucker.route.js'
import { bonierRoute } from './routes/bonier.route.js'
import { tischTabRoute } from './routes/tisch-tab.route.js'
import { userRoute } from './routes/user.route.js'
import { zvtRoute } from './routes/zvt.route.js'
import { berichtRoute } from './routes/bericht.route.js'
import { kategorieRoute } from './routes/kategorie.route.js'
import { tischplanRoute } from './routes/tischplan.route.js'
import { modifikatorRoute } from './routes/modifikator.route.js'
import { lagerstandRoute } from './routes/lagerstand.route.js'
import { sseRoute } from './routes/sse.route.js'
import { bonierdruckerRoute } from './routes/bonierdrucker.route.js'
import { posConfigRoute } from './routes/pos-config.route.js'
import { kundeRoute } from './routes/kunde.route.js'
import { angebotRoute } from './routes/angebot.route.js'
import { lieferscheinRoute } from './routes/lieferschein.route.js'
import { offenerPostenRoute } from './routes/offenerPosten.route.js'
import { gutscheinRoute } from './routes/gutschein.route.js'
import { lieferbestellungRoute } from './routes/lieferbestellung.route.js'
import { mandantRoute }          from './routes/mandant.route.js'
import { kasseRoute }            from './routes/kasse.route.js'
import { auditRoute }           from './routes/audit.route.js'
import { kassenbuchRoute }      from './routes/kassenbuch.route.js'
import { depSicherungRoute }    from './routes/dep-sicherung.route.js'
import { dbBackupRoute }        from './routes/db-backup.route.js'
import { finanzpruefungRoute }  from './routes/finanzpruefung.route.js'
import { lieferantRoute }       from './routes/lieferant.route.js'
import { kdsRoute }            from './routes/kds.route.js'
import { gastRoute }           from './routes/gast.route.js'
import { registerDisplayRoutes } from './routes/display.route.js'
import { emailRoute }            from './routes/email.route.js'
import { monitoringRoute }       from './routes/monitoring.route.js'
import { reservierungRoute }     from './routes/reservierung.route.js'
import { buchungRoute }          from './routes/buchung.route.js'
import { zeiterfassungRoute }    from './routes/zeiterfassung.route.js'
import { exportRoute }           from './routes/export.route.js'
import { werbefolienRoute }      from './routes/werbefolien.route.js'
import { dienstplanRoute }       from './routes/dienstplan.route.js'
import { selfcheckoutRoute }     from './routes/selfcheckout.route.js'

export interface ServerDeps {
  config:          Config
  db:              Db
  setupDeps:       SetupServiceDeps
  belegDeps:       BelegServiceDeps
  backupDir:       string
  dbBackupDir:     string
  dbBackupRetention: number
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
    },
    disableRequestLogging: deps.config.NODE_ENV === 'test',
  })

  await fastify.register(cors, {
    origin: deps.config.CORS_ORIGIN.split(',').map(s => s.trim()),
    credentials: true,
  })

  // HTTP Security Headers (Helmet)
  await fastify.register(helmet, {
    // CSP: erlaubt nur eigene Ressourcen + inline-Scripts (Vite-Inlines in Prod)
    contentSecurityPolicy: deps.config.NODE_ENV === 'production' ? {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'", "'unsafe-inline'"],
        imgSrc:         ["'self'", 'data:'],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'"],
        objectSrc:      ["'none'"],
        frameSrc:       ["'none'"],
        upgradeInsecureRequests: [],
      },
    } : false,
    // HSTS: Browser merkt sich HTTPS-Only für 1 Jahr
    hsts: deps.config.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  })

  // Rate-Limiting — in Tests deaktiviert, in Produktion aktiv
  await fastify.register(rateLimit, {
    global:     true,
    max:        deps.config.NODE_ENV === 'test' ? 10_000 : 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      fehler: `Zu viele Anfragen. Bitte in ${Math.ceil(context.ttl / 1000)} Sekunden erneut versuchen.`,
    }),
  })

  // Auth-Plugin registrieren (stellt fastify.jwt + fastify.authenticate bereit)
  await registerAuth(fastify, deps.config)

  // SSE ausserhalb des /api-Prefix registrieren (eigener Prefix /sse)
  await fastify.register(sseRoute)

  // Display-Routen: POST /api/display + GET /sse/display
  await registerDisplayRoutes(fastify)

  await fastify.register(async (api) => {
    // Offene Routen (kein Login nötig)
    await api.register(healthRoute,  { db:   deps.db })
    await api.register(authRoute,    { db:   deps.db })
    await api.register(setupRoute,   { deps: deps.setupDeps })

    // Geschützte Routen — alle Handler verlangen JWT via onRequest-Hook in den Routes
    await api.register(artikelRoute, { db:   deps.db })
    await api.register(belegRoute,   { deps: deps.belegDeps, config: deps.config })
    await api.register(druckerRoute, { db:   deps.db })
    await api.register(bonierRoute,  { deps: { db: deps.db } })
    await api.register(tischTabRoute, { deps: { db: deps.db, belegDeps: deps.belegDeps } })
    await api.register(userRoute,     { db:   deps.db })
    await api.register(zvtRoute,      { deps: { db: deps.db } })
    await api.register(berichtRoute,  { deps: { db: deps.db } })
    await api.register(kategorieRoute,   { db:   deps.db })
    await api.register(tischplanRoute,   { deps: { db: deps.db } })
    await api.register(modifikatorRoute, { db:   deps.db })
    await api.register(lagerstandRoute,     { db:   deps.db })
    await api.register(bonierdruckerRoute,  { db:   deps.db })
    await api.register(posConfigRoute,      { db:   deps.db })
    await api.register(kundeRoute,          { db:   deps.db })
    await api.register(angebotRoute,        { db:   deps.db })
    await api.register(lieferscheinRoute,    { db:   deps.db })
    await api.register(offenerPostenRoute,   { db:   deps.db })
    await api.register(gutscheinRoute,          { db: deps.db })
    await api.register(lieferbestellungRoute,   { db: deps.db })
    await api.register(mandantRoute,            { db: deps.db })
    await api.register(kasseRoute,              { db: deps.db })
    await api.register(auditRoute,              { db: deps.db })
    await api.register(kassenbuchRoute,         { db: deps.db })
    await api.register(depSicherungRoute,       { db: deps.db, backupDir: deps.backupDir })
    await api.register(dbBackupRoute,           { db: deps.db, databaseUrl: deps.config.DATABASE_URL, backupDir: deps.dbBackupDir, retention: deps.dbBackupRetention })
    await api.register(finanzpruefungRoute,     { db: deps.db })
    await api.register(lieferantRoute,          { db: deps.db })
    await api.register(kdsRoute,                { db: deps.db })
    await api.register(gastRoute,               { db: deps.db })
    await api.register(emailRoute,              { db: deps.db, config: deps.config })
    await api.register(reservierungRoute,       { db: deps.db, config: deps.config })
    await api.register(buchungRoute,            { db: deps.db, config: deps.config })
    await api.register(zeiterfassungRoute,      { db: deps.db })
    await api.register(exportRoute,             { db: deps.db })
    await api.register(werbefolienRoute,        { db: deps.db })
    await api.register(dienstplanRoute,         { db: deps.db })
    await api.register(selfcheckoutRoute,       { db: deps.db })
  }, { prefix: '/api' })

  await fastify.register(monitoringRoute, { db: deps.db })

  // Globaler Fehler-Handler — fängt alle unbehandelten Fehler ab
  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error({ err: error, url: request.url, method: request.method }, 'Unbehandelter Serverfehler')
    if (reply.sent) return
    return reply.status(500).send({ fehler: 'Interner Serverfehler' })
  })

  return fastify
}
