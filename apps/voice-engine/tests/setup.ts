// Test setup — set required env vars before any module imports
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CREDENTIAL_KEK = "dGVzdGtleTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNA==";
process.env.GEMINI_API_KEY = "test-gemini-api-key";
process.env.VOICENTER_API_URL = "http://localhost:9000";
process.env.VOICENTER_API_KEY = "test-voicenter-key";
process.env.WHATSAPP_ACCESS_TOKEN = "test-whatsapp-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
process.env.REDIS_URL = "redis://localhost:6379";
