// apps/voice-engine/src/config.ts
import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  credentialKek: process.env.CREDENTIAL_KEK!,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  geminiApiKey: process.env.GEMINI_API_KEY!,
  geminiModel: process.env.GEMINI_LIVE_MODEL ?? "models/gemini-2.5-flash-live-preview",
  voicenterApiUrl: process.env.VOICENTER_API_URL ?? "",
  voicenterApiKey: process.env.VOICENTER_API_KEY ?? "",

  // SIP Gateway (Asterisk) — replaces direct Voicenter REST API
  sipGatewayBaseUrl: process.env.SIP_GATEWAY_BASE_URL ?? "http://188.166.166.234:8091",
  sipGatewayApiKey: process.env.SIP_GATEWAY_API_KEY ?? "",
  sipGatewayEventsSecret: process.env.SIP_GATEWAY_EVENTS_SECRET ?? "",
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  callHardTimeoutMs: Number(process.env.CALL_HARD_TIMEOUT_MS ?? 300_000), // 5 minutes

  // Compliance
  recordingConsentEnabled: process.env.RECORDING_CONSENT_ENABLED !== "false",
  dncFailClosed: process.env.DNC_FAIL_CLOSED !== "false", // Block call if DNC check errors

  // Schedule enforcement
  defaultTimezone: "Asia/Jerusalem",
} as const;

// Validate required env vars at startup
const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CREDENTIAL_KEK",
  "GEMINI_API_KEY",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
