# Notes
- Preview (port 3000) = `apps/admin` Vite dashboard; API on port 4000 (`services/api`, tsx watch) with Postgres.
- DB init mounts `schema.sql` + `001_dev_seed.sql`; the API applies migrations 002+ at boot.
- A one-shot `install` service runs the npm workspace install (api/admin/shared only; mobile apps are skipped).
- Dev mode needs no secrets (JWT falls back, CORS open). Paystack/maps/storage keys are optional.
