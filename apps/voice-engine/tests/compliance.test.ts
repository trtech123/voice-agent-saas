// apps/voice-engine/tests/compliance.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComplianceGate, type PreCallCheckResult } from "../src/compliance.js";

function createMockDncEnforcer(overrides: Record<string, unknown> = {}) {
  return {
    checkDnc: vi.fn().mockResolvedValue({ blocked: false }),
    checkNationalRegistry: vi.fn().mockResolvedValue({ blocked: false, stub: true }),
    markOptOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockAuditDAL() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTenantDAL() {
  return {
    get: vi.fn().mockResolvedValue({
      id: "tenant-1",
      calls_used_this_month: 50,
      calls_limit: 300,
    }),
    isUnderCallLimit: vi.fn().mockResolvedValue(true),
    incrementCallsUsed: vi.fn().mockResolvedValue(51),
  };
}

function createMockContactDAL() {
  return {
    getById: vi.fn().mockResolvedValue({
      id: "contact-1",
      phone: "972501234567",
      name: "Yossi",
    }),
  };
}

const defaultCampaign = {
  id: "campaign-1",
  tenant_id: "tenant-1",
  schedule_windows: [
    { start: "10:00", end: "13:00" },
    { start: "16:00", end: "19:00" },
  ],
  schedule_days: ["sun", "mon", "tue", "wed", "thu"],
  script: "Test script",
};

describe("ComplianceGate", () => {
  let dncEnforcer: ReturnType<typeof createMockDncEnforcer>;
  let auditDAL: ReturnType<typeof createMockAuditDAL>;
  let tenantDAL: ReturnType<typeof createMockTenantDAL>;
  let contactDAL: ReturnType<typeof createMockContactDAL>;
  let gate: ComplianceGate;

  beforeEach(() => {
    dncEnforcer = createMockDncEnforcer();
    auditDAL = createMockAuditDAL();
    tenantDAL = createMockTenantDAL();
    contactDAL = createMockContactDAL();
    gate = new ComplianceGate(
      dncEnforcer as any,
      auditDAL as any,
      tenantDAL as any,
      contactDAL as any
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("preCallCheck", () => {
    it("allows call when all checks pass", async () => {
      // Wednesday 2026-04-08 at 11:00 Israel time
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z"));

      const result = await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      expect(result.allowed).toBe(true);
      expect(result.checks.dnc).toBe("pass");
      expect(result.checks.schedule).toBe("pass");
      expect(result.checks.callLimit).toBe("pass");
    });

    it("blocks call when contact is DNC", async () => {
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z"));
      dncEnforcer.checkDnc.mockResolvedValue({
        blocked: true,
        reason: "Contact on DNC list",
      });

      const result = await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      expect(result.allowed).toBe(false);
      expect(result.checks.dnc).toBe("blocked");
      expect(result.reason).toContain("DNC");
    });

    it("blocks call outside schedule windows", async () => {
      // Wednesday 2026-04-08 at 14:00 Israel time (between windows)
      vi.setSystemTime(new Date("2026-04-08T11:00:00.000Z"));

      const result = await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      expect(result.allowed).toBe(false);
      expect(result.checks.schedule).toBe("blocked");
    });

    it("blocks call on Shabbat", async () => {
      // Saturday 2026-04-11 at 11:00 Israel time
      vi.setSystemTime(new Date("2026-04-11T08:00:00.000Z"));

      const result = await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      expect(result.allowed).toBe(false);
      expect(result.checks.schedule).toBe("blocked");
      expect(result.reason).toContain("Shabbat");
    });

    it("blocks call when tenant over call limit", async () => {
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z"));
      tenantDAL.isUnderCallLimit.mockResolvedValue(false);

      const result = await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      expect(result.allowed).toBe(false);
      expect(result.checks.callLimit).toBe("blocked");
      expect(result.reason).toContain("call limit");
    });

    it("logs all compliance checks to audit", async () => {
      vi.setSystemTime(new Date("2026-04-08T08:00:00.000Z"));

      await gate.preCallCheck({
        contactId: "contact-1",
        campaignContactId: "cc-1",
        campaign: defaultCampaign as any,
      });

      // DNC check is logged inside DncEnforcer, schedule check logged here
      expect(auditDAL.log).toHaveBeenCalledWith(
        "schedule_check",
        "campaign",
        "campaign-1",
        expect.objectContaining({ allowed: true })
      );
    });
  });

  describe("recordingConsentPrompt", () => {
    it("returns the Hebrew recording consent disclosure text", () => {
      const prompt = ComplianceGate.getRecordingConsentText();
      expect(prompt).toContain("השיחה מוקלטת");
    });

    it("injects consent disclosure into a campaign script", () => {
      const script = "אתה נציג מכירות של חברת דוגמה.";
      const enhanced = gate.injectRecordingConsent(script);
      expect(enhanced).toContain("השיחה מוקלטת");
      expect(enhanced).toContain(script);
    });
  });

  describe("logCallStart", () => {
    it("logs call_start event to audit with contact info", async () => {
      await gate.logCallStart({
        callId: "call-1",
        contactId: "contact-1",
        campaignId: "campaign-1",
      });

      expect(auditDAL.log).toHaveBeenCalledWith(
        "call_start",
        "call",
        "call-1",
        expect.objectContaining({
          contact_id: "contact-1",
          campaign_id: "campaign-1",
        })
      );
    });
  });

  describe("logCallEnd", () => {
    it("logs call_end event to audit with disposition", async () => {
      await gate.logCallEnd({
        callId: "call-1",
        contactId: "contact-1",
        campaignId: "campaign-1",
        disposition: "completed",
        durationSeconds: 120,
        leadStatus: "hot",
      });

      expect(auditDAL.log).toHaveBeenCalledWith(
        "call_end",
        "call",
        "call-1",
        expect.objectContaining({
          disposition: "completed",
          duration_seconds: 120,
          lead_status: "hot",
        })
      );
    });
  });

  describe("logRecordingConsent", () => {
    it("logs recording_consent event to audit", async () => {
      await gate.logRecordingConsent("call-1");

      expect(auditDAL.log).toHaveBeenCalledWith(
        "recording_consent",
        "call",
        "call-1",
        expect.objectContaining({
          disclosure_text: expect.stringContaining("השיחה מוקלטת"),
        })
      );
    });
  });
});
