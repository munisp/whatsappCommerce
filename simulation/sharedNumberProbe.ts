/**
 * simulation/sharedNumberProbe.ts — a buyer's whole conversation with a shop on the shared number, answered by a
 * REAL model (SIM_REAL_LLM_URL, e.g. a port-forwarded Ollama), printed turn by turn for review. Meta and payments
 * stay mocked: nothing is sent to WhatsApp. Not pass/fail: the transcript is the result.
 *   SIM_REAL_LLM_URL=http://localhost:11434 SIM_REAL_LLM_MODEL=llama3.2 npx tsx simulation/sharedNumberProbe.ts
 */
import { bootWorld } from "./world";
import * as payloads from "./payloads";
import { journeys } from "./sharedNumberSuite";

const SHARED_PN = "pn_sim_shared_001";
// SIM_PROBE_SCRIPT="hi|SHOP MAMAPUT|YES|…" replaces the default conversation.
const SCRIPT = process.env.SIM_PROBE_SCRIPT ? process.env.SIM_PROBE_SCRIPT.split("|") : [
  "hi", "SHOP MAMAPUT", "YES", "menu", "1", "Oh 1", "I want 2 jollof rice", "add a pepsi", "what's in my cart",
  "remove the pepsi", "i need to have drink today", "how much is zobo", "do you have pizza?", "I want 100 pepsi",
  "do you deliver to Ikeja?", "what time do you close?", "how are you?", "abeg I wan buy rice", "Ẹ jọ̀wọ́ mo fẹ́ ra iresi",
  "checkout", "talk to a human", "some pepsi can you check stores around me that sell this?", "stores",
];

const say = (c: any): string => {
  const b = c?.body ?? {};
  if (b.type === "text") return b.text?.body ?? "";
  if (b.type === "interactive") {
    const it = b.interactive;
    const opts = [...(it.action?.buttons ?? []).map((x: any) => `[${x.reply?.title}]`),
      ...(it.action?.sections ?? []).flatMap((s: any) => (s.rows ?? []).map((r: any) => `• ${r.title}${r.description ? " — " + r.description : ""}`))];
    return `${it.body?.text ?? ""}\n${opts.join("\n")}`;
  }
  return `(${b.type})`;
};

async function main() {
  const world = await bootWorld();
  await world.resetJourneyState();
  // Seed the suite's shops (the first journey's setup does it).
  const seed = journeys[0];
  await (seed as any).run.call(null, { ...world, inbound: async () => {}, settle: async () => {} } as any).catch(() => {});
  const phone = world.newPhone("p");
  for (const msg of SCRIPT) {
    const before = world.outbound.toPhone(phone).length;
    await world.inbound(payloads.inbound.text(SHARED_PN, phone, msg));
    // A real model answers in seconds with nothing else happening meanwhile, so settle() alone would move on early:
    // wait for the first reply (or 60s), then for the rest of the burst.
    const t0 = Date.now();
    while (world.outbound.toPhone(phone).length === before && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
    await world.settle(1500, 90000);
    const replies = world.outbound.toPhone(phone).slice(before);
    console.log(`\n👤 ${msg}`);
    if (!replies.length) console.log("   (no reply)");
    for (const r of replies) console.log("🤖 " + say(r).split("\n").join("\n   "));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
