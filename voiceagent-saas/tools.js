// voiceagent-saas/tools.js
//
// Vendor-clean: provider-specific schema conversion lives in *-tools-adapter.js
// (e.g. elevenlabs-tools-adapter.js). This file owns the canonical tool names,
// descriptions, parameter schemas, and implementations. It must not import
// from or reference any LLM vendor SDK.

/**
 * SaaS tool definitions for the voice agent.
 *
 * Lead qualification tools: score_lead, send_whatsapp,
 * request_callback, mark_opt_out, end_call.
 */

// ─── Tool Definitions ───────────────────────────────────────────────

/**
 * Build the canonical tool declarations for the SaaS voice agent.
 * Vendor adapters (elevenlabs-tools-adapter.js) translate these into
 * provider-specific shapes.
 */
export function buildToolDefinitions() {
  return {
    functionDeclarations: [
      {
        name: "score_lead",
        description:
          "Score the lead based on qualification answers. Call this before ending the call.",
        parameters: {
          type: "OBJECT",
          properties: {
            score: {
              type: "NUMBER",
              description: "Lead score from 1 (cold) to 5 (very hot)",
            },
            status: {
              type: "STRING",
              description: "Lead status: hot, warm, cold, not_interested, or callback",
              enum: ["hot", "warm", "cold", "not_interested", "callback"],
            },
            answers: {
              type: "OBJECT",
              description:
                "Key-value pairs of qualification question answers. Keys match the question keys from the campaign config.",
              properties: {},
            },
          },
          required: ["score", "status", "answers"],
        },
      },
      {
        name: "send_whatsapp",
        description:
          "Send a WhatsApp follow-up message to the lead with details or a booking link.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: {
              type: "STRING",
              description:
                "Optional custom message. If omitted, the campaign's default WhatsApp template is used.",
            },
          },
          required: [],
        },
      },
      {
        name: "request_callback",
        description:
          "The lead wants to be called back at a different time. Record their preference.",
        parameters: {
          type: "OBJECT",
          properties: {
            preferred_time: {
              type: "STRING",
              description: "When the lead wants to be called back (free text, e.g. '\u05DE\u05D7\u05E8 \u05D1\u05D1\u05D5\u05E7\u05E8')",
            },
          },
          required: ["preferred_time"],
        },
      },
      {
        name: "mark_opt_out",
        description:
          "The lead explicitly asked not to be contacted again. Permanently removes them from all campaigns for this business.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: [],
        },
      },
      {
        name: "end_call",
        description:
          "End the current call. Must call score_lead before this.",
        parameters: {
          type: "OBJECT",
          properties: {
            disposition: {
              type: "STRING",
              description:
                "Call disposition: completed_qualified, not_interested, callback_scheduled, opt_out, or error",
            },
          },
          required: ["disposition"],
        },
      },
    ],
  };
}

// ─── Tool Execution ─────────────────────────────────────────────────

/**
 * Execute a tool call by name. Vendor-neutral — routes to the appropriate
 * handler and returns the result for the caller to deliver back to the LLM.
 */
export async function executeToolCall(name, args, context) {
  const started = Date.now();
  const log = context.log;

  log.info({ tool: name, args: redactArgs(args) }, "Tool execution started");

  try {
    let result;

    switch (name) {
      case "score_lead":
        result = await handleScoreLead(args, context);
        break;
      case "send_whatsapp":
        result = await handleSendWhatsApp(args, context);
        break;
      case "request_callback":
        result = await handleRequestCallback(args, context);
        break;
      case "mark_opt_out":
        result = await handleMarkOptOut(context);
        break;
      case "end_call":
        result = await handleEndCall(args, context);
        break;
      default:
        result = { error: `Unknown tool: ${name}` };
    }

    const durationMs = Date.now() - started;
    log.info({ tool: name, durationMs, result: summarizeResult(result) }, "Tool execution finished");
    return result;
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, tool: name, durationMs }, "Tool execution threw");
    return { success: false, error: message };
  }
}

// ─── Tool Handlers ──────────────────────────────────────────────────

async function handleScoreLead(args, ctx) {
  const score = Number(args.score);
  const status = String(args.status);
  const answers = args.answers ?? {};

  // Persist to calls table
  await ctx.dal.calls.update(ctx.callId, {
    lead_score: score,
    lead_status: status,
    qualification_answers: answers,
  });

  return { success: true, score, status };
}

async function handleSendWhatsApp(args, ctx) {
  // Build message from template or custom
  let message;
  if (args.message && typeof args.message === "string" && args.message.trim()) {
    message = args.message;
  } else if (ctx.whatsappFollowupTemplate) {
    message = ctx.whatsappFollowupTemplate.replace(
      /\[link\]/g,
      ctx.whatsappFollowupLink || ""
    );
  } else {
    return { success: false, error: "No WhatsApp message template configured" };
  }

  const result = await ctx.sendWhatsApp(ctx.contactPhone, message);

  if (result.success) {
    // Mark WhatsApp sent on the call record
    await ctx.dal.calls.update(ctx.callId, { whatsapp_sent: true });
  }

  return {
    success: result.success,
    messageId: result.messageId ?? null,
    message_sent: result.success,
  };
}

async function handleRequestCallback(args, ctx) {
  const preferredTime = String(args.preferred_time ?? "");

  // Update call record with callback status
  await ctx.dal.calls.update(ctx.callId, {
    lead_status: "callback",
    qualification_answers: { callback_preferred_time: preferredTime },
  });

  // Log audit event
  await ctx.dal.auditLog.log("callback_requested", "call", ctx.callId, {
    contactId: ctx.contactId,
    preferredTime,
  });

  return {
    success: true,
    callback_requested: true,
    preferred_time: preferredTime,
  };
}

async function handleMarkOptOut(ctx) {
  // Mark contact as DNC permanently
  await ctx.dal.contacts.markDnc(ctx.contactId, "opt_out");

  // Audit log -- required for tikun 40 compliance
  await ctx.dal.auditLog.log("opt_out", "contact", ctx.contactId, {
    tenantId: ctx.tenantId,
    campaignId: ctx.campaignId,
    callId: ctx.callId,
    source: "voice_agent_opt_out",
  });

  return { success: true, dnc_set: true };
}

async function handleEndCall(args, ctx) {
  const disposition = String(args.disposition ?? "completed");

  return {
    success: true,
    disposition,
    call_ended: true,
  };
}

// ─── Utilities ──────────────────────────────────────────────────────

function redactArgs(args) {
  const out = { ...args };
  // Redact phone numbers if present
  if (typeof out.to === "string") {
    const digits = out.to.replace(/\D/g, "");
    out.to = digits.length >= 4 ? `***${digits.slice(-4)}` : "[redacted]";
  }
  return out;
}

function summarizeResult(result) {
  return {
    success: result.success,
    hasError: Boolean(result.error),
  };
}
