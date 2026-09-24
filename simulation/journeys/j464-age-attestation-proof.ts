// === W47 crosscutting ===
/**
 * J464 — ONB-TOCTOU-2: age attestations carry proof + versioning, and stale
 * attestations re-prompt.
 *
 *   - recordAgeAttestation stamps policyVersion + proofWamid (mig 0170);
 *   - re-attestation refreshes proof + freshness;
 *   - an attestation older than ONB_DORMANT_DAYS no longer satisfies the gate
 *     (recycled-number protection → hasAgeAttestation false);
 *   - the attestation prompt is localized (ONB-I18N-1 hook) and the nlp path
 *     threads the inbound wamid (source contract).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J464",
  name: "age attestation proof versioning + dormant re-attestation",
  feature: "ONB-TOCTOU-2 age-gate proof",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ageGate = await import("../../server/services/ageGate");

    const phone = world.newPhone("ag464");
    await ageGate.recordAgeAttestation(world.db, {
      tenantId: TENANT_ID, phone, attestedAge: 18, proofWamid: "wamid.j464",
    });
    const [row] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(row, "attestation row exists");
    assert(row.policyVersion === ageGate.AGE_GATE_POLICY_VERSION, `policy version stamped (got ${row.policyVersion})`);
    assert(row.proofWamid === "wamid.j464", "evidence wamid stamped");
    assert(await ageGate.hasAgeAttestation(world.db, TENANT_ID, phone, 18), "fresh attestation satisfies the gate");

    // Re-attestation refreshes proof (e.g. a higher age requirement later).
    await ageGate.recordAgeAttestation(world.db, {
      tenantId: TENANT_ID, phone, attestedAge: 21, proofWamid: "wamid.j464b",
    });
    const [row2] = await world.db.select().from(schema.ageAttestations)
      .where(and(eq(schema.ageAttestations.tenantId, TENANT_ID), eq(schema.ageAttestations.phone, phone)));
    assert(Number(row2.attestedAge) === 21, "attested age monotonic raise");
    assert(row2.proofWamid === "wamid.j464b", "proof refreshed on re-attestation");

    // Dormant attestation (120 days old) no longer satisfies the gate.
    await world.db.update(schema.ageAttestations)
      .set({ createdAt: new Date(Date.now() - 120 * 86_400_000) })
      .where(eq(schema.ageAttestations.id, row2.id));
    assert(!(await ageGate.hasAgeAttestation(world.db, TENANT_ID, phone, 18)),
      "stale attestation re-prompts (dormant identity protection)");

    // Localized prompt (delegates to the i18n packs).
    const fr = ageGate.buildAgeAttestationPrompt(18, ["Gin"], "fr");
    assert(fr.includes("18") && fr.includes("Gin") && !fr.includes("age-restricted"), "fr attestation prompt localized");

    // nlp checkout threads the evidence wamid (source contract).
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assert(nlp.includes("ageProofWamid: input.wamid"), "nlp passes the inbound wamid into the attestation");
    assert(nlp.includes('wamid: z.string().max(120).optional()'), "processMessage accepts wamid");
  },
};
