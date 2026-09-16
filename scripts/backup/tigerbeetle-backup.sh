#!/usr/bin/env sh
# tigerbeetle-backup.sh — OFFLINE TigerBeetle data-file backup (W39, PLT-2).
#
# TigerBeetle 0.16.x has no snapshot/export API, and file-copying a RUNNING
# replica is crash-consistent only (torn tail possible). This script is the
# documented SAFE path: scale the single dev replica to 0, copy the data file
# from the PVC, scale back to 1.
#
# Honest scope:
#  - Dev overlay / maintenance-window use. Production ledger durability
#    requires a 3-replica TB cluster (VSR replication) — see
#    docs/RESILIENCE.md ("Backups (W39)" and "Multi-node TigerBeetle").
#  - The weekly cron-tigerbeetle-backup CronJob (k8s/backups.yaml #43) is a
#    crash-consistent safety net only; restores should prefer an offline copy
#    made by this script whenever one exists.
#
# Usage:
#   scripts/backup/tigerbeetle-backup.sh [namespace] [dest-dir]
# Defaults: namespace=whatsapp-commerce, dest=./tb-backups
set -eu

NS="${1:-whatsapp-commerce}"
DEST="${2:-./tb-backups}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DEPLOY=tigerbeetle
POD_LABEL="app=tigerbeetle"

mkdir -p "${DEST}"

echo "[tb-backup] scaling ${DEPLOY} to 0 in ${NS} (ledger briefly unavailable)"
kubectl -n "${NS}" scale deploy/"${DEPLOY}" --replicas=0
kubectl -n "${NS}" wait --for=delete pod -l "${POD_LABEL}" --timeout=120s || true

# Mount the PVC in a throwaway copy pod (RWO: TB must be down first).
echo "[tb-backup] copying /data/0_0.tigerbeetle from PVC tigerbeetle-data"
kubectl -n "${NS}" run "tb-backup-${TS}" --rm -i --restart=Never \
  --image=ghcr.io/tigerbeetle/tigerbeetle:0.16.40 \
  --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"tigerbeetle-data"}}],"containers":[{"name":"tb-backup","image":"ghcr.io/tigerbeetle/tigerbeetle:0.16.40","command":["sh","-c","cat /data/0_0.tigerbeetle"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}]}}' \
  > "${DEST}/0_0.tigerbeetle.${TS}"

echo "[tb-backup] restoring ${DEPLOY} to 1 replica"
kubectl -n "${NS}" scale deploy/"${DEPLOY}" --replicas=1
kubectl -n "${NS}" rollout status deploy/"${DEPLOY}" --timeout=180s

echo "[tb-backup] done: ${DEST}/0_0.tigerbeetle.${TS}"
echo "[tb-backup] restore = reverse: scale to 0, write file back to the PVC as 0_0.tigerbeetle, scale to 1."
