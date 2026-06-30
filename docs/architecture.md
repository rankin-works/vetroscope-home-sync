# Home Sync Architecture

A self-hosted alternative to Vetroscope Cloud Sync. Users deploy a small
Docker image on their own hardware.

---

## Why does Home Sync exist?

Time-tracking data regarding screen time and computer activity is highly sensitive. It is understandable for some users to desire ownership of their sensitive data rather than handing it off to a third-party. Despite the fact Vetroscope Cloud encrypts data end-to-end using an encryption key just like Home Sync, this alternative provides peace of mind to those who value their data. It's also built for power users to leverage more machines since Vetroscope Cloud has a hard limit of 5 devices per Vetroscope account.

---

## System Overview

```
  Device A                     Home Sync Server                       Device B 
 ┌─────────────────┐        ┌───────────────────────┐            ┌─────────────────┐
 │  Electron App   │        │   Docker Container    │            │  Electron App   │
 │                 │        │   vetroscope/home-sync│            │                 │
 │ ┌─────────────┐ │        │                       │            │ ┌─────────────┐ │
 │ │ Local SQLite│ │  HTTPS │  ┌───────────────┐    │   HTTPS    │ │ Local SQLite│ │
 │ │ vetroscope  │◄────────►│  │ /data/sync.db │    │◄────────────►│ vetroscope  │ │
 │ │ -{user}.db  │ │        │  │   (SQLite)    │    │            │ │ -{user}.db  │ │
 │ └─────────────┘ │        │  └───────────────┘    │            │ └─────────────┘ │
 │                 │        │                       │            │                 │
 │ ┌─────────────┐ │        │  ┌───────────────┐    │            │ ┌─────────────┐ │
 │ │ SyncManager │ │        │  │ Node + better- │   │            │ │ SyncManager │ │
 │ │ AuthManager │ │        │  │    sqlite3     │   │            │ │ AuthManager │ │
 │ │ Encryption  │ │        │  └───────────────┘    │            │ │ Encryption  │ │
 │ └─────────────┘ │        │                       │            │ └─────────────┘ │
 └─────────────────┘        │  Bind-mounted volume  │            └─────────────────┘
                            │  /host/vetroscope → /data            
                            └───────────────────────┘
                                      ▲
                                      │
                                 Local network only
                                 (LAN / Tailscale / VPN)
```

Everything behind the HTTPS line is owned by the user. Vetroscope ships the
Docker image but never touches the data; there are no webhooks, no telemetry routes to Vetroscope's API.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20+ | Shares rouhly ~70% of request-handling logic with the existing Vetroscope API code. Same route shapes, same SQL, same JWT scheme. Lets us port routes with minor tweaks instead of rewriting in Go or Rust. Also keeps the maintenance burden smaller. |
| DB | SQLite via `better-sqlite3` | Matches the local client's `node:sqlite` semantics. Single file, easy to back up, fits on any hardware. Vetroscope Cloud's SQL dialect is SQLite, so the existing schema transfers verbatim. |
| HTTP | Fastify | Fast, low-ceremony, first-class TypeScript types. Alternative: bare Node `http` — rejected because we want structured logging + validation hooks. |
| Auth | JWT (HS256) | Symmetric secret generated on first boot. Tokens signed by the server; validated by each request handler. Refresh tokens live in a `refresh_tokens` table (same pattern as cloud). |
| Password hashing | PBKDF2 via WebCrypto | Identical to Vetroscope API so hashes generated on either side are interchangeable (useful for future migrations). |
| TLS | Caddy or `node:https` with user-provided cert | Default Docker Compose file pairs the app with a Caddy sidecar for automatic Let's Encrypt. Users who only expose over LAN can either skip TLS (HTTP is fine over a trusted network) or generate a self-signed cert. |

---

## Repository Layout

```
vetroscope-home-sync/
├── Dockerfile
├── docker-compose.yml               # example for users
├── docker-compose.dev.yml           # our dev + CI harness
├── package.json
├── tsconfig.json
├── schema.sql                       # copied/adapted from api/schema.sql
├── src/
│   ├── index.ts                     # Fastify bootstrap
│   ├── env.ts                       # config / env-var loader
│   ├── db.ts                        # better-sqlite3 setup + migrations
│   ├── migrations/
│   │   ├── 001_initial.sql          # copy of Vetroscope API Cloud schema
│   │   ├── 002_app_overrides.sql
│   │   └── 003_goal_achievements.sql
│   ├── routes/
│   │   ├── auth.ts                  # register, login, refresh, logout (separate from Vetroscope API)
│   │   ├── user.ts                  # profile, devices, encryption key
│   │   ├── sync.ts                  # push, pull, reset
│   │   └── admin.ts                 # first-boot bootstrap, health, stats
│   ├── middleware/
│   │   ├── auth.ts                  # JWT verification
│   │   ├── ratelimit.ts             # in-memory token bucket
│   │   └── logging.ts
│   └── lib/
│       ├── crypto.ts                # shared with Vetroscope API via a published util package or copied
│       └── migrations.ts            # applies files in /migrations on boot
└── README.md
```

Shared utility: we'll extract `api/src/lib/crypto.ts` into
`shared/crypto.ts` at the repo root and symlink / publish it so Vetroscope API and Home Sync reuse the same password-hashing and token
primitives.

---

## Auth Model

Home Sync owns its own user accounts — it doesn't know about
vetroscope.com's user table.

- First-boot setup is easy (one admin creates the server password during initial setup).
- Additional devices can be added with a one-time invite code or
  the owner's email/password, user's choice.
- Same token shape as Vetroscope Cloud clients already expect, so the
  `AuthManager` needs minimal branching.

### First-boot bootstrap

When `sync.db` doesn't exist, the container generates a one-time
setup token and prints it to the logs:

```
[home-sync] First boot detected.
[home-sync] Open http://<host>:4437/setup and enter this code:
[home-sync]     T7K2-95BM-X45T
[home-sync] (This code is logged once and will not be shown again.)
```

The setup token is stored hashed in `server_state`. The client's Home Sync onboarding wizard takes that
code plus a chosen admin email/password and issues the first JWT.

### Device additions

Once the admin exists, they can:
1. Sign in directly with the server password on a new device.
2. Generate a 24h invite token for a another account/device.
3. Revoke devices from Settings → Devices on any already-signed-in client

### Multi-user

Home Sync supports multiple user accounts on one server (for household
or small-team use). `users`, `devices`, `refresh_tokens`, `sync_*`
tables all scope by `user_id` in the database.

---

## Data Schema

Identical to Vetroscope Cloud. Same tables, same columns,
same natural keys — the point is that a client can push the same
payload to either endpoint and the server-side handling is the same.

**Tables to copy from `api/schema.sql`:**
- `users`
- `devices`
- `refresh_tokens`
- `sync_entries`, `sync_tags`, `sync_goals`, `sync_markers`,
  `sync_goal_achievements` (all 5 sync tables verbatim)
- `sync_icons`, `sync_overrides` (optional for Home Sync users, but
  keeping them means full parity with Vetroscope Cloud)
- `sync_settings`

**New table specific to Home Sync:**
```sql
CREATE TABLE IF NOT EXISTS server_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: setup_token_hash, jwt_secret, server_version, created_at
```

**Encryption:** Clients continue to encrypt fields client-side with the
user's recovery code before push. The home server only sees encrypted
blobs, same as the Vetroscope Cloud. This means even a compromised Home Sync
instance can't read the data.

---

### New Home-Sync-only endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | /health | — | Returns `{ ok: true, version, users: N, databases_size_bytes }`. Used by the client to verify connectivity before the first sync. |
| POST | /setup | Setup token | First-boot bootstrap (creates the initial admin user). |
| POST | /admin/invites | Access token (admin role) | Generates a 24h invite token for a new device/user. |
| GET | /server-info | — | Returns `{ name, version, motd }` — lets the client display a friendly server name in Settings ("Jake's Home Sync"). |

---

## Client Integration

### Settings → Sync

The existing "Cloud Sync" section becomes a choose-your-adventure:

```
Sync
┌─────────────────────────────────────────────────┐
│ ○ Off                                           │
│ ○ Vetroscope Cloud            $10/mo Pro only   │
│ ● Home Sync                    Licensed+        │
│                                                 │
│   ┌────────────────────────────────────────────┐│
│   │ Server URL                                 ││
│   │ http://vetroscope.home.local:4437          ││
│   └────────────────────────────────────────────┘│
│   ┌────────────────────────────────────────────┐│
│   │ Sign in                                    ││
│   │ Email:    user@gmail.com                   ││
│   │ Password: ••••••••                         ││
│   └────────────────────────────────────────────┘│
│                                                 │
│   Status: Connected · 3 devices · Last sync 2m ago
└─────────────────────────────────────────────────┘
```

**Switch behavior:**
Both Vetroscope Cloud and Home Sync can be active simultaneously.

### SyncManager changes

Currently `electron/sync.ts` has a hard-coded `API_BASE`. We parameterize:

```ts
const API_BASE = getSyncEndpoint(); // reads from settings
// "https://api.vetroscope.com"  — cloud
// "http://vetroscope.home.local:4437"  — home sync
```

Everywhere the SyncManager calls `fetch(`${API_BASE}/sync/push`, ...)`
it already points at the configured endpoint. The request/response
shapes are identical between cloud and home, so no conditional logic
needed beyond the base URL.

### AuthManager changes

Similar parameterization — token refresh calls use the same
`${API_BASE}/auth/refresh` path regardless of target. The stored
`user_plan` field gets `"home"` for home-sync users, which we map to
licensed-tier UI treatments (e.g. no upgrade prompts, no Pro-only
feature grayouts).

**Licensing gate:** before enabling Home Sync, the client checks
`licenseState.status === "active" || licenseState.status === "pro"`.
Trial users are unable to access settings.

### Connection wizard

Because Home Sync has more setup friction than "enter your email", we
ship a wizard:

1. **URL + Health check** — user pastes `http://vetroscope.home.local:4437`,
   client hits `/health`, shows green check on success. On TLS errors,
   offer "Trust this certificate for this server" (stored as a
   pinned-cert hash in `sync_state`).
2. **Sign in or Setup** — `/server-info` returns whether an admin
   exists yet. If not, we show the setup-token prompt ("Paste the code
   from your server logs"). If yes, we show the standard email/password
   sign-in.
3. **Device registration** — same device-id mechanics as cloud.
4. **Encryption setup** — identical to Vetroscope Cloud's encryption flow
   (recovery code → wrapped sync key → stored in `/user/sync-key`).
5. **Initial pull** — kicks off a full pull to populate the local DB
   if this is a fresh device.

---

## Docker Distribution

### Published image

- **Registry:** `ghcr.io/rankin-works/vetroscope-home-sync` (public).
- **Tags:** `:latest`, `:vX.Y.Z`, `:vX.Y` (minor pinning), `:vX` (major pinning).
- **Arch:** `linux/amd64`, `linux/arm64` (built via `docker buildx`).
- **Size target:** < 120MB compressed (multi-stage build, Node 20 alpine).
- **Health check:** `HEALTHCHECK CMD curl -f http://localhost:4437/health || exit 1`.

### Example `docker-compose.yml`

Shipped in the repo README + as a starter template in the Home Sync
onboarding wizard (copy-paste block):

```yaml
services:
  vetroscope-home-sync:
    image: ghcr.io/rankin-works/vetroscope-home-sync:latest
    container_name: vetroscope-home-sync
    restart: unless-stopped
    ports:
      - "4437:4437"
    environment:
      # Optional: friendly server name shown in client Settings
      VS_SERVER_NAME: "Jake's Home Sync"
      # Generated automatically on first boot, then re-read from disk
      # VS_JWT_SECRET: "set-externally-if-you-want-to"
      # TLS: if you want the container to terminate HTTPS directly
      # VS_TLS_CERT: /certs/server.crt
      # VS_TLS_KEY:  /certs/server.key
    volumes:
      - /mnt/nas/vetroscope:/data   # persists sync.db, backups, icons
      # - /mnt/nas/certs:/certs      # optional
    labels:
      # For traefik / caddy sidecars — example only
      - "traefik.enable=true"
      - "traefik.http.routers.vetroscope.rule=Host(`vetroscope.home.lan`)"
```

### Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `VS_DATA_DIR` | `/data` | Where the SQLite DB, backups, and logs live |
| `VS_PORT` | `4437` | HTTP(S) listen port. `4437` picked because it's unassigned by IANA |
| `VS_SERVER_NAME` | hostname | Friendly name shown in the client |
| `VS_JWT_SECRET` | auto-generated | Persisted in `server_state` after first boot |
| `VS_TLS_CERT`, `VS_TLS_KEY` | unset | Paths to PEM files. If both set, server listens over HTTPS instead of HTTP. |
| `VS_MAX_DEVICES_PER_USER` | `10` | Per-user device cap. Higher default than cloud's 5 since it's your server. |
| `VS_ALLOW_REGISTRATION` | `invite` | `open` (anyone can register), `invite` (only via invite token), `closed` (only the admin can add users via CLI) |
| `VS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `VS_ENABLE_METRICS` | `false` | When true, adds a `/metrics` Prometheus endpoint |

### First-boot experience

```
$ docker compose up -d
$ docker compose logs -f vetroscope-home-sync

[home-sync] Vetroscope Home Sync v0.2.14
[home-sync] Data dir: /data
[home-sync] Listening on 0.0.0.0:4437
[home-sync] ═══════════════════════════════════════════════
[home-sync]   First boot detected. Set up your server at:
[home-sync]     http://<your-host>:4437/setup
[home-sync]
[home-sync]   Setup code: V7K2-9ABM-X4FT
[home-sync]   (One-time. Will not appear in future logs.)
[home-sync] ═══════════════════════════════════════════════
```

---

## Security Model

### Threat model

In order of severity:
1. **Attacker on the local network** — sees cleartext HTTP traffic if
   the user skips TLS. Mitigation: warn prominently, ship with sensible
   defaults, Tailscale network recommended.
2. **Attacker with filesystem access to the host** — can read
   `sync.db`. Mitigation: fields are encrypted client-side with the
   user's recovery code, so a stolen DB file is mostly useless (only
   non-sensitive fields like `is_adobe`, `timestamp`, UUIDs are in
   plaintext).
3. **Insider (household member, roommate)** — has a second user account
   on the same server. Mitigation: strict `user_id` scoping on every
   query (enforced by tests). Invite tokens are single-use and have a
   24h TTL.
4. **Attacker who steals a refresh token** — Mitigation: tokens rotate
   on each refresh, old tokens are blacklisted server-side.

### TLS handling

Three supported modes:

**Mode A — Reverse proxy (recommended for internet exposure):**
User runs Caddy/Traefik/nginx in front of the container. Container
listens over plain HTTP on an internal network. Full Let's Encrypt.

**Mode B — Built-in TLS:**
User provides a cert + key (self-signed or real). Container listens on
443 or configurable port. Good for users who don't want to run a reverse
proxy.

**Mode C — LAN plaintext (not recommended):**
Plain HTTP. Works fine for trusted home networks. Docs are upfront:
"fine for LAN, never expose to the internet without TLS."

### Rate limiting

In-memory token bucket per IP for `/auth/*` endpoints. Not a scalable
design, but fine for a single-server deployment with a handful of
devices. Returns 429 after 10 attempts/minute.

### Secrets

- JWT secret: generated via `crypto.randomBytes(32)` on first boot,
  persisted to `server_state.jwt_secret`. Rotating it requires a CLI
  command (invalidates all active tokens).
- Setup token: 12-char base32, hashed with PBKDF2 before storing.
  Consumed on successful setup.
- Invite tokens: same shape, hashed, TTL-bound.

---

## Migration Paths

### Vetroscope Cloud → Home Sync

For users who started with Pro and want to switch:

1. User goes to Settings → Sync → makes sure Home Sync is active.
2. Client does a full Vetroscope Cloud pull to ensure local database is up-to-date.
3. Client disconnects from Vetroscope Cloud, clicks disable, select delete server data.
4. Client pushes all data to Home Sync.

### Home Sync → Cloud

Symmetric to the above but in reverse.

### Home Sync instance → new Home Sync instance

User wants to move their self-hosted data from one machine to another.
CLI tool in the container: `docker exec vetroscope-home-sync vhs-export > backup.tar.gz`.
Import via `docker exec -i vetroscope-home-sync vhs-import < backup.tar.gz`.
Tar contains the SQLite db, encryption-wrapped-keys blob, and a
manifest. Preserves uuids, so devices keep syncing without re-auth.

---

## Licensing Gate

Home Sync is unlocked when the client's license status is **active
(licensed)** or **pro**. Explicit carve-out from the Pro-only gate on
cloud features:

```ts
const canUseHomeSync =
  licenseState.status === "active" ||   // licensed lifetime
  licenseState.status === "pro";         // paying subscriber
```
---

## Encryption

Unchanged from cloud. The client:
1. Generates a random 32-byte encryption key on first enable.
2. Wraps it with a key derived from the user's recovery code (12-word
   BIP-39 phrase).
3. Pushes the wrapped key to `/user/sync-key` — server stores the
   ciphertext, never sees the plaintext key.
4. Every push encrypts `app_name`, `window_title`, `project`, marker
   labels, override display names, and sync_settings values before
   transmission.

**Why still encrypt when the server is yours?** Defense in depth:
- If the server is compromised, data is still unreadable without the
  recovery code.
- If the user exposes the server to the internet and someone exploits
  a future bug, the DB is still encrypted at rest (functionally).
- Same code paths as cloud — less branching means fewer bugs.

The client treats Home Sync exactly like Cloud from an encryption
standpoint; no UI changes.

---
  who want that are already running their own proxy layer.
