# Production Runbook

## Scope

This runbook covers production operations for gateway + monolith + microservices:

- trips-service
- payments-service
- ops-service
- ai-service
- saas-service
- events-service

## 1) Pre-deploy checklist

- Confirm CI is green for `main`.
- Confirm database backup completed in last 24h.
- Confirm rollback image tags are available.
- Confirm secret values are present in cluster (`ubar-secrets`).
- Confirm `DATABASE_URL`, `JWT_SECRET`, `BILLING_WEBHOOK_SECRET`, and metrics token are valid.

Run preflight locally (or in GitHub Actions manual workflow):

```bash
npm run preflight:prod
```

Sync Kubernetes secrets from environment values:

```bash
npm run sync:secrets:k8s
```

Run full local release gate:

```bash
npm run release:gate
```

Trigger GitHub production release gate workflow from terminal:

```bash
npm run trigger:prod:gate
```

Trigger with live smoke against deployed gateway:

```bash
RUN_LIVE_SMOKE=1 GATEWAY_BASE_URL=https://<gateway-host> npm run trigger:prod:gate
```

## 2) Deploy

```bash
bash scripts/k8s-deploy.sh
```

Verify rollout:

```bash
kubectl -n ubar get deploy
kubectl -n ubar rollout status deploy/api-gateway
kubectl -n ubar rollout status deploy/monolith
kubectl -n ubar rollout status deploy/trips-service
kubectl -n ubar rollout status deploy/payments-service
kubectl -n ubar rollout status deploy/ops-service
kubectl -n ubar rollout status deploy/ai-service
kubectl -n ubar rollout status deploy/saas-service
kubectl -n ubar rollout status deploy/events-service
```

## 3) Health checks

```bash
kubectl -n ubar port-forward svc/api-gateway 8080:80
curl -s http://localhost:8080/health
curl -s http://localhost:8080/api/ms/trips/health || true
curl -s http://localhost:8080/api/ms/payments/health || true
```

Run platform integration test from CI runner/workspace:

```bash
npm run test:gateway
```

## 4) Billing webhook verification

- Ensure provider sends webhook to gateway path routed to SaaS service:
  - `/api/ms/saas/billing/webhooks/provider`
- Validate signature using `BILLING_WEBHOOK_SECRET`.
- For test payloads, use the adapter signature logic in `services/saas-service/provider-adapter.js`.

## 5) Reconciliation procedure

Manual run:

```bash
curl -X POST http://<gateway-host>/api/ms/saas/billing/reconciliation/run \
  -H "x-role: admin" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Summary:

```bash
curl http://<gateway-host>/api/ms/saas/billing/reconciliation/summary \
  -H "x-role: admin"
```

## 6) Incident response quick actions

- Identify failing pods:

```bash
kubectl -n ubar get pods
kubectl -n ubar describe pod <pod-name>
kubectl -n ubar logs <pod-name> --tail=200
```

- Restart one deployment safely:

```bash
kubectl -n ubar rollout restart deploy/<deployment-name>
```

## 7) Rollback

Rollback a single deployment:

```bash
kubectl -n ubar rollout undo deploy/<deployment-name>
```

Check status:

```bash
kubectl -n ubar rollout status deploy/<deployment-name>
```

## 8) Backup and recovery

Create backup:

```bash
npm run backup:db
```

Restore backup:

```bash
npm run restore:db -- ./backups/<file>.dump
```

## 9) Post-deploy validation

- Metrics endpoints respond.
- Alert rules loaded and firing state reviewed.
- `npm run test:gateway` passes.
- Billing webhooks and reconciliation are healthy.
- Mobile clients can read gateway health and key APIs.
