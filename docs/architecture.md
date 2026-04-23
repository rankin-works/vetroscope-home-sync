# Home Sync Architecture

A self-hosted alternative to Vetroscope Cloud Sync. Users deploy a small
Docker image on their own hardware (NAS, home server, Raspberry Pi, always-on
workstation) and point their Vetroscope clients at it instead of
api.vetroscope.com. Data never leaves the user's network.

**Positioning:** Home Sync is a first-class feature, not a stripped-down
alternative. It ships with the **Licensed** tier — no Pro subscription
required. Cloud Sync stays a Pro feature because Anthropic (us) operates
real infrastructure and storage for it; Home Sync runs on the user's own
hardware, so the value exchange is different.

---

## Why Home Sync?

Three audiences the cloud version doesn't serve well:

1. **Privacy-first users.** Tracking data includes window titles (file names,
   URLs, document names). Some people want that on a local NAS only, never on
   a third-party server.
2. **Organizations with data-residency rules.** Teams that can't legally
   ship metadata off-site can stand up one Home Sync instance on their
   intranet and have everyone sync to it.
3. **Infra-minded power users.** Homelabbers enjoy self-hosting their
   services — Home Sync slots into the same Docker Compose stack as
   Nextcloud, Jellyfin, Pi-hole, etc.

It's a meaningful differentiator versus RescueTime, Timing, Toggl, etc. — none
of those offer a self-hostable option.

---

## System Overview

```
  Device A (Mac)               Home Sync Server                    Device B (Windows)
 ┌─────────────────┐        ┌──────────────────────┐            ┌─────────────────┐
 │  Electron App   │        │   Docker Container    │            │  Electron App   │
 │                 │        │   vetroscope/home-sync│            │                 │
 │ ┌─────────────┐ │        │                       │            │ ┌─────────────┐ │
 │ │ Local SQLite│ │  HTTPS │  ┌───────────────┐   │   HTTPS    │ │ Local SQLite│ │
 │ │ vetroscope  │◄├───────►│  │ /data/sync.db │   │◄──────────►├►│ vetroscope  │ │
 │ │ -{user}.db  │ │        │  │   (SQLite)    │   │            │ │ -{user}.db  │ │
 │ └─────────────┘ │        │  └───────────────┘   │            │ └─────────────┘ │
 │                 │        │                       │            │                 │
 │ ┌─────────────┐ │        │  ┌───────────────┐   │            │ ┌─────────────┐ │
 │ │ SyncManager │ │        │  │ Node + better- │   │            │ │ SyncManager │ │
 │ │ AuthManager │ │        │  │    sqlite3     │   │            │ │ AuthManager │ │
 │ │ Encryption  │ │        │  └───────────────┘   │            │ │ Encryption  │ │
 │ └─────────────┘ │        │                       │            │ └─────────────┘ │
 └─────────────────┘        │  Bind-mounted volume  │            └─────────────────┘
                            │  /host/vetroscope → /data            
                            └──────────────────────┘
                                      ▲
                                      │
                                 Local network only
                                 (LAN / Tailscale / VPN)
```

Everything behind the HTTPS line is owned by the user. Vetroscope ships the
Docker image but never touches the data; there are no webhooks, no telemetry
back to us.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20+ | Shares ~70% of request-handling logic with the existing Cloudflare Worker code — same route shapes, same SQL, same JWT scheme. Lets us port routes with minor tweaks instead of rewriting in Go or Rust. Also keeps the maintenance burden on one team. |
| DB | SQLite via `better-sqlite3` | Matches the local client's `node:sqlite` semantics. Single file, easy to back up, fits on any hardware. D1's SQL dialect is SQLite, so the existing schema transfers verbatim. |
| HTTP | Fastify | Fast, low-ceremony, first-class TypeScript types. Alternative: bare Node `http` — rejected because we want structured logging + validation hooks. |
| Auth | JWT (HS256) | Symmetric secret generated on first boot. Tokens signed by the server; validated by each request handler. Refresh tokens live in a `refresh_tokens` table (same pattern as cloud). No Lemon Squeezy on the server — auth is entirely self-contained. |
| Password hashing | PBKDF2 via WebCrypto | Identical to the cloud Worker so hashes generated on either side are interchangeable (useful for future migrations). |
| TLS | Caddy or `node:https` with user-provided cert | Default Docker Compose file pairs the app with a Caddy sidecar for automatic Let's Encrypt. Users who only expose over LAN can either skip TLS (HTTP is fine over a trusted network) or generate a self-signed cert. |

**Why not port the Worker itself?** `wrangler` is Cloudflare-specific and
the Worker runtime assumes bindings (D1, KV). Shipping Wrangler inside
Docker isn't officially supported. A direct Node port is cleaner.

---

## Repository Layout

This repo is the top-level project. Planned layout:

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
│   │   ├── 001_initial.sql          # copy of cloud schema, minus billing tables
│   │   ├── 002_app_overrides.sql
│   │   └── 003_goal_achievements.sql
│   ├── routes/
│   │   ├── auth.ts                  # register, login, refresh, logout
│   │   ├── user.ts                  # profile, devices, sync-key
│   │   ├── sync.ts                  # push, pull, reset
│   │   └── admin.ts                 # first-boot bootstrap, health, stats
│   ├── middleware/
│   │   ├── auth.ts                  # JWT verification
│   │   ├── ratelimit.ts             # in-memory token bucket
│   │   └── logging.ts
│   └── lib/
│       ├── crypto.ts                # shared with api/ via a published util package or copied
│       └── migrations.ts            # applies files in /migrations on boot
└── README.md
```

Shared utility: we'll extract `api/src/lib/crypto.ts` into
`shared/crypto.ts` at the repo root and symlink / publish it so the
cloud Worker and Home Sync reuse the same password-hashing and token
primitives.

---

## Auth Model

Home Sync owns its own user accounts — it doesn't know about
vetroscope.com's user table. Design goals:

- First-boot setup is easy (one admin creates the server password).
- Additional devices can be added with a one-time invite code or
  the owner's email/password, user's choice.
- Same token shape as cloud clients already expect, so the
  `AuthManager` needs minimal branching.
- No email delivery required (homelabs rarely have SMTP).

### First-boot bootstrap

When `sync.db` doesn't exist, the container generates a one-time
setup token and prints it to the logs:

```
[home-sync] First boot detected.
[home-sync] Open http://<host>:4437/setup and enter this code:
[home-sync]     V7K2-9ABM-X4FT
[home-sync] (This code is logged once and will not be shown again.)
```

The setup token is stored hashed in `server_state`. A browser-based
setup page — or the client's Home Sync onboarding wizard — takes that
code plus a chosen admin email/password and issues the first JWT.

### Device additions

Once the admin exists, they can:
1. Sign in directly with the server password on a new device.
2. Generate a 24h invite token for a partner/roommate/teammate.
3. Revoke devices from Settings → Devices on any already-signed-in client
   (same UI as the cloud version, pointed at the home server).

### Multi-user

Home Sync supports multiple user accounts on one server (for household
or small-team use). `users`, `devices`, `refresh_tokens`, `sync_*`
tables all scope by `user_id` exactly like the cloud version.

---

## Data Schema

Identical to cloud minus billing tables. Same tables, same columns,
same natural keys — the point is that a client can push the same
payload to either endpoint and the server-side handling is the same.

**Tables to copy from `api/schema.sql`:**
- `users` (drop `ls_customer_id`, `ls_subscription_id`, `license_key`;
  keep `plan` with fixed value `"home"` for visual differentiation in
  the client)
- `devices`
- `refresh_tokens`
- `password_resets` (optional — Home Sync ships with a CLI
  reset-password command inside the container for admins)
- `sync_entries`, `sync_tags`, `sync_goals`, `sync_markers`,
  `sync_goal_achievements` (all 5 sync tables verbatim)
- `sync_icons`, `sync_overrides` (optional for Home Sync users, but
  keeping them means full parity with cloud)
- `sync_settings`

**New table specific to Home Sync:**
```sql
CREATE TABLE IF NOT EXISTS server_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: setup_token_hash, jwt_secret, server_version, created_at
```

**Dropped tables:**
- `orders`, `subscriptions` — Home Sync has no billing
- Anything Lemon-Squeezy-specific

**Encryption:** Clients continue to encrypt fields client-side with the
user's recovery code before push. The home server only sees encrypted
blobs, same as the cloud. This means even a compromised Home Sync
instance can't read the plaintext — the encryption layer is identical
to cloud. We'll document this clearly so users don't assume
"self-hosted means unencrypted."

---

## API Endpoints

Routes mirror the cloud Worker one-to-one. The client toggles
`API_BASE` between `https://api.vetroscope.com` and the user's
configured home server URL; every other code path is unchanged.

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | /auth/register | Setup token (first user) or invite | Creates a user account |
| POST | /auth/login | — | Email + password → JWT pair |
| POST | /auth/refresh | Refresh token | Rotates tokens |
| POST | /auth/logout | Access token | Revokes refresh token |
| GET  | /user/profile | Access token | Returns user + devices |
| PATCH | /user/profile | Access token | Update display name |
| PATCH | /user/password | Access token | Change password |
| DELETE | /user/devices/:id | Access token | Unlink device |
| DELETE | /user/account | Access token + password | Wipe user's data |
| PUT | /user/sync-key | Access token | Store wrapped encryption key |
| GET | /user/sync-key | Access token | Retrieve wrapped encryption key |
| POST | /sync/push | Access token | Same payload shape as cloud |
| POST | /sync/pull | Access token | Same response shape as cloud |
| POST | /sync/reset | Access token | Wipe cloud-side rows for this user |

Endpoints **not** ported:
- `/billing/*` — no Lemon Squeezy
- `/user/link-license` — no concept of a "license" on the home server
  (everyone on a Home Sync instance is effectively "home-plan")

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
│ ○ Off                                             │
│ ○ Vetroscope Cloud            $4/mo Pro only     │
│ ● Home Sync                    Licensed+          │
│                                                   │
│   ┌────────────────────────────────────────────┐ │
│   │ Server URL                                   │ │
│   │ https://vetroscope.home.local:4437           │ │
│   └────────────────────────────────────────────┘ │
│   ┌────────────────────────────────────────────┐ │
│   │ Sign in                                     │ │
│   │ Email:    jake@home.lan                     │ │
│   │ Password: ••••••••                          │ │
│   └────────────────────────────────────────────┘ │
│                                                   │
│   Status: Connected · 3 devices · Last sync 2m ago │
└─────────────────────────────────────────────────┘
```

**Switch behavior:** Only one sync target is active at a time. Switching
from Cloud → Home (or vice versa) prompts: "This will stop syncing with
{current}. Your local data stays on this device. Continue?" On confirm,
the client signs out of the current target, clears `sync_cursor`, signs
into the new target, and triggers a full pull.

### SyncManager changes

Currently `electron/sync.ts` has a hard-coded `API_BASE`. We parameterize:

```ts
const API_BASE = getSyncEndpoint(); // reads from settings
// "https://api.vetroscope.com"  — cloud
// "https://jake.home.lan:4437"  — home sync
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
Trial users can browse the section but the enable toggle is disabled
with "Licensed or Pro required to enable sync" copy.

### Connection wizard

Because Home Sync has more setup friction than "enter your email", we
ship a wizard:

1. **URL + Health check** — user pastes `https://jake.home.lan:4437`,
   client hits `/health`, shows green check on success. On TLS errors,
   offer "Trust this certificate for this server" (stored as a
   pinned-cert hash in `sync_state`).
2. **Sign in or Setup** — `/server-info` returns whether an admin
   exists yet. If not, we show the setup-token prompt ("Paste the code
   from your server logs"). If yes, we show the standard email/password
   sign-in.
3. **Device registration** — same device-id mechanics as cloud.
4. **Encryption setup** — identical to cloud's encryption flow
   (recovery code → wrapped sync key → stored in `/user/sync-key`).
5. **Initial pull** — kicks off a full pull to populate the local DB
   if this is a fresh device.

The wizard can run inside the Settings modal or a dedicated full-screen
onboarding page; starting with the latter since there are a lot of
steps.

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
| `VS_PORT` | `4437` | HTTP(S) listen port. `4437` picked because it's unassigned by IANA and spells "HIDEY" upside-down on a phone (subjective) |
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
   defaults, document Caddy sidecar for LAN HTTPS.
2. **Attacker with filesystem access to the host** — can read
   `sync.db`. Mitigation: fields are encrypted client-side with the
   user's recovery code, so a stolen DB file is mostly useless (only
   non-sensitive fields like `is_adobe`, `timestamp`, UUIDs are in
   plaintext — same as cloud).
3. **Insider (household member, roommate)** — has a second user account
   on the same server. Mitigation: strict `user_id` scoping on every
   query (enforced by tests). Invite tokens are single-use and have a
   24h TTL.
4. **Attacker who steals a refresh token** — Mitigation: tokens rotate
   on each refresh, old tokens are blacklisted server-side, user can
   revoke via Settings → Devices.

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

### Anonymous → Home Sync

Same flow as anonymous → cloud. After successful first sign-in, the
client detects tracked data in the default db and prompts: "You have
X hours of activity tracked locally. Migrate it to your home server?"
If yes, it's pushed in the next sync cycle.

### Cloud → Home Sync

For users who started with Pro and want to switch:

1. User goes to Settings → Sync → switches from Cloud to Home.
2. Client does a full cloud pull to ensure local is up-to-date.
3. Client disconnects from cloud (POST /sync/reset? no — that wipes.
   Just stops syncing. Cloud-side data persists in case they switch back).
4. Client connects to Home Sync, does initial push of everything.
5. Settings shows "Your Cloud Sync is paused. Resume anytime."
6. On Cloud Sync re-enable, client resumes with cloud cursor — no data loss.

### Home Sync → Cloud

Symmetric to the above.

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

Trial users see the option in Settings with a "Purchase a license to
enable Home Sync" blurb and a Purchase button that opens Lemon Squeezy
checkout.

Why include Pro users too? They already paid for a license as a
prerequisite for Pro (per our tier structure). Pro users who want to
self-host instead should be able to.

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

## Phased Implementation Plan

**Phase 1 — Scaffolding (1 week)**
- Create `home-sync/` directory with Fastify skeleton, Dockerfile,
  compose template
- Extract shared crypto + types into `shared/` or an `npm link`ed
  workspace
- Copy schema + migrations verbatim (minus billing tables)
- Implement `/health` + `/server-info`

**Phase 2 — Auth (1 week)**
- First-boot setup flow (`/setup` endpoint, setup-token generation,
  admin user creation)
- Login / refresh / logout with matching JWT shape
- Invite-token endpoint
- CLI scripts (reset-password, create-user, revoke-tokens)

**Phase 3 — Sync parity (1.5 weeks)**
- Port `/sync/push` and `/sync/pull` from the Worker, adapting to
  `better-sqlite3` (it's a synchronous API, slightly different from
  `env.DB`'s Promises). Keep LWW semantics identical.
- `/sync/reset`
- Port all user management endpoints (`/user/profile`, `/user/devices`,
  `/user/sync-key`)

**Phase 4 — Client integration (1 week)**
- New settings shape: sync target dropdown
- Home Sync onboarding wizard (URL → health check → setup/sign-in →
  encryption → initial pull)
- `SyncManager` / `AuthManager` parameterization on `API_BASE`
- Cert-pinning UI for self-signed certs
- License-status gate on the enable toggle

**Phase 5 — Docker packaging (3 days)**
- Multi-stage Dockerfile, multi-arch buildx pipeline
- GitHub Actions workflow publishing `:latest` + version tags to GHCR
- Docker Compose template tested on macOS / Linux / Synology DSM

**Phase 6 — Documentation + polish (1 week)**
- `docs/home-sync-setup-guide.md` — step-by-step with screenshots
- `home-sync/README.md` — quick-start, env vars, reverse-proxy examples
- Marketing landing page section on vetroscope.com
- Migration path walkthrough (cloud ↔ home)
- Troubleshooting guide (TLS errors, firewall, port conflicts)

**Phase 7 — Beta + launch (2 weeks)**
- Private beta with 10-20 power users (homelabbers from the community)
- Fix reported issues
- Public launch as "Home Sync for Licensed users, now available"
- Bump to 0.3.0 since this is a flagship feature

**Total:** ~7 weeks to ship a solid v1.

---

## Open Questions & Risks

**Self-signed cert UX.** The client's first connection to a self-signed
HTTPS server will fail cert validation. Options: (a) trust-on-first-use
prompt, (b) require the user to paste the fingerprint into Settings,
(c) skip TLS entirely and require a reverse proxy. Current plan is (a)
with the fingerprint displayed prominently for the user to verify out
of band. **Risk:** classic MITM attack possible on a hostile network.
Mitigation: surface a warning on first connection that says "Home Sync
is designed for trusted networks. If you don't recognize this
fingerprint, don't trust it."

**Database upgrades.** If a user runs an old Home Sync container and a
new client tries to sync, the client needs to detect the version
mismatch gracefully. Plan: `/server-info` returns the server version;
client compares against a known-compatible range. If the server is too
old, sync is disabled with a "Please update your Home Sync container"
message.

**Concurrent client bug surface.** The Cloudflare Worker handles each
request in isolation — no shared state. `better-sqlite3` is synchronous
and single-threaded; multiple concurrent push requests from 5 devices
could contend on the SQLite writer lock. Plan: use WAL mode (enabled
by default in `better-sqlite3`), and set a reasonable request timeout.

**Device limit enforcement.** The cloud tops out at 5 because Pro is a
subscription. Home Sync's default is 10, and the admin can raise it
with `VS_MAX_DEVICES_PER_USER`. **Risk:** Someone could stand up a
Home Sync instance and share it with 100 coworkers to dodge Vetroscope
Pro. Mitigation: that's a feature, not a bug. They still had to buy
Licensed first. The person running the server is eating infra cost and
maintenance work, and we'd rather they be happy users than push them
to a competitor.

**Support burden.** Self-hosted means users will ask us for help with
Docker, networking, TLS, NAS permissions, etc. Mitigation: solid docs +
"this is power user territory" copy. If volume gets high, open a
community Discord channel so users help each other.

**What if Cloudflare goes down?** Home Sync doesn't care — it doesn't
talk to Cloudflare. This is actually an upsell for the Home tier: your
sync keeps working during our outages.

**Backup story.** The SQLite file is on the user's volume; they're on
the hook. Container ships a `vhs-backup` CLI that snapshots the db +
compresses. Doc the obvious rsync / Time Machine / Nextcloud-backup
integrations.

---

## Success Criteria

- **v1 ships:** working Docker image on GHCR, Settings UI for Home
  Sync, documented setup flow, beta-tested by at least 10 users.
- **6 months post-launch:** 5% of licensed users have enabled Home
  Sync. (Cloud sits at a much higher rate, but Home Sync is
  discretionary.)
- **Zero Vetroscope-servers data incidents** traceable to Home Sync.
  Which is trivially true because it doesn't touch our infra, but
  worth calling out.
- **Tangible differentiation vs competitors.** No comparable productivity
  app offers a first-class self-hosted option. That's the whole pitch.

---

## Open-Sourcing the Server

The Home Sync server — and only the server — ships as a public
open-source project under **Apache 2.0**. The Electron client stays
proprietary in the private Vetroscope repo.

### Why open-source the server

1. **Unblocks first-class inclusion** in FOSS-leaning catalogs
   (TrueNAS Community Apps, TrueCharts, CasaOS). Many of these reject
   or deprioritize closed-source apps.
2. **Audit-ability is a core promise.** The privacy pitch ("your data
   never leaves your network") is weaker if the server binary is a
   black box. Publishing the source lets security-minded users verify
   the claim.
3. **Community contributions.** Homelabbers maintain their own zoo of
   NAS-specific quirks (Synology permission models, Unraid path
   conventions, TrueNAS dataset bind-mounts). PRs cost us nothing and
   improve the product.
4. **Zero competitive downside.** The server is plumbing — sync
   endpoints, JWT auth, SQLite schema. It has no value without the
   Vetroscope client. No competitor will fork it to build a rival
   product.

### Why Apache 2.0

- Catalog-friendly. Permissive enough that no corporate reviewer
  stops the packaging process.
- Patent grant included (vs MIT) — slight extra protection if we ever
  hit a software-patent dispute.
- Allows commercial use, modification, redistribution. The kind of
  license that gets adopted without drama.
- **Rejected alternatives:**
  - **MIT** — functionally similar, no patent grant. Fine but
    Apache 2.0 is a strict superset of guarantees for us.
  - **AGPL-3.0** — forces derivative network services to publish
    source. Philosophically appealing but scares off corporate users
    and isn't really needed: nobody is going to run a
    Vetroscope-sync-server-as-a-service business.
  - **SSPL / BSL / proprietary** — kills catalog inclusion, kills
    audit-ability, kills the whole reason we're doing this.

### Repo structure

- **Private:** `rankin-works/Vetroscope` — the Vetroscope client +
  cloud Worker + internal design docs live there. Not publicly
  readable.
- **Public:** `rankin-works/vetroscope-home-sync` — **this repo**.
  Server implementation, public docs, Docker packaging. Apache 2.0.
- **Linkage:** the public repo's README points back at
  `vetroscope.com` for the client; the private Vetroscope repo
  references the public server repo where relevant.

### Required files for the public repo

- `LICENSE` — full Apache 2.0 text
- `README.md` — quick-start, Docker Compose example, link to the
  setup guide (when it's written), link back to vetroscope.com
- `CONTRIBUTING.md` — PR process, code style, commit message format
- `CODE_OF_CONDUCT.md` — Contributor Covenant boilerplate
- `SECURITY.md` — private disclosure channel (support@vetroscope.com),
  supported versions, expected response time
- `.github/workflows/` — CI (lint, typecheck, tests) and the Docker
  publish pipeline building multi-arch images to GHCR

### Contributor attribution policy

Commits on the public server repo must **not** include
`Co-Authored-By: Claude` trailers. The server is authored by the
human developer(s); AI-assisted work is fine behind the scenes but
shouldn't show up in the public git history.

Enforced three ways:

1. **CLAUDE.md directive** in the public repo: "Never add
   `Co-Authored-By: Claude` trailers to commits in this repository."
   I'll follow it consistently across sessions.
2. **Pre-commit hook** (`.git/hooks/commit-msg` or a local husky
   equivalent) that rejects any commit message containing
   `Co-Authored-By: Claude`. Belt-and-suspenders for any accidents.
3. **Pre-publication history scrub.** If the Home Sync code is ever
   developed in the private repo first, run `git filter-repo
   --replace-message` to strip Claude trailers before pushing to the
   public repo. Cleanest outcome is to just never add them in the
   first place, but this is the escape hatch.

No retroactive scrubbing needed on the private Vetroscope repo —
those commits stay as-is.

---

## Distribution Channels (Post-v1)

Shipping a working Docker image on GHCR is table stakes. To actually
reach the homelabber audience, we want the app to show up where they
already browse for services.

### TrueNAS Community Apps catalog

TrueNAS SCALE ships with a **Discover** tab that lists apps from
bundled catalogs. Landing there means a TrueNAS user can install
Vetroscope Home Sync with a click, fill out a form, and be running
— no compose-file copy-paste.

TrueNAS moved from Kubernetes + Helm charts to Docker Compose in
version 24.10 ("Electric Eel", late 2024), so the submission format
shifts around. Concrete checklist will need to be verified against
the current catalog contribution guide at submission time; broad
strokes:

**Gate 1 — Packaging prerequisites we need anyway for Phase 5:**
- Docker image published to a public registry (GHCR). ✓ planned
- Multi-arch build (`linux/amd64` + `linux/arm64`). ✓ planned
- Non-root container user with a predictable UID/GID so bind-mounted
  dataset permissions don't require `chmod -R 1000:1000`. Add to
  Phase 5 work.
- `HEALTHCHECK` in Dockerfile. ✓ planned
- Actively maintained upstream (they reject dead projects). ✓

**Gate 2 — Catalog-entry artifacts (new work, ~2–3 days):**
- `app.yaml` — app identity: name, categories (`productivity`,
  `backup`), description, icon URL, screenshot URLs, maintainer
  email, homepage, source URL.
- `item.yaml` — version metadata; mirrors our semver tags.
- `docker-compose.yaml` — the compose definition rewritten to use
  TrueNAS's template helpers (`{{ .Values.network.web.port }}`,
  volume mounts to `ixVolume` datasets).
- `questions.yaml` — schema for the GUI-driven setup wizard. Drives
  the form fields TrueNAS shows users when they install the app.
  Needs to cover: port, server name, data volume, optional TLS cert
  paths, device cap, registration mode.
- Icon (512×512 PNG) + at least two screenshots for Discover thumbnails.
- README tailored to TrueNAS users (bind-mount vs ixVolume tradeoffs,
  reverse-proxy setup).

**Gate 3 — Submission + review:**
- PR to the catalog repo (current URL: `github.com/truenas/apps`;
  re-verify before submitting).
- Automated CI (linting, compose validation, image-pull checks).
- iXSystems human review — usually 1–2 rounds of feedback.
- Merge → next catalog index build → live in Discover within a day.

**Gate 4 — Ongoing maintenance:**
- Each version bump needs a PR to update `item.yaml`.
- Security advisories get triaged and patched promptly (they monitor).
- Respond to user issues filed against the catalog entry.

Budget for first submission: ~1 week including review cycles. Worth
doing a few weeks after public launch once the compose distribution
has shaken out real-world issues.

### TrueCharts

Historically the dominant community catalog. Had a public
reorganization in 2024 that reshuffled priorities; current state
needs re-checking before targeting. Users who have the TrueCharts
catalog added still see its apps in Discover, so it's worth a
parallel submission if the overhead is low.

### Other catalogs to evaluate

- **Portainer templates** — their template catalog lets Portainer
  users install apps with a click. Low bar for inclusion.
- **Unraid Community Applications (CA)** — Unraid's equivalent to
  TrueNAS Discover. Similar process: submit a template XML.
- **CasaOS App Store** — growing homelab OS with a friendlier UI;
  docker-compose-based catalog.
- **Synology Community Packages** — harder target (Synology's own
  package format), but DSM has the biggest NAS install base. Defer
  to v1.1+.
- **Awesome-Selfhosted** — not a store, just a curated README list.
  Trivial PR, decent SEO boost once we're eligible ("self-hosted",
  "licensed").

### Pre-launch sanity check items

Before submitting to any catalog, make sure:
- Our image size is reasonable (< 150 MB target) — catalog reviewers
  push back on bloated images.
- First-boot experience works without manual docker exec (setup
  token flow is good here).
- Upgrade path from an older version works (schema migrations auto-
  apply, don't require user intervention).
- Clean uninstall leaves the user's data volume intact so they can
  reinstall without losing history.

Revisit this section once Phase 5 ships and we have a working image
to point reviewers at.

---

## Out of Scope for v1

- **Multi-server federation** (e.g., home server in Seattle syncing
  with home server in NYC). Too niche.
- **iOS / mobile apps** — those come later and will get Home Sync
  support then.
- **Admin UI web dashboard.** CLI-only for v1; a web UI is a v1.1
  addition if users want it.
- **Plugins / extensions.** Home Sync is a data-sync server, not an
  app platform.
- **Cloud ↔ Home two-way mirror.** Only one active target at a time.
- **TLS-terminating reverse proxy bundled in the image.** We document
  Caddy / Traefik setups but don't ship them inside our image; users
  who want that are already running their own proxy layer.
