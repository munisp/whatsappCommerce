# TLS verification for infra clients (W42 / PLT-14)

The PG, Redis and OpenSearch clients verify server certificates by default
(`rejectUnauthorized: true`). The previous blanket
`rejectUnauthorized: false` accepted any certificate and was MITM-able.

## Private CA / self-signed deployments (the honest fix)

Provide your CA bundle — verification stays ON, your internal CA is trusted:

| Client | Env | Value |
| --- | --- | --- |
| Postgres | `PG_TLS_CA` | PEM bundle inline, or a readable file path |
| Redis (`rediss://`) | `REDIS_TLS_CA` | same |
| OpenSearch | `OPENSEARCH_TLS_CA` | same |

Example (file path, e.g. a mounted k8s secret):
`PG_TLS_CA=/run/secrets/ca.crt`

A `*_TLS_CA` value that is neither inline PEM nor a readable file makes the
client throw an honest error at connect time — it never silently falls back
to skipping verification.

## Dev-only escape hatch (insecure)

For local dev against a self-signed throwaway service you may set
`<PREFIX>_TLS_REJECT_UNAUTHORIZED=false` (`PG_…`, `REDIS_…`,
`OPENSEARCH_…`). This restores the old insecure behavior and logs a loud
warning on every client init. **Do not use in production or staging** — an
attacker between the platform and the datastore sees credentials and tenant
data. The right fix everywhere real is `*_TLS_CA`.

Note: TLS only activates when the connection itself is TLS — PG
`sslmode=require` URLs, `rediss://` Redis URLs, and `https://` OpenSearch
nodes. Plain `redis://` / non-SSL dev URLs are unaffected.
