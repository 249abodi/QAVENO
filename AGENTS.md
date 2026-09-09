# AGENTS.md

QAVENO — POS & inventory desktop app + cloud backend + static marketing site. No framework in the renderer, no bundler, no shared build. Three independent deployables in one repo.

## Layout

- `src/` — Electron desktop app (CommonJS, plain JS). Main process in `src/main/*.js`; renderer is plain HTML/JS/CSS per window under `src/renderer/{login,cashier,admin,owner}/`. UI is Arabic RTL.
- `backend/` — NestJS + PostgreSQL + TypeORM (TypeScript). Global API prefix `api/v1`; domain modules under `src/modules/`.
- `website/` and `owner-portal/` — separate static Vercel projects. `owner-portal/app.js` hard-codes the production API `https://qaveno-production.up.railway.app/api/v1`.
- `tests/` — ad-hoc Node scripts (no test framework, no Electron), run from repo root against a temp SQLite DB.
- `scripts/` — deploy/audit/health-check helpers. Backend CI + desktop builds live in `.github/workflows/release.yml`.

## Desktop app (root)

- Requires Node 22+ (uses builtin `node:sqlite` `DatabaseSync`; no `sqlite3` dep). CI pins Node 22.
- DB lives at `data/pos.db`; schema/migrations are hand-maintained in `src/main/migrations.js` (not auto-run via TypeORM).
- Run: `npm start`. Package: `npm run build` → NSIS installer in `dist-electron/`.
- Offline-first cloud sync: local op → `src/main/db.js` → outbox (`src/main/cloud/outbox.js`) → sync engine (`src/main/cloud/sync.js`) → NestJS API.
- Tests are pure Node (no Electron) and each boots its own temp DB: `npm run smoke-test` (core business logic), or the per-module `-test` scripts (`auth`, `suppliers`, `purchases`, `inventory`, `branches`, `transfers`, `license`, `currencies`). Full gate: `npm test` (also runs `sync`, `website`, `owner-portal` tests).
- `tests/website.test.js` and `tests/owner-portal.test.js` are **static string assertions** on HTML/JS — not browser tests. `tests/owner-portal.browser.js` is the Playwright browser test.

## Backend

- Build: `npm run build` (`tsc -p tsconfig.build.json`). Dev: `npm run start:dev`.
- `synchronize` is off — after schema changes, run `npm run migration:run` (migrations in `src/database/migrations/`).
- `npm test` = e2e only; `npm run test:unit` for `*.spec.ts`.
- E2E boots the full app against a real Postgres: locally spawns `@embedded-postgres/windows-x64` (port 55432) on Windows, or uses the CI service Postgres when `CI=true` + `POSTGRES_HOST` are set (`backend/test/bootstrap-pg.ts`). On non-Windows dev it fails unless you provide a Postgres. Tests reset DB state and seed org/branch/subscription themselves.
- Production refuses to boot on missing/weak DB credentials or a short `JWT_SECRET` (`backend/src/database/data-source.ts`, `backend/src/main.ts`).
- `npm run import:snapshot -- --sqlite=path/to/pos.db` imports a desktop SQLite DB into Postgres preserving IDs.

## Releasing (version-bump gotcha)

- Releasing = tag `v*` → CI builds the Windows installer and publishes a GitHub release (electron-builder configured for `249abodi/QAVENO`). Desktop auto-updates via electron-updater from those releases.
- Bumping the desktop version requires updating **both** `website/index.html` download URL and the matching literal-URL assertion in `tests/website.test.js` (e.g. `releases/download/v1.1.0/QAVENO-Setup-1.1.0.exe`); otherwise `npm test` fails.

## Env

- Root `.env.example` documents backend/Postgres vars (`POSTGRES_*`, `JWT_SECRET`, `CORS_ORIGINS`, `QAVENO_TRIAL_SECRET`). `website/` and `owner-portal/` each carry their own `.env.local`.
- `docker-compose.yml` runs postgres + backend and requires `POSTGRES_PASSWORD`, `JWT_SECRET`, `QAVENO_TRIAL_SECRET` set in the environment.

There is no lint/format/typecheck command configured anywhere in the repo.