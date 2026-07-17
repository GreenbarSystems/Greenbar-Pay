import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(), // used in AP inbox routing addresses (§3.2)
  // 1 = single-stage (default); 2 = reviewer then admin final approval.
  approvalStagesRequired: integer("approval_stages_required").notNull().default(1),
  // When true, PO validation additionally requires receipt_confirmed_at on the PO
  // and warns when any line's received_quantity < quantity. The global
  // PO_THREE_WAY_ENABLED env var is checked first (for backwards-compat / deploy override);
  // this per-org column takes effect when the env var is not set.
  poThreeWayEnabled: boolean("po_three_way_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
