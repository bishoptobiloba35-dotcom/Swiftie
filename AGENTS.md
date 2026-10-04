# Notes
- Preview (port 3000) = `apps/admin` Vite dashboard; API on port 4000 (`services/api`, tsx watch) with Postgres.
- DB init mounts `schema.sql` + `001_dev_seed.sql`; the API applies migrations 002+ at boot.
- A one-shot `install` service runs the npm workspace install (api/admin/shared only; mobile apps are skipped).
- Dev mode needs no secrets (JWT falls back, CORS open). Paystack/maps/storage keys are optional.
- Ports: 3000 customer (Expo web, preview), 3001 driver (Expo web), 3002 admin (Vite), 4000 API. Public URL pattern: https://<port>-$BASE44_PUBLIC_HOST_SUFFIX.
- Mobile apps run via Expo web (react-native-web); apps/customer/metro.config.js stubs react-native-maps on web. Entry is each app's index.js (registerRootComponent).
