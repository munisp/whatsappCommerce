// === W45 go-rust-services ===
/**
 * J383 — hermes-bridge callback base URL config (MSG-20, config half): the
 * hard-coded http://localhost callback is replaced by HERMES_CALLBACK_BASE_URL,
 * validated fail-closed (absolute http(s), non-loopback in production), and
 * documented across env.example.txt / k8s configmap / deployment. Lazy source
 * reads only — no Go process booted.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J383",
  name: "hermes callback base URL config validation",
  feature: "go-rust services: MSG-20 callback URL",
  async run() {
    const main = await readFile(`${repoRoot}/services/hermes-bridge/main.go`, "utf8");

    // ── Config field + env source ──────────────────────────────────────────
    assertIncludes(main, "PublicCallbackBaseURL", "config carries the public callback base URL");
    assertIncludes(main, 'os.Getenv("HERMES_CALLBACK_BASE_URL")', "env-driven, no default");

    // ── Startup validation: absolute http(s), non-loopback in production ───
    assertIncludes(main, "func validateConfig(cfg Config) error", "startup config validation");
    assertIncludes(main, "HERMES_CALLBACK_BASE_URL is required in production", "fail-closed when unset in prod");
    assertIncludes(main, 'host == "localhost"', "loopback detection");
    assertIncludes(main, "must not be a loopback host in production", "loopback rejected in prod");
    assertIncludes(main, "validateConfig(cfg)", "validation actually invoked at boot");

    // ── Callback construction uses the configured base ─────────────────────
    assertIncludes(main, "func (ep *EventProcessor) callbackURL() string", "callbackURL builder");
    assertIncludes(main, 'strings.TrimRight(base, "/") + "/hermes/callback"', "path joined onto configured base");
    assertIncludes(main, "CallbackURL:    ep.callbackURL()", "Hermes requests carry the configured callback");

    // ── TS-visible docs/manifests ──────────────────────────────────────────
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "HERMES_CALLBACK_BASE_URL", "env.example documents callback base URL");

    const configmap = await readFile(`${repoRoot}/k8s/configmap.yaml`, "utf8");
    assertIncludes(configmap, "HERMES_CALLBACK_BASE_URL", "k8s configmap carries the key");
    assert(
      !/HERMES_CALLBACK_BASE_URL:\s*"https?:\/\/(localhost|127\.0\.0\.1)/.test(configmap),
      "k8s configmap value must not be loopback",
    );

    const deploy = await readFile(`${repoRoot}/k8s/hermes-bridge.yaml`, "utf8");
    assertIncludes(deploy, "HERMES_CALLBACK_BASE_URL", "k8s deployment injects the callback base URL");

    // docker-compose keeps an explicit (documented) dev loopback default only.
    const compose = await readFile(`${repoRoot}/docker-compose.yml`, "utf8");
    assertIncludes(compose, "HERMES_CALLBACK_BASE_URL", "compose documents the var");
  },
};
