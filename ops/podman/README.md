# Podman + systemd (Quadlet) — Proof of Concept

Äquivalent zum `docker-compose.yml`, aber als **Quadlet**-Units (Podman erzeugt
daraus systemd-Services). Vorteile gegenüber Docker für eine unbeaufsichtigte
Kassen-Box: **daemonlos**, optional **rootless**, native **systemd-Supervision**
(sauberer Autostart nach Stromausfall, `systemctl`/`journalctl`).

Gleiche Images (aus GHCR), gleiche Container-Namen wie die Compose-Services →
nginx-Upstream (`backend:3000`) und `DATABASE_URL` (Host `postgres`) funktionieren
unverändert.

## Voraussetzungen
- Linux-Box mit **Podman ≥ 4.4** (Quadlet) und systemd.
- Zugriff auf die GHCR-Images (`podman login ghcr.io`, falls privat).

## Installation (system-/rootful — einfachste Variante, Port 80 ohne Tricks)

```bash
# 1. Unit-Dateien nach /etc/containers/systemd/ kopieren
sudo cp ops/podman/*.network ops/podman/*.volume ops/podman/*.container \
        /etc/containers/systemd/

# 2. Backup-Skripte + Secrets nach /etc/kassa/
sudo mkdir -p /etc/kassa
sudo cp ops/backup/restic-backup.sh ops/backup/restic-healthcheck.sh /etc/kassa/
sudo install -m 600 ops/podman/kassa.env.example /etc/kassa/kassa.env
sudo $EDITOR /etc/kassa/kassa.env          # Secrets eintragen (POSTGRES_PASSWORD == in DATABASE_URL!)

# 3. (falls Images privat) an GHCR anmelden
sudo podman login ghcr.io

# 4. Quadlet-Generator laufen lassen + Stack starten
sudo systemctl daemon-reload
sudo systemctl start frontend.service      # zieht backend + postgres als Requires nach
# optional alle Frontends/Backup mitstarten:
sudo systemctl start kds.service kundendisplay.service gast.service kellner.service backup.service
```

## Prüfen
```bash
systemctl status backend.service           # Service-Status
sudo podman ps                             # laufende Container
sudo podman healthcheck run backend        # Health on demand
curl -s localhost/ | head                  # Frontend
curl -s "localhost:3000/api/health"        # (Backend-Port nicht published → ggf. via podman exec)
```

Autostart beim Boot ist durch `[Install] WantedBy=multi-user.target` aktiv,
sobald `daemon-reload` gelaufen ist (Quadlet enabled die generierten Services).

## Wichtige Hinweise
- **Image-Pinning:** Die Units zeigen auf `:latest`. In Produktion auf ein
  konkretes `:<sha>` pinnen → reproduzierbar + Rollback. **Kein** `AutoUpdate`
  (eine Fiskalkasse nie automatisch aktualisieren).
- **Rootless-Variante:** Units nach `~/.config/containers/systemd/` legen und mit
  `systemctl --user` betreiben (`loginctl enable-linger <user>` für Boot-Start).
  Dann bindet Port 80 nicht ohne Weiteres — entweder hohen Port + Reverse-Proxy
  oder `net.ipv4.ip_unprivileged_port_start=80` setzen.
- **SELinux:** Bei aktivem SELinux die Bind-Mounts der Skripte ggf. mit `:ro,Z`
  versehen (in `backup.container`).
- **Secret-Härtung:** Für strengere Isolation `kassa.env` aufteilen — eine
  `db.env` nur mit `POSTGRES_PASSWORD` für den Postgres-Container, damit dieser
  keine restic-/JWT-Secrets im Environment sieht.
- **Healthy-Gate:** systemd ordnet nur nach „Service gestartet", nicht „healthy".
  `Restart=always` überbrückt das Rennen Backend↔Postgres beim Boot.

## Dateien
| Datei | Zweck |
|-------|-------|
| `kassa.network` | gemeinsames Podman-Netz (DNS per ContainerName) |
| `kassa-*.volume` | benannte Volumes (pgdata, db-/dep-backups, restic-cache, backup-status) |
| `postgres.container` | PostgreSQL |
| `backend.container` | Fastify-Backend |
| `frontend/kds/kundendisplay/gast/kellner.container` | nginx-Frontends |
| `backup.container` | restic Off-Site-Backup |
| `kassa.env.example` | Secrets/Config-Vorlage → `/etc/kassa/kassa.env` |
