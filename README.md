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

Common endpoints:

- `GET /api/admin/dashboard/stats`
- `GET /api/users` (admin-only)
- `GET /api/passengers` + `POST/PUT/DELETE /api/passengers/...`
- `GET /api/drivers/pending` + `PATCH /api/drivers/:id/approval`
- `PUT /api/drivers/:id/earnings/update`
- `POST /api/admin/wallet/transaction`

## Realtime + live updates

The backend runs Socket.IO on the same server (see [server.js](server.js)).

There is also a live snapshot endpoint:

- `GET /api/trips/:id/live` (trip + latest driver location)

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
