# Troubleshooting

Common issues and how to triage them. If something isn't covered
here, open an issue at
[rankin-works/vetroscope-home-sync](https://github.com/rankin-works/vetroscope-home-sync/issues).

## The client can't reach the server

1. Can you `curl http://<host-ip>:4437/health` from another machine
   on the same network? If not, the container isn't listening where
   you think it is. Double-check `docker compose ps` — the port
   mapping should show `0.0.0.0:4437->4437/tcp` (or whatever host
   port you picked).
2. Firewall: `ufw`, `firewalld`, macOS's built-in, or the router's
   LAN-AP isolation setting will happily block a working server.
3. On a Synology NAS, the built-in firewall often needs an explicit
   "allow 4437" rule even on the same subnet.

## `invalid_setup_token` when running /setup

The setup code is:

- **One-time.** Once `/setup` succeeds, the hash is wiped. If you
  see `setup_already_completed` (HTTP 410), you already ran it.
- **Case-sensitive at the DB level, but we upper-case incoming
  tokens** for the Crockford base32 alphabet. Spaces and hyphens are
  part of the display format; `V7K2-9ABM-X4FT` works, `V7K29ABMX4FT`
  does too.
- **Per-installation.** A code from one container won't verify
  against another. If you redeployed the container without keeping
  the `/data` volume, you've lost the original code — see "I lost
  the setup code" below.

## I lost the setup code before running /setup

The code only exists in container logs and isn't recoverable.
Easiest path:

```bash
docker compose down
rm /path/to/vetroscope-data/sync.db  # or whatever you mounted
docker compose up -d
docker compose logs vetroscope-home-sync | grep "Setup code"
```

This deletes the (empty) database and triggers a fresh first-boot.
**Only do this if there's nothing in the DB you care about.**

## I lost the admin password

Use the in-container CLI. It doesn't need a password of its own —
anyone with `docker exec` on the host is implicitly trusted.

```bash
docker exec vetroscope-home-sync vhs-cli reset-password \
  --email you@home.lan \
  --password 'your-new-password'
```

This also revokes every active refresh token for that user, so any
device that was signed in will have to re-authenticate.

## The client says "device limit reached"

Bump `VS_MAX_DEVICES_PER_USER` (default 10) in your compose file
and `docker compose up -d`. Or unlink an old device from Settings →
Sync → Devices on any still-active client.

## Certificate / TLS errors in the client

If you're using a self-signed cert, the client shows a fingerprint
on first connection and asks you to trust it. Verify the
fingerprint out-of-band (`openssl x509 -in cert.pem -fingerprint -sha256`
on the server) before clicking trust.

If you're using a Let's Encrypt cert behind Caddy / Traefik, make
sure the hostname you're typing into the client matches the cert's
CN/SAN exactly.

## Home Sync is slow / sync is taking forever on first run

The initial push from a device with years of history can be on the
order of hundreds of thousands of rows. Home Sync batches requests
client-side (500 rows per `/sync/push`); a full catch-up typically
completes in a few minutes. If it stalls for longer than ten
minutes, grab `docker compose logs vetroscope-home-sync` — any SQL
error will land there.

## "database is locked" in the logs

SQLite's WAL mode plus the 5s `busy_timeout` means this should be
rare. If you see it frequently:

- Check that you're not running the CLI and the server against the
  same DB in a way that pins a long transaction (the CLI never
  should, but a user script might).
- If you've got more than ~5 clients pushing concurrently on
  low-end hardware (Raspberry Pi 3, old Synology), you might need
  to stagger their sync intervals. v1 doesn't offer a server-side
  knob for this; file an issue with your scenario.

## Resetting a user's cloud-side data

```bash
# Option A: client-initiated — Settings → Sync → Reset cloud data
# Option B: admin CLI — wipes rows and revokes tokens
docker exec vetroscope-home-sync vhs-cli revoke-tokens --email user@home.lan
```

There's no CLI subcommand to wipe sync rows for a specific user
directly; the `/sync/reset` endpoint is the supported path.

## Rotating the JWT secret

Only necessary if you think the secret has leaked (e.g., you
published your `/data` volume somewhere by mistake):

```bash
docker exec vetroscope-home-sync vhs-cli rotate-jwt-secret --confirm
```

This invalidates every active session across every device. Users
will have to sign in again. Refresh tokens are wiped too.

## Upgrading the container

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on startup. If a migration fails
partway, the transaction rolls back — the next start will retry. If
it keeps failing, open an issue with the log output and the version
you're upgrading from.

## Getting help

- **Bugs / feature requests:** GitHub issues on this repo.
- **Security issues:** `security@vetroscope.com` — see
  [SECURITY.md](../SECURITY.md).
- **Conduct concerns:** `conduct@vetroscope.com`.
