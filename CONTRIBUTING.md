# Contributing to Vetroscope Home Sync

Thanks for your interest! This is the self-hosted sync backend for
[Vetroscope](https://vetroscope.com). Contributions — bug reports,
packaging improvements, NAS-specific quirks, doc fixes — are welcome.

## Before you start

- For non-trivial changes, open an issue first so we can agree on the
  approach. Small fixes can skip straight to a PR.
- Check `docs/architecture.md` for the design rationale. If a proposed
  change conflicts with the architecture (e.g., "let's add server-side
  search"), it probably won't land as-is — the architecture exists for
  reasons that took a while to sort through.

## Development setup

Requirements: Node.js 20.11+, a C toolchain for `better-sqlite3`
(`build-essential` on Debian/Ubuntu, Xcode Command Line Tools on macOS).

```bash
git clone https://github.com/rankin-works/vetroscope-home-sync.git
cd vetroscope-home-sync
npm install
npm run dev
```

The dev server writes its SQLite DB to `./data/sync.db` by default —
override with `VS_DATA_DIR=…`. First boot prints a one-time setup
code; look for the banner in the terminal.

Common tasks:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest
npm run build         # tsc + copy SQL assets to dist/
```

## What compatibility means here

Home Sync is one of several targets a Vetroscope client can sync against.
What it shares with the others is the **wire format**: the request and
response shapes in `src/types.ts`, the endpoint paths, and the convergence
rules documented at the top of `src/routes/sync.ts`. A client points at a
base URL and sends the same documents it would anywhere else.

What it does not share is an implementation. This server is its own
codebase with its own bugs, its own fixes, and its own release cadence.
Don't assume a behavior is correct here because it's correct somewhere
else, and don't describe the two as the same code — that assumption has
already let a fix land in one place and not the other.

Practically:

- Adding a field to a payload type is a compatibility change. Keep it
  optional so older clients and servers still parse the document.
- Changing convergence semantics (what wins on conflict, what a cursor
  means) is a compatibility change even when no type moves.
- Changing how a handler is implemented is not.

## Tenant isolation

Any table that replicates user data must be scoped by `user_id` on both
read and write. For tables keyed on a bare client-generated `uuid`, the
key space is shared across every account on the server, so the conflict
clause must also require the existing row to belong to the caller:

```sql
ON CONFLICT(uuid) DO UPDATE SET ...
WHERE <table>.user_id = excluded.user_id
  AND excluded.updated_at > <table>.updated_at
```

`src/__tests__/tenant-isolation.test.ts` is table-driven with one case per
uuid-keyed table. Adding a replicated table means adding a case — a
missing entry there is the review signal that scoping was skipped.

## Code style

- TypeScript, strict mode, ESM. Target Node 20.
- Every new source file gets `// SPDX-License-Identifier: Apache-2.0`
  at the top.
- Prettier + ESLint configs live at the repo root — editors should
  pick them up automatically.
- Prefer small, focused modules. Route handlers, helpers, and
  migrations are cheap to add; shared abstractions should earn their
  keep.

## Commit conventions

- Subject line: imperative, under 72 chars, sentence case
  (`Add sync/push endpoint with LWW upsert`).
- Body: wrap at 72 chars. Explain **why**, not **what** — the diff
  shows what.
- One logical change per commit. Follow-up refactors in separate
  commits, please.

### No Claude trailers

**Do not include `Co-Authored-By: Claude <…>` trailers on commits.**
AI-assisted work is fine behind the scenes, but the public git history
should show human authorship only. A `commit-msg` hook installed via
`npm install` enforces this locally — if it rejects your commit, drop
the trailer and try again.

## Pull requests

- Target `main`. Rebase rather than merge when resolving conflicts.
- Include tests for behavior changes. New routes need at least a happy
  path + one failure path.
- Link the related issue if there is one.
- CI must pass before review. If you're stuck on a failure that looks
  unrelated, ping us in the PR thread.

## Licensing

This project is Apache-2.0. By submitting a PR you agree your
contribution is licensed under the same terms. If you're pulling in
third-party code, make sure its license is compatible (MIT, BSD, ISC,
Apache-2.0 are all fine; GPL / AGPL / SSPL aren't) and preserve its
attribution in `NOTICE`.

## Reporting security issues

Please don't file public issues for security bugs. See
[`SECURITY.md`](SECURITY.md) for the private disclosure channel.
