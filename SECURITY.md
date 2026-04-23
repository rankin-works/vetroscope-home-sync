# Security Policy

## Supported versions

Vetroscope Home Sync is in early development. Until the first `1.0.0`
release, only the latest published tag on
`ghcr.io/rankin-works/vetroscope-home-sync` receives security fixes.
Once 1.0 ships, we'll support the current minor and the one before it.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | latest tag only    |
| 1.x     | TBD at 1.0 release |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security bugs.

Instead, email **support@vetroscope.com** with:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (or a proof-of-concept) if you have one.
- The version or commit you found it on.
- Your preferred contact for follow-up.

We'll acknowledge receipt within **3 business days** and aim to provide
an initial assessment within **7 days**. Once a fix ships, we'll
credit you in the release notes unless you prefer to stay anonymous.

## Scope

In scope:

- The Home Sync server in this repository (source + published Docker
  image).
- The authentication flow (setup token, JWT issuance, refresh rotation).
- The sync endpoints and anything touching user data at rest.

Out of scope:

- Issues that require physical access to the host the server is
  running on (e.g., reading `sync.db` from the filesystem). Home Sync
  encrypts sensitive fields client-side, but the threat model assumes
  the host itself is trusted by its operator.
- Vulnerabilities in reverse proxies, Docker itself, or the host OS.
- The Vetroscope desktop client — those go to `support@vetroscope.com`
  with a note that it's a client issue.

## Hardening recommendations

If you're running Home Sync yourself, please:

- Terminate TLS in front of the container (Caddy / Traefik / nginx) if
  you expose it beyond LAN.
- Keep the image updated — pull `:latest` or pin to a minor tag.
- Back up `/data/sync.db` regularly. The container ships a
  `vhs-backup` CLI (arriving in Phase 5).
