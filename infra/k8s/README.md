# Kubernetes Deployment

This directory contains a production-oriented Kubernetes baseline for Ubar services.

## Files

- `namespace.yaml`
- `configmap.yaml`
- `secret.example.yaml`
- `postgres.yaml`
- `monolith.yaml`
- `trips-service.yaml`
- `payments-service.yaml`
- `ops-service.yaml`
- `ai-service.yaml`
- `saas-service.yaml`
- `events-service.yaml`
- `gateway.yaml`
- `ingress.yaml`
- `monitoring-servicemonitors.yaml`

## Apply

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/secret.example.yaml
kubectl apply -f infra/k8s/postgres.yaml
kubectl apply -f infra/k8s/monolith.yaml
kubectl apply -f infra/k8s/trips-service.yaml
kubectl apply -f infra/k8s/payments-service.yaml
kubectl apply -f infra/k8s/ops-service.yaml
kubectl apply -f infra/k8s/ai-service.yaml
kubectl apply -f infra/k8s/saas-service.yaml
kubectl apply -f infra/k8s/events-service.yaml
kubectl apply -f infra/k8s/gateway.yaml
kubectl apply -f infra/k8s/ingress.yaml
```

If Prometheus Operator is installed:

```bash
kubectl apply -f infra/k8s/monitoring-servicemonitors.yaml
```

## Notes

- Replace image names with your registry tags.
- Replace `secret.example.yaml` with real secrets in your cluster.
- Lock down `/metrics` using `METRICS_TOKEN` and scrape via secure headers.
