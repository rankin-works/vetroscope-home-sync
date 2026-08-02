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
 │ │ Sync engine │ │        │  │ Node + better- │   │            │ │ Sync engine │ │
 │ │ Auth/tokens │ │        │  │    sqlite3     │   │            │ │ Auth/tokens │ │
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
| Runtime | Node.js 20+ | Same runtime the desktop client already ships, so the sync payload types are shared vocabulary rather than a translation layer. Mature ecosystem, and one language across the project keeps the maintenance burden small. |
| DB | SQLite via `better-sqlite3` | Matches the local client's `node:sqlite` semantics. Single file, easy to back up, fits on any hardware from a Pi to a NAS. |
| HTTP | Fastify | Fast, low-ceremony, first-class TypeScript types. Alternative: bare Node `http` — rejected because we want structured logging + validation hooks. |
| Auth | JWT (HS256) | Symmetric secret generated on first boot. Tokens signed by the server; validated by each request handler. Refresh tokens live in a `refresh_tokens` table and rotate on every use. |
| Password hashing | PBKDF2 via WebCrypto | Available in the standard runtime with no native dependency. The stored format is fixed by the rows already on disk — see the note in `src/lib/crypto.ts` before changing any parameter. |
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
├── src/
│   ├── index.ts                     # entry point: config → db → migrations → listen
│   ├── app.ts                       # Fastify factory (testable without a socket)
│   ├── env.ts                       # config / env-var loader
│   ├── db.ts                        # better-sqlite3 setup
│   ├── types.ts                     # row + sync payload shapes
│   ├── cli/index.ts                 # vhs-cli admin surface
│   ├── migrations/                  # forward-only, applied by filename on boot
│   ├── routes/
│   │   ├── setup.ts                 # first-boot admin bootstrap
│   │   ├── auth.ts                  # register, login, refresh, logout
│   │   ├── user.ts                  # profile, devices, sync-key, account
│   │   ├── google-calendar.ts       # credential vault + leader lease
│   │   ├── sync.ts                  # push, pull, reset, count
│   │   ├── admin.ts                 # invite management (role=admin)
│   │   ├── server-info.ts           # unauthenticated descriptor
│   │   └── health.ts                # liveness probe
│   ├── middleware/
│   │   ├── auth.ts                  # JWT verification + revocation check
│   │   └── ratelimit.ts             # in-memory token bucket
│   └── lib/                         # crypto, migrations runner, services
└── README.md
```

---

## Auth Model

Home Sync owns its own user accounts — it doesn't know about
vetroscope.com's user table.

- First-boot setup is easy (one admin creates the server password during initial setup).
- Additional devices can be added with a one-time invite code or
  the owner's email/password, user's choice.
- Tokens follow the shape the client already handles, so pointing it at a
  Home Sync target needs no special-casing in its auth flow.

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

Column names and types follow the sync payload the desktop client puts on
the wire, so a client pointed at a Home Sync target serializes exactly what
it would for any other target. That wire compatibility is the contract;
everything about how this server stores and processes those documents is
its own concern.

**Account and session tables:**
- `users` — credentials, plan, role, wrapped sync keys, `token_version`
- `devices` — one row per linked device, capped by `VS_MAX_DEVICES_PER_USER`
- `refresh_tokens` — rotated on every use
- `invites`, `password_resets`

**Replicated tables**, all keyed by a client-generated natural key and
scoped by `user_id`:
- `sync_entries`, `sync_tags`, `sync_goals`, `sync_markers`,
  `sync_goal_achievements`
- `sync_icons`, `sync_overrides`, `sync_settings`
- `sync_tag_sticky_exclusions`, `sync_tag_sticky_project_apps`,
  `sync_tag_sticky_subproject_scopes`
- `sync_media_links`, `sync_reminders`, `sync_reminder_events`,
  `sync_reminder_claims`, `sync_entry_dismissals`

**Server-local tables** (never replicated):
```sql
CREATE TABLE IF NOT EXISTS server_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: jwt_secret, setup_token_hash, setup_token_salt,
--       installation_id, created_at, setup_completed_at
```

**Tenant scoping.** Rows keyed on a bare `uuid` share one key space across
every account on the server, so each push upsert additionally requires the
existing row to belong to the authenticated user before it will update it.
A uuid that collides across accounts is dropped, not applied. Any new
replicated table inherits this requirement — see
`src/__tests__/tenant-isolation.test.ts`, which carries one case per
uuid-keyed table so an omission shows up as a missing case.

**Encryption:** Clients encrypt sensitive fields client-side before push,
so the server only ever holds ciphertext for them. A compromised server —
or a stolen `sync.db` — doesn't yield readable activity data.

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

### What the client needs from a target

A Home Sync target is just a base URL the client is configured with. Every
request path below hangs off it, and the request and response bodies are
the ones documented in `src/types.ts`:

- `GET /health` and `GET /server-info` — reachability and capability check
  before any credentials are entered.
- `POST /setup` or `POST /auth/register` / `POST /auth/login` — account
  bootstrap or sign-in, returning an access + refresh token pair.
- `POST /auth/refresh` — token rotation on the same base URL.
- `POST /sync/push` and `POST /sync/pull` — the replication loop.

Accounts on this server report `plan: "home"`, which the client maps to
licensed-tier treatment. Home Sync is available on the Licensed tier and
above; the client gates the feature before offering the setup flow.

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
3. **Device registration** — the client registers a device id and name,
   subject to `VS_MAX_DEVICES_PER_USER`.
4. **Encryption setup** — recovery code → wrapped sync key → stored via
   `/user/sync-key`. The server sees only the wrap.
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
| `VS_SYNC_DEK_KEK` | unset | Optional 32-byte key (64 hex chars or base64) used to wrap sync data-encryption keys for sign-in recovery. When unset, the wrapping key is derived from the JWT secret, which means `vhs-cli rotate-jwt-secret` renders existing wraps unreadable. Setting it decouples the two. Wraps written before it was set stay readable; new wraps are tagged `v2:` and require the KEK. **Losing this value after wraps exist makes sign-in recovery unrecoverable** — back it up with the same care as the database. Generate with `openssl rand -hex 32`. |
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
   on the same server. Mitigation: every pull query filters on `user_id`,
   and every push upsert additionally requires the row it would update to
   already belong to the caller — a uuid that collides across accounts is
   dropped rather than applied. Covered by
   `src/__tests__/tenant-isolation.test.ts`, one case per uuid-keyed
   table. Invite tokens are single-use with a 24h TTL.
4. **Attacker who steals a refresh token** — Mitigation: tokens rotate on
   each refresh and the consumed row is deleted, so a replayed token is
   rejected.
5. **Attacker who steals an access token** — Mitigation: 1h expiry, and a
   password change bumps `users.token_version`, which invalidates every
   outstanding access token for that account on its next request rather
   than waiting for expiry.

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
(licensed)** or **pro** — it is not a Pro-only feature. The server itself
enforces nothing here: every account it holds is `plan: "home"`, and the
gate lives in the client before it offers the setup flow.

---

## Encryption

The server never holds a key that can read a user's activity data. The
client:
1. Generates a random 32-byte encryption key on first enable.
2. Wraps it with a key derived from the user's recovery code (12-word
   BIP-39 phrase).
3. Pushes the wrapped key to `/user/sync-key` — the server stores the
   ciphertext and never sees the plaintext key.
4. Encrypts `app_name`, `window_title`, `project`, marker labels,
   override display names, and `sync_settings` values on every push.

Optionally, a user can instead store a server-held wrap for sign-in
recovery (`/user/sync-key/server`), trading some of that guarantee for the
ability to recover the key by signing in. That wrap is sealed with
`VS_SYNC_DEK_KEK` when configured — see the environment variable table.

**Why still encrypt when the server is yours?** Defense in depth:
- A compromised server, or a stolen `sync.db`, is still unreadable
  without the recovery code.
- If the server is exposed to the internet and a future bug is found,
  the data at rest doesn't come with it.
- On a multi-user server, one account's operator-level access to the host
  doesn't become access to another account's activity.

---
  who want that are already running their own proxy layer.
