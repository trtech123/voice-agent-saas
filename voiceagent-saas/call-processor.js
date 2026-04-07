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
import { CallBridge, preRegisterBridge } from "./call-bridge.js";
import { ComplianceGate, DncEnforcer, isWithinScheduleWindows } from "./compliance.js";
import { executeToolCall, buildToolDefinitions } from "./tools.js";
import { WhatsAppClient } from "./whatsapp-client.js";

// ─── Constants ─────────────────────────────────────────────────────

const CALL_QUEUE_NAME = "call-jobs";
const MONTHLY_RESET_QUEUE_NAME = "monthly-reset";

// Failure reasons that justify a retry (subject to daily cap, with bump).
const RETRYABLE_FAILURE_REASONS = new Set([
  "voicenter_busy",
  "el_ws_connect_failed",
  "el_ws_dropped",
  "no_answer",
  "network_error",
  "agent_not_ready",
]);

// Non-retryable: mark contact and stop.
const NON_RETRYABLE_FAILURE_REASONS = new Set([
  "dnc_listed",
  "invalid_number",
  "compliance_block",
]);

// Special case: re-enqueue WITHOUT bumping daily_retry_count.
const TRANSPARENT_RETRY_REASONS = new Set(["agent_version_mismatch"]);

// Backoff schedule (ms) by current retry_count (capped at last entry).
const RETRY_BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];
const MAX_DAILY_RETRIES = 3;

/**
 * Compute today's date in Israel timezone (DST-correct), as ISO yyyy-mm-dd.
 * Uses sv-SE locale because it formats as ISO. Spec §5.2.
 */
function israelTodayIso() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jerusalem" });
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
// Recording capture is now handled by ElevenLabs + audio-archive-processor
// (signed URL → call-recordings bucket). The local PCM writer was removed
// in T12 along with the slin16 audio-out path through Gemini.

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

  // -- Step 1b: Snapshot agent_id_used + sync_version_used (T11.1) --
  // Re-fetch the campaign row right at dequeue to shrink the deploy/sync
  // race window. The values we capture here are pinned into the calls row
  // and the call-bridge cfg so the EL session is always pinned to a single
  // (agent_id, sync_version) tuple for its lifetime.
  let agentIdUsed = null;
  let syncVersionUsed = null;
  try {
    const { data: freshCampaign, error: freshErr } = await db
      .from("campaigns")
      .select("id, elevenlabs_agent_id, sync_version, agent_status, voice_id")
      .eq("id", campaignId)
      .single();
    if (freshErr) throw freshErr;

    // Hard-fail guards (do NOT bump daily_retry_count). Each failure writes
    // failure_reason='agent_not_ready' (DUAL WRITE to legacy text + new enum).
    if (freshCampaign.voice_id == null) {
      log.warn({ campaignId }, "voice_id_not_set — agent_not_ready");
      await writeAgentNotReadyCall(db, {
        tenantId,
        campaignId,
        contactId,
        campaignContactId,
        agentIdUsed: freshCampaign.elevenlabs_agent_id,
        syncVersionUsed: freshCampaign.sync_version,
        note: "voice_id_not_set",
      });
      await campaignContactDal.updateStatus(campaignContactId, "needs_attention");
      return;
    }
    if (freshCampaign.agent_status !== "ready") {
      log.warn({ campaignId, status: freshCampaign.agent_status }, "agent_status_not_ready");
      await writeAgentNotReadyCall(db, {
        tenantId,
        campaignId,
        contactId,
        campaignContactId,
        agentIdUsed: freshCampaign.elevenlabs_agent_id,
        syncVersionUsed: freshCampaign.sync_version,
        note: `agent_status=${freshCampaign.agent_status}`,
      });
      await campaignContactDal.updateStatus(campaignContactId, "needs_attention");
      return;
    }
    if (freshCampaign.elevenlabs_agent_id == null) {
      log.warn({ campaignId }, "elevenlabs_agent_id_null");
      await writeAgentNotReadyCall(db, {
        tenantId,
        campaignId,
        contactId,
        campaignContactId,
        agentIdUsed: null,
        syncVersionUsed: freshCampaign.sync_version,
        note: "elevenlabs_agent_id_null",
      });
      await campaignContactDal.updateStatus(campaignContactId, "needs_attention");
      return;
    }

    agentIdUsed = freshCampaign.elevenlabs_agent_id;
    syncVersionUsed = freshCampaign.sync_version;
    // Stamp into job payload for downstream visibility (e.g. retry logic).
    job.data.agentIdUsed = agentIdUsed;
    job.data.syncVersionUsed = syncVersionUsed;
  } catch (err) {
    log.error({ err }, "campaign snapshot fetch failed");
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
    agent_id_used: agentIdUsed,
    sync_version_used: syncVersionUsed,
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

  // -- Step 9: Start call bridge (ElevenLabs runtime) --
  const bridge = new CallBridge({
    callId,
    tenantId,
    campaignId,
    contactId,
    campaignContactId,
    // Snapshot pinned at dequeue (T11.1) — used by call-bridge CAS check.
    agentIdUsed,
    syncVersionUsed,
    supabase: db,
    contactPhone: contact.phone,
    contactName: contact.name,
    campaign: {
      id: campaignId,
      name: campaign.name,
      script: enhancedScript,
      questions: campaign.questions,
      voice_id: campaign.voice_id,
      first_message: campaign.first_message || null,
      whatsapp_followup_template: campaign.whatsapp_followup_template,
      whatsapp_followup_link: campaign.whatsapp_followup_link,
    },
    tenant: {
      id: tenantId,
      name: tenant.name,
      business_type: tenant.business_type,
    },
    contact: {
      id: contactId,
      name: contact.name,
      phone: contact.phone,
      custom_fields: contact.custom_fields,
    },
    toolContext,
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
      failure_reason: "voicenter_busy",
      failure_reason_t: "voicenter_busy",
      ended_at: new Date().toISOString(),
    });
    bridge.cleanup();
    // Treat as retryable.
    await handleRetryDecision({
      db,
      log,
      job,
      tenantId,
      campaignContactId,
      campaignContact,
      failureReason: "voicenter_busy",
      retryQueueName: CALL_QUEUE_NAME,
    });
    return;
  }

  if (callInitResult && !callInitResult.success) {
    log.error({ error: callInitResult.error }, "Gateway call initiation returned failure");
    await callDal.update(callId, {
      status: "failed",
      failure_reason: "voicenter_busy",
      failure_reason_t: "voicenter_busy",
      ended_at: new Date().toISOString(),
    });
    bridge.cleanup();
    await handleRetryDecision({
      db,
      log,
      job,
      tenantId,
      campaignContactId,
      campaignContact,
      failureReason: "voicenter_busy",
      retryQueueName: CALL_QUEUE_NAME,
    });
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
      failure_reason: "network_error",
      failure_reason_t: "network_error",
      ended_at: new Date().toISOString(),
    });
    await handleRetryDecision({
      db,
      log,
      job,
      tenantId,
      campaignContactId,
      campaignContact,
      failureReason: "network_error",
      retryQueueName: CALL_QUEUE_NAME,
    });
    return;
  }

  // -- Step 10: Post-call processing --
  log.info(
    {
      duration: bridgeResult.duration_seconds,
      endReason: bridgeResult.endReason,
      failureReason: bridgeResult.failureReason,
    },
    "Call bridge completed, starting post-call processing"
  );

  // Re-read the calls row to learn the canonical failure_reason_t that
  // call-bridge wrote during finalize (single source of truth).
  const finalCallRow = await callDal.getById(callId);
  const failureReason = finalCallRow?.failure_reason_t || finalCallRow?.failure_reason || null;

  if (failureReason) {
    // Failed call: route through retry decision (sole writer of
    // daily_retry_count + last_retry_day).
    await handleRetryDecision({
      db,
      log,
      job,
      tenantId,
      campaignContactId,
      campaignContact,
      failureReason,
      retryQueueName: CALL_QUEUE_NAME,
    });
  } else {
    // Successful call.
    await callDal.update(callId, {
      status: "completed",
      duration_seconds: bridgeResult.duration_seconds,
    });
    await campaignContactDal.updateStatus(campaignContactId, "completed", {
      call_id: callId,
      attempt_count: campaignContact.attempt_count + 1,
    });
  }

  // Send WhatsApp for hot/warm leads (if not already sent by tool).
  // Skip on failed calls.
  if (!failureReason) {
    const updatedCall = finalCallRow;
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
      disposition: "completed",
      durationSeconds: bridgeResult.duration_seconds,
      leadStatus: updatedCall?.lead_status ?? null,
    });

    // Recording consent audit
    await complianceGate.logRecordingConsent(callId);
  }

  log.info(
    {
      callId,
      duration: bridgeResult.duration_seconds,
      failureReason,
    },
    "Call job processing complete"
  );
}

// ─── Retry / Daily Cap Helper (T11.2 / T11.3 — sole writer) ────────

/**
 * Decide what to do after a failed call: re-enqueue, mark needs_attention,
 * or mark failed. This is the SOLE writer of campaign_contacts.daily_retry_count
 * and last_retry_day. DST-correct via Asia/Jerusalem date.
 *
 * agent_version_mismatch is a transparent retry — re-enqueues without
 * incrementing daily_retry_count and is exempt from the daily cap. The fresh
 * snapshot at next dequeue resolves the drift.
 */
async function handleRetryDecision({
  db,
  log,
  job,
  tenantId,
  campaignContactId,
  campaignContact,
  failureReason,
  retryQueueName,
}) {
  // Non-retryable: stop, mark needs_attention.
  if (NON_RETRYABLE_FAILURE_REASONS.has(failureReason)) {
    log.info({ failureReason }, "non-retryable failure, marking needs_attention");
    await db
      .from("campaign_contacts")
      .update({ status: "needs_attention", updated_at: new Date().toISOString() })
      .eq("id", campaignContactId);
    return;
  }

  // Transparent retry: re-enqueue WITHOUT bumping daily counter.
  if (TRANSPARENT_RETRY_REASONS.has(failureReason)) {
    log.info({ failureReason }, "transparent retry — re-enqueue, no bump");
    await enqueueRetry({ job, retryQueueName, delayMs: 0 });
    return;
  }

  // Unknown reasons: be conservative and stop.
  if (!RETRYABLE_FAILURE_REASONS.has(failureReason)) {
    log.warn({ failureReason }, "unknown failure_reason, marking needs_attention");
    await db
      .from("campaign_contacts")
      .update({ status: "needs_attention", updated_at: new Date().toISOString() })
      .eq("id", campaignContactId);
    return;
  }

  // Retryable: bump daily_retry_count (DST-correct), enforce cap, schedule.
  const today = israelTodayIso();
  const { data: cc } = await db
    .from("campaign_contacts")
    .select("daily_retry_count, last_retry_day")
    .eq("id", campaignContactId)
    .single();

  let newCount;
  if (!cc || cc.last_retry_day !== today) {
    // New Israel day → reset to 1.
    newCount = 1;
  } else {
    newCount = (cc.daily_retry_count || 0) + 1;
  }

  await db
    .from("campaign_contacts")
    .update({
      daily_retry_count: newCount,
      last_retry_day: today,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignContactId);

  if (newCount > MAX_DAILY_RETRIES) {
    log.warn({ newCount, failureReason, metric: "daily_cap_reached" }, "daily_cap_reached");
    await db
      .from("campaign_contacts")
      .update({ status: "needs_attention", updated_at: new Date().toISOString() })
      .eq("id", campaignContactId);
    return;
  }

  // Schedule retry with backoff per current attempt index (newCount-1).
  const idx = Math.min(newCount - 1, RETRY_BACKOFF_MS.length - 1);
  const delayMs = RETRY_BACKOFF_MS[idx];
  log.info(
    { failureReason, newCount, delayMs },
    "scheduling retry with backoff",
  );
  await enqueueRetry({ job, retryQueueName, delayMs });
}

/**
 * Re-enqueue the same call job onto the call-jobs queue with a delay.
 * Uses a fresh BullMQ Queue handle (cheap — connection pooled by ioredis).
 */
async function enqueueRetry({ job, retryQueueName, delayMs }) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  const q = new Queue(retryQueueName, { connection: { url: redisUrl } });
  try {
    // Strip the snapshot fields so the next dequeue picks fresh ones.
    const { agentIdUsed, syncVersionUsed, ...freshData } = job.data;
    await q.add("call", freshData, { delay: delayMs });
  } finally {
    await q.close().catch(() => {});
  }
}

/**
 * Helper for the dequeue-time hard-fail guards (T11.1).
 * Creates a calls row with failure_reason='agent_not_ready' (DUAL WRITE)
 * and the snapshotted (possibly null) agent_id_used + sync_version_used.
 * Does NOT increment daily_retry_count.
 */
async function writeAgentNotReadyCall(db, {
  tenantId,
  campaignId,
  contactId,
  campaignContactId,
  agentIdUsed,
  syncVersionUsed,
  note,
}) {
  const nowIso = new Date().toISOString();
  await db.from("calls").insert({
    tenant_id: tenantId,
    campaign_id: campaignId,
    contact_id: contactId,
    campaign_contact_id: campaignContactId,
    status: "failed",
    started_at: nowIso,
    ended_at: nowIso,
    failure_reason: "agent_not_ready",
    failure_reason_t: "agent_not_ready",
    agent_id_used: agentIdUsed,
    sync_version_used: syncVersionUsed,
  });
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
