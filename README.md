# Vetroscope Home Sync

Self-hosted sync server for [Vetroscope](https://vetroscope.com), the
privacy-first, cross platform screen time tracking app. Deploy it on your own
hardware such as a NAS, VPS, a Raspberry Pi, or any always-on
workstation you trust. Point your Vetroscope clients at it's IP in Vetroscope's sync settings.
Works for licensed Vetroscope users, and Vetroscope Pro subscribers. Can be used in conjunction with Vetroscope Cloud sync.

- **Open source.** Apache 2.0.
- **End-to-end encrypted.** Sensitive fields (app names, window
  titles, project names) are encrypted client-side before upload.
  Even a compromised server can't read them.
- **No telemetry.** Totally isolated from api.vetroscope.com

## Quick start

```bash
curl -LO https://raw.githubusercontent.com/rankin-works/vetroscope-home-sync/main/docker-compose.yml
docker compose up -d
docker compose logs vetroscope-home-sync   # grab the one-time setup code
```

Then open the Vetroscope client on your desktop, go to Settings →
Sync, switch to **Home Sync**, paste your server URL, and follow the
onboarding wizard.

## Quick start (from source, today)

Requires Node.js 20.11+ and a C toolchain for `better-sqlite3`.

```bash
git clone https://github.com/rankin-works/vetroscope-home-sync.git
cd vetroscope-home-sync
npm install
npm run dev
# → GET http://localhost:4437/health
# → GET http://localhost:4437/server-info
```

First boot prints a one-time setup code; consume it via `/setup`
(arriving in Phase 2) to create your admin user.

## Configuration

All configuration is env-var driven. Full table is in
[`docs/architecture.md`](docs/architecture.md#docker-distribution);
the essentials:

| Var                       | Default     | Description                                             |
| ------------------------- | ----------- | ------------------------------------------------------- |
| `VS_DATA_DIR`             | `/data`     | Where `sync.db` and backups live                        |
| `VS_PORT`                 | `4437`      | HTTP(S) listen port                                     |
| `VS_SERVER_NAME`          | `hostname`  | Friendly name shown in the Vetroscope client            |
| `VS_ALLOW_REGISTRATION`   | `invite`    | `open` \| `invite` \| `closed`                          |
| `VS_MAX_DEVICES_PER_USER` | `10`        | Per-user device cap                                     |
| `VS_TLS_CERT`             | unset       | Path to PEM cert; pair with `VS_TLS_KEY` to enable HTTPS
| `VS_TLS_KEY`              | unset       | Path to PEM key                                         |

## Documentation

- [`docs/setup-guide.md`](docs/setup-guide.md) — step-by-step first
  deployment walkthrough.
- [`docs/reverse-proxy.md`](docs/reverse-proxy.md) — Caddy,
  Traefik, nginx, and Cloudflare Tunnel configs.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — common
  issues and how to triage them.
- [`docs/architecture.md`](docs/architecture.md) — design, data
  schema, API surface, security model, phased plan.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, style, PR process.
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities.

## Admin CLI

The container ships with `vhs-cli` for operations that need host
access rather than an API call:

```bash
docker exec vetroscope-home-sync vhs-cli help
docker exec vetroscope-home-sync vhs-cli reset-password --email you@home.lan --password 'new-pw'
docker exec vetroscope-home-sync vhs-cli list-users
docker exec vetroscope-home-sync vhs-cli rotate-jwt-secret --confirm
```

## License

Apache 2.0 — see [`LICENSE`](LICENSE). Third-party attributions in
[`NOTICE`](NOTICE).

Vetroscope itself (the desktop client, the Cloud Sync service) is a
separate product; this repository ships only the self-hosted sync
backend.
