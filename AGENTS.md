# SwiftDrop — Base44 dev environment

## Stack

- **API** (`services/api`): Express 5 + TypeScript, runs on port 4000 via `tsx watch`. Uses PostgreSQL (`pg`). Self-contained — does not import `@swiftdrop/shared`.
- **Admin dashboard** (`apps/admin`): Vite + React 19 SPA, served on port 5173 (mapped to host 3000). Calls the API at `VITE_API_URL`.
- **Customer / Driver** (`apps/customer`, `apps/driver`): Expo mobile apps — not run in the web preview.
- **Shared** (`packages/shared`): domain types, not imported by the API or admin at runtime.

## Database setup (important)

The API runs migrations `002`–`028` from `services/api/src/database/migrations/` on boot via `runMigrations()`, but the **base schema** (`services/api/src/database/schema.sql`, which creates `users`, `drivers`, `deliveries`, `payments`, etc.) is **not** in the migration list. A one-shot `db-init` compose service applies `schema.sql` + `001_dev_seed.sql` and creates an admin user **before** the API starts. The API `depends_on: db-init (service_completed_successfully)`.

## Admin login (development)

The dev seed creates an admin account so the dashboard is usable:

- Phone: `+2348000000000`
- Password: `swiftdrop-admin`

The seed file lives in `/tmp/swiftdrop/seed.mjs` (outside the repo) and is mounted into the `db-init` container.

## Environment

- `NODE_ENV` is left as `development` so `validateProductionConfig()` does not enforce production-only vars (Paystack, Supabase, HTTPS CORS).
- `JWT_SECRET` is generated as a development secret; the API also falls back to `development-only-change-me` if absent.
- Private file storage uses the local filesystem (`LOCAL_PRIVATE_STORAGE_DIR`) in dev — no Supabase needed.
- Maps (`MAPS_API_KEY`) and Paystack (`PAYSTACK_SECRET_KEY`) are optional in dev; quotes/payments degrade gracefully without them.

## Verify it works

```sh
docker compose -f docker-compose.base44.yml up -d --build
docker compose -f docker-compose.base44.yml ps
curl -sf http://localhost:8000/health        # API
curl -sf http://localhost:3000/              # admin SPA
```

Then open the preview, log in with the admin credentials above.

## Tests

```sh
docker compose -f docker-compose.base44.yml exec api sh -c "cd services/api && npm test"
```
