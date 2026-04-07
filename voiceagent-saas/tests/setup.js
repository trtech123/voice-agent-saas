// Vitest global setup for voiceagent-saas
// Sets environment variables that module-level code expects so that
// imports in test files do not throw during construction.

process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-key-xi";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SUPABASE_DIRECT_DB_URL =
  process.env.SUPABASE_DIRECT_DB_URL ||
  "postgresql://postgres:test@localhost:5432/postgres";
