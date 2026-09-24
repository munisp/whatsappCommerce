// === W47 buyer (Coder B) ===
/**
 * J439 — ONB-B-3: the NDPR first-contact consent gate is hoisted ahead of
 * ALL WhatsApp message-type branches. Interactive buttons, media (mirror /
 * AI-scan), CTWA keyword texts and native location messages from a number
 * with NO consent row all get the opt-in prompt — no customers row, no
 * mirrored media, no campaign claim before consent. (TG already gated
 * callbacks/voice/location — this restores WA parity.)
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J439",
  name: "ONB-B-3 consent gate covers buttons/media/CTWA/location on WA",
  feature: "W47 buyer hoisted consent gate",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const consentRow = async (phone: string) => {
      const [row] = await world.db.select().from(schema.consents)
        .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone))).limit(1);
      return row ?? null;
    };
    const customerRow = async (phone: string) => {
      const [row] = await world.db.select().from(schema.customers)
        .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.whatsappPhone, phone))).limit(1);
      return row ?? null;
    };

    // 1. Interactive button first contact → prompt, no customer row.
    const phoneBtn = world.newPhone("439b");
    await world.buttonReply(phoneBtn, "menu_1", "Shop");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phoneBtn)), "NDPR", "button first contact gets the NDPR prompt");
    assert(!(await customerRow(phoneBtn)), "no customers row provisioned before consent");

    // 2. Media (image) first contact → prompt, no mirrored media row.
    const phoneImg = world.newPhone("439i");
    await world.image(phoneImg, "media-j439-1", "what is this?");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phoneImg)), "NDPR", "media first contact gets the prompt");
    const mediaRows = await world.db.select().from(schema.whatsappMediaFiles)
      .where(eq(schema.whatsappMediaFiles.waPhoneNumber, phoneImg)).catch(() => [] as any[]);
    assert(mediaRows.length === 0, "no media mirrored before consent");

    // 3. Location first contact → prompt.
    const phoneLoc = world.newPhone("439l");
    await world.location(phoneLoc, 6.5244, 3.3792, "Home", "Lagos");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phoneLoc)), "NDPR", "location first contact gets the prompt");

    // 4. CTWA keyword first contact → prompt, NOT the campaign claim reply.
    const phoneCtwa = world.newPhone("439c");
    await world.text(phoneCtwa, "simdeal");
    const ctwaReply = bodyText(world.outbound.lastOfType("text", phoneCtwa));
    assertIncludes(ctwaReply, "NDPR", "CTWA first contact gets the consent prompt");
    assert(!ctwaReply.includes("Sim Deal campaign"), "campaign claim deferred until consent");

    // 5. After YES, normal service resumes (button path works).
    await world.text(phoneBtn, "YES");
    assert((await consentRow(phoneBtn))?.granted === true, "consent granted");
    await world.buttonReply(phoneBtn, "menu_1", "Shop");
    const post = bodyText(world.outbound.lastOfType("text", phoneBtn));
    assert(post.length > 0 && !post.includes("Reply YES to receive"), "post-consent button no longer gated");

    // 6. Source wiring: gate invoked before type-specific branches.
    const { readFile } = await import("node:fs/promises");
    const idx = await readFile(new URL("../../server/_core/index.ts", import.meta.url), "utf8");
    assertIncludes(idx, "waFirstContactConsentGate", "webhook invokes the hoisted gate");
    const gatePos = idx.indexOf("waFirstContactConsentGate");
    const interactivePos = idx.indexOf('msg.type === "interactive"');
    assert(gatePos > -1 && interactivePos > -1 && gatePos < interactivePos, "gate runs before the interactive branch");
  },
};
