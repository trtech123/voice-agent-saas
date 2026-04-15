// apps/voice-engine/src/call-processor.ts

/**
 * Call Processor — Full call lifecycle management.
 *
 * Replaces the Phase 1 placeholder BullMQ worker processor.
 * Implements the complete flow from spec section 4:
 *
 * 1. Validate: DNC, schedule windows, call limit, campaign active
 * 2. Decrypt tenant credentials
 * 3. Initiate outbound call via Voicenter
 * 4. Bridge audio: Voicenter <-> Gemini Live
 * 5. Post-call: recording upload, transcript save, lead scoring,
 *    retry logic for no_answer, dead-letter for permanent failures
 * 6. Audit logging for compliance
 */

import type { Job } from "bullmq";
import {
  createSupabaseAdmin,
  decryptCredential,
  TenantDAL,
  CampaignDAL,
  ContactDAL,
  CampaignContactDAL,
  CallDAL,
  CallTranscriptDAL,
  AuditLogDAL,
} from "@vam/database";
import { config } from "./config.js";
import { CallBridge, type CallBridgeResult } from "./call-bridge.js";
import { VoicenterClient, parseVoicenterCredentials } from "./voicenter-client.js";
import {
  registerPendingCall,
  attachMediaEvents,
  removePendingCall,
  sendToGateway,
} from "./sip-routes.js";
import type { ToolExecutionContext } from "./tools.js";
import type { CallJobData } from "./worker.js";

// ─── Israel Timezone Helpers ────────────────────────────────────────

const IST_TIMEZONE = "Asia/Jerusalem";

/** Day name lookup: 0=sun, 1=mon, ..., 6=sat */
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Check if the given date falls on a scheduled day (in Israel timezone).
 */
export function isScheduleDay(scheduleDays: string[], now: Date): boolean {
  // Get the day of week in Israel timezone
  const istDay = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    weekday: "short",
  }).format(now);

  // Map to our format: Sun -> sun, Mon -> mon, etc.
  const dayMap: Record<string, string> = {
    Sun: "sun",
    Mon: "mon",
    Tue: "tue",
    Wed: "wed",
    Thu: "thu",
    Fri: "fri",
    Sat: "sat",
  };
  const currentDay = dayMap[istDay] ?? "";
  return scheduleDays.includes(currentDay);
}

/**
 * Check if the current time (in Israel timezone) falls within any schedule window.
 */
export function isWithinScheduleWindows(
  windows: Array<{ start: string; end: string }>,
  now: Date
): boolean {
  // Get current time in IST as HH:MM
  const istTime = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  // Normalize to HH:MM (Intl may return single-digit hour)
  const [hourStr, minuteStr] = istTime.split(":");
  const currentMinutes = parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);

  for (const window of windows) {
    const [startH, startM] = window.start.split(":").map(Number);
    const [endH, endM] = window.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return true;
    }
  }

  return false;
}

// ─── Precondition Validation ────────────────────────────────────────

export interface PreconditionResult {
  valid: boolean;
  reason?: string;
}

interface PreconditionDAL {
  contacts: { isDnc: (contactId: string) => Promise<boolean> };
  tenants: { isUnderCallLimit: () => Promise<boolean> };
}

interface CampaignSchedule {
  schedule_days: string[];
  schedule_windows: Array<{ start: string; end: string }>;
  status: string;
}

/**
 * Validate all preconditions before making a call.
 * Checks: DNC status, schedule compliance, call limit, campaign active.
 */
export async function validateCallPreconditions(
  contactId: string,
  campaign: CampaignSchedule,
  dal: PreconditionDAL,
  now = new Date()
): Promise<PreconditionResult> {
  // Campaign must be active
  if (campaign.status !== "active") {
    return { valid: false, reason: "campaign_not_active" };
  }

  // DNC check
  const isDnc = await dal.contacts.isDnc(contactId);
  if (isDnc) {
    return { valid: false, reason: "contact_dnc" };
  }

  // Schedule day check (includes Shabbat)
  if (!isScheduleDay(campaign.schedule_days, now)) {
    return { valid: false, reason: "outside_schedule" };
  }

  // Schedule window check
  if (!isWithinScheduleWindows(campaign.schedule_windows, now)) {
    return { valid: false, reason: "outside_schedule" };
  }

  // Call limit check
  const underLimit = await dal.tenants.isUnderCallLimit();
  if (!underLimit) {
    return { valid: false, reason: "call_limit_exceeded" };
  }

  return { valid: true };
}

// ─── WhatsApp Sender ────────────────────────────────────────────────

async function sendWhatsApp(
  to: string,
  message: string,
  credentials: { accessToken: string; phoneNumberId: string },
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<{ success: boolean; messageId?: string }> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${credentials.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, error: errorText }, "WhatsApp send failed");
      return { success: false };
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const messageId = data.messages?.[0]?.id;
    log.info({ messageId }, "WhatsApp message sent");
    return { success: true, messageId };
  } catch (err) {
    log.error({ err }, "WhatsApp send threw");
    return { success: false };
  }
}

// ─── Main Processor ─────────────────────────────────────────────────

/**
 * Process a single call job. This is the BullMQ processor function.
 *
 * Full lifecycle:
 * 1. Load campaign, contact, tenant from DAL
 * 2. Validate preconditions (DNC, schedule, limits)
 * 3. Create call record
 * 4. Decrypt Voicenter credentials
 * 5. Initiate outbound call via Voicenter
 * 6. Bridge audio between Voicenter and Gemini Live
 * 7. Post-call processing:
 *    - Upload recording to Supabase Storage
 *    - Save transcript
 *    - Update call record with results
 *    - Update campaign_contact status
 *    - Handle retry for no_answer
 *    - Send WhatsApp for hot/warm leads
 *    - Audit logging
 */
export async function processCallJob(
  job: Job<CallJobData>,
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    child: (bindings: Record<string, unknown>) => any;
  }
): Promise<void> {
  const { tenantId, campaignId, contactId, campaignContactId } = job.data;
  const jobLog = log.child({ jobId: job.id, tenantId, campaignId, contactId });

  jobLog.info("Processing call job");

  // Initialize DAL (tenant-scoped)
  const db = createSupabaseAdmin(config.supabaseUrl, config.supabaseServiceRoleKey);
  const tenantDal = new TenantDAL(db, tenantId);
  const campaignDal = new CampaignDAL(db, tenantId);
  const contactDal = new ContactDAL(db, tenantId);
  const campaignContactDal = new CampaignContactDAL(db, tenantId);
  const callDal = new CallDAL(db, tenantId);
  const transcriptDal = new CallTranscriptDAL(db, tenantId);
  const auditLogDal = new AuditLogDAL(db, tenantId);

  // -- Step 1: Load entities --
  const [tenant, campaign, contact, campaignContact] = await Promise.all([
    tenantDal.get(),
    campaignDal.getById(campaignId),
    contactDal.getById(contactId),
    campaignContactDal.getById(campaignContactId),
  ]);

  if (!tenant || !campaign || !contact || !campaignContact) {
    jobLog.error(
      { hasTenant: !!tenant, hasCampaign: !!campaign, hasContact: !!contact },
      "Missing entities for call job"
    );
    return;
  }

  // -- Step 2: Validate preconditions --
  const precondition = await validateCallPreconditions(
    contactId,
    campaign as unknown as CampaignSchedule,
    { contacts: contactDal, tenants: tenantDal }
  );

  if (!precondition.valid) {
    jobLog.warn(
      { reason: precondition.reason },
      "Call precondition failed"
    );

    // Log to audit
    await auditLogDal.log(
      precondition.reason === "contact_dnc" ? "dnc_check" : "schedule_check",
      "call",
      null,
      { contactId, reason: precondition.reason }
    );

    // If DNC, update campaign_contact status
    if (precondition.reason === "contact_dnc") {
      await campaignContactDal.updateStatus(campaignContactId, "dnc");
    }

    return;
  }

  // -- Step 3: Atomic call limit increment + create call record --
  const newCallCount = await tenantDal.incrementCallsUsed();
  jobLog.info({ callsUsed: newCallCount }, "Call limit incremented");

  const callRecord = await callDal.create({
    campaign_id: campaignId,
    contact_id: contactId,
    campaign_contact_id: campaignContactId,
    status: "initiated",
    started_at: new Date().toISOString(),
  });
  const callId = callRecord.id;
  jobLog.info({ callId }, "Call record created");

  // Update campaign_contact to calling
  await campaignContactDal.updateStatus(campaignContactId, "calling", {
    call_id: callId,
    attempt_count: campaignContact.attempt_count + 1,
  });

  // Audit log: call_start
  await auditLogDal.log("call_start", "call", callId, {
    contactId,
    campaignId,
    attemptCount: campaignContact.attempt_count + 1,
  });

  // -- Step 4: Initialize SIP gateway client --
  // MVP: All tenants share the same Voicenter trunk via the Asterisk gateway.
  // Per-tenant SIP credentials are a post-MVP feature.
  const voicenterClient = new VoicenterClient(
    { apiKey: config.sipGatewayApiKey, callerId: "", tenantId },
    jobLog
  );

  // -- Step 5: Register pending call + initiate outbound call --
  // Register the call in the SIP routes module so inbound gateway
  // connections (lifecycle events + media WebSocket) can be matched.
  registerPendingCall(callId);

  // Voice engine public URL for gateway callbacks
  const voiceEnginePublicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${config.port}`;
  const eventWebhookUrl = `${voiceEnginePublicUrl}/api/v1/sip-events`;
  const mediaStreamWsUrl = voiceEnginePublicUrl.replace("https://", "wss://").replace("http://", "ws://")
    + `/api/v1/media-stream?callId=${encodeURIComponent(callId)}`;

  const callResult = await voicenterClient.initiateCall(contact.phone, callId, {
    eventWebhookUrl,
    mediaStreamUrl: mediaStreamWsUrl,
  });
  if (!callResult.success) {
    jobLog.error(
      { error: callResult.error },
      "SIP gateway call initiation failed"
    );
    await callDal.update(callId, {
      status: "failed",
      failure_reason: callResult.error ?? "sip_gateway_initiation_failed",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    removePendingCall(callId);
    return;
  }

  // Update call with SIP gateway call ID
  await callDal.update(callId, {
    voicenter_call_id: callResult.sipCallId,
    status: "ringing",
  });

  // -- Step 6: Parse WhatsApp credentials --
  let whatsappCreds = { accessToken: "", phoneNumberId: "" };
  if (tenant.whatsapp_credentials) {
    try {
      const decrypted = decryptCredential(tenant.whatsapp_credentials, config.credentialKek);
      whatsappCreds = JSON.parse(decrypted);
    } catch {
      jobLog.warn("Failed to decrypt WhatsApp credentials, WhatsApp sends will fail");
    }
  }

  // -- Step 7: Build tool execution context --
  const toolContext: ToolExecutionContext = {
    tenantId,
    campaignId,
    contactId,
    callId,
    contactPhone: contact.phone,
    contactName: contact.name,
    whatsappFollowupTemplate: campaign.whatsapp_followup_template,
    whatsappFollowupLink: campaign.whatsapp_followup_link,
    dal: {
      contacts: contactDal,
      calls: callDal,
      campaignContacts: campaignContactDal,
      auditLog: auditLogDal,
    },
    sendWhatsApp: (to, message) => sendWhatsApp(to, message, whatsappCreds, jobLog),
    log: jobLog,
  };

  // -- Step 8: Start call bridge --
  const bridge = new CallBridge({
    callId,
    tenantId,
    campaignId,
    contactId,
    campaignContactId,
    contactPhone: contact.phone,
    contactName: contact.name,
    campaign: {
      script: campaign.script,
      questions: campaign.questions as Array<{ question: string; key: string; options?: string[] }>,
      whatsapp_followup_template: campaign.whatsapp_followup_template,
      whatsapp_followup_link: campaign.whatsapp_followup_link,
    },
    tenant: {
      name: tenant.name,
      business_type: tenant.business_type,
    },
    contact: {
      name: contact.name,
      phone: contact.phone,
      custom_fields: (contact.custom_fields ?? {}) as Record<string, unknown>,
    },
    toolContext,
    voicenterClient,
    onGatewayControl: (msg) => sendToGateway(callId, msg),
    log: jobLog,
  });

  // Wire outbound audio: bridge -> VoicenterClient -> gateway WebSocket
  // Instead of the old outbound connectMediaStream, we route audio through
  // the sip-routes pending call registry where the gateway connects to us.
  voicenterClient.setSendFn((audioBase64, mimeType) => {
    sendToGateway(callId, {
      event: "media",
      audio: { data: audioBase64, mimeType },
    });
  });

  // Update call status to connected
  await callDal.update(callId, { status: "connected" });

  // Wait for bridge to complete (call ends).
  // bridge.start() sets _mediaEvents synchronously inside its Promise
  // constructor, so we capture the promise without awaiting, attach the
  // media events to the sip-routes pending call, then await completion.
  let bridgeResult: CallBridgeResult;
  const bridgePromise = bridge.start();

  // Now _mediaEvents is set — wire them into the sip-routes registry
  // so inbound gateway WebSocket messages reach the bridge.
  const mediaEvents = bridge.getMediaEvents();
  if (mediaEvents) {
    attachMediaEvents(callId, mediaEvents);
  }

  try {
    bridgeResult = await bridgePromise;
  } catch (err) {
    jobLog.error({ err }, "Call bridge threw unexpectedly");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: err instanceof Error ? err.message : "bridge_error",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    voicenterClient.cleanup();
    removePendingCall(callId);
    return;
  }

  // -- Step 9: Post-call processing --
  jobLog.info(
    {
      duration: bridgeResult.duration_seconds,
      endReason: bridgeResult.endReason,
      transcriptParts: bridgeResult.transcript.length,
      hasRecording: !!bridgeResult.recordingBuffer,
    },
    "Call bridge completed, starting post-call processing"
  );

  // Hang up Voicenter call and clean up pending call registry
  await voicenterClient.hangup();
  voicenterClient.cleanup();
  removePendingCall(callId);

  // Determine final call status
  const isNoAnswer =
    bridgeResult.endReason === "voicenter_no_answer" ||
    bridgeResult.duration_seconds < 5;

  const finalStatus = isNoAnswer ? "no_answer" : "completed";

  // Update call record with final data
  await callDal.update(callId, {
    status: finalStatus,
    ended_at: new Date().toISOString(),
    duration_seconds: bridgeResult.duration_seconds,
  });

  // Upload recording to Supabase Storage
  if (bridgeResult.recordingBuffer && bridgeResult.recordingBuffer.length > 0) {
    try {
      const storagePath = `${tenantId}/recordings/${callId}.wav`;
      const { error: uploadError } = await db.storage
        .from("recordings")
        .upload(storagePath, bridgeResult.recordingBuffer, {
          contentType: "audio/wav",
          upsert: true,
        });
      if (uploadError) {
        jobLog.error({ error: uploadError }, "Recording upload failed");
      } else {
        await callDal.update(callId, { recording_path: storagePath });
        jobLog.info({ storagePath }, "Recording uploaded");
      }
    } catch (err) {
      jobLog.error({ err }, "Recording upload threw");
    }
  }

  // Save transcript
  if (bridgeResult.transcript.length > 0) {
    const transcriptWithTimestamps = bridgeResult.transcript.map((t) => ({
      ...t,
      timestamp: new Date().toISOString(),
    }));
    await transcriptDal.save(callId, transcriptWithTimestamps);
  }

  // Update campaign_contact status
  if (isNoAnswer) {
    // Retry logic: re-enqueue if under max attempts
    if (campaignContact.attempt_count + 1 < campaign.max_retry_attempts) {
      const nextRetryAt = new Date(
        Date.now() + campaign.retry_delay_minutes * 60 * 1000
      ).toISOString();
      await campaignContactDal.updateStatus(campaignContactId, "no_answer", {
        next_retry_at: nextRetryAt,
        attempt_count: campaignContact.attempt_count + 1,
      });
      jobLog.info(
        { nextRetryAt, attemptCount: campaignContact.attempt_count + 1 },
        "No answer — scheduled retry"
      );
    } else {
      await campaignContactDal.updateStatus(campaignContactId, "no_answer", {
        attempt_count: campaignContact.attempt_count + 1,
      });
      jobLog.info("No answer — max retries reached");
    }
  } else {
    await campaignContactDal.updateStatus(campaignContactId, "completed", {
      call_id: callId,
      attempt_count: campaignContact.attempt_count + 1,
    });
  }

  // Send WhatsApp for hot/warm leads (if not already sent by tool)
  const updatedCall = await callDal.getById(callId);
  if (
    updatedCall &&
    !updatedCall.whatsapp_sent &&
    (updatedCall.lead_status === "hot" || updatedCall.lead_status === "warm") &&
    campaign.whatsapp_followup_template &&
    whatsappCreds.accessToken
  ) {
    const whatsappMessage = campaign.whatsapp_followup_template.replace(
      /\[link\]/g,
      campaign.whatsapp_followup_link || ""
    );
    const waResult = await sendWhatsApp(
      contact.phone,
      whatsappMessage,
      whatsappCreds,
      jobLog
    );
    if (waResult.success) {
      await callDal.update(callId, { whatsapp_sent: true });
    }
  }

  // Audit log: call_end
  await auditLogDal.log("call_end", "call", callId, {
    contactId,
    campaignId,
    duration: bridgeResult.duration_seconds,
    endReason: bridgeResult.endReason,
    leadStatus: updatedCall?.lead_status ?? null,
    leadScore: updatedCall?.lead_score ?? null,
  });

  // Recording consent audit
  await auditLogDal.log("recording_consent", "call", callId, {
    contactId,
    disclosed: true,
  });

  jobLog.info(
    {
      callId,
      duration: bridgeResult.duration_seconds,
      status: finalStatus,
      leadStatus: updatedCall?.lead_status,
    },
    "Call job processing complete"
  );
}

// ─── Dead-Letter Handler ────────────────────────────────────────────

/**
 * Handle permanent call failures by moving to dead-letter state.
 * Called when the BullMQ job fails permanently.
 */
export async function handleDeadLetter(
  jobData: CallJobData,
  failureReason: string,
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<void> {
  const { tenantId, campaignContactId } = jobData;

  const db = createSupabaseAdmin(config.supabaseUrl, config.supabaseServiceRoleKey);
  const campaignContactDal = new CampaignContactDAL(db, tenantId);
  const auditLogDal = new AuditLogDAL(db, tenantId);

  await campaignContactDal.updateStatus(campaignContactId, "failed");

  await auditLogDal.log("call_dead_letter", "call", null, {
    ...jobData,
    failureReason,
  });

  log.info({ ...jobData, failureReason }, "Call moved to dead letter");
}
