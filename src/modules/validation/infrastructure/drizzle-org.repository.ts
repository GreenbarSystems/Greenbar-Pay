import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { organizations } from "@/db/schema";
import type { OrgSettingsRepository } from "../application/ports";

async function findPoThreeWayEnabled(tx: Tx, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ poThreeWayEnabled: organizations.poThreeWayEnabled })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.poThreeWayEnabled ?? false;
}

export const drizzleOrgSettingsRepository: OrgSettingsRepository = {
  findPoThreeWayEnabled,
};
