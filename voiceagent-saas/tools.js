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

// ─── Tool Catalog ───────────────────────────────────────────────────

/**
 * Single source of truth for SaaS voice-agent tool schemas.
 *
 * Each entry carries the canonical name + description plus two parameter
 * shapes:
 *   - `legacy`  : Gemini-style (OBJECT/STRING/NUMBER casing) consumed by
 *                 `buildToolDefinitions()` and the EL convai adapter.
 *   - `openai`  : OpenAI function-calling style (lowercase JSON-schema
 *                 types) consumed by `buildOpenAIToolSchema()` for the new
 *                 unbundled LLM session.
 *
 * NOTE: Three tools intentionally diverge between the two shapes —
 * each divergence reflects a real runtime contract difference, not drift:
 *
 *   - `score_lead`: production convai requires {score, status, answers}.
 *     The unbundled pipeline LLM session will use a thin
 *     mapOpenAIToolArgs() shim (Plan 3) to translate {score, reason} →
 *     {score, status, answers} before calling handleScoreLead().
 *
 *   - `send_whatsapp.message`: optional in convai (server-side template
 *     fallback) but required in OpenAI shape because the unbundled
 *     pipeline does not yet wire the template fallback.
 *
 *   - `end_call.disposition`: required in convai but optional in OpenAI
 *     shape because handleEndCall() defaults to "completed" when missing,
 *     and a more flexible LLM-side schema reduces tool-call friction.
 *
 * Tool names and descriptions stay in single-source — drift on those is
 * impossible because both formatters consume the one TOOL_CATALOG below.
 */
export const TOOL_CATALOG = [
  {
    name: "score_lead",
    description:
      "Score the lead based on qualification answers. Call this before ending the call.",
    legacy: {
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
    openai: {
      properties: {
        score: {
          type: "integer",
          description: "Lead score from 1 (cold) to 5 (very hot)",
        },
        reason: {
          type: "string",
          description: "Short justification for the assigned score",
        },
      },
      required: ["score", "reason"],
    },
  },
  {
    name: "send_whatsapp",
    description:
      "Send a WhatsApp follow-up message to the lead with details or a booking link.",
    legacy: {
      properties: {
        message: {
          type: "STRING",
          description:
            "Optional custom message. If omitted, the campaign's default WhatsApp template is used.",
        },
      },
      required: [],
    },
    openai: {
      properties: {
        message: {
          type: "string",
          description:
            "Custom WhatsApp follow-up message body to send to the lead.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "request_callback",
    description:
      "The lead wants to be called back at a different time. Record their preference.",
    legacy: {
      properties: {
        preferred_time: {
          type: "STRING",
          description:
            "When the lead wants to be called back (free text, e.g. '\u05DE\u05D7\u05E8 \u05D1\u05D1\u05D5\u05E7\u05E8')",
        },
        callback_timestamp: {
          type: "STRING",
          description:
            "The exact UTC time for the callback in ISO 8601 format (e.g., 2026-04-16T15:30:00Z). Calculate this from the current time context in the system instructions.",
        },
      },
      required: ["preferred_time", "callback_timestamp"],
    },
    openai: {
      properties: {
        preferred_time: {
          type: "string",
          description:
            "When the lead wants to be called back (free text, e.g. '\u05DE\u05D7\u05E8 \u05D1\u05D1\u05D5\u05E7\u05E8')",
        },
        callback_timestamp: {
          type: "string",
          description:
            "The exact UTC time for the callback in ISO 8601 format (e.g., 2026-04-16T15:30:00Z). Calculate this based on the current time provided in your system instructions.",
        },
      },
      required: ["preferred_time", "callback_timestamp"],
    },
  },
  {
    name: "mark_opt_out",
    description:
      "The lead explicitly asked not to be contacted again. Permanently removes them from all campaigns for this business.",
    legacy: {
      properties: {},
      required: [],
    },
    openai: {
      properties: {},
      required: [],
    },
  },
  {
    name: "end_call",
    description: "End the current call. Must call score_lead before this.",
    legacy: {
      properties: {
        disposition: {
          type: "STRING",
          description:
            "Call disposition: completed_qualified, not_interested, callback_scheduled, opt_out, or error",
        },
      },
      required: ["disposition"],
    },
    openai: {
      properties: {
        disposition: {
          type: "string",
          description:
            "Call disposition: completed_qualified, not_interested, callback_scheduled, opt_out, or error",
        },
      },
      required: [],
    },
  },
];

// ─── Tool Definitions ───────────────────────────────────────────────

/**
 * Build the canonical (Gemini-style) tool declarations for the SaaS voice
 * agent. Vendor adapters (elevenlabs-tools-adapter.js) translate these into
 * provider-specific shapes.
 *
 * Returns an array of function declarations. For backwards compatibility
 * with callers that read `.functionDeclarations` (EL adapter), the array
 * also carries a `functionDeclarations` property pointing to itself.
 */
export function buildToolDefinitions() {
  const decls = TOOL_CATALOG.map((entry) => ({
    name: entry.name,
    description: entry.description,
    parameters: {
      type: "OBJECT",
      properties: entry.legacy.properties,
      required: entry.legacy.required,
    },
  }));
  Object.defineProperty(decls, "functionDeclarations", {
    value: decls,
    enumerable: false,
  });
  return decls;
}

/**
 * Build the OpenAI function-calling tool schema for the SaaS voice agent,
 * suitable for passing directly to chat.completions `tools` parameter.
 */
export function buildOpenAIToolSchema() {
  return TOOL_CATALOG.map((entry) => ({
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
      parameters: {
        type: "object",
        properties: entry.openai.properties,
        required: entry.openai.required,
      },
    },
  }));
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

  const existingCall = typeof ctx.dal.calls.getById === "function"
    ? await ctx.dal.calls.getById(ctx.callId)
    : null;
  const existingAnswers =
    existingCall?.qualification_answers && typeof existingCall.qualification_answers === "object"
      ? existingCall.qualification_answers
      : {};

  // Persist to calls table
  await ctx.dal.calls.update(ctx.callId, {
    lead_score: score,
    lead_status: status,
    qualification_answers: { ...existingAnswers, ...answers },
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
  const callbackTimestamp = String(args.callback_timestamp ?? "");
  const existingCall = typeof ctx.dal.calls.getById === "function"
    ? await ctx.dal.calls.getById(ctx.callId)
    : null;
  const existingAnswers =
    existingCall?.qualification_answers &&
      typeof existingCall.qualification_answers === "object"
      ? existingCall.qualification_answers
      : {};

  // Update call record with callback status
  await ctx.dal.calls.update(ctx.callId, {
    lead_status: "callback",
    qualification_answers: {
      ...existingAnswers,
      callback_preferred_time: preferredTime,
      callback_timestamp: callbackTimestamp,
    },
  });

  // Log audit event
  await ctx.dal.auditLog.log("callback_requested", "call", ctx.callId, {
    contactId: ctx.contactId,
    preferredTime,
    callbackTimestamp,
  });

  return {
    success: true,
    callback_requested: true,
    preferred_time: preferredTime,
    callback_timestamp: callbackTimestamp,
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
