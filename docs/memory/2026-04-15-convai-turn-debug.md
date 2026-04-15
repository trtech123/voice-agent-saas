# Session log — 2026-04-15 — Convai turn-taking and repeat prompts

## Goal

Stabilize outbound call behavior so the agent does not repeat itself and gives the user enough time to answer.

## What we investigated

- User-reported issues:
  - Agent repeated the same lines.
  - Agent did not wait for user reply.
  - In one case, user got another call almost immediately after intro / no-answer.
- Confirmed active path was `convai` (not unbundled) for campaign `22222222-2222-2222-2222-222222222222`.
- Reviewed `call-bridge` and `elevenlabs-session` flow:
  - `handleCustomerAnswered()` transitions to `live`, then `startConversation()` is called.
  - Caller audio forwarding (`session.sendAudio`) is active when state is `live`.
  - Convai turn-taking is managed by ElevenLabs agent config (not by local VAD constants used in the unbundled path).

## Runtime evidence collected

- Pulled `journalctl -u voiceagent-saas` from droplet `188.166.166.234`.
- Observed multiple relevant calls:
  - `callId=73cd8606-e140-4703-850f-940761dee559` (job 68):
    - Bridge transitioned to `live` correctly.
    - Greeting latency ~607ms.
    - Turn latencies measured (e.g. 206ms, 3493ms).
    - Ended `asterisk_disconnect`.
  - `callId=853ecedc-6296-4e4e-a821-3db7a5339143` (job 70):
    - Stayed `pre_warmed` and later hit EL heartbeat watchdog (`el_ws_dropped`) after 30s.
    - Retry scheduled by worker backoff.
- Conclusion from logs: core bridge lifecycle was functioning; primary conversation pacing issue was agent turn configuration.

## Code / tools added during session

Created helper scripts in `voiceagent-saas/scripts`:

- `probe-convai-agent-turn.js` — reads live ElevenLabs Convai agent config via GET; prints turn settings (`turn_timeout`, `turn_eagerness`, `speculative_turn`, etc.).
- `el-agent-patch-turn.json` — PATCH body used to update turn settings.
- `remote-patch-el-agent-turn.sh` — droplet-side script to read `ELEVENLABS_API_KEY` from `/opt/voiceagent-saas/.env` and run PATCH.

Temporary files created and removed during execution:

- `el-agent-patch-speculative-off.json` (deleted)
- `remote-patch-el-speculative-off.sh` (deleted)

## ElevenLabs API checks and updates performed

Target agent:

- `agent_8101knmxjmkwf16bgypzepnzx4qj`

Initial live values observed (via API):

- `turn_timeout: 1.8`
- `turn_eagerness: patient`
- `speculative_turn: true`

PATCH applied by API (HTTP 200):

- Requested:
  - `turn_timeout: 12`
  - `turn_eagerness: patient`
  - `speculative_turn: false`
- Result:
  - `turn_timeout` successfully changed to `12`.
  - `turn_eagerness` remained `patient`.
  - `speculative_turn` still returned `true` after patch (likely model / platform constraint for this agent configuration).

## Important operational note

- Sourcing `/opt/voiceagent-saas/.env` directly can fail in bash due to an unquoted `SUPABASE_DIRECT_DB_URL` line.
- Workaround used: extract only `ELEVENLABS_API_KEY` from `.env` with `grep` / `sed` in remote scripts.

## Current expected behavior before next test

- Agent should wait up to ~12 seconds of silence before re-engaging.
- Agent may still feel somewhat eager due to `speculative_turn` staying `true`.
- If interruption persists, next step is to disable speculative turn from the ElevenLabs dashboard (if exposed there for this turn model), then re-test.

## Files touched in this session

- Existing project files (already modified before / through session context):
  - `voiceagent-saas/call-processor.js`
  - `voiceagent-saas/unbundled-pipeline.js`
  - `voiceagent-saas/tts-session.js`
  - `voiceagent-saas/tests/tts-session.test.js`
  - `voiceagent-saas/elevenlabs-session.js`
- New utility files:
  - `voiceagent-saas/scripts/probe-convai-agent-turn.js`
  - `voiceagent-saas/scripts/el-agent-patch-turn.json`
  - `voiceagent-saas/scripts/remote-patch-el-agent-turn.sh`

## Next step (planned)

- Run a fresh “Call Now” and validate:
  - user has enough reply window,
  - fewer repeated prompts,
  - no immediate second-call behavior unless worker retry conditions are hit.

## Follow-up implementation — duplicate/overlapping call lock (same day)

Implemented a targeted active-call lock in `voiceagent-saas/call-processor.js` to prevent simultaneous calls for the same `(tenantId, campaignId, contactId)` tuple.

### Behavior implemented

- Lock key:
  - `call-lock:${NODE_ENV || "unknown"}:${tenantId}:${campaignId}:${contactId}`
- Lock token:
  - BullMQ `job.id` (string), so stalled-job recovery can be distinguished from true duplicates.
- Acquire semantics:
  - `SET key token EX 900 NX` (15m crash-safety TTL).
- Duplicate handling:
  - If lock is owned by another job, worker logs `call_lock_duplicate_skip` and exits early as no-op (no retry counter bump).
- Stalled-job recovery:
  - If lock owner token equals current `job.id`, worker treats it as recovered stalled execution, extends TTL, and proceeds.
- Redis outage path:
  - Fail-closed. If lock check/acquire throws, job throws (no dial), allowing BullMQ retry/backoff.
- Safe release:
  - Token-checked Lua compare-and-delete in `finally` so only lock owner can release.
  - Release is best-effort and logged if ownership changed or Redis fails.
- Connection reuse:
  - Lock operations use BullMQ worker Redis client (`await worker.client`), avoiding extra connection pools.

### Files changed for this follow-up

- `voiceagent-saas/call-processor.js`
- `voiceagent-saas/tests/call-processor-lock.test.js` (new)

### Verification run

- Command:
  - `npm run test -- tests/call-processor-lock.test.js tests/call-processor-pipeline-resolution.test.js`
- Result:
  - 2 test files passed, 9 tests passed.
- Lint:
  - No linter errors in touched files.
