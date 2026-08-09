/**
 * J15 — Voice note: audio inbound → Whisper transcription (mocked OpenAI
 * fetch) → SAME NLP pipeline; without an API key the buyer gets a localized
 * fail-soft reply instead of silence.
 */
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J15",
  name: "voice note ordering",
  feature: "transcribe → NLP pipeline; fail-soft",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    // ── No OPENAI_API_KEY → localized fail-soft ──────────────────────────
    delete process.env.OPENAI_API_KEY;
    scriptMedia("m-voice-1", "fake-ogg-bytes", "audio/ogg");
    await world.audio(phone, "m-voice-1");
    await world.waitFor(() => {
      const t = bodyText(world.outbound.lastOfType("text", phone));
      return t.length > 0;
    }, 8000, "fail-soft reply sent");
    const soft = bodyText(world.outbound.lastOfType("text", phone));
    assert(
      soft.includes("voice") || soft.includes("Voice") || soft.includes("🎙"),
      `fail-soft reply explains voice is unavailable (got ${soft.slice(0, 120)})`,
    );

    // ── With key → transcribe → same pipeline (cart → confirm → order) ──
    process.env.OPENAI_API_KEY = "sk-sim-voice";
    world.openai.transcripts.push("2 jollof rice and 1 chicken voice order");
    world.llm.when("2 jollof rice and 1 chicken voice order", {
      reply: "Added to your cart!",
      intent: "add_to_cart",
      nextState: "add_to_cart",
      extractedItems: [
        { product: "Jollof Rice", quantity: 2 },
        { product: "Grilled Chicken", quantity: 1 },
      ],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    scriptMedia("m-voice-2", "fake-ogg-bytes-2", "audio/ogg");
    const before = world.outbound.toPhone(phone).length;
    await world.audio(phone, "m-voice-2");
    await world.waitFor(() => world.outbound.toPhone(phone).length > before && world.openai.calls > 0, 10000, "transcript processed");
    assert(world.openai.calls === 1, "Whisper mock was called exactly once");
    const reply = world.outbound.toPhone(phone).slice(before).map((c) => bodyText(c)).join("\n");
    assertIncludes(reply, "2 × Jollof Rice", "voice order added to cart via the same pipeline");
    assertIncludes(reply, "1 × Grilled Chicken", "voice order included the chicken");
    delete process.env.OPENAI_API_KEY;
  },
};
