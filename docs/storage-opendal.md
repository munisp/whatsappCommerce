# W67 — Apache OpenDAL storage layer

All server object/file storage goes through `server/services/opendalStorage.ts`,
a single facade over the official OpenDAL Node.js binding (npm `opendal`,
https://opendal.apache.org/). `server/storage.ts` is now a thin set of
delegates; its export signatures and semantics are unchanged.

## Backends (OPENDAL_SCHEME)

| Scheme | When | Root / bucket |
|---|---|---|
| `fs` | dev + simulation default | `OPENDAL_ROOT` (default `./data/opendal`) for the object namespace |
| `s3` | production / docker-compose / k8s | `OPENDAL_S3_BUCKET` (falls back to legacy `S3_BUCKET`, default `wacommerce`) |

**Fail-closed in production**: with `NODE_ENV=production` and
`OPENDAL_SCHEME` unset, the first storage operation throws instead of
silently guessing a backend. The `fs` fallback exists only outside prod.

### s3 env

```
OPENDAL_S3_ENDPOINT        # falls back to S3_ENDPOINT (bare host tolerated)
OPENDAL_S3_BUCKET          # falls back to S3_BUCKET
OPENDAL_S3_ACCESS_KEY_ID   # falls back to S3_ACCESS_KEY
OPENDAL_S3_SECRET_ACCESS_KEY  # falls back to S3_SECRET_KEY
OPENDAL_S3_REGION          # default us-east-1
```

Path-style addressing is used (no virtual-host style), so any
S3-compatible store (MinIO, Ceph, Garage, AWS) works. **Bucket provisioning
is an ops concern** — OpenDAL does not create buckets. docker-compose has a
`minio` + `minio-init` one-shot that creates `wacommerce`; k8s mirrors this
in `k8s/minio.yaml`. This fixes the previous dev-story gap where the root
compose had no MinIO and puts silently degraded.

## Presign caveats

Presigned URLs are per-backend:

- **s3**: native `presignRead`/`presignWrite` (used for WA media re-send to Meta).
- **fs**: no presign capability. `presignRead` falls back to the app-proxied
  `/api/storage/{key}` URL, which flows through the unchanged session /
  capability-token / public-namespace policy in
  `server/services/storageSecurity.ts` — identical to the old behavior when
  MinIO presign failed. `presignWrite` throws on fs; uploads keep going
  through the authenticated app endpoints (as before).

## What moved where (migration mapping)

| Pre-W67 touchpoint | Now |
|---|---|
| `server/storage.ts` MinIO client (`storagePut/Get/Delete/Serve`, signed URLs) | delegates to facade `put/presignRead/deleteObject/serveStream`; same return shapes |
| KYC/evidence/escrow/visual-inventory/whatsapp-media/wa-media/branding/product-images/generated/medusa-onboarding/uploads prefixes | unchanged keys + auth policy (`storageSecurity.ts` untouched) |
| `ucDocsPdf.writeDocPdf` (customer/proforma/commission/wallet PDFs) | async `docsPut("uc-docs", rel)`; fs scheme keeps the exact `UC_DOCS_DIR` layout |
| W58 wallet `manifest.json` RMW | `docsGet`/`docsPut` in the uc-docs namespace (same path on fs) |
| W33 supplier tax statements | `docsPut("tax-statements", rel)` under `TAX_STATEMENTS_DIR` (fs) |
| `GET /api/uc-docs/*` | streams via `docsGet`; auth + traversal guard unchanged |
| W66 lakehouse bronze JSON batches | `lakehousePut` — **always fs-rooted** at `LAKEHOUSE_DATA_DIR` (shared-root contract below) |
| few-shot JSONL append (intentMisses) | `jsonlAppend` (fs: native O_APPEND; s3: read-append-rewrite). DB claim-first semantics unchanged |
| WA webhook DLQ fallback JSONL | `jsonlAppend`/`jsonlReadAll`/`jsonlWriteAll`; replay truncation identical |
| `scripts/migrate-prod.ts` dump upload (second MinIO client) | `putToBucket(bucket, key, buf, creds)` |
| GDPR erasure (`kycPrivacy.storageDelete`) | unchanged call — idempotent delete, **throws on unreachable** (sweep retries) |

## Shared-root contract (lakehouse)

`services/ml-stack` (python) reads bronze partitions
(`bronze/<table>/dt=YYYY-MM-DD/batch-*.json`) and writes parquet from the
same directory the Node exporter writes to (`LAKEHOUSE_DATA_DIR`, default
`services/ml-stack/data/lakehouse`). Lakehouse output therefore stays on the
**fs backend even when `OPENDAL_SCHEME=s3`** — moving it to objects would
silently break the python dual-reader. If bronze ever moves to S3, migrate
`pipeline/lakehouse.py` in the same change.

## Sidecar decision (Rust/Python OpenDAL)

No sidecar does direct S3 I/O against the platform bucket:

- `hermes-router` (rust) DLQ appends to plain local files (`DLQ_DIR`) — not
  object storage; no `opendal` crate added.
- `ml-stack` (python) shares the lakehouse fs root (above); its MLflow
  artifacts use its own dedicated MinIO via boto-style env, unchanged.
- `kyc-verifier` only uses ephemeral tempfiles.

So no Rust/Python OpenDAL dependencies were introduced in W67.

## JSONL append semantics

Object stores have no append. On the fs scheme the JSONL helpers use native
`O_APPEND` (byte-identical to pre-W67). On s3 they do read-append-rewrite;
today's only writers either hold a DB claim first (intentMisses status flip)
or are single-writer fallback paths (webhook DLQ), so semantics are
preserved. High-contention appends should move to Postgres/Redis instead of
relying on this.

## Pinning note

`opendal` is pinned at `^0.47.8`: 0.49.x native binaries require
glibc ≥ 2.38; 0.47.8 runs on glibc 2.36 (Debian 12).
