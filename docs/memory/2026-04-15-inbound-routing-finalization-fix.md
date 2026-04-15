# 2026-04-15 Inbound Routing Finalization Fix

## Context

After reviewing the inbound callback routing and callback scheduling work, five issues were identified:

1. Inbound DID default campaigns could cross tenant boundaries.
2. Inbound calls could remain `connected` after hangup because they bypassed worker post-call finalization.
3. Schedule-window reschedules could leave DB rows queued without a delayed BullMQ job if enqueue failed.
4. `supabase/.temp/*` CLI state was showing up in git status.
5. `remote-patch-el-agent-turn.sh` hardcoded one production ElevenLabs agent and `/tmp` payload path.

## What was implemented

- Added `voiceagent-saas/inbound-routing.js`
  - Centralizes inbound DID/contact/campaign routing helpers.
  - Requires resolved campaigns to belong to the selected tenant.
  - Requires `status='active'` for recent-call routing, DID defaults, system defaults, and newest-campaign fallback.
  - Logs and ignores inactive/cross-tenant campaign candidates.

- Updated `voiceagent-saas/server.js`
  - Uses inbound routing helpers.
  - Fetches final inbound campaign with `id`, `tenant_id`, and `status='active'`.
  - Wires inbound `CallBridge` completion through `startInboundBridgeFinalizer(...)`.
  - Keeps inbound calls independent of `campaign_contacts`.

- Added `voiceagent-saas/inbound-finalizer.js`
  - Awaits `bridge.start()` in a detached finalizer.
  - On success, writes `calls.status='completed'` and `duration_seconds`.
  - On bridge-reported failure, writes `calls.status='failed'` plus `failure_reason` and `failure_reason_t`.
  - On thrown errors, logs safely, best-effort writes `network_error`, and best-effort cleans Asterisk resources.
  - Catches DB update failures to avoid unhandled promise rejections.

- Added `supabase/migrations/005_inbound_route_tenant_safety.sql`
  - Repairs invalid existing `phone_numbers.default_campaign_id` values by nulling cross-tenant defaults.
  - Adds a `FOR EACH ROW` trigger on `phone_numbers` to enforce same-tenant `default_campaign_id`.
  - Adds a complementary trigger on `campaigns` to prevent changing `tenant_id` while referenced by inbound phone routing.
  - Keeps `default_campaign_id = null` valid.

- Updated `voiceagent-saas/call-processor.js`
  - Exports `handleScheduleBlockedReschedule(...)` for focused tests.
  - Adds enqueue rollback for schedule-window reschedules:
    - DB is first updated to `queued`.
    - If delayed enqueue fails, status is reverted to `needs_attention` and `next_retry_at` is cleared.
    - If rollback fails too, logs a manual reconciliation error.

- Updated repository hygiene
  - Added `supabase/.temp/` to `.gitignore`.
  - Parameterized `voiceagent-saas/scripts/remote-patch-el-agent-turn.sh`:
    - Usage: `remote-patch-el-agent-turn.sh <elevenlabs_agent_id> [patch_json_path]`
    - Default payload remains `/tmp/el-agent-patch-turn.json`.

- Added follow-up memory note:
  - `docs/memory/2026-04-15-follow-up-orphan-call-sweeper.md`
  - Tracks future stale-call reconciliation for process-crash cases.

## Tests added

- `voiceagent-saas/tests/inbound-routing.test.js`
  - Cross-tenant and inactive recent-call campaign candidates are ignored.
  - Cross-tenant DID default is ignored and safe fallback is used.

- `voiceagent-saas/tests/inbound-finalizer.test.js`
  - Success writes `completed` and duration.
  - Bridge-reported failure writes `failed` and failure reason.
  - Thrown bridge errors are caught, marked as `network_error`, and cleanup is attempted.
  - DB update failures are logged for manual reconciliation.

- `voiceagent-saas/tests/call-processor-schedule-reschedule.test.js`
  - Schedule enqueue failure reverts campaign contact to `needs_attention`.
  - Rollback failure is logged for manual reconciliation.

- `voiceagent-saas/tests/inbound-migration-safety.test.js`
  - Migration contains existing-data repair.
  - Migration contains row-level same-tenant phone-number enforcement.
  - Migration contains campaign tenant immutability guard for inbound routes.

## Verification run

Syntax checks passed:

- `node --check voiceagent-saas/server.js`
- `node --check voiceagent-saas/call-processor.js`
- `node --check voiceagent-saas/inbound-routing.js`
- `node --check voiceagent-saas/inbound-finalizer.js`

Targeted test run passed after allowing Vitest/esbuild to spawn outside the sandbox:

- Command:
  - `npm run test -- tests/inbound-routing.test.js tests/inbound-finalizer.test.js tests/call-processor-schedule-reschedule.test.js tests/inbound-migration-safety.test.js tests/tools-openai-schema.test.js tests/tools-request-callback.test.js tests/agent-prompt-system-context.test.js tests/call-processor-lock.test.js tests/tts-session.test.js`
- Result:
  - 9 test files passed.
  - 52 tests passed.

## Operational caveats / next steps

- `supabase/migrations/005_inbound_route_tenant_safety.sql` has been created locally but not applied to the remote Supabase project in this turn.
- `supabase/migrations/004_inbound_calls.sql` was previously applied via direct SQL query, not standard migration tracking.
- `supabase/.temp/cli-latest` remains a modified tracked file (`v2.84.2` -> `v2.90.0`). `.gitignore` now prevents new temp files from appearing, but does not untrack already-tracked files.
- Git still warns that `C:\Users\admin/.config/git/ignore` is permission denied.

## Superpowers install done during same session

User requested installation of `https://github.com/obra/superpowers.git` for Codex.

- Cloned to:
  - `C:\Users\admin\.codex\superpowers`
- Created Windows junction:
  - `C:\Users\admin\.agents\skills\superpowers` -> `C:\Users\admin\.codex\superpowers\skills`
- Available after Codex restart.
