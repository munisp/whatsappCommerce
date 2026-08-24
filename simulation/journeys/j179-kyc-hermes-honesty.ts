/**
 * J179 — W30 deploy: kyc-verifier mock guard + hermes wiring + approvePO
 * supplier-email failure honesty.
 *
 *   1. The kyc-verifier image default is VLM_MOCK_MODE=false; compose carries
 *      the mock only as an explicit dev override; /health echoes the mode.
 *   2. Platform compose/k8s set HERMES_BRIDGE_URL to the hermes-bridge
 *      service DNS; INTERNAL_API_KEY is in REQUIRED_BY_ENV.
 *   3. approvePO with an unreachable hermes-skills returns
 *      { success:false, retryable:true } and leaves the PO in the retryable
 *      'approved_email_failed' state — NOT a fabricated { success:true }.
 *   4. Re-approving from that state is possible (retry path).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J179",
  name: "kyc mock guard + hermes wiring + approvePO email-failure honesty",
  feature: "deploy/observability: fail-closed kyc sidecar, honest hermes approval",
  async run(world: World) {
    // ── 1. kyc-verifier mock guard (static) ──────────────────────────────
    const dockerfile = fs.readFileSync(path.join(ROOT, "services/kyc-verifier/Dockerfile"), "utf-8");
    assert(/ENV VLM_MOCK_MODE=false/.test(dockerfile), "kyc-verifier Dockerfile must default VLM_MOCK_MODE=false");
    assert(!/ENV VLM_MOCK_MODE=true/.test(dockerfile), "kyc-verifier Dockerfile still bakes mock mode");
    const vlm = fs.readFileSync(path.join(ROOT, "services/kyc-verifier/app/vlm_processor.py"), "utf-8");
    assert(vlm.includes('os.getenv("VLM_MOCK_MODE", "false")'), "vlm_processor default must be real vision");
    const health = fs.readFileSync(path.join(ROOT, "services/kyc-verifier/app/main.py"), "utf-8");
    assert(health.includes("vlm_mock_mode"), "kyc-verifier /health must echo vlm_mock_mode for the boot-gate probe");
    const envSrc = fs.readFileSync(path.join(ROOT, "server/_core/env.ts"), "utf-8");
    assert(envSrc.includes("vlm_mock_mode"), "Node boot gate must probe the sidecar mock mode");

    // ── 2. Hermes wiring (static) ────────────────────────────────────────
    const { load: yamlLoad } = await import("js-yaml");
    const compose = yamlLoad(fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf-8")) as any;
    assert(
      compose.services.platform.environment.HERMES_BRIDGE_URL?.includes("http://hermes-bridge:8096"),
      "platform compose env missing HERMES_BRIDGE_URL=http://hermes-bridge:8096",
    );
    assert(
      compose.services["kyc-verifier"]?.environment?.VLM_MOCK_MODE !== undefined,
      "compose must carry the kyc mock as an explicit override",
    );
    const configmap = fs.readFileSync(path.join(ROOT, "k8s/configmap.yaml"), "utf-8");
    assert(configmap.includes("HERMES_BRIDGE_URL"), "k8s configmap missing HERMES_BRIDGE_URL");
    assert(
      /INTERNAL_API_KEY:\s*process\.env/.test(envSrc) && envSrc.includes("REQUIRED_BY_ENV"),
      "INTERNAL_API_KEY must be in REQUIRED_BY_ENV",
    );

    // ── 3. approvePO email-failure honesty (live) ────────────────────────
    const schema = await import("../../drizzle/schema");
    const poId = `po-j179-${Date.now()}`;
    await world.db.insert(schema.hermesPODrafts).values({
      poId,
      tenantId: TENANT_ID,
      supplierName: "J179 Supplier",
      supplierEmail: "supplier@j179.sim",
      sku: "SKU-J179",
      productName: "J179 Widgets",
      quantity: 10,
      unitCost: 500,
      totalCost: 5000,
      currency: "NGN",
      approvalToken: "tok-j179",
      status: "pending",
      createdAt: Math.floor(Date.now() / 1000),
    });

    const caller = await adminCaller();
    // hermes-skills is not running in the simulation → dispatch must fail.
    const result = await caller.hermes.approvePO({ poId, approvalToken: "tok-j179" });
    assert(result.success === false, `approvePO must report failure, got ${JSON.stringify(result)}`);
    assert(result.retryable === true, "approvePO failure must be retryable");
    assert(result.error === "supplier_email_failed", `unexpected error code: ${result.error}`);

    const [po] = await world.db.select().from(schema.hermesPODrafts)
      .where(eq(schema.hermesPODrafts.poId, poId));
    assert(po.status === "approved_email_failed", `PO must be in retryable state, got ${po.status}`);

    // ── 4. Retry path: the capability token still works from the failed state
    const retry = await caller.hermes.approvePO({ poId, approvalToken: "tok-j179" });
    // Still no skills service → still honest failure (NOT 404 "already processed").
    assert(retry.success === false && retry.retryable === true,
      `retry from approved_email_failed must reach the email step, got ${JSON.stringify(retry)}`);
  },
};
