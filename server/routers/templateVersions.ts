import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, desc, and } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { templateVersions, whatsappTemplates } from "../../drizzle/schema";

export const templateVersionsRouter = router({
  // List all versions for a template
  list: protectedProcedure
    .input(z.object({ templateId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { versions: [] };
      const versions = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.templateId, input.templateId))
        .orderBy(desc(templateVersions.version));
      return { versions };
    }),

  // Create a new draft version from current template body
  create: protectedProcedure
    .input(z.object({
      templateId: z.string(),
      bodyText: z.string().min(1),
      headerText: z.string().optional(),
      footerText: z.string().optional(),
      variables: z.array(z.string()).optional(),
      buttons: z.array(z.object({ type: z.string(), text: z.string(), value: z.string().optional() })).optional(),
      changeSummary: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Get the latest version number
      const existing = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.templateId, input.templateId))
        .orderBy(desc(templateVersions.version))
        .limit(1);

      const nextVersion = existing.length > 0 ? (existing[0]!.version + 1) : 1;

      const id = nanoid();
      await db.insert(templateVersions).values({
        id,
        templateId: input.templateId,
        version: nextVersion,
        bodyText: input.bodyText,
        headerText: input.headerText ?? null,
        footerText: input.footerText ?? null,
        variables: input.variables ?? null,
        buttons: input.buttons ?? null,
        status: "draft",
        changeSummary: input.changeSummary ?? null,
        changedBy: ctx.user?.name ?? ctx.user?.openId ?? "system",
      });

      return { id, version: nextVersion };
    }),

  // Publish a draft version (makes it the active version on the template)
  publish: protectedProcedure
    .input(z.object({ versionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Get the version
      const [version] = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.id, input.versionId))
        .limit(1);

      if (!version) throw new Error("Version not found");

      // Mark this version as published
      await db
        .update(templateVersions)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(templateVersions.id, input.versionId));

      // Archive all other published versions for this template
      await db
        .update(templateVersions)
        .set({ status: "archived" })
        .where(
          and(
            eq(templateVersions.templateId, version.templateId),
            eq(templateVersions.status, "published")
          )
        );

      // Re-publish the target version (in case it was just archived above)
      await db
        .update(templateVersions)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(templateVersions.id, input.versionId));

      // Sync the body back to the parent template
      await db
        .update(whatsappTemplates)
        .set({
          bodyText: version.bodyText,
          headerText: version.headerText,
          footerText: version.footerText,
          variables: version.variables,
          buttons: version.buttons,
          updatedAt: new Date(),
        })
        .where(eq(whatsappTemplates.id, version.templateId));

      return { success: true };
    }),

  // Revert template to a specific version (creates a new draft from that version's content)
  revert: protectedProcedure
    .input(z.object({ versionId: z.string(), changeSummary: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [source] = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.id, input.versionId))
        .limit(1);

      if (!source) throw new Error("Version not found");

      const existing = await db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.templateId, source.templateId))
        .orderBy(desc(templateVersions.version))
        .limit(1);

      const nextVersion = existing.length > 0 ? (existing[0]!.version + 1) : 1;
      const id = nanoid();

      await db.insert(templateVersions).values({
        id,
        templateId: source.templateId,
        version: nextVersion,
        bodyText: source.bodyText,
        headerText: source.headerText,
        footerText: source.footerText,
        variables: source.variables,
        buttons: source.buttons,
        status: "draft",
        changeSummary: input.changeSummary ?? `Reverted to v${source.version}`,
        changedBy: ctx.user?.name ?? ctx.user?.openId ?? "system",
      });

      return { id, version: nextVersion };
    }),

  // Archive a version
  archive: protectedProcedure
    .input(z.object({ versionId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .update(templateVersions)
        .set({ status: "archived" })
        .where(eq(templateVersions.id, input.versionId));
      return { success: true };
    }),
});

