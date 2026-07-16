import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * One row per active accounting integration per org.
 * Unique on (organization_id, provider) — only one QBO and one Xero
 * connection per org at a time. Tokens are AES-256-GCM encrypted at rest
 * via src/lib/integrations/tokens.ts before being stored here.
 */
export const accountingConnections = pgTable(
  "accounting_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 'qbo' = QuickBooks Online, 'xero' = Xero */
    provider: text("provider").notNull(),
    /** QBO: company realmId. Xero: tenantId from the connections endpoint. */
    realmId: text("realm_id").notNull(),
    /** AES-256-GCM encrypted (see tokens.ts). */
    accessToken: text("access_token").notNull(),
    /** AES-256-GCM encrypted. */
    refreshToken: text("refresh_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    /**
     * Provider-specific settings stored as JSON.
     * QBO: { defaultExpenseAccountId?: string, companyName?: string }
     * Xero: { tenantName?: string }
     */
    settings: jsonb("settings").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgProvider: unique("uq_accounting_connections_org_provider").on(
      t.organizationId,
      t.provider,
    ),
    orgIdx: index("idx_accounting_connections_org").on(t.organizationId),
  }),
);
