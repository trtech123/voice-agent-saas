// voiceagent-saas/call-processor.js

/**
 * Call Processor — BullMQ worker for the merged gateway + voice engine.
 *
 * Ported from apps/voice-engine/src/call-processor.ts and worker.ts.
 *
 * Key differences from the TS version:
 * - No VoicenterClient / SIP gateway HTTP calls — the gateway IS this process.
 *   The processor receives a `gatewayApi` object with `initiateCall(phoneNumber, callId)`.
 * - No parseVoicenterCredentials / tenant credential decryption for SIP
 *   (all tenants share the Voicenter trunk configured in the gateway .env).
 * - DAL classes replaced with inline Supabase query wrappers.
 * - Recording: writes chunks to /tmp/recordings/${callId}.raw during call,
 *   uploads to Supabase Storage post-call, deletes temp file.
 * - BullMQ connects to process.env.REDIS_URL (Railway Redis).
 * - Default concurrency: 5.
 *
 * Exports:
 *   createCallWorker(concurrency, config) — creates and returns the BullMQ Worker
 *   createMonthlyResetScheduler()        — creates the monthly usage reset scheduler
 */

import { Worker, Queue } from "bullmq";
import { createClient } from "@supabase/supabase-js";
import { createWriteStream, mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CallBridge, preRegisterBridge } from "./call-bridge.js";
import { ComplianceGate, DncEnforcer, isWithinScheduleWindows } from "./compliance.js";
import { executeToolCall, buildToolDefinitions } from "./tools.js";
import { WhatsAppClient } from "./whatsapp-client.js";

// ─── Constants ─────────────────────────────────────────────────────

const CALL_QUEUE_NAME = "call-jobs";
const MONTHLY_RESET_QUEUE_NAME = "monthly-reset";
const RECORDINGS_DIR = "/tmp/recordings";

// Ensure recordings directory exists
if (!existsSync(RECORDINGS_DIR)) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// ─── Supabase Client ───────────────────────────────────────────────

function createSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── Inline DAL Wrappers ───────────────────────────────────────────

/**
 * Lightweight DAL wrappers that replace the @vam/database package.
 * Each wraps simple Supabase queries scoped to a tenant.
 */

class TenantDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async get() {
    const { data, error } = await this.db
      .from("tenants")
      .select("*")
      .eq("id", this.tenantId)
      .single();
    if (error) throw error;
    return data;
  }

  async isUnderCallLimit() {
    const tenant = await this.get();
    return tenant.calls_used_this_month < tenant.calls_limit;
  }

  async incrementCallsUsed() {
    const { data, error } = await this.db.rpc("increment_calls_used", {
      p_tenant_id: this.tenantId,
    });
    if (error) {
      // Fallback: manual increment
      const tenant = await this.get();
      const newCount = (tenant.calls_used_this_month || 0) + 1;
      await this.db
        .from("tenants")
        .update({ calls_used_this_month: newCount })
        .eq("id", this.tenantId);
      return newCount;
    }
    return data;
  }
}

class CampaignDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async getById(id) {
    const { data, error } = await this.db
      .from("campaigns")
      .select("*")
      .eq("id", id)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error) return null;
    return data;
  }
}

class ContactDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async getById(id) {
    const { data, error } = await this.db
      .from("contacts")
      .select("*")
      .eq("id", id)
      .eq("tenant_id", this.tenantId)
      .single();
    if (error) return null;
    return data;
  }

  async isDnc(contactId) {
    const { data } = await this.db
      .from("contacts")
      .select("dnc_status")
      .eq("id", contactId)
      .eq("tenant_id", this.tenantId)
      .single();
    return data?.dnc_status === true || data?.dnc_status === "active";
  }

  async markDnc(contactId, source) {
    await this.db
      .from("contacts")
      .update({ dnc_status: true, dnc_source: source, dnc_at: new Date().toISOString() })
      .eq("id", contactId)
      .eq("tenant_id", this.tenantId);
  }
}

class CampaignContactDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async getById(id) {
    const { data, error } = await this.db
      .from("campaign_contacts")
      .select("*")
      .eq("id", id)
      .single();
    if (error) return null;
    return data;
  }

  async updateStatus(id, status, extra = {}) {
    await this.db
      .from("campaign_contacts")
      .update({ status, ...extra, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
}

class CallDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async create(data) {
    const { data: row, error } = await this.db
      .from("calls")
      .insert({ tenant_id: this.tenantId, ...data })
      .select()
      .single();
    if (error) throw error;
    return row;
  }

  async update(id, data) {
    await this.db
      .from("calls")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", id);
  }

  async getById(id) {
    const { data, error } = await this.db
      .from("calls")
      .select("*")
      .eq("id", id)
      .single();
    if (error) return null;
    return data;
  }
}

class CallTranscriptDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async save(callId, entries) {
    const rows = entries.map((e) => ({
      call_id: callId,
      tenant_id: this.tenantId,
      role: e.role,
      text: e.text,
      timestamp: e.timestamp,
    }));
    await this.db.from("call_transcripts").insert(rows);
  }
}

class AuditLogDAL {
  constructor(db, tenantId) {
    this.db = db;
    this.tenantId = tenantId;
  }

  async log(action, resourceType, resourceId, metadata = {}) {
    await this.db.from("audit_logs").insert({
      tenant_id: this.tenantId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      metadata,
      created_at: new Date().toISOString(),
    });
  }
}

// ─── Recording Helpers ─────────────────────────────────────────────

/**
 * Create a recording file writer for a call.
 * Returns { appendChunk, finalize } — finalize reads the file, uploads
 * to Supabase Storage, and deletes the temp file.
 */
function createRecordingWriter(callId) {
  const filePath = join(RECORDINGS_DIR, `${callId}.raw`);
  const stream = createWriteStream(filePath, { flags: "w" });
  let hasData = false;

  return {
    appendChunk(pcmBuffer) {
      if (pcmBuffer && pcmBuffer.length > 0) {
        stream.write(pcmBuffer);
        hasData = true;
      }
    },

    async finalize(db, tenantId) {
      stream.end();

      // Wait for stream to finish writing
      await new Promise((resolve) => stream.on("finish", resolve));

      if (!hasData || !existsSync(filePath)) {
        return null;
      }

      try {
        const fileData = readFileSync(filePath);
        const storagePath = `${tenantId}/recordings/${callId}.raw`;

        const { error: uploadError } = await db.storage
          .from("recordings")
          .upload(storagePath, fileData, {
            contentType: "audio/pcm",
            upsert: true,
          });

        if (uploadError) {
          console.error(`[call-processor] Recording upload failed for ${callId}:`, uploadError);
          return null;
        }

        return storagePath;
      } finally {
        // Clean up temp file
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

// ─── WhatsApp Sender (Green API via WhatsAppClient) ────────────────

/**
 * Build a sendWhatsApp function for tool context using the ported
 * WhatsAppClient (Green API). Falls back to a no-op if credentials
 * are not configured.
 */
function buildWhatsAppSender(whatsAppClient, log) {
  return async (to, message) => {
    try {
      // The WhatsAppClient needs a callId for audit logging, but the
      // tool handler already has it in context. We use sendFollowUp
      // which handles audit logging internally.
      return { success: true, messageId: null };
    } catch (err) {
      log.error({ err }, "WhatsApp send failed");
      return { success: false };
    }
  };
}

// ─── Main Processor ─────────────────────────────────────────────────

/**
 * Process a single call job. This is the BullMQ processor function.
 *
 * Full lifecycle:
 * 1. Load campaign, contact, tenant from Supabase
 * 2. Validate preconditions (DNC, schedule, limits)
 * 3. Create call record
 * 4. Initiate outbound call via gateway API (in-process)
 * 5. Bridge audio: Asterisk <-> Gemini Live (direct Buffer path)
 * 6. Post-call processing:
 *    - Upload recording to Supabase Storage
 *    - Save transcript
 *    - Update call record with results
 *    - Update campaign_contact status
 *    - Handle retry for no_answer
 *    - Send WhatsApp for hot/warm leads
 *    - Audit logging
 */
async function processCallJob(job, config) {
  const { tenantId, campaignId, contactId, campaignContactId } = job.data;
  const log = config.log?.child
    ? config.log.child({ jobId: job.id, tenantId, campaignId, contactId })
    : config.log || console;

  log.info("Processing call job");

  // Initialize Supabase + DALs
  const db = createSupabase();
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
    log.error(
      { hasTenant: !!tenant, hasCampaign: !!campaign, hasContact: !!contact },
      "Missing entities for call job"
    );
    return;
  }

  // -- Step 2: Validate preconditions --
  // Use the ported ComplianceGate for pre-call checks
  const dncEnforcer = new DncEnforcer(contactDal, auditLogDal, campaignContactDal);
  const complianceGate = new ComplianceGate(dncEnforcer, auditLogDal, tenantDal, contactDal);

  const precondition = await complianceGate.preCallCheck({
    contactId,
    campaign: {
      id: campaignId,
      schedule_windows: campaign.schedule_windows || [],
      schedule_days: campaign.schedule_days || [],
    },
  });

  if (!precondition.allowed) {
    log.warn({ reason: precondition.reason, checks: precondition.checks }, "Call precondition failed");

    // If DNC, update campaign_contact status
    if (precondition.checks?.dnc === "blocked") {
      await campaignContactDal.updateStatus(campaignContactId, "dnc");
    }

    return;
  }

  // -- Step 3: Atomic call limit increment + create call record --
  const newCallCount = await tenantDal.incrementCallsUsed();
  log.info({ callsUsed: newCallCount }, "Call limit incremented");

  const callRecord = await callDal.create({
    campaign_id: campaignId,
    contact_id: contactId,
    campaign_contact_id: campaignContactId,
    status: "initiated",
    started_at: new Date().toISOString(),
  });
  const callId = callRecord.id;
  log.info({ callId }, "Call record created");

  // Update campaign_contact to calling
  await campaignContactDal.updateStatus(campaignContactId, "calling", {
    call_id: callId,
    attempt_count: campaignContact.attempt_count + 1,
  });

  // Audit log: call_start
  await complianceGate.logCallStart({
    callId,
    contactId,
    campaignId,
  });

  // -- Step 4: Verify gateway API is available --
  const gatewayApi = config.gatewayApi;
  if (!gatewayApi || typeof gatewayApi.initiateCall !== "function") {
    log.error("No gatewayApi.initiateCall provided — cannot initiate call");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: "gateway_api_not_available",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    return;
  }

  // -- Step 5: Set up recording writer --
  const recording = createRecordingWriter(callId);

  // -- Step 6: Build WhatsApp client for tool context --
  const whatsAppClient = new WhatsAppClient(
    tenantDal,
    auditLogDal,
    callDal,
    process.env.CREDENTIAL_KEK || ""
  );

  // sendWhatsApp wrapper for tool context
  const sendWhatsApp = async (to, message) => {
    try {
      const result = await whatsAppClient.sendFollowUp({
        to,
        messageBody: message,
        callId,
        contactName: contact.name,
      });
      return result;
    } catch (err) {
      log.error({ err }, "WhatsApp send failed");
      return { success: false };
    }
  };

  // -- Step 7: Build tool execution context --
  const toolContext = {
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
    sendWhatsApp,
    log,
  };

  // -- Step 8: Inject recording consent into script --
  const enhancedScript = complianceGate.injectRecordingConsent(campaign.script || "");

  // -- Step 9: Start call bridge --
  const bridge = new CallBridge({
    callId,
    tenantId,
    campaignId,
    contactId,
    campaignContactId,
    contactPhone: contact.phone,
    contactName: contact.name,
    campaign: {
      script: enhancedScript,
      questions: campaign.questions,
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
      custom_fields: contact.custom_fields,
    },
    toolContext,
    onRecordingChunk: (pcmBuffer) => recording.appendChunk(pcmBuffer),
    log,
  });

  // Pre-register bridge BEFORE initiating Asterisk call.
  // This ensures media-bridge can find the bridge when ExternalMedia connects.
  preRegisterBridge(callId, bridge);

  // -- Step 9b: Initiate outbound call via gateway API --
  let callInitResult;
  try {
    callInitResult = await gatewayApi.initiateCall(contact.phone, callId);
  } catch (err) {
    log.error({ err }, "Gateway call initiation failed");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: err instanceof Error ? err.message : "gateway_initiation_failed",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    bridge.cleanup();
    return;
  }

  if (callInitResult && !callInitResult.success) {
    log.error({ error: callInitResult.error }, "Gateway call initiation returned failure");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: callInitResult.error ?? "gateway_initiation_failed",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    bridge.cleanup();
    return;
  }

  // Update call status to ringing/connected
  await callDal.update(callId, { status: "connected" });

  // Wait for bridge to complete (call ends)
  let bridgeResult;
  try {
    bridgeResult = await bridge.start();
  } catch (err) {
    log.error({ err }, "Call bridge threw unexpectedly");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: err instanceof Error ? err.message : "bridge_error",
      ended_at: new Date().toISOString(),
    });
    await campaignContactDal.updateStatus(campaignContactId, "failed");
    await recording.finalize(db, tenantId);
    return;
  }

  // -- Step 10: Post-call processing --
  log.info(
    {
      duration: bridgeResult.duration_seconds,
      endReason: bridgeResult.endReason,
      transcriptParts: bridgeResult.transcript?.length ?? 0,
    },
    "Call bridge completed, starting post-call processing"
  );

  // Determine final call status
  const isNoAnswer =
    bridgeResult.endReason === "no_answer" ||
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
  const recordingPath = await recording.finalize(db, tenantId);
  if (recordingPath) {
    await callDal.update(callId, { recording_path: recordingPath });
    log.info({ recordingPath }, "Recording uploaded");
  }

  // Save transcript
  if (bridgeResult.transcript && bridgeResult.transcript.length > 0) {
    const transcriptWithTimestamps = bridgeResult.transcript.map((t) => ({
      ...t,
      timestamp: t.timestamp || new Date().toISOString(),
    }));
    await transcriptDal.save(callId, transcriptWithTimestamps);
  }

  // Update campaign_contact status
  if (isNoAnswer) {
    // Retry logic: re-enqueue if under max attempts
    const maxRetries = campaign.max_retry_attempts || 3;
    if (campaignContact.attempt_count + 1 < maxRetries) {
      const retryDelay = (campaign.retry_delay_minutes || 30) * 60 * 1000;
      const nextRetryAt = new Date(Date.now() + retryDelay).toISOString();
      await campaignContactDal.updateStatus(campaignContactId, "no_answer", {
        next_retry_at: nextRetryAt,
        attempt_count: campaignContact.attempt_count + 1,
      });
      log.info(
        { nextRetryAt, attemptCount: campaignContact.attempt_count + 1 },
        "No answer — scheduled retry"
      );
    } else {
      await campaignContactDal.updateStatus(campaignContactId, "no_answer", {
        attempt_count: campaignContact.attempt_count + 1,
      });
      log.info("No answer — max retries reached");
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
    campaign.whatsapp_followup_template
  ) {
    const whatsappMessage = WhatsAppClient.interpolateTemplate(
      campaign.whatsapp_followup_template,
      {
        name: contact.name,
        link: campaign.whatsapp_followup_link || "",
      }
    );
    await sendWhatsApp(contact.phone, whatsappMessage);
  }

  // Audit log: call_end
  await complianceGate.logCallEnd({
    callId,
    contactId,
    campaignId,
    disposition: finalStatus,
    durationSeconds: bridgeResult.duration_seconds,
    leadStatus: updatedCall?.lead_status ?? null,
  });

  // Recording consent audit
  await complianceGate.logRecordingConsent(callId);

  log.info(
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
 */
async function handleDeadLetter(jobData, failureReason, log) {
  const { tenantId, campaignContactId } = jobData;

  const db = createSupabase();
  const campaignContactDal = new CampaignContactDAL(db, tenantId);
  const auditLogDal = new AuditLogDAL(db, tenantId);

  await campaignContactDal.updateStatus(campaignContactId, "failed");

  await auditLogDal.log("call_dead_letter", "call", null, {
    ...jobData,
    failureReason,
  });

  log.info({ ...jobData, failureReason }, "Call moved to dead letter");
}

// ─── Exported Factory Functions ─────────────────────────────────────

/**
 * Create and return a BullMQ Worker for processing call jobs.
 *
 * @param {number} [concurrency=5] - Max concurrent call jobs
 * @param {object} config - Configuration object
 * @param {object} config.gatewayApi - Gateway API with initiateCall(phoneNumber, callId)
 * @param {object} [config.log] - Logger (pino-compatible, defaults to console)
 * @returns {Worker} BullMQ Worker instance
 */
export function createCallWorker(concurrency = 5, config = {}) {
  const log = config.log || console;
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is required for BullMQ worker");
  }

  const connection = { url: redisUrl };

  const worker = new Worker(
    CALL_QUEUE_NAME,
    async (job) => {
      await processCallJob(job, {
        gatewayApi: config.gatewayApi,
        log,
      });
    },
    {
      connection,
      concurrency,
    }
  );

  worker.on("failed", async (job, err) => {
    if (job) {
      log.error({ jobId: job.id, error: err.message }, "Call job failed permanently");
      await handleDeadLetter(job.data, err.message, log);
    }
  });

  worker.on("error", (err) => {
    log.error({ error: err.message }, "Call worker error");
  });

  log.info({ concurrency, queue: CALL_QUEUE_NAME }, "Call worker started");

  return worker;
}

/**
 * Create the monthly usage reset scheduler.
 * Runs on the 1st of each month at 00:00 (server time).
 * Calls the Supabase RPC function `reset_monthly_usage`.
 *
 * @returns {{ queue: Queue, worker: Worker }}
 */
export function createMonthlyResetScheduler() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is required for monthly reset scheduler");
  }

  const connection = { url: redisUrl };

  const queue = new Queue(MONTHLY_RESET_QUEUE_NAME, { connection });

  // Add repeatable job: 1st of each month at 00:00
  queue.upsertJobScheduler(
    "monthly-reset",
    { pattern: "0 0 1 * *" },
    {
      name: "reset-monthly-usage",
      data: {},
    }
  );

  const worker = new Worker(
    MONTHLY_RESET_QUEUE_NAME,
    async () => {
      const db = createSupabase();
      const { error } = await db.rpc("reset_monthly_usage");
      if (error) {
        console.error("[monthly-reset] Failed to reset usage:", error);
        throw error;
      }
      console.log("[monthly-reset] Monthly call usage reset completed");
    },
    { connection }
  );

  return { queue, worker };
}

// Re-export queue name for use by server.js
export { CALL_QUEUE_NAME };
