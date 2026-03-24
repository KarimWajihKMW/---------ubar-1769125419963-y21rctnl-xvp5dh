# Akwadra Taxi App (Web + API)

This repo is a Node.js + Express app backed by PostgreSQL.

- Backend: [server.js](server.js) (Express + pg + JWT + Socket.IO)
- Frontend: static HTML/JS served from the repo root (the server uses `express.static('.')`)

## Run locally

### Requirements

- Node.js (npm)
- PostgreSQL

### Environment

- `DATABASE_URL` (required)
  - Example: `postgresql://postgres:password@localhost:5432/ubar_test`
- `PORT` (optional, default: `3000`)

Optional but recommended:

- `JWT_SECRET` (recommended)
  - If not set, the app derives a deterministic secret from `DATABASE_URL` (see [auth.js](auth.js)).
- `JWT_ACCESS_TTL_SECONDS` (optional, default: `86400`)

### Install + start

```bash
npm install
export DATABASE_URL='postgresql://...'
npm start
```

Open:

- `http://localhost:3000/start.html`
- or directly `http://localhost:3000/index.html`

## Production hardening

The server now includes:

- `helmet` security headers middleware
- API rate limiting on `/api/*` (configurable via env)

Related env vars:

- `API_RATE_LIMIT_MAX` (default: `500` requests/window)
- `API_RATE_LIMIT_WINDOW_MS` (default: `900000` = 15 minutes)
- `METRICS_TOKEN` (optional, protects `/metrics` on monolith)

## Docker deployment

Run with Docker Compose:

```bash
docker compose up --build -d
```

This starts:

- `app` on `:3000`
- `postgres` on `:5432`

Main files:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

## CI/CD

GitHub Actions workflow is included at:

- `.github/workflows/ci.yml`

Pipeline steps:

- install dependencies (`npm ci`)
- run build check (`npm run build`)
- run API tests (`npm test`) against a CI PostgreSQL service

## Microservices + API Gateway (new)

The repository now includes a modular microservices-ready architecture:

- `gateway/server.js` (API gateway + proxy routing)
- `services/trips-service/server.js`
- `services/payments-service/server.js`
- `docker-compose.microservices.yml`

Gateway routes:

- `GET /health`
- `GET|POST /api/ms/trips/*` -> Trips service
- `GET|POST /api/ms/payments/*` -> Payments service
- `* /api/*` -> fallback to monolith backend

Useful scripts:

- `npm run start:gateway`
- `npm run start:trips-service`
- `npm run start:payments-service`
- `npm run start:micro`
- `npm run micro:down`
- `npm run test:gateway`

## Monitoring and metrics

Prometheus-compatible metrics endpoints are available on:

- Monolith: `GET /metrics`
- API gateway: `GET /metrics`
- Trips service: `GET /metrics`
- Payments service: `GET /metrics`

Core metrics include request totals, latency histograms (monolith), and default Node.js process/runtime metrics.

## Kubernetes baseline

Production-oriented Kubernetes manifests are available under:

- `infra/k8s/`

Main resources include namespace, config, secrets template, deployments, services, ingress, and optional ServiceMonitor objects.

Deploy command:

```bash
npm run deploy:k8s
```

Or directly:

```bash
bash scripts/k8s-deploy.sh
```

## Backup and disaster recovery

Database backup/restore scripts are available:

- `npm run backup:db`
- `npm run restore:db -- ./backups/<file>.dump`

Requirements:

- `DATABASE_URL` must be set.
- PostgreSQL client tools (`pg_dump`, `pg_restore`) must be available.

Scripts:

- `scripts/backup-postgres.sh`
- `scripts/restore-postgres.sh`

## Alerting rules

Prometheus alert rules baseline is included:

- `infra/k8s/prometheus-rules.yaml`

It includes high-level alerts for:

- gateway error rate
- monolith P95 latency
- trips service down
- payments service down

## Terraform cloud baseline

AWS Terraform baseline is included under:

- `infra/terraform/`

Use:

```bash
cd infra/terraform
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

## Native mobile scaffolds (new)

Expo-based mobile app starters were added:

- `mobile/rider-app`
- `mobile/driver-app`

See `mobile/README.md` for quick start and expansion notes.

## How it works (high level)

### Static web app

The server serves all files in the repository root as static assets.

Main pages you’ll commonly use:

- [start.html](start.html): simple entry page
- [index.html](index.html): main UI (role-based passenger/driver/admin experience)
- [menu.html](menu.html): navigation hub
- [profile.html](profile.html): user profile + session/token handling
- [earnings.html](earnings.html): driver earnings/stats UI
- [pending-rides.html](pending-rides.html): pending ride requests UI (mainly admin)
- [passengers.html](passengers.html): passenger management UI (admin)
- [admin-driver-earnings.html](admin-driver-earnings.html): admin edit driver earnings
- [admin-risk-command.html](admin-risk-command.html): admin fraud/risk command center
- [admin-innovations.html](admin-innovations.html): admin innovations lab (10 approved exclusive features)
- [settings.html](settings.html), [support.html](support.html), [egypt-map.html](egypt-map.html)

Client-side API calls are centralized in [api-service.js](api-service.js).

### Authentication + roles

Auth is JWT-based.

- The client sends: `Authorization: Bearer <token>`
- The web UI stores the token in `localStorage` key: `akwadra_token`
- The server decodes JWT into `req.auth` for every request via `authMiddleware` (see [auth.js](auth.js))

Roles used throughout the API:

- `admin`
- `driver`
- `passenger`

Default admin users are auto-created on server startup if missing (see [server.js](server.js)).

### Database (conceptual)

The app uses PostgreSQL tables for:

- users/passengers/admins (login + profile)
- drivers + driver stats/earnings
- trips (ride lifecycle)
- pending ride requests (driver acceptance/rejection workflow)
- wallet transactions (ledger)

Exact schema is created/updated by scripts in the repo (examples: `setup-db.js`, migrations, and helper scripts).

## Core flows

### Passenger flow (request a ride)

1. Passenger logs in (JWT issued).
2. Passenger creates a trip via the API.
3. The backend stores the trip and (when applicable) creates/updates a corresponding pending-ride request.

Common endpoints:

- `POST /api/users/login` (phone login)
- `GET /api/trips` / `GET /api/trips/:id`
- `POST /api/trips` (create trip)
- `PATCH /api/trips/:id/status` (status updates)

### Driver flow (see + accept rides)

1. Driver logs in and gets a JWT.
2. Driver fetches pending rides suitable for them.
3. Driver accepts/rejects.
4. Driver updates location and trip status.

Common endpoints:

- `GET /api/drivers/:driver_id/pending-rides`
- `POST /api/pending-rides/:request_id/accept`
- `POST /api/pending-rides/:request_id/reject`
- `PATCH /api/drivers/:id/location`
- `GET /api/drivers/:id/stats`

### Admin flow

Admins can:

- View dashboard stats
- Manage users/passengers
- Approve driver registrations
- Edit driver earnings
- Manage wallet ledger credits/debits
- Operate fraud/risk features, alerts, locks, and scans

Common endpoints:

- `GET /api/admin/dashboard/stats`
- `GET /api/users` (admin-only)
- `GET /api/passengers` + `POST/PUT/DELETE /api/passengers/...`
- `GET /api/drivers/pending` + `PATCH /api/drivers/:id/approval`
- `PUT /api/drivers/:id/earnings/update`
- `POST /api/admin/wallet/transaction`
- `GET /api/admin/risk/features`
- `POST /api/admin/risk/scan`
- `GET /api/admin/risk/alerts`
- `POST /api/admin/risk/alerts/:id/decision`

Admin Innovations endpoints (exclusive features):

- `POST /api/admin/innovations/policy-twin/simulate`
- `GET /api/admin/innovations/city-pulse/genome?refresh=1`
- `POST /api/admin/innovations/trust-route/rebuild`
- `POST /api/admin/innovations/outcome-market/decision`
- `GET /api/admin/innovations/silent-crisis/predict`
- `POST /api/admin/innovations/recovery-composer/compose`
- `PATCH /api/admin/innovations/ethical-dial`
- `POST /api/admin/innovations/narrative-audit/build`
- `POST /api/admin/innovations/copilot-arena/session`
- `POST /api/admin/innovations/hub-rebalancer/rebalance`
- `GET /api/admin/innovations/kpis/summary`
- `GET /api/admin/innovations/roadmap`
- `GET /api/admin/innovations/compliance-report`
- `GET /api/admin/innovations/gaps`

Approved reference for these 10 features:

- [Mlf_ala8tra7at_administration_haged_ubar4](Mlf_ala8tra7at_administration_haged_ubar4)

Pre-commit verification for the approved admin innovations set:

```bash
npm run verify:admin-innovations
```

This command runs:

- `npm run test:admin-innovations` (API smoke test for all 10 approved features)
- `npm run build`

## Realtime + live updates

The backend runs Socket.IO on the same server (see [server.js](server.js)).

There is also a live snapshot endpoint:

- `GET /api/trips/:id/live` (trip + latest driver location)

## SaaS + multi-tenant layer (new)

The platform now includes a tenant-aware SaaS control layer with domain/header-based tenant resolution.

- Tenant context resolution:
  - Header: `x-tenant-key` (or `x-tenant-id`)
  - Domain mapping via `saas_tenant_domains`
- Tenant context endpoint:
  - `GET /api/saas/tenant/context`
- Usage metering endpoint:
  - `POST /api/saas/usage/events`

Admin SaaS control endpoints:

- `GET /api/admin/saas/tenants`
- `POST /api/admin/saas/tenants`
- `PATCH /api/admin/saas/tenants/:id`
- `PATCH /api/admin/saas/tenants/:id/branding`
- `GET /api/admin/saas/plans`
- `POST /api/admin/saas/plans`
- `POST /api/admin/saas/tenants/:id/subscription`
- `GET /api/admin/saas/tenants/:id/usage`
- `POST /api/admin/saas/tenants/:id/invoices/generate`
- `GET /api/admin/saas/tenants/:id/invoices`
- `PATCH /api/admin/saas/invoices/:id/status`
- `GET /api/admin/saas/invoices/:id/payments`
- `POST /api/admin/saas/invoices/:id/payments`
- `POST /api/saas/billing/webhooks/generic` (HMAC via `x-billing-signature`)

This supports isolated tenant config, white-label branding JSON, plan management, subscription state, usage tracking, and invoice lifecycle management.

## AI layer (new)

A production-safe AI layer (heuristic decision engine + auditable logs) is now available via:

- `POST /api/admin/ai/fraud-score`
- `POST /api/admin/ai/demand-forecast`
- `POST /api/admin/ai/pricing-recommendation`
- `POST /api/admin/ai/ticket-summarize`
- `GET /api/admin/ai/insights/overview`
- `POST /api/ai/assistant/query`

All AI outputs are logged in `ai_decision_logs` for governance and compliance review.

## Safety, sharing, and support (implemented endpoints)

The API includes additional modules that the UI can call:

- Trip share links: `POST /api/trips/:id/share` and `GET /api/share/:token`
- Emergency/help events: `/api/trips/:id/safety/...`
- Guardian check-in flow: `/api/trips/:id/guardian/...`
- Support tickets: `POST /api/support/tickets` (with optional file upload)

## OAuth (optional)

Google/Apple OAuth routes exist but only work when configured:

- `/api/oauth/google/login` + `/api/oauth/google/callback`
- `/api/oauth/apple/login` + `/api/oauth/apple/callback`
- Status endpoint: `GET /api/oauth/:provider/status`

## Tests

There’s no build step.

```bash
npm test
```

This runs:

- `node test-api.js`
- `node test-passenger-features.js`

For the exclusive admin innovations suite:

```bash
npm run test:admin-innovations
```
