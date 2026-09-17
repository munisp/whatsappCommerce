# Secrets master-key rotation runbook (W42 / PLT-9)

`server/services/crypto/secrets.ts` encrypts tenant secrets at rest with
AES-256-GCM under a **versioned keyring**. Ciphertexts are addressed by key
id: `v2:<kid>:<iv>:<tag>:<ct>` (legacy: `v1:<iv>:<tag>:<ct>`, readable by any
ring key). Readers decrypt **any generation present in the ring**; writers
always use the **current kid**.

## Env contract

| Var | Meaning |
| --- | --- |
| `SECRETS_MASTER_KEY` | Legacy single key (base64, 32 bytes). Registered as kid `SECRETS_MASTER_KEY_ID` (default `k1`). Still supported on its own. |
| `SECRETS_MASTER_KEYRING` | JSON `{"k1":"…","k2":"…"}` or `k1=…,k2=…`. Holds every live generation. |
| `SECRETS_MASTER_KEY_ID` | Kid used for **new writes**. Must exist in the ring. |

Generate a key: `openssl rand -base64 32`.

## Rotation procedure (zero-downtime)

1. **Add the new key, keep the old.** Set
   `SECRETS_MASTER_KEYRING='{"k1":"<old>","k2":"<new>"}'` and
   `SECRETS_MASTER_KEY_ID=k1` (still old). Roll out. All reads work; nothing
   changes on write yet.
2. **Flip the write generation.** Set `SECRETS_MASTER_KEY_ID=k2` and unset
   `SECRETS_MASTER_KEY` (its value is already in the ring as `k1`). Roll out.
   New writes are `v2:k2:…`; old ciphertexts still decrypt via `k1`.
3. **Sweep old ciphertexts.** Run the re-encrypt sweep for the migrated
   secret type (sample: `odoo_integrations.apiKey`):
   `sweepOdooApiKeys(db, limit)` in `server/services/crypto/rotateSweep.ts`
   (idempotent; chunk with `limit`; failed row ids are reported, never
   corrupted). Other types migrate lazily on next write or by extending the
   sweep.
4. **Verify no old-generation ciphertexts remain** (`needsReencrypt()` false
   for every row of the swept type).
5. **Remove the old key** from `SECRETS_MASTER_KEYRING` and roll out. Any
   missed ciphertext now fails closed (decrypt throws naming the unknown
   kid) — restore the old key immediately if this appears, then repeat
   steps 3–4.

Never remove a kid before step 4 verifies clean: `v2` decrypt with an
unknown kid and `v1` decrypt with no matching ring key both **fail closed**
(throw), they never return partial plaintext.

## Dev/test

With no keys configured, dev/test uses a deterministic dev-only key (kid
`dev`) with a loud warning. Production with no usable keyring refuses to
boot crypto paths (fail closed).
