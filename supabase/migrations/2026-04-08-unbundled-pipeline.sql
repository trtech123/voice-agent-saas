-- 2026-04-08 unbundled voice pipeline
-- Idempotent. Adds per-campaign pipeline flag, prompt+greeting columns,
-- and new latency/cost telemetry columns to call_metrics.
-- Spec: docs/superpowers/specs/2026-04-08-unbundled-voice-pipeline-design.md §6.1

BEGIN;

-- Per-campaign pipeline flag (primary). NULL means "use tenant default".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'voice_pipeline'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN voice_pipeline TEXT
      CHECK (voice_pipeline IS NULL OR voice_pipeline IN ('convai','unbundled'));
  END IF;
END $$;

-- Per-tenant default fallback for voice_pipeline
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'default_voice_pipeline'
  ) THEN
    ALTER TABLE tenants
      ADD COLUMN default_voice_pipeline TEXT NOT NULL DEFAULT 'convai'
      CHECK (default_voice_pipeline IN ('convai','unbundled'));
  END IF;
END $$;

-- Campaign-owned prompt + greeting (moved out of EL agent config)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS first_message TEXT;

-- Latency / cost / observability columns on call_metrics
ALTER TABLE call_metrics
  ADD COLUMN IF NOT EXISTS pipeline TEXT,
  ADD COLUMN IF NOT EXISTS stt_model_used TEXT,
  -- Latency: paired mean / p95 per segment
  ADD COLUMN IF NOT EXISTS mean_stt_first_partial_ms INTEGER,
  ADD COLUMN IF NOT EXISTS p95_stt_first_partial_ms INTEGER,
  ADD COLUMN IF NOT EXISTS mean_llm_first_token_ms INTEGER,
  ADD COLUMN IF NOT EXISTS p95_llm_first_token_ms INTEGER,
  ADD COLUMN IF NOT EXISTS mean_llm_first_sentence_ms INTEGER,
  ADD COLUMN IF NOT EXISTS p95_llm_first_sentence_ms INTEGER,
  ADD COLUMN IF NOT EXISTS mean_tts_first_byte_ms INTEGER,
  ADD COLUMN IF NOT EXISTS p95_tts_first_byte_ms INTEGER,
  ADD COLUMN IF NOT EXISTS mean_total_turn_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS p95_total_turn_latency_ms INTEGER,
  -- Behavioral counters
  ADD COLUMN IF NOT EXISTS barge_count INTEGER,
  ADD COLUMN IF NOT EXISTS barge_response_ms INTEGER,
  ADD COLUMN IF NOT EXISTS dg_reconnect_count INTEGER,
  ADD COLUMN IF NOT EXISTS tool_call_count INTEGER,
  ADD COLUMN IF NOT EXISTS tool_call_max_ms INTEGER,
  -- Cost telemetry (variable-cost dependencies)
  ADD COLUMN IF NOT EXISTS llm_tokens_in INTEGER,
  ADD COLUMN IF NOT EXISTS llm_tokens_out INTEGER,
  ADD COLUMN IF NOT EXISTS llm_cost_usd_micros INTEGER,
  ADD COLUMN IF NOT EXISTS stt_audio_seconds NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS tts_chars_synthesized INTEGER;

COMMIT;
