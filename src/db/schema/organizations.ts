import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(), // used in AP inbox routing addresses (§3.2)
  // 1 = single-stage (default); 2 = reviewer then admin final approval.
  approvalStagesRequired: integer("approval_stages_required").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
