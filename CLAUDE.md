# CLAUDE.md

This file gives Claude Code (claude.ai/code) guidance for working in this repository.

## What this is

Ledgerly, a small ERP for a cardboard factory (dashboard title "СП Shoxina Prestij"). It tracks raw materials, production batches, finished-goods stock, sales to clients, purchases from suppliers, payments in both directions, and extra expenses. All UI text and API error messages are in **Russian**, and new strings should be too. Money is UZS and quantities are kilograms.

## Commands

Bun is the runtime and package manager.

- `bun run dev` starts the API (`server.ts` on :8790, watch mode) and Vite (:5180, which proxies `/api` to :8790)
- `bun run dev:api` / `bun run dev:web` start either half on its own
- `bun run build` runs `tsc -b && vite build`, which is also the typecheck
- `bun run lint` runs oxlint
- `bun run start` serves the built `dist/` and the API from one Bun process
- `bun run scripts/reset-ledger.ts [--apply]` wipes all operations from Turso. Without `--apply` it is a dry run. With it, it writes a `ledger-backup-*.json` first. Materials are kept.

There is no test suite.

The API needs `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env` (see `.env.example`). `lib/ledger.ts` throws at import time without them. The app always talks to the remote Turso database, so local dev writes to real data.

## Architecture

Three code files hold nearly everything:

- **`lib/ledger.ts`**: the whole backend. It holds the schema, the migrations, and a hand-rolled router (`handleApi`) that matches `url.pathname` and method in sequence. `idFrom(url, prefix)` extracts `/api/<prefix>/:id`. Two entry points share it:
  - `server.ts`: Bun server for local dev and `bun start`
  - `api/[...path].ts`: Vercel catch-all function. It must stay on the **Node runtime, not edge** (libsql pulls in `ws`), and it imports `../lib/ledger.js` with a `.js` extension on purpose. See the comments in that file.
- **`src/App.tsx`**: the whole frontend. It holds the layout shell, every page component (`Overview`, `Inventory`, `Production`, `Clients`/`Suppliers` via `PeoplePage`, `PersonProfile`, `Products`, `Expenses`, `Ledger`), one generic `Modal` form keyed by `Kind`, and `Confirm` for deletes. Routes are declared in `src/main.tsx`. `src/Link.tsx` wraps react-router's `Link`/`NavLink` with view transitions.

### Data flow

- The frontend loads everything with one `GET /api/snapshot` into a context (`LedgerCtx`/`useLedger`). After any successful write, `done()` re-fetches the full snapshot. There is no per-entity fetching or client cache.
- `snapshot()` uses a single `db.batch` because the database is remote and round trips are expensive. Keep new reads inside that batch. Lists are capped at 500 rows.
- CRUD endpoints: `/api/{people,products,materials,expenses,production,intake,transactions}` with `POST` on the collection and `PATCH`/`DELETE` on `/:id`.

### Domain model and invariants

- `clients` holds **both clients and suppliers**, distinguished by `person_type`. The FK column is `transactions.client_id` for both. A person's type can't change once they have transactions.
- `transactions.kind` is one of `sale` / `client_payment` (clients only) or `purchase` / `supplier_payment` (suppliers only). Person balance = payments − (sales + purchases). Negative means someone owes money.
- My balance = client payments − purchases − expenses.
- **Stock is never stored; it is derived.** Material stock = purchases + `stock_intake` − `production_inputs`. Product stock = production output − sales. See `MATERIAL_SQL` / `PRODUCT_SQL`.
- Every write that affects stock goes through `mutate()`. It runs the work in a write transaction, recomputes all stock, and rolls back if anything goes negative. Edits pass `skipId` to `buildTx`/`buildRun` so a row's own consumption counts as available. The frontend mirrors this (`ownSale`, `ownUse`, `ownIntake`) to validate before submit.
- Deletes of people, products, and materials are refused while dependent operations exist, rather than cascading.
- Money is stored as integer `*_cents` (UZS × 100). Quantities are `REAL` kg, compared with `EPSILON = 1e-9`.
- `production_inputs` are deleted explicitly before their run. Don't rely on `ON DELETE CASCADE`, because `PRAGMA foreign_keys` is per connection.

### Schema changes

`ensureSchema()` runs once per process. It **skips all DDL if the `stock_intake` table exists**, since that is the newest table. If you add a table or migration, update that sentinel check to the new table, or `createSchema()` will never run against existing databases. The DDL uses `CREATE ... IF NOT EXISTS` and idempotent `UPDATE`/`INSERT OR IGNORE` statements. Seeded materials: Крахмал (`kraxmal`), Краситель (`color`), Макулатура (`makulatura`).

## Code style

- `src/App.tsx` and `lib/ledger.ts` use a dense, compact style: minimal whitespace, one-line functions, chained ternaries, and inline JSX. Match it in those files rather than reformatting them. `src/Link.tsx`, `api/`, and `scripts/` use conventional formatting.
- Comments are sparse and explain *why*: a non-obvious constraint or runtime quirk.
- Commit messages are a short imperative subject, often with a colon clause giving the reason (e.g. "Run the API function on Node, not edge: libsql drags in `ws`").
