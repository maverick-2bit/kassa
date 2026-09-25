#!/bin/sh
# =============================================================================
# Verhaltenstest der Client-IP-Kette — Grundlage des Rate-Limits je Client.
#
# Die ECHTEN App-nginx-Configs (packages/*/nginx.conf) und die ECHTE Caddyfile
# (ops/caddy/Caddyfile) laufen mit echtem nginx/Caddy in einem eigenen
# Docker-Netz vor einem Echo-Backend; client.js prüft je App und Eingang, welche
# Client-IP beim Backend ankommt (direkt :80, Caddy :8090, Tunnel :8091) und
# dass gefälschte X-Real-IP / X-Forwarded-For / CF-Connecting-IP nichts bewirken.
# Nebenbei: Cache-Header für index.html und sw.js (Service-Worker-Updates) sowie
# gehashte Schriften — dafür liefern die nginx einen Mini-Webroot (webroot/) statt
# ihrer Standardseite.
#
# Aufruf (Repo-Wurzel, Docker nötig):   sh ops/nginx/client-ip-test/test.sh
# Läuft in CI als Job „nginx-client-ip". Räumt Container und Netz immer ab.
# =============================================================================
set -eu
cd "$(dirname "$0")/../../.."
WURZEL=$(pwd)
NETZ="kassa-ipt-$$"
APPS="frontend kellner kds gast terminal kundendisplay abholmonitor tickets einlass"
NODE_IMG=node:22-alpine
NGINX_IMG=nginx:1.27-alpine    # wie in packages/<app>/Dockerfile
CADDY_IMG=caddy:2.8-alpine     # wie in docker-compose.yml (Profil „proxy")

aufraeumen() {
  docker ps -aq --filter "label=kassa-ipt=$NETZ" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NETZ" >/dev/null 2>&1 || true
}
trap aufraeumen EXIT

docker network create "$NETZ" >/dev/null

# Echo-Backend unter dem Namen, den alle nginx-Configs ansprechen (backend:3000)
docker run -d --label "kassa-ipt=$NETZ" --name "$NETZ-backend" --network "$NETZ" --network-alias backend \
  -v "$WURZEL/ops/nginx/client-ip-test/echo.js:/echo.js:ro" "$NODE_IMG" node /echo.js >/dev/null

for app in $APPS; do
  docker run -d --label "kassa-ipt=$NETZ" --name "$NETZ-$app" --network "$NETZ" --network-alias "$app" \
    -v "$WURZEL/packages/$app/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$WURZEL/ops/nginx/client-ip-test/webroot:/usr/share/nginx/html:ro" "$NGINX_IMG" >/dev/null
done

# Echte Caddyfile; *.localhost bekommt Zertifikate von Caddys interner CA
docker run -d --label "kassa-ipt=$NETZ" --name "$NETZ-caddy" --network "$NETZ" --network-alias caddy \
  -e KASSA_DOMAIN=ipt.localhost -e ACME_EMAIL=test@example.com \
  -v "$WURZEL/ops/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMG" >/dev/null

sleep 3
fehler=0
for c in backend $APPS caddy; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NETZ-$c")" != "true" ]; then
    echo "FEHLER: $c läuft nicht:"
    docker logs --tail 20 "$NETZ-$c" 2>&1
    fehler=1
  fi
done
[ "$fehler" = 0 ] || exit 1

echo "$(docker exec "$NETZ-kellner" nginx -v 2>&1) / Caddy $(docker exec "$NETZ-caddy" caddy version)"
docker run --rm --network "$NETZ" -v "$WURZEL/ops/nginx/client-ip-test/client.js:/client.js:ro" \
  "$NODE_IMG" node /client.js
