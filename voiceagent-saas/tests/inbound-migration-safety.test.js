import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "..", "supabase", "migrations", "005_inbound_route_tenant_safety.sql"),
  "utf8",
);

describe("005 inbound route tenant safety migration", () => {
  it("repairs invalid existing DID default campaigns before adding enforcement", () => {
    expect(migration).toContain("update public.phone_numbers pn");
    expect(migration).toContain("pn.default_campaign_id = c.id");
    expect(migration).toContain("pn.tenant_id <> c.tenant_id");
  });

  it("adds row-level enforcement for same-tenant default campaigns including bulk inserts", () => {
    expect(migration).toContain("create or replace function public.enforce_phone_number_default_campaign_tenant()");
    expect(migration).toContain("before insert or update of tenant_id, default_campaign_id");
    expect(migration).toContain("for each row");
    expect(migration).toContain("campaign_tenant_id <> new.tenant_id");
  });

  it("prevents changing campaign tenant while referenced by inbound routing", () => {
    expect(migration).toContain("create or replace function public.prevent_campaign_tenant_change_when_inbound_routed()");
    expect(migration).toContain("before update of tenant_id");
    expect(migration).toContain("where default_campaign_id = old.id");
  });
});
