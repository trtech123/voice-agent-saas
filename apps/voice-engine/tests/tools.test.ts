// apps/voice-engine/tests/tools.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildToolDefinitions,
  executeToolCall,
  type ToolExecutionContext,
} from "../src/tools.js";

describe("buildToolDefinitions", () => {
  it("returns a valid Gemini function declarations object", () => {
    const defs = buildToolDefinitions();
    expect(defs).toHaveProperty("functionDeclarations");
    expect(Array.isArray(defs.functionDeclarations)).toBe(true);
  });

  it("includes all 5 SaaS tools", () => {
    const defs = buildToolDefinitions();
    const names = defs.functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toContain("score_lead");
    expect(names).toContain("send_whatsapp");
    expect(names).toContain("request_callback");
    expect(names).toContain("mark_opt_out");
    expect(names).toContain("end_call");
    expect(names).toHaveLength(5);
  });

  it("score_lead has required parameters", () => {
    const defs = buildToolDefinitions();
    const scoreLead = defs.functionDeclarations.find(
      (d: { name: string }) => d.name === "score_lead"
    );
    expect(scoreLead).toBeDefined();
    const paramNames = Object.keys(scoreLead!.parameters.properties);
    expect(paramNames).toContain("score");
    expect(paramNames).toContain("status");
    expect(paramNames).toContain("answers");
  });
});

describe("executeToolCall", () => {
  let mockContext: ToolExecutionContext;

  beforeEach(() => {
    mockContext = {
      tenantId: "tenant-123",
      campaignId: "campaign-456",
      contactId: "contact-789",
      callId: "call-abc",
      contactPhone: "972501234567",
      contactName: "דני כהן",
      whatsappFollowupTemplate: "הנה פרטים: [link]",
      whatsappFollowupLink: "https://example.com",
      dal: {
        contacts: {
          markDnc: vi.fn().mockResolvedValue(undefined),
        },
        calls: {
          update: vi.fn().mockResolvedValue({}),
        },
        campaignContacts: {
          updateStatus: vi.fn().mockResolvedValue(undefined),
        },
        auditLog: {
          log: vi.fn().mockResolvedValue(undefined),
        },
      } as any,
      sendWhatsApp: vi.fn().mockResolvedValue({ success: true, messageId: "msg-1" }),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any,
    };
  });

  it("score_lead returns success with score and status", async () => {
    const result = await executeToolCall(
      "score_lead",
      { score: 4, status: "hot", answers: { budget: "1M", area: "תל אביב" } },
      mockContext
    );
    expect(result).toEqual({ success: true, score: 4, status: "hot" });
  });

  it("score_lead updates the call record via DAL", async () => {
    await executeToolCall(
      "score_lead",
      { score: 4, status: "hot", answers: { budget: "1M" } },
      mockContext
    );
    expect(mockContext.dal.calls.update).toHaveBeenCalledWith(
      "call-abc",
      expect.objectContaining({
        lead_score: 4,
        lead_status: "hot",
        qualification_answers: { budget: "1M" },
      })
    );
  });

  it("send_whatsapp calls the WhatsApp sender", async () => {
    const result = await executeToolCall(
      "send_whatsapp",
      { message: "פרטים נוספים" },
      mockContext
    );
    expect(mockContext.sendWhatsApp).toHaveBeenCalled();
    expect(result).toHaveProperty("success", true);
  });

  it("request_callback returns success with preferred time", async () => {
    const result = await executeToolCall(
      "request_callback",
      { preferred_time: "מחר בבוקר" },
      mockContext
    );
    expect(result).toEqual({
      success: true,
      callback_requested: true,
      preferred_time: "מחר בבוקר",
    });
  });

  it("request_callback updates campaign_contact status to callback", async () => {
    await executeToolCall(
      "request_callback",
      { preferred_time: "מחר ב-10" },
      mockContext
    );
    expect(mockContext.dal.calls.update).toHaveBeenCalledWith(
      "call-abc",
      expect.objectContaining({ lead_status: "callback" })
    );
  });

  it("mark_opt_out marks contact as DNC", async () => {
    const result = await executeToolCall("mark_opt_out", {}, mockContext);
    expect(mockContext.dal.contacts.markDnc).toHaveBeenCalledWith("contact-789", "opt_out");
    expect(result).toEqual({ success: true, dnc_set: true });
  });

  it("mark_opt_out writes to audit log", async () => {
    await executeToolCall("mark_opt_out", {}, mockContext);
    expect(mockContext.dal.auditLog.log).toHaveBeenCalledWith(
      "opt_out",
      "contact",
      "contact-789",
      expect.any(Object)
    );
  });

  it("end_call returns success with disposition", async () => {
    const result = await executeToolCall(
      "end_call",
      { disposition: "completed_qualified" },
      mockContext
    );
    expect(result).toEqual({ success: true, disposition: "completed_qualified", call_ended: true });
  });

  it("unknown tool returns error", async () => {
    const result = await executeToolCall("unknown_tool", {}, mockContext);
    expect(result).toHaveProperty("error");
  });
});
