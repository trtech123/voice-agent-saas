// apps/voice-engine/src/whatsapp-client.ts

/**
 * Multi-tenant WhatsApp client via Green API.
 *
 * Green API connects to a regular WhatsApp number via QR code scan,
 * which is simpler for Israeli SMBs than the Meta Business API.
 *
 * - Credentials are per-tenant (encrypted in tenants.whatsapp_credentials)
 * - Supports free-form text messages (no template approval needed)
 * - All sends are audit-logged
 * - Call record is updated with whatsapp_sent=true on success
 *
 * Green API docs: https://green-api.com/docs/
 */

import { decryptCredential } from "@vam/database";
import type { TenantDAL, AuditLogDAL, CallDAL } from "@vam/database";

const GREEN_API_BASE_URL = "https://api.green-api.com";

export interface WhatsAppCredentials {
  idInstance: string;
  apiTokenInstance: string;
}

export interface SendFollowUpParams {
  to: string;
  messageBody: string;
  callId: string;
  contactName: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Normalize a phone number by stripping all non-digit characters.
 */
export function normalizePhoneNumber(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/[^\d]/g, "");
}

/**
 * Format a phone number as a Green API chatId.
 * Green API expects: "972XXXXXXXXX@c.us"
 */
function toChatId(phone: string): string {
  const digits = normalizePhoneNumber(phone);
  return `${digits}@c.us`;
}

export class WhatsAppClient {
  private credentialsCache: WhatsAppCredentials | null = null;

  constructor(
    private tenantDAL: TenantDAL,
    private auditDAL: AuditLogDAL,
    private callDAL: CallDAL,
    private kekBase64: string
  ) {}

  /**
   * Get decrypted WhatsApp credentials for the current tenant.
   * Caches after first load (credentials don't change mid-session).
   */
  private async getCredentials(): Promise<WhatsAppCredentials> {
    if (this.credentialsCache) return this.credentialsCache;

    const tenant = await this.tenantDAL.get();
    if (!tenant?.whatsapp_credentials) {
      throw new Error(
        "WhatsApp not configured for this tenant. Set credentials in Settings > WhatsApp."
      );
    }

    const decrypted = decryptCredential(
      tenant.whatsapp_credentials,
      this.kekBase64
    );
    this.credentialsCache = JSON.parse(decrypted) as WhatsAppCredentials;
    return this.credentialsCache;
  }

  /**
   * Build the Green API endpoint URL for a given method.
   */
  private buildUrl(
    credentials: WhatsAppCredentials,
    method: string
  ): string {
    return `${GREEN_API_BASE_URL}/waInstance${credentials.idInstance}/${method}/${credentials.apiTokenInstance}`;
  }

  /**
   * Send a free-form text follow-up message after a qualifying call.
   * Marks calls.whatsapp_sent = true on success.
   */
  async sendFollowUp(params: SendFollowUpParams): Promise<WhatsAppSendResult> {
    const { to, messageBody, callId, contactName } = params;
    const normalizedTo = normalizePhoneNumber(to);

    try {
      const credentials = await this.getCredentials();
      const url = this.buildUrl(credentials, "sendMessage");

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chatId: toChatId(normalizedTo),
          message: messageBody,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMessage =
          (payload as any)?.message ??
          `Green API request failed with status ${response.status}`;
        throw new Error(errorMessage);
      }

      const messageId = (payload as any)?.idMessage ?? null;

      // Mark call as whatsapp_sent
      await this.callDAL.update(callId, { whatsapp_sent: true });

      // Audit log success
      await this.auditDAL.log("whatsapp_sent", "call", callId, {
        to: normalizedTo,
        contact_name: contactName,
        message_id: messageId,
        type: "text",
        provider: "green-api",
        sent_at: new Date().toISOString(),
      });

      return {
        success: true,
        messageId: messageId ?? undefined,
      };
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      // Audit log failure
      await this.auditDAL.log("whatsapp_failed", "call", callId, {
        to: normalizedTo,
        contact_name: contactName,
        error: errorMessage,
        type: "text",
        provider: "green-api",
        attempted_at: new Date().toISOString(),
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Interpolate a WhatsApp message template string with dynamic values.
   * Template format uses {{key}} placeholders.
   *
   * Example:
   *   template: "שלום {{name}}, הנה הפרטים: {{link}}"
   *   params: { name: "Yossi", link: "https://..." }
   *   result: "שלום Yossi, הנה הפרטים: https://..."
   */
  static interpolateTemplate(
    template: string,
    params: Record<string, string>
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return key in params ? params[key] : match;
    });
  }
}
