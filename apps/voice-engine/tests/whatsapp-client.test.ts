// apps/voice-engine/tests/whatsapp-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WhatsAppClient,
  normalizePhoneNumber,
  type WhatsAppCredentials,
} from "../src/whatsapp-client.js";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock DALs
function createMockTenantDAL(credentials: WhatsAppCredentials | null = null) {
  return {
    get: vi.fn().mockResolvedValue({
      id: "tenant-1",
      whatsapp_credentials: credentials ? JSON.stringify(credentials) : null,
    }),
  };
}

function createMockAuditDAL() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCallDAL() {
  return {
    update: vi.fn().mockResolvedValue({}),
  };
}

// Mock encryption
vi.mock("@vam/database", async () => {
  const actual = await vi.importActual("@vam/database");
  return {
    ...actual,
    decryptCredential: vi.fn((encrypted: string) => encrypted), // passthrough for tests
  };
});

describe("normalizePhoneNumber", () => {
  it("strips non-digit characters", () => {
    expect(normalizePhoneNumber("+972-50-123-4567")).toBe("972501234567");
  });

  it("handles already clean numbers", () => {
    expect(normalizePhoneNumber("972501234567")).toBe("972501234567");
  });

  it("handles undefined/null gracefully", () => {
    expect(normalizePhoneNumber(undefined as any)).toBe("");
    expect(normalizePhoneNumber(null as any)).toBe("");
  });
});

describe("WhatsAppClient", () => {
  const validCredentials: WhatsAppCredentials = {
    idInstance: "1234567890",
    apiTokenInstance: "test-api-token-abc123",
  };

  let tenantDAL: ReturnType<typeof createMockTenantDAL>;
  let auditDAL: ReturnType<typeof createMockAuditDAL>;
  let callDAL: ReturnType<typeof createMockCallDAL>;
  let client: WhatsAppClient;

  beforeEach(() => {
    vi.clearAllMocks();
    tenantDAL = createMockTenantDAL(validCredentials);
    auditDAL = createMockAuditDAL();
    callDAL = createMockCallDAL();
    client = new WhatsAppClient(
      tenantDAL as any,
      auditDAL as any,
      callDAL as any,
      "test-kek-base64"
    );
  });

  describe("sendFollowUp", () => {
    it("sends a text message via Green API and marks whatsapp_sent on the call", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ idMessage: "msg-abc123" }),
      });

      const result = await client.sendFollowUp({
        to: "972501234567",
        messageBody: "Test follow-up message",
        callId: "call-1",
        contactName: "Yossi",
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe("msg-abc123");

      // Verify fetch was called with correct Green API URL and payload
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("waInstance1234567890/sendMessage/test-api-token-abc123"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );

      // Verify the body has chatId in Green API format
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.chatId).toBe("972501234567@c.us");
      expect(body.message).toBe("Test follow-up message");

      // Verify call was marked as whatsapp_sent
      expect(callDAL.update).toHaveBeenCalledWith("call-1", {
        whatsapp_sent: true,
      });

      // Verify audit log
      expect(auditDAL.log).toHaveBeenCalledWith(
        "whatsapp_sent",
        "call",
        "call-1",
        expect.objectContaining({
          to: "972501234567",
          message_id: "msg-abc123",
        })
      );
    });

    it("returns failure when tenant has no WhatsApp credentials", async () => {
      tenantDAL = createMockTenantDAL(null);
      client = new WhatsAppClient(tenantDAL as any, auditDAL as any, callDAL as any, "kek");

      const result = await client.sendFollowUp({
        to: "972501234567",
        messageBody: "Hello",
        callId: "call-1",
        contactName: "Test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("WhatsApp not configured");
      expect(auditDAL.log).toHaveBeenCalledWith(
        "whatsapp_failed",
        "call",
        "call-1",
        expect.objectContaining({ error: expect.stringContaining("WhatsApp not configured") })
      );
    });

    it("logs failure to audit on Green API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ message: "Invalid phone number" }),
      });

      const result = await client.sendFollowUp({
        to: "invalid",
        messageBody: "Hello",
        callId: "call-1",
        contactName: "Test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid phone number");
      expect(auditDAL.log).toHaveBeenCalledWith(
        "whatsapp_failed",
        "call",
        "call-1",
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe("interpolateTemplate", () => {
    it("interpolates contact name and deal link into template", () => {
      const template = "שלום {{name}}, הנה הפרטים שביקשת: {{link}}";
      const result = WhatsAppClient.interpolateTemplate(template, {
        name: "Yossi",
        link: "https://example.com/deal/123",
      });
      expect(result).toBe(
        "שלום Yossi, הנה הפרטים שביקשת: https://example.com/deal/123"
      );
    });

    it("leaves unreplaced placeholders as-is", () => {
      const template = "Hello {{name}}, your ref is {{ref}}";
      const result = WhatsAppClient.interpolateTemplate(template, {
        name: "Test",
      });
      expect(result).toBe("Hello Test, your ref is {{ref}}");
    });
  });
});
