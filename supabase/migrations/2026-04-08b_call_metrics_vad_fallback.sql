-- 2026-04-08b_call_metrics_vad_fallback.sql
-- Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md
-- Plan: docs/superpowers/plans/2026-04-08-turn-latency-vad-plan.md (Task 1)
--
-- Adds a single aggregate column tracking how many turns in a call fell
-- back to EL's partial-transcript anchor because the local RMS VAD
-- was unreliable. Primary signal for "is the hybrid working?" — if this
-- is >50% of turns across many calls, the RMS threshold needs tuning.
--
-- Canonical fallback-rate query:
--   select call_id,
--          vad_fallback_count::float
--            / nullif(array_length(turn_latencies_ms, 1), 0) as fallback_rate
--   from call_metrics
--   where vad_fallback_count is not null;
--
-- The denominator is array_length(turn_latencies_ms, 1) — that's the
-- exact set of turns where an anchor resolved (not transcript_turn_count,
-- which includes skipped null-anchor turns). DO NOT persist a separate
-- denominator column; turn_latencies_ms is the canonical source.
--
-- NULL semantics:
--   - Pre-migration rows: NULL (correctly represents "not instrumented")
--   - Janitor-finalized rows (bridge crashed): NULL
--   - Bridge-finalized rows: 0 or positive
-- Dashboards must filter `vad_fallback_count IS NOT NULL` for averages.
--
-- Non-destructive, idempotent, inherits tenant_id RLS.

begin;

alter table public.call_metrics
  add column if not exists vad_fallback_count int;

alter table public.call_metrics
  add constraint call_metrics_vad_fallback_nonneg
    check (vad_fallback_count is null or vad_fallback_count >= 0);

commit;
