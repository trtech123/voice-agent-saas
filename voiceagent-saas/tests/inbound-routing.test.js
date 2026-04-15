import { describe, it, expect, vi } from "vitest";
import { resolveInboundCampaignId } from "../inbound-routing.js";

class Query {
  constructor(rows) {
    this.rows = rows;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  not(field, op, value) {
    if (op === "is" && value === null) {
      this.rows = this.rows.filter((row) => row[field] !== null && row[field] !== undefined);
    }
    return this;
  }

  order(field, { ascending = true } = {}) {
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
    });
    return this;
  }

  async limit(n) {
    return { data: this.rows.slice(0, n), error: null };
  }
}

function createDb(tables) {
  return {
    from(name) {
      return new Query([...(tables[name] || [])]);
    },
  };
}

describe("resolveInboundCampaignId", () => {
  it("ignores cross-tenant or inactive recent call campaigns and uses an active safe fallback", async () => {
    const warn = vi.fn();
    const db = createDb({
      calls: [
        {
          tenant_id: "tenant-1",
          contact_id: "contact-1",
          campaign_id: "campaign-other-tenant",
          created_at: "2026-04-15T10:00:00Z",
        },
        {
          tenant_id: "tenant-1",
          contact_id: "contact-1",
          campaign_id: "campaign-paused",
          created_at: "2026-04-15T09:00:00Z",
        },
      ],
      campaigns: [
        { id: "campaign-other-tenant", tenant_id: "tenant-2", status: "active", created_at: "2026-04-15T08:00:00Z" },
        { id: "campaign-paused", tenant_id: "tenant-1", status: "paused", created_at: "2026-04-15T07:00:00Z" },
        { id: "campaign-active", tenant_id: "tenant-1", status: "active", created_at: "2026-04-15T06:00:00Z" },
      ],
    });

    const campaignId = await resolveInboundCampaignId(
      db,
      "tenant-1",
      "contact-1",
      null,
      { warn },
    );

    expect(campaignId).toBe("campaign-active");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("rejects an inactive or cross-tenant DID default and falls back to newest active tenant campaign", async () => {
    const warn = vi.fn();
    const db = createDb({
      calls: [],
      campaigns: [
        { id: "did-default", tenant_id: "tenant-2", status: "active", created_at: "2026-04-15T10:00:00Z" },
        { id: "old-active", tenant_id: "tenant-1", status: "active", created_at: "2026-04-15T08:00:00Z" },
        { id: "new-active", tenant_id: "tenant-1", status: "active", created_at: "2026-04-15T09:00:00Z" },
      ],
    });

    const campaignId = await resolveInboundCampaignId(
      db,
      "tenant-1",
      "contact-1",
      "did-default",
      { warn },
    );

    expect(campaignId).toBe("new-active");
    expect(warn).toHaveBeenCalledWith(
      { tenantId: "tenant-1", campaignId: "did-default" },
      "Ignoring inactive or cross-tenant DID default campaign",
    );
  });
});
