# Home Sync Setup Guide

This walks through standing up a Vetroscope Home Sync server from
scratch and pointing the Vetroscope client at it. Budget ~15 minutes
for a fresh install; longer if you're also wiring up TLS or a reverse
proxy.

If you've never run a Docker container before, no sweat — the steps
below are copy-paste runnable on any host that has Docker installed
(a Synology NAS, a TrueNAS SCALE box, a Raspberry Pi, or an
always-on laptop).

## Prerequisites

- A host with Docker (version 20.10+) and Docker Compose v2.
- An account on that host that can run `docker` commands.
- A data directory on disk that you're okay persisting time-tracking
  data to. Examples: `/mnt/nas/vetroscope`, `/var/lib/vetroscope`.
  Home Sync creates `sync.db` + friends inside this directory.
- A Vetroscope Licensed or Pro client. Trial users can browse the
  Home Sync settings but the "Enable" toggle is locked.

## 1. Deploy the container

Grab the example compose file and adjust the volume mount:

```bash
curl -LO https://raw.githubusercontent.com/rankin-works/vetroscope-home-sync/main/docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

The defaults expose port `4437` on every interface of the host.
Leave that alone for a pure-LAN setup; see the [reverse-proxy
guide](reverse-proxy.md) if you're putting it behind Caddy / Traefik /
nginx.

Sanity check:

```bash
curl http://<host-ip>:4437/health
# → {"ok":true,"version":"…","users":0,"database_size_bytes":4096}
```

## 2. Grab the setup code

On first boot, the container prints a one-time setup code to its
logs:

```bash
docker compose logs vetroscope-home-sync | grep "Setup code"
# [home-sync]   Setup code: V7K2-9ABM-X4FT
```

Copy that code. It won't appear in logs again — the hash is wiped
from the database as soon as setup completes.

## 3. Bootstrap the admin account

Post the code plus the admin credentials you want:

```bash
curl -s -X POST http://<host-ip>:4437/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "setup_token": "V7K2-9ABM-X4FT",
    "email": "you@home.lan",
    "password": "a-long-strong-password",
    "display_name": "You"
  }'
```

The response includes a `user` object with `role: "admin"`. Once the
bootstrap admin is created, `/setup` returns `410 Gone` on any
further request.

> **Prefer the GUI?** The Vetroscope client (v0.3+) will walk you
> through this wizard-style from Settings → Sync → Home Sync, so you
> never have to touch curl. This guide exists for users who want to
> pre-flight the server before connecting a client.

## 4. Connect the Vetroscope client

On a Licensed or Pro client:

1. Open **Settings → Sync**.
2. Select **Home Sync**.
3. Paste `https://<host-ip>:4437` (or `http://` if you haven't wired
   up TLS yet — OK for LAN, never for the open internet).
4. Click **Continue**. The client hits `/health` and `/server-info`;
   a green check means you're talking to the right server.
5. Sign in with the admin credentials you set in step 3.
6. Follow the encryption setup — if you have an existing Vetroscope
   Cloud recovery code, paste it here to re-use the same E2E key.
7. First sync kicks off automatically.

You should see **Connected · 1 device · Last sync just now** in
Settings → Sync.

## 5. Invite another device or user

### Same account, additional device

On the second device, open Settings → Sync → Home Sync and sign in
with the same email/password. The server enforces the configured
device cap (`VS_MAX_DEVICES_PER_USER`, default 10).

### Additional user (household/small team)

From the admin account, mint an invite:

```bash
curl -s -X POST http://<host-ip>:4437/admin/invites \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"user","ttl_hours":24}'
# → {"id":"…","token":"HN10-SE0Z-7RYV","expires_at":"…","role":"user"}
```

Hand the `token` to your family member / teammate. On their client,
they paste it into the **Invite code** field on Home Sync sign-in.

## 6. Optional: TLS

Three choices, best to worst for internet-exposed setups:

1. **Reverse proxy (recommended).** See
   [reverse-proxy.md](reverse-proxy.md) for Caddy, Traefik, and
   nginx examples. Free Let's Encrypt certs, flexible routing, and
   Home Sync stays on plain HTTP inside your Docker network.
2. **Container-native TLS.** Mount a cert + key and set
   `VS_TLS_CERT` / `VS_TLS_KEY`. Simple, but you're responsible for
   cert rotation.
3. **No TLS.** Fine on a trusted LAN; never acceptable over the
   public internet.

## 7. Back up your data

The entire Home Sync state lives in a single directory (`/data`
inside the container, whatever you mounted outside). Snapshot that
directory however you already back up the rest of your NAS — rsync,
Time Machine, a Nextcloud-backup flow, Restic, whatever. The
`sync.db` file is SQLite in WAL mode; copying it while the server
runs is safe as long as you also grab `sync.db-wal` and
`sync.db-shm`, or run:

```bash
docker exec vetroscope-home-sync \
  sqlite3 /data/sync.db ".backup '/data/sync.db.bak'"
```

which writes a consistent point-in-time snapshot to `sync.db.bak`.

## Common next steps

- [Reverse-proxy setup](reverse-proxy.md)
- [Troubleshooting](troubleshooting.md)
- `docker exec vetroscope-home-sync vhs-cli help` — admin CLI (reset
  passwords, revoke tokens, promote users, rotate the JWT secret)
