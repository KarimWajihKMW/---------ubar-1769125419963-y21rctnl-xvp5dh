# ---------ubar-1769125419963-y21rctnl-xvp5dh
Super build for أعملي-زي-ubar-1769125419963

## Quick Start
- Setup & run: [QUICK_START.md](QUICK_START.md)

## Security + Wallet (v1)
- Plan/spec: [SECURITY_WALLET_PLAN.md](SECURITY_WALLET_PLAN.md)

Implemented in the app:
- Password hashing via `bcryptjs` (supports legacy plaintext + auto-upgrade on login)
- JWT auth (Authorization: Bearer token)
- RBAC for `admin` / `driver` / `passenger`
- Wallet ledger table `wallet_transactions` + self-view endpoints + admin credit/debit

## Local environment
- Copy `.env.example` → `.env` (never commit `.env`)
- Run: `npm install`
- Start: `npm start` (or `./scripts/run-dev.sh`)
- Test: `npm test`
