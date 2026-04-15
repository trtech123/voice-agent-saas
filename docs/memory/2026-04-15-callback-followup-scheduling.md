# 2026-04-15 Callback Follow-up Scheduling

## Context

Production readiness required callback follow-ups when a lead asks for a later call (for example: "in 5 minutes" or "tomorrow").

## What was implemented

- Updated `request_callback` tool contract in `voiceagent-saas/tools.js`:
  - Added required `callback_timestamp` (ISO 8601 UTC).
  - Kept `preferred_time` as raw user intent.
  - Persisted both into `calls.qualification_answers`.
  - Preserved existing qualification answers (merge instead of overwrite).

- Updated prompt guidance in `voiceagent-saas/agent-prompt.js`:
  - Injects current Israel date/time, weekday, and UTC timestamp.
  - Injects campaign legal calling windows (`schedule_days` and `schedule_windows`).
  - Instructs model to output legal `callback_timestamp` values and propose legal alternatives if requested time is outside policy.

- Updated worker behavior in `voiceagent-saas/call-processor.js`:
  - If lead status is `callback`, schedule delayed BullMQ re-enqueue based on `qualification_answers.callback_timestamp`.
  - On invalid timestamp parse, fallback delay is 1 hour with warning log.
  - Set `campaign_contacts` to `queued` with `next_retry_at`.

- Fixed schedule precheck drop:
  - When precheck fails due to schedule window block, job is rescheduled to next legal window (instead of silent drop).
  - Uses `getNextScheduleWindow(...)`.
  - Uses daily retry counters to avoid infinite reschedule loops.
  - Escalates to `needs_attention` when cap is exceeded.

- Added Redis/DB split-brain protection:
  - If DB is updated to `queued` but delayed enqueue fails, status is reverted to `needs_attention` to avoid limbo records.

## Test coverage added

- `voiceagent-saas/tests/tools-openai-schema.test.js`
  - Verifies `request_callback` requires both `preferred_time` and `callback_timestamp`.

- `voiceagent-saas/tests/tools-request-callback.test.js`
  - Verifies persistence of callback fields and merge semantics.
  - Verifies audit payload includes both values.
  - Verifies fallback path when `calls.getById` is unavailable.

- `voiceagent-saas/tests/agent-prompt-system-context.test.js`
  - Verifies prompt includes time/day/UTC context.
  - Verifies prompt includes schedule guidance and callback timestamp instruction.
  - Verifies fallback schedule text when campaign schedule data is missing.

## Verification run

- `npm test -- tools-openai-schema.test.js tools-request-callback.test.js agent-prompt-system-context.test.js`
  - Passed (11 tests).

- `npm test -- call-processor-pipeline-resolution.test.js`
  - Passed.

## Live validation checklist

1. Run a real test call and say "חזור אליי בעוד 5 דקות".
2. Confirm `calls.qualification_answers.callback_timestamp` is present.
3. Confirm `campaign_contacts.status='queued'` and `next_retry_at` is set.
4. Confirm delayed job executes and second call attempt occurs.
5. Repeat with "מחר בבוקר" to validate next-day scheduling and legal window handling.

## Notes

- Unit coverage is strong for tool + prompt layers.
- Queue scheduling behavior is implemented in runtime code and validated with targeted tests, but still requires full telephony E2E confirmation in staging/production-like conditions.

## Live Debug Update (later same day)

### Calls inspected

- `45ea971c-a935-43b0-a725-583d76745d6b`
- `61c6dd4e-6710-4bd9-b117-49d0f365d569`

Both were fetched directly from droplet production env via:

- `node scripts/fetch-latest-call.js` (uploaded to `/opt/voiceagent-saas/scripts/`)

### What happened

- In both calls, bridge finalized with:
  - `endReason = asterisk_disconnect`
  - `failureReason = null`
- ARI events show customer channel teardown:
  - `ChannelHangupRequest` (cause `16`)
  - `StasisEnd`
  - `ChannelDestroyed` (cause text `Normal Clearing`)
- This indicates the SIP/customer leg ended first, not `end_call` tool logic and not EL websocket failure.

### Callback path status from those calls

- `call_tool_invocations` was empty in both calls (`tool_call_count = 0`).
- No `request_callback` tool call was executed.
- Therefore callback scheduling logic did not run in those sessions.

### Transcript/turn observations

- Several user turns remained `is_final = false` (partial-only capture before call end).
- One user turn included `<|nolang|>` marker text.
- Agent outputs included truncated phrases (for example: `אני לא יכול להת...`) due to call leg ending mid-response.
- One call had an agent turn with `text = null` (non-fatal transcript artifact).

### Data consistency observation

- Calls had valid `ended_at` and `call_metrics.call_duration_seconds`, but `calls.status` still appeared as `initiated` in fetched rows.
- This is likely a separate status update inconsistency to investigate in post-call write path.

### Next session starting points

1. Reproduce one more call while tailing logs:
   - `journalctl -u voiceagent-saas -f --no-pager | grep -iE \"ChannelHangupRequest|ChannelDestroyed|StasisEnd|asterisk_disconnect|tool_end_call|callId\"`
2. Confirm whether cause `16` keeps recurring around similar elapsed durations.
3. If recurring, investigate telephony side (Voicenter/carrier/dialplan) as primary suspect.
4. Separately trace and fix `calls.status` write consistency after bridge completion.
