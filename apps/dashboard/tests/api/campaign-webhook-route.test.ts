import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/campaigns/webhook/route";

const getUser = vi.fn();
const update = vi.fn();
const from = vi.fn();

vi.mock("@/lib/supabase-server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser,
    },
    from,
  })),
}));

describe("POST /api/campaigns/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rotates the webhook secret and returns it once", async () => {
    const existingCampaignSingle = vi.fn().mockResolvedValue({
      data: {
        id: "campaign-1",
        webhook_secret_hash: "hashed-old",
      },
      error: null,
    });
    const updateSingle = vi.fn().mockResolvedValue({
      data: {
        id: "campaign-1",
        tenant_id: "tenant-1",
        webhook_enabled: true,
        webhook_secret_hash: "hashed-new",
        webhook_source_label: "Facebook Lead Ads",
        webhook_payload_example: { phone: "0501234567" },
      },
      error: null,
    });

    from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: existingCampaignSingle,
          }),
        }),
      }),
      update: (...args: unknown[]) => {
        update(...args);
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: updateSingle,
              }),
            }),
          }),
        };
      },
    }));

    getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          app_metadata: {
            tenant_id: "tenant-1",
          },
        },
      },
    });

    const request = new Request("http://localhost/api/campaigns/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "rotate",
        campaignId: "campaign-1",
        webhookSourceLabel: "Facebook Lead Ads",
      }),
    });

    const response = await POST(request as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(10);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook_enabled: true,
        webhook_source_label: "Facebook Lead Ads",
      })
    );
    expect(existingCampaignSingle).toHaveBeenCalled();
    expect(updateSingle).toHaveBeenCalled();
  });
});
