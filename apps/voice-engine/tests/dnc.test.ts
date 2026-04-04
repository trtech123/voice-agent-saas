// apps/voice-engine/tests/dnc.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DncEnforcer } from "../src/dnc.js";

// Mock DALs
function createMockContactDAL(overrides: Record<string, unknown> = {}) {
  return {
    isDnc: vi.fn().mockResolvedValue(false),
    markDnc: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue({
      id: "contact-1",
      tenant_id: "tenant-1",
      phone: "972501234567",
      name: "Test Contact",
      is_dnc: false,
    }),
    ...overrides,
  };
}

function createMockAuditLogDAL() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCampaignContactDAL() {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe("DncEnforcer", () => {
  let contactDAL: ReturnType<typeof createMockContactDAL>;
  let auditDAL: ReturnType<typeof createMockAuditLogDAL>;
  let campaignContactDAL: ReturnType<typeof createMockCampaignContactDAL>;
  let enforcer: DncEnforcer;

  beforeEach(() => {
    contactDAL = createMockContactDAL();
    auditDAL = createMockAuditLogDAL();
    campaignContactDAL = createMockCampaignContactDAL();
    enforcer = new DncEnforcer(
      contactDAL as any,
      auditDAL as any,
      campaignContactDAL as any
    );
  });

  describe("checkDnc", () => {
    it("returns allowed=true for non-DNC contact and logs the check", async () => {
      contactDAL.isDnc.mockResolvedValue(false);
      const result = await enforcer.checkDnc("contact-1");
      expect(result.blocked).toBe(false);
      expect(auditDAL.log).toHaveBeenCalledWith(
        "dnc_check",
        "contact",
        "contact-1",
        expect.objectContaining({ is_dnc: false })
      );
    });

    it("returns blocked=true for DNC contact and logs it", async () => {
      contactDAL.isDnc.mockResolvedValue(true);
      const result = await enforcer.checkDnc("contact-1");
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("DNC");
      expect(auditDAL.log).toHaveBeenCalledWith(
        "dnc_check",
        "contact",
        "contact-1",
        expect.objectContaining({ is_dnc: true, blocked: true })
      );
    });
  });

  describe("markOptOut", () => {
    it("marks contact as DNC with opt_out source and logs to audit", async () => {
      await enforcer.markOptOut("contact-1", "campaign-contact-1");
      expect(contactDAL.markDnc).toHaveBeenCalledWith("contact-1", "opt_out");
      expect(campaignContactDAL.updateStatus).toHaveBeenCalledWith(
        "campaign-contact-1",
        "dnc"
      );
      expect(auditDAL.log).toHaveBeenCalledWith(
        "opt_out",
        "contact",
        "contact-1",
        expect.objectContaining({ source: "opt_out" })
      );
    });
  });

  describe("markDncManual", () => {
    it("marks contact as DNC with manual source", async () => {
      await enforcer.markDncManual("contact-1");
      expect(contactDAL.markDnc).toHaveBeenCalledWith("contact-1", "manual");
      expect(auditDAL.log).toHaveBeenCalledWith(
        "dnc_set",
        "contact",
        "contact-1",
        expect.objectContaining({ source: "manual" })
      );
    });
  });

  describe("checkNationalRegistry", () => {
    it("returns blocked=false (stub) and logs the check", async () => {
      const result = await enforcer.checkNationalRegistry("972501234567");
      expect(result.blocked).toBe(false);
      expect(result.stub).toBe(true);
      expect(auditDAL.log).toHaveBeenCalledWith(
        "dnc_check",
        "contact",
        null,
        expect.objectContaining({
          registry: "national",
          stub: true,
        })
      );
    });
  });

  describe("bulkMarkDnc", () => {
    it("marks multiple contacts as DNC with manual source", async () => {
      await enforcer.bulkMarkDnc(["contact-1", "contact-2", "contact-3"]);
      expect(contactDAL.markDnc).toHaveBeenCalledTimes(3);
      expect(auditDAL.log).toHaveBeenCalledTimes(3);
    });
  });
});
