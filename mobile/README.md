# Mobile Apps Scaffold

This folder contains production-ready starting points for native mobile apps:

- `rider-app/` (Passenger app)
- `driver-app/` (Captain app)

## Quick start

```bash
cd mobile/rider-app && npm install && npm start
cd mobile/driver-app && npm install && npm start
```

Optional environment variable for both apps:

- `EXPO_PUBLIC_API_BASE_URL` (default: `http://localhost:8080`)

Example:

```bash
export EXPO_PUBLIC_API_BASE_URL=http://localhost:8080
```

Both apps are Expo-based scaffolds and should be expanded with:

- Authentication + secure token storage
- Live map + GPS tracking
- Trip lifecycle socket sync
- Wallet/payments screens
- Push notifications and deep links
