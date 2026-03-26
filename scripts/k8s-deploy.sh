#!/usr/bin/env bash
set -euo pipefail

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

echo "Kubernetes baseline deployment applied."
