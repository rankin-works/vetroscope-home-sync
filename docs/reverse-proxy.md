# Reverse Proxy Configurations

Home Sync runs plain HTTP on `4437` by default. For anything more
than a pure-LAN setup, put a reverse proxy in front of it. Every
example below assumes the Home Sync container is reachable on the
same Docker network as the proxy; adapt the hostnames for your
deployment.

## Caddy

Easiest path to Let's Encrypt automation.

```caddyfile
vetroscope.home.example.com {
  reverse_proxy vetroscope-home-sync:4437
  encode gzip zstd
}
```

Docker Compose snippet (add alongside the Home Sync service):

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

  vetroscope-home-sync:
    image: ghcr.io/rankin-works/vetroscope-home-sync:latest
    restart: unless-stopped
    # no `ports:` — Caddy is the only thing exposed to the outside
    volumes:
      - vetroscope-data:/data

volumes:
  caddy-data:
  caddy-config:
  vetroscope-data:
```

Point `vetroscope.home.example.com` at your public IP; Caddy will
grab a cert on first hit. On a DNS you control locally (Pi-hole,
Unbound, router rewrite), you can use the same flow against a
private name.

## Traefik v3

For stacks that already use Traefik as the shared ingress. Labels
live on the `vetroscope-home-sync` service:

```yaml
services:
  vetroscope-home-sync:
    image: ghcr.io/rankin-works/vetroscope-home-sync:latest
    restart: unless-stopped
    volumes:
      - vetroscope-data:/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.vetroscope.rule=Host(`vetroscope.home.example.com`)"
      - "traefik.http.routers.vetroscope.entrypoints=websecure"
      - "traefik.http.routers.vetroscope.tls.certresolver=letsencrypt"
      - "traefik.http.services.vetroscope.loadbalancer.server.port=4437"
```

Traefik's dashboard should show a new router once the container
starts.

## nginx

Static config; no automatic certs. Pair with `certbot` or a cert
lifecycle tool of your choice.

```nginx
upstream vetroscope_home_sync {
    server vetroscope-home-sync:4437;
    keepalive 16;
}

server {
    listen 443 ssl http2;
    server_name vetroscope.home.example.com;

    ssl_certificate     /etc/letsencrypt/live/vetroscope.home.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vetroscope.home.example.com/privkey.pem;

    client_max_body_size 20m;  # icon payloads can be chunky

    location / {
        proxy_pass         http://vetroscope_home_sync;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name vetroscope.home.example.com;
    return 301 https://$host$request_uri;
}
```

## Tell the server it's behind a proxy

Whichever proxy you use, set `VS_TRUST_PROXY=true` on the container:

```yaml
environment:
  VS_TRUST_PROXY: "true"
```

Without it the server treats every request as coming from the proxy,
because that is literally the address it sees. Logs then show the proxy
for every client, and — more importantly — the rate limiter puts all of
your devices in one bucket, so several devices signing in at once can
trip a 429 meant for one attacker. The server logs a warning the first
time it sees an `X-Forwarded-For` it has been told to ignore.

**Only set it when a proxy really is in front.** The header is just a
request header: anyone who can reach the server directly can put whatever
they like in it. With it trusted and no proxy in the way, a caller can
change the value on every request and get a fresh rate-limit bucket each
time, which removes the cap on password and setup-code guessing. That is
why it is off by default and opt-in rather than the reverse.

If only some upstreams should be believed, the variable also accepts a
hop count (`VS_TRUST_PROXY=1`) or a comma-separated address/CIDR
allowlist (`VS_TRUST_PROXY=10.0.0.0/8,172.16.0.0/12`).

## Cloudflare Tunnel

If you'd rather not open a port on your router, a Cloudflare Tunnel
works transparently:

```bash
cloudflared tunnel create vetroscope
cloudflared tunnel route dns vetroscope vetroscope.home.example.com
cloudflared tunnel --config config.yml run vetroscope
```

Minimal `config.yml`:

```yaml
tunnel: vetroscope
credentials-file: /etc/cloudflared/<uuid>.json
ingress:
  - hostname: vetroscope.home.example.com
    service: http://vetroscope-home-sync:4437
  - service: http_status:404
```

This is handy for offsite access without reconfiguring your ISP's
NAT.

## TLS inside the container

If you really want Home Sync itself to terminate TLS (no proxy
layer), mount a cert + key and set both env vars:

```yaml
services:
  vetroscope-home-sync:
    image: ghcr.io/rankin-works/vetroscope-home-sync:latest
    environment:
      VS_TLS_CERT: /certs/server.crt
      VS_TLS_KEY:  /certs/server.key
    volumes:
      - /etc/letsencrypt/live/vetroscope.home.example.com:/certs:ro
    ports:
      - "4437:4437"
```

You'll still have to renew the cert; Home Sync does not run
`certbot` inside the image.

## Self-signed certs

LAN-only setups can get away with a self-signed cert. The
Vetroscope client offers a "Trust this certificate for this server"
prompt on first connection, with the fingerprint displayed for you
to verify out-of-band. If you don't recognize the fingerprint when
the prompt appears, **do not trust it** — someone may be
intercepting the connection.
