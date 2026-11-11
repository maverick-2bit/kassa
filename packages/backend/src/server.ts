import Fastify, { LogController, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { SetupServiceDeps } from './services/setup.service.js'
import type { BelegServiceDeps } from './services/beleg.service.js'
import type { StatfsFn } from './services/monitoring.service.js'
import { fehlerHandler } from './fehler-handler.js'
import { registerAuth } from './auth/plugin.js'
import { zugriffFuerRoute } from './auth/route-rechte.js'
import { waechterVon } from './auth/waechter.js'
import { rateLimitSchluessel } from './auth/rate-limit.js'
import { setupRoute } from './routes/setup.route.js'
import { healthRoute } from './routes/health.route.js'
import { systemRoute } from './routes/system.route.js'
import { authRoute } from './routes/auth.route.js'
import { artikelRoute } from './routes/artikel.route.js'
import { belegRoute } from './routes/beleg.route.js'
import { druckerRoute } from './routes/drucker.route.js'
import { bonierRoute } from './routes/bonier.route.js'
import { bonProblemeRoute } from './routes/bon-probleme.route.js'
import { tischTabRoute } from './routes/tisch-tab.route.js'
import { userRoute } from './routes/user.route.js'
import { zvtRoute } from './routes/zvt.route.js'
import { berichtRoute } from './routes/bericht.route.js'
import { kategorieRoute } from './routes/kategorie.route.js'
import { tischplanRoute } from './routes/tischplan.route.js'
import { modifikatorRoute } from './routes/modifikator.route.js'
import { preisregelRoute } from './routes/preisregel.route.js'
import { seriennummerRoute } from './routes/seriennummer.route.js'
import { lagerstandRoute } from './routes/lagerstand.route.js'
import { inventurRoute } from './routes/inventur.route.js'
import { sseRoute } from './routes/sse.route.js'
import { bonierdruckerRoute } from './routes/bonierdrucker.route.js'
import { druckerPoolRoute } from './routes/drucker-pool.route.js'
import { posConfigRoute } from './routes/pos-config.route.js'
import { einrichtungRoute } from './routes/einrichtung.route.js'
import { kasseArtikelLayoutRoute } from './routes/kasse-artikel-layout.route.js'
import { kundeRoute } from './routes/kunde.route.js'
import { angebotRoute } from './routes/angebot.route.js'
import { lieferscheinRoute } from './routes/lieferschein.route.js'
import { wartungsvertragRoute } from './routes/wartungsvertrag.route.js'
import { offenerPostenRoute } from './routes/offenerPosten.route.js'
import { gutscheinRoute } from './routes/gutschein.route.js'
import { lieferbestellungRoute } from './routes/lieferbestellung.route.js'
import { mandantRoute }          from './routes/mandant.route.js'
import { kasseRoute }            from './routes/kasse.route.js'
import { auditRoute }           from './routes/audit.route.js'
import { kassenbuchRoute }      from './routes/kassenbuch.route.js'
import { depSicherungRoute }    from './routes/dep-sicherung.route.js'
import { dbBackupRoute }        from './routes/db-backup.route.js'
import { mandantTransferRoute } from './routes/mandant-transfer.route.js'
import { finanzpruefungRoute }  from './routes/finanzpruefung.route.js'
import { rksvSelbsttestRoute }  from './routes/rksv-selbsttest.route.js'
import { lieferantRoute }       from './routes/lieferant.route.js'
import { einkaufBestellungRoute } from './routes/einkauf-bestellung.route.js'
import { preislisteRoute }      from './routes/preisliste.route.js'
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
import { oeffentlicherBelegRoute } from './routes/oeffentlicher-beleg.route.js'
import { dienstplanRoute }       from './routes/dienstplan.route.js'
import { selfcheckoutRoute }     from './routes/selfcheckout.route.js'
import { registerTerminalRoutes } from './routes/terminal.route.js'
import { registerStripeWebhook }  from './routes/stripe-webhook.route.js'
import { sbBestellungRoute }     from './routes/sb-bestellung.route.js'
import { ticketingRoute } from './routes/ticketing.route.js'
import { spracheRoute } from './routes/sprache.route.js'
import { ticketshopRoute } from './routes/ticketshop.route.js'
import { ticketverkaufRoute } from './routes/ticketverkauf.route.js'
import type { ShopStripe } from './services/ticketshop.service.js'
import { einlassRoute } from './routes/einlass.route.js'

export interface ServerDeps {
  config:          Config
  db:              Db
  setupDeps:       SetupServiceDeps
  belegDeps:       BelegServiceDeps
  backupDir:       string
  dbBackupDir:     string
  dbBackupRetention: number
  /** Nur für Tests: Plattenplatz-Messung ersetzen (hermetisch statt echte Platte). */
  statfsFn?:       StatfsFn
  /** Nur für Tests: Stripe-Zugriffe des Ticketshops ersetzen (kein Netz). */
  ticketshopStripe?: ShopStripe
  /** Nur für Tests: globales Rate-Limit (Anfragen/Minute je Client) statt des Standards. */
  rateLimitMax?:   number
  /**
   * Nur für Tests: Limit der Einrichtungs-Route (Anfragen/Minute je Client). Im Betrieb gilt immer das
   * enge Limit (5); in Tests (NODE_ENV=test) praktisch keines, damit Suiten, die mehrere Mandanten anlegen,
   * nicht ins Limit laufen — der Limit-Test setzt hier bewusst einen kleinen Wert.
   */
  setupRateLimitMax?: number
  /** Nur für Tests: Log-Zeilen abfangen statt nach stdout zu schreiben. */
  logStream?:      { write: (zeile: string) => void }
  /**
   * Nur für Tests: sammelt jede registrierte Route samt ihren onRequest-Hooks (Wächter siehe auth/waechter.ts).
   * Grundlage von tests/route-schutz.test.ts — dort muss jede Route öffentlich oder geschützt sein.
   */
  routenRegister?: RoutenEintrag[]
}

/** Eine beim Aufbau des Servers registrierte Route (siehe ServerDeps.routenRegister). */
export interface RoutenEintrag {
  method:    string | string[]
  url:       string
  onRequest: unknown
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      ...(deps.logStream && { stream: deps.logStream }),
    },
    // Request-Logzeilen ("incoming request" / "request completed") nur außerhalb
    // der Tests. Über den LogController statt der Top-Level-Option
    // disableRequestLogging: die ist seit Fastify 5.12 deprecated (FSTDEP023, die
    // Warnung kam bei jedem Start und jedem Testlauf) und fällt in Fastify 6 weg.
    // Die Top-Level-Option darf nicht mehr gesetzt werden, auch nicht als false.
    logController: new LogController({
      disableRequestLogging: deps.config.NODE_ENV === 'test',
    }),
    // Werbefolien-Uploads (Base64-Bilder) brauchen mehr als das 1-MiB-Default
    bodyLimit: 4 * 1024 * 1024,
  })

  // Globaler Fehler-Handler — MUSS vor allen Plugins/Routen stehen: Fastify
  // vererbt ihn nur an Plugin-Kontexte, die danach entstehen. Am Ende von
  // buildServer galt er für keine einzige Route, und der Fastify-Standard
  // schickte interne Meldungen (SQL, Parameter) an den Client.
  fastify.setErrorHandler(fehlerHandler)

  // Rechte je Route (auth/route-rechte.ts): Der Hook hängt jeder Route, die nur „angemeldet" verlangt, das Recht an, das die
  // Tabelle für sie vorsieht. Er steht VOR allen Plugins/Routen, sonst sieht er sie nicht (onRoute gilt nur für später
  // registrierte Routen und Plugin-Kontexte). Die Decorators (requireBerechtigung …) gibt es erst nach registerAuth —
  // der Hook läuft pro Route, also nach deren Registrierung.
  fastify.addHook('onRoute', (route) => {
    const methoden = Array.isArray(route.method) ? route.method : [route.method]
    const waechter = waechterVon(route.onRequest)
    // Nur Routen mit blankem authenticate: eigene Wächter (Rolle, Recht, Betreiber, Gerät) und öffentliche Routen bleiben.
    if (waechter.length === 0 || waechter.some(w => w.art !== 'angemeldet')) return

    const zugriffe = methoden.map(m => zugriffFuerRoute(m, route.url))
    const zugriff = zugriffe[0]
    if (!zugriff || zugriffe.some(z => JSON.stringify(z) !== JSON.stringify(zugriff))) {
      // Nicht in der Tabelle (neue Route?) oder je Methode verschieden: nichts anhängen — tests/route-schutz.test.ts schlägt an.
      return
    }
    if (zugriff.art === 'jeder') return

    const vorhanden = Array.isArray(route.onRequest) ? route.onRequest : (route.onRequest ? [route.onRequest] : [])
    const guard = zugriff.art === 'admin'
      ? fastify.requireRolle('admin')
      : fastify.requireBerechtigung(...zugriff.berechtigungen)
    route.onRequest = [...vorhanden, guard]
  })

  // Nur für Tests: jede Route (auch in Plugins, die danach entstehen) mit ihren onRequest-Hooks festhalten — NACH dem
  // Rechte-Hook oben, damit die Liste den endgültigen Schutz zeigt.
  const routenRegister = deps.routenRegister
  if (routenRegister) {
    fastify.addHook('onRoute', (route) => {
      routenRegister.push({ method: route.method, url: route.url, onRequest: route.onRequest })
    })
  }

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

  // Rate-Limiting je Client — angemeldet je Anmeldung, sonst je Client-IP
  // (Schlüssel siehe auth/rate-limit.ts). In Tests praktisch aus.
  // Wer ins Limit läuft, steht einmal je Minute und Schlüssel im Log: so lässt
  // sich nach einem Event nachvollziehen, WER gebremst wurde, ohne dass eine
  // Anfrageflut das Log flutet.
  const letzteLimitMeldung = new Map<string, number>()
  await fastify.register(rateLimit, {
    global:       true,
    max:          deps.rateLimitMax ?? (deps.config.NODE_ENV === 'test' ? 10_000 : 300),
    timeWindow:   '1 minute',
    keyGenerator: rateLimitSchluessel,
    onExceeded:   (request, key) => {
      const jetzt = Date.now()
      if ((letzteLimitMeldung.get(key) ?? 0) > jetzt - 60_000) return
      if (letzteLimitMeldung.size >= 1000) letzteLimitMeldung.clear()
      letzteLimitMeldung.set(key, jetzt)
      request.log.warn({ schluessel: key, url: request.url }, 'Rate-Limit überschritten')
    },
    // statusCode ist Pflicht: ohne ihn antwortete Fastify mit 500 statt 429
    // (der Builder-Rückgabewert wird als Fehler geworfen)
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      fehler: `Zu viele Anfragen. Bitte in ${Math.ceil(context.ttl / 1000)} Sekunden erneut versuchen.`,
    }),
  })

  // Auth-Plugin registrieren (stellt fastify.jwt + fastify.authenticate bereit)
  await registerAuth(fastify, deps.config)

  // SSE ausserhalb des /api-Prefix registrieren (eigener Prefix /sse)
  await fastify.register(sseRoute)

  // Display-Routen: POST /api/display + GET /sse/display
  await registerDisplayRoutes(fastify, { db: deps.db })

  // SB-Terminal (öffentlich): /api/terminal/* + GET /sse/abholung
  await registerTerminalRoutes(fastify, { deps: { db: deps.db, belegDeps: deps.belegDeps } })

  // Stripe-Webhook (öffentlich, eigener Raw-Body-Parser) — außerhalb des /api-JSON-Bereichs
  await registerStripeWebhook(fastify, { deps: {
    db: deps.db, belegDeps: deps.belegDeps, config: deps.config,
    ...(deps.ticketshopStripe ? { ticketshopStripe: deps.ticketshopStripe } : {}),
  } })

  await fastify.register(async (api) => {
    // Offene Routen (kein Login nötig)
    await api.register(healthRoute,  { db:   deps.db })
    await api.register(systemRoute,  { db:   deps.db, config: deps.config })
    await api.register(authRoute,    { db:   deps.db, loginRateLimitMax: deps.config.LOGIN_RATE_LIMIT_MAX })
    await api.register(setupRoute,   {
      deps:         deps.setupDeps,
      setupToken:   deps.config.SETUP_TOKEN,
      rateLimitMax: deps.setupRateLimitMax ?? (deps.config.NODE_ENV === 'test' ? 10_000 : 5),
    })

    // Geschützte Routen — alle Handler verlangen JWT via onRequest-Hook in den Routes
    await api.register(artikelRoute, { db:   deps.db })
    await api.register(belegRoute,   { deps: deps.belegDeps, config: deps.config })
    await api.register(druckerRoute, { db:   deps.db })
    await api.register(bonierRoute,  { deps: { db: deps.db } })
    await api.register(bonProblemeRoute, { db: deps.db })
    await api.register(tischTabRoute, { deps: { db: deps.db, belegDeps: deps.belegDeps } })
    await api.register(userRoute,     { db:   deps.db })
    await api.register(zvtRoute,      { deps: { db: deps.db } })
    await api.register(berichtRoute,  { deps: { db: deps.db } })
    await api.register(kategorieRoute,   { db:   deps.db })
    await api.register(tischplanRoute,   { deps: { db: deps.db } })
    await api.register(modifikatorRoute, { db:   deps.db })
    await api.register(preisregelRoute,  { db:   deps.db })
    await api.register(seriennummerRoute, { db:  deps.db })
    await api.register(lagerstandRoute,     { db:   deps.db, config: deps.config })
    await api.register(inventurRoute,       { db:   deps.db, config: deps.config })
    await api.register(bonierdruckerRoute,  { db:   deps.db })
    await api.register(druckerPoolRoute,    { db:   deps.db })
    await api.register(posConfigRoute,      { db:   deps.db })
    await api.register(einrichtungRoute,    { db:   deps.db })
    await api.register(kasseArtikelLayoutRoute, { db: deps.db })
    await api.register(kundeRoute,          { db:   deps.db })
    await api.register(angebotRoute,        { db:   deps.db })
    await api.register(lieferscheinRoute,    { db: deps.db, config: deps.config })
    await api.register(wartungsvertragRoute, { db: deps.db, config: deps.config })
    await api.register(offenerPostenRoute,   { db:   deps.db })
    await api.register(gutscheinRoute,          { db: deps.db })
    await api.register(lieferbestellungRoute,   { db: deps.db })
    await api.register(mandantRoute,            { db: deps.db, config: deps.config })
    await api.register(kasseRoute,              { db: deps.db, setupDeps: deps.setupDeps, belegDeps: deps.belegDeps, config: deps.config })
    await api.register(auditRoute,              { db: deps.db })
    await api.register(kassenbuchRoute,         { db: deps.db })
    await api.register(depSicherungRoute,       { db: deps.db, backupDir: deps.backupDir })
    await api.register(dbBackupRoute,           { db: deps.db, databaseUrl: deps.config.DATABASE_URL, backupDir: deps.dbBackupDir, retention: deps.dbBackupRetention })
    await api.register(mandantTransferRoute,    { db: deps.db, databaseUrl: deps.config.DATABASE_URL, masterPassphrase: deps.belegDeps.masterPassphrase })
    await api.register(finanzpruefungRoute,     { db: deps.db })
    await api.register(rksvSelbsttestRoute,     { db: deps.db })
    await api.register(lieferantRoute,          { db: deps.db })
    await api.register(einkaufBestellungRoute,  { db: deps.db, config: deps.config })
    await api.register(preislisteRoute,         { db: deps.db })
    await api.register(kdsRoute,                { db: deps.db })
    await api.register(gastRoute,               { db: deps.db, belegDeps: deps.belegDeps, config: deps.config })
    await api.register(emailRoute,              { db: deps.db, config: deps.config })
    await api.register(reservierungRoute,       { db: deps.db, config: deps.config })
    await api.register(buchungRoute,            { db: deps.db, config: deps.config })
    await api.register(zeiterfassungRoute,      { db: deps.db })
    await api.register(exportRoute,             { db: deps.db })
    await api.register(werbefolienRoute,        { db: deps.db })
    await api.register(oeffentlicherBelegRoute, { db: deps.db })
    await api.register(dienstplanRoute,         { db: deps.db })
    await api.register(selfcheckoutRoute,       { db: deps.db })
    await api.register(sbBestellungRoute,       { db: deps.db })
    await api.register(ticketingRoute,          { db: deps.db, config: deps.config, belegDeps: deps.belegDeps })
    await api.register(spracheRoute,            { db: deps.db })
    await api.register(ticketshopRoute,         { db: deps.db })
    await api.register(ticketverkaufRoute,      {
      db: deps.db, config: deps.config, belegDeps: deps.belegDeps,
      ...(deps.ticketshopStripe ? { stripe: deps.ticketshopStripe } : {}),
    })
    await api.register(einlassRoute,            { db: deps.db })
  }, { prefix: '/api' })

  await fastify.register(monitoringRoute, {
    db: deps.db,
    monitoringToken:     deps.config.MONITORING_TOKEN,
    dbBackupMaxStunden:  deps.config.DB_BACKUP_MAX_AGE_STUNDEN,
    depBackupMaxStunden: deps.config.DEP_BACKUP_MAX_AGE_STUNDEN,
    dbBackupDir:         deps.dbBackupDir,
    statfsFn:            deps.statfsFn,
  })

  return fastify
}
