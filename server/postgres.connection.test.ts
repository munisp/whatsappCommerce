import { describe, it, expect } from "vitest";
import postgres from "postgres";

describe("PostgreSQL connection", () => {
  it("connects to local PostgreSQL and can query the users table", async () => {
    const connStr =
      process.env.POSTGRES_URL ||
      "postgresql://wacommerce:wacommerce_dev_2026@localhost:5432/whatsapp_commerce";

    const sql = postgres(connStr, { max: 1, connect_timeout: 10 });
    try {
      const result = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
      const tableNames = result.map((r: { table_name: string }) => r.table_name);

      // Verify core tables exist
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("tenants");
      expect(tableNames).toContain("products");
      expect(tableNames).toContain("conversations");
      expect(tableNames).toContain("orders");
      expect(tableNames).toContain("whatsapp_templates");
      expect(tableNames).toContain("whatsapp_menus");
      expect(tableNames).toContain("tenant_menu_assignments");
      expect(tableNames).toContain("twenty_integrations");
      expect(tableNames).toContain("odoo_integrations");
      expect(tableNames.length).toBeGreaterThanOrEqual(21);
    } finally {
      await sql.end();
    }
  });

  it("can insert and query from the tenants table", async () => {
    const connStr =
      process.env.POSTGRES_URL ||
      "postgresql://wacommerce:wacommerce_dev_2026@localhost:5432/whatsapp_commerce";

    const sql = postgres(connStr, { max: 1, connect_timeout: 10 });
    try {
      const testId = `test-${Date.now()}`;
      await sql`
        INSERT INTO tenants (id, name, slug, plan, status, "defaultCurrency", "defaultLanguage", "aiEnabled", "createdAt", "updatedAt")
        VALUES (${testId}, 'Test Tenant', ${`slug-${testId}`}, 'starter', 'trial', 'USD', 'en', true, NOW(), NOW())
      `;
      const rows = await sql`SELECT id, name FROM tenants WHERE id = ${testId}`;
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Test Tenant");
      // cleanup
      await sql`DELETE FROM tenants WHERE id = ${testId}`;
    } finally {
      await sql.end();
    }
  });
});
