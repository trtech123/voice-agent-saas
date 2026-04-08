-- 2026-04-08_call_metrics_latency_columns.sql
-- Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md
-- Plan: docs/superpowers/plans/2026-04-08-call-latency-instrumentation-plan.md (Task 1)
--
-- Adds per-call latency metrics to call_metrics. Non-destructive, idempotent.
-- Columns nullable so existing rows remain valid. New columns inherit the
-- existing tenant_id RLS policy on call_metrics automatically.
--
-- Note: tts_first_byte_ms remains in place but its semantics ("from WS open")
-- are now misleading post-lifecycle-fix. greeting_latency_ms is the correct
-- user-perspective metric going forward. Not renamed to avoid touching
-- existing query paths.

begin;

alter table public.call_metrics
  add column if not exists greeting_latency_ms int,
  add column if not exists avg_turn_latency_ms int,
  add column if not exists p95_turn_latency_ms int,
  add column if not exists audio_plumbing_ms  int,
  add column if not exists turn_latencies_ms  int[];

-- Non-negative guards. Plain inline CHECK — all existing rows have NULL in
-- the new columns so validation is instant.
alter table public.call_metrics
  add constraint call_metrics_greeting_latency_nonneg
    check (greeting_latency_ms is null or greeting_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_avg_turn_latency_nonneg
    check (avg_turn_latency_ms is null or avg_turn_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_p95_turn_latency_nonneg
    check (p95_turn_latency_ms is null or p95_turn_latency_ms >= 0);
alter table public.call_metrics
  add constraint call_metrics_audio_plumbing_nonneg
    check (audio_plumbing_ms is null or audio_plumbing_ms >= 0);

commit;
