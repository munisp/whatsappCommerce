// === W45 go-rust-services ===
/**
 * J384 — conversation-orchestrator real Chatwoot wiring (MSG-17): replies go
 * through the real Chatwoot API (messages endpoint + api_access_token), errors
 * propagate, handoff is checked, and resolve takes the bot_active path back
 * from handed_off. Source-contract checks + TS-visible env docs; lazy only.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const svc = `${repoRoot}/services/conversation-orchestrator`;

export const journey: Journey = {
  id: "J384",
  name: "conversation-orchestrator real Chatwoot reply + resolve→bot_active",
  feature: "go-rust services: MSG-17 orchestrator",
  async run() {
    const orch = await readFile(`${svc}/internal/orchestrator/orchestrator.go`, "utf8");
    const handler = await readFile(`${svc}/internal/handler/handler.go`, "utf8");
    const config = await readFile(`${svc}/internal/config/config.go`, "utf8");
    const store = await readFile(`${svc}/internal/store/postgres.go`, "utf8");

    // ── Real reply path (no log-only stub) ─────────────────────────────────
    assert(!orch.includes("In production this would use the Chatwoot API"), "log-only Chatwoot stub removed");
    assertIncludes(orch, "/conversations/%d/messages", "real Chatwoot messages endpoint");
    assertIncludes(orch, 'req.Header.Set("api_access_token"', "auth header sent");
    assertIncludes(orch, '"message_type": "outgoing"', "outgoing message type");
    assertIncludes(orch, "chatwoot reply api %d", "HTTP errors propagate");

    // ── Handoff is checked (previous POST discarded the response) ──────────
    assert(!orch.includes("\n\to.client.Do(req)\n"), "no unchecked fire-and-forget POST remains");
    assertIncludes(orch, "setChatwootStatus(ctx, conv.ChatwootConvID, \"open\")", "handoff opens Chatwoot conversation");

    // ── Resolve → bot_active path back from handed_off ─────────────────────
    assertIncludes(orch, "func (o *Orchestrator) ResolveToBot", "resolve-to-bot entrypoint");
    assertIncludes(orch, '"resolved")', "Chatwoot conversation marked resolved");
    assertIncludes(orch, '"bot_active"', "local state flips to bot_active");
    assertIncludes(handler, "h.orch.ResolveToBot", "HTTP resolve route uses the real path");
    assertIncludes(handler, '"bot_active"', "handler reports bot_active");
    assertIncludes(store, "GetConversationByID", "store supports resolve lookup");

    // ── Config + TS-visible docs ───────────────────────────────────────────
    assertIncludes(config, "ChatwootAPIAccessToken", "config carries the API token");
    assertIncludes(config, "CHATWOOT_API_ACCESS_TOKEN", "token env var");
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "CHATWOOT_API_ACCESS_TOKEN", "env.example documents Chatwoot token");
    assertIncludes(envExample, "CHATWOOT_ACCOUNT_ID", "env.example documents Chatwoot account");

    // Compose still deploys the orchestrator (service kept, now real).
    const compose = await readFile(`${repoRoot}/docker-compose.yml`, "utf8");
    assertIncludes(compose, "conversation-orchestrator", "orchestrator still deployed in compose");
  },
};
