/**
 * === W42 pipeline-durability (Coder A) ===
 * J309 — PLT-5 broker drift fixed: wacommerce.* platform events are
 * side-published to the Fluvio REST produce endpoint (the broker the only
 * in-repo consumer, services/fluvio-consumer, actually reads). A local fake
 * Fluvio REST proxy asserts the real HTTP contract
 * (POST /topics/{topic}/produce, {key, value} body — same as the gateway's
 * Go Fluvio producer).
 */
import http from "http";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J309",
  name: "wacommerce.* events reach the Fluvio consumer's broker",
  feature: "PLT-5 fluvio side-publish of platform events",
  async run(_world: World) {
    const received: { url: string; body: string }[] = [];
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        received.push({ url: req.url ?? "", body: b });
        res.statusCode = 200;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;

    process.env.FLUVIO_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
      const { publishOrderEvent } = await import("../../server/kafka");
      await publishOrderEvent("ord-j309", TENANT_ID, "created", { total: 12345 });

      const hit = received.find((r) => r.url === "/topics/wacommerce.orders/produce");
      assert(hit, `fluvio produce endpoint called for wacommerce.orders (got ${JSON.stringify(received.map((r) => r.url))})`);
      const body = JSON.parse(hit!.body);
      assert(body.key === "ord-j309", `fluvio record key is the order id (got ${body.key})`);
      const value = JSON.parse(body.value);
      assert(value.orderId === "ord-j309" && value.status === "created" && value.tenantId === TENANT_ID,
        `fluvio record carries the order event payload (got ${hit!.body.slice(0, 200)})`);
    } finally {
      delete process.env.FLUVIO_ENDPOINT;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  },
};
