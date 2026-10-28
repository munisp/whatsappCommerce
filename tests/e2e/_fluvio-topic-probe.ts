/**
 * Proves finding #6 + its fix at the real producer→/produce HTTP contract, using a
 * mock Fluvio REST endpoint that enforces Fluvio's topic-name rule (lowercase
 * letters, numbers, hyphens only). No Fluvio cluster needed.
 *   - OLD dotted topic  (wacommerce.orders)  → rejected 400 → event dropped (the bug)
 *   - NEW hyphenated      (wacommerce-orders) → accepted 200 → delivered (the fix)
 *   - the actual publishOrderEvent helper now sends the hyphenated name
 */
import http from "node:http";

const received: { topic: string; status: number }[] = [];
const server = http.createServer((req, res) => {
  const m = req.url?.match(/^\/topics\/([^/]+)\/produce$/);
  if (req.method === "POST" && m) {
    const topic = decodeURIComponent(m[1]);
    const valid = /^[a-z0-9-]+$/.test(topic); // Fluvio naming rule (QA-045/046)
    const status = valid ? 200 : 400;
    received.push({ topic, status });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(valid ? { ok: true } : { ok: false, error: "Invalid topic name" }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  process.env.FLUVIO_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.KAFKA_BROKERS = ""; // keep Kafka out of it

  const { publishFluvioEvents, publishOrderEvent } = await import("../../server/kafka");

  // (A) OLD behaviour: a dotted topic name (what the helpers emitted before the fix)
  await publishFluvioEvents([{ topic: "wacommerce.orders", key: "k", value: { tenantId: "t" } }]);
  // (B) NEW behaviour: the hyphenated canonical name
  await publishFluvioEvents([{ topic: "wacommerce-orders", key: "k", value: { tenantId: "t" } }]);
  // (C) the ACTUAL fixed helper a real flow calls (orderCrud.ts:350)
  await publishOrderEvent("o1", "t1", "created");

  server.close();

  const dotted = received.find((r) => r.topic === "wacommerce.orders");
  const hyphen = received.filter((r) => r.topic === "wacommerce-orders");
  let fail = 0;
  const check = (label: string, ok: boolean, detail: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`); if (!ok) fail++; };

  check("BUG reproduced: dotted topic rejected by Fluvio naming rule (event dropped)",
    !!dotted && dotted.status === 400, `dotted 'wacommerce.orders' → HTTP ${dotted?.status ?? "n/a"}`);
  check("FIX: hyphenated topic accepted (event delivered)",
    hyphen.length >= 1 && hyphen.every((r) => r.status === 200), `hyphenated 'wacommerce-orders' → ${hyphen.map((r) => r.status).join(",") || "n/a"}`);
  check("FIX: publishOrderEvent() now emits the hyphenated canonical topic",
    hyphen.length >= 2, `helper produced 'wacommerce-orders' (total hyphenated deliveries: ${hyphen.length})`);

  console.log(`\nreceived at mock /produce: ${JSON.stringify(received)}`);
  console.log(fail === 0 ? "\nFINDING #6 FIX VERIFIED at the produce contract." : `\n${fail} checks failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { server.close(); console.error("PROBE_ERROR", e); process.exit(2); });
