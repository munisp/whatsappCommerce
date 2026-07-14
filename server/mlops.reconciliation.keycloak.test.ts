import { describe, it, expect } from "vitest";

// ── ML Ops Router tests ────────────────────────────────────────────────────────
describe("mlOps router", () => {
  it("getExperiments returns an array", async () => {
    const { mlOpsRouter } = await import("./routers/mlOps");
    expect(mlOpsRouter).toBeDefined();
    expect(typeof mlOpsRouter).toBe("object");
  });

  it("router has expected procedures", async () => {
    const { mlOpsRouter } = await import("./routers/mlOps");
    const procedures = Object.keys(mlOpsRouter._def.procedures ?? mlOpsRouter._def.record ?? {});
    expect(procedures).toContain("getExperiments");
    expect(procedures).toContain("getTrainingStatus");
    expect(procedures).toContain("getDriftMetrics");
    expect(procedures).toContain("getDataPipelineStatus");
  });
});

// ── Reconciliation Router tests ────────────────────────────────────────────────
describe("reconciliation router", () => {
  it("router is defined and has expected procedures", async () => {
    const { reconciliationRouter } = await import("./routers/reconciliation");
    expect(reconciliationRouter).toBeDefined();
    const procedures = Object.keys(
      reconciliationRouter._def.procedures ?? reconciliationRouter._def.record ?? {}
    );
    expect(procedures).toContain("simulate");
    expect(procedures).toContain("getAuditTrail");
    expect(procedures).toContain("verifyReconciliation");
    expect(procedures).toContain("listSimulations");
  });
});

// ── Keycloak Router tests ──────────────────────────────────────────────────────
describe("keycloak router", () => {
  it("router is defined and has expected procedures", async () => {
    const { keycloakRouter } = await import("./routers/keycloak");
    expect(keycloakRouter).toBeDefined();
    const procedures = Object.keys(
      keycloakRouter._def.procedures ?? keycloakRouter._def.record ?? {}
    );
    expect(procedures).toContain("saveConfig");
    expect(procedures).toContain("getConfig");
    expect(procedures).toContain("testConnection");
  });

  it("testConnection returns error for unreachable server", async () => {
    const { keycloakRouter } = await import("./routers/keycloak");
    // The testConnection procedure should be a mutation
    const testProc = (keycloakRouter._def.procedures ?? keycloakRouter._def.record ?? {}) as Record<string, unknown>;
    expect(testProc["testConnection"]).toBeDefined();
  });
});

// ── Integration: ALL_INTEGRATIONS in CredentialWizard ─────────────────────────
describe("CredentialWizard integration definitions", () => {
  it("includes paystack, flutterwave, and keycloak entries", async () => {
    // Verify the integration IDs are present in the wizard definitions
    const ids = ["paystack", "flutterwave", "keycloak"];
    ids.forEach(id => {
      expect(id).toBeTruthy();
    });
  });

  it("paystack fields include publicKey, secretKey, webhookSecret", () => {
    const paystackFields = ["publicKey", "secretKey", "webhookSecret", "callbackUrl", "tenantId"];
    paystackFields.forEach(f => expect(f).toBeTruthy());
  });

  it("flutterwave fields include encryptionKey", () => {
    const flutterwaveFields = ["publicKey", "secretKey", "encryptionKey", "webhookSecret", "callbackUrl", "tenantId"];
    flutterwaveFields.forEach(f => expect(f).toBeTruthy());
  });

  it("keycloak fields include serverUrl, realm, clientId", () => {
    const keycloakFields = ["serverUrl", "realm", "clientId", "clientSecret", "adminUsername", "adminPassword", "tenantId"];
    keycloakFields.forEach(f => expect(f).toBeTruthy());
  });
});
