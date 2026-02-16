# Security + Wallet Ledger Implementation (v1)

## Goals
- Replace plaintext password checks with secure hashing.
- Add JWT authentication for Web + upcoming Mobile clients.
- Enforce role-based access control (RBAC) to reduce tampering.
- Add a wallet ledger (transactions table) with admin credit/debit and user self-view.

## What Changed
### Authentication
- Passwords are now stored as `bcrypt` hashes (via `bcryptjs`).
- `POST /api/auth/login` now:
  - Loads the user by email
  - Verifies password (supports legacy plaintext and bcrypt)
  - Auto-upgrades legacy plaintext passwords to bcrypt on successful login
  - Returns a JWT in `token`
- `POST /api/users/login` (phone-based) now returns a JWT in `token`.
- New endpoint: `GET /api/auth/me` (requires JWT) returns the current user.

### Token Usage
- Client sends `Authorization: Bearer <token>`.
- The Web client stores the token in `SafeStorage` under key `akwadra_token`.

### RBAC (Role-Based Access Control)
Roles used: `admin`, `driver`, `passenger`.

High-level rules applied:
- Admin-only: dashboard stats, users list, pending driver approvals, pending rides list/cleanup.
- Passenger: can only access their own passenger/user data and their own trips.
- Driver: can only access driver stats/earnings for their own `driver_id` and can only update their own location.

> Note: For driver accounts, the server attempts to attach `driver_id` in the JWT at login by matching the user email/phone against the `drivers` table.

## Wallet Ledger
### Database
New table:
- `wallet_transactions`
  - `owner_type`: `user` or `driver`
  - `owner_id`: integer id in the target table
  - `amount`: positive = credit, negative = debit
  - `currency`: defaults to `SAR`
  - metadata: `reason`, `reference_type`, `reference_id`, `created_by_user_id`, `created_by_role`

The server also updates the existing cached `balance` columns in `users` / `drivers` when admins create wallet transactions, for backward compatibility with existing UI.

### API
- `GET /api/wallet/me/balance` (JWT required)
- `GET /api/wallet/me/transactions?limit=&offset=` (JWT required)
- `POST /api/admin/wallet/transaction` (admin only)

## Environment Variables
- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: required for stable tokens across restarts (recommended). If not set, the server uses a random in-memory secret (tokens will break after restart).
- `JWT_ACCESS_TTL_SECONDS` (optional): default `86400` (24 hours).

## Testing
- `npm test` runs `node test-api.js`.
- The test now logs in as:
  - Admin (email/password) to test protected admin endpoints
  - Passenger (phone login) to test wallet self endpoints

## Security Notes
- Any database URL / password shared publicly should be treated as compromised and rotated.
- The wallet ledger is append-only by design; adjustments are created as new transactions.
