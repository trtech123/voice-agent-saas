# Implementation Plan — Spec A: ElevenLabs Runtime Swap

**Date:** 2026-04-07
**Spec:** `docs/superpowers/specs/2026-04-07-elevenlabs-runtime-swap-design.md`

## Phase 0 — Encryption gate

**Status: PASSED with caveat.** `packages/database/src/encryption.ts` exists and implements AES-256-GCM envelope encryption (random per-record DEK wrapped by KEK from env). Acceptable for Spec A's `tenants.llm_api_key_encrypted` column. **Future hardening recommendation:** migrate to pgsodium / Supabase Vault in a follow-up spec — not a prerequisite for this plan.

## Task ordering

### T1 — SQL migration (single file, single transaction)
**File:** `supabase/migrations/2026-04-07_elevenlabs_runtime_swap.sql` (new)
**Depends on:** none
**Acceptance criteria:**
- Creates enums `agent_status_t`, `llm_provider_t`, `audio_archive_status_t`, `call_failure_reason_t` (idempotent).
- Adds all `campaigns`, `tenants`, `calls`, `campaign_contacts` columns per §3. Uses `ADD COLUMN IF NOT EXISTS` for `calls.started_at`/`ended_at` (confirmed already present in `supabase/migrations/001_initial_schema.sql` lines 190-191 — so the IF NOT EXISTS is load-bearing).
- `tts_model` ordering MUST be: (1) ADD COLUMN nullable → (2) backfill from `platform_settings.default_tts_model` → (3) `SET NOT NULL`, all inside one `BEGIN…COMMIT`. `voice_id` stays nullable forever (no default per product decision #1).
- Creates `call_turns`, `call_tool_invocations`, `webhook_events`, `platform_settings`, `call_metrics` per §3 with all indexes, unique constraints, RLS enabled.
- Adds `tenants.feature_flags jsonb not null default '{}'::jsonb` (consumed by Spec B's per-tenant rollout — folded here so Spec B needs no migration).
- `campaigns.voice_id` is added but **NOT** seeded with a default; trigger fills `tts_model` only. `voice_id` stays NULL until the user picks one via Spec B's voice picker; Quick Call is blocked while NULL.
- Adds `max_duration_exceeded` to `call_failure_reason_t` enum (used by `ElevenLabsSession` 10-minute kill switch in T4).
- `call_tool_invocations.latency_ms` is a stored generated column.
- `webhook_events` has `CHECK (octet_length(raw_body::text) <= 262144)` and the partial unique index on `(source, external_id) WHERE external_id IS NOT NULL`.
- Seeds `platform_settings` with `default_tts_model='eleven_turbo_v2_5'` only. **No `default_voice_id` seed** (per product decision #1 — user must pick).
- Creates **`BEFORE INSERT` trigger on `campaigns`** that fills `tts_model` from `platform_settings.default_tts_model` when NULL. **Does NOT fill `voice_id`** — that stays NULL until the user picks via Spec B. **No app-layer fetch fallback.**
- Creates `call-recordings` Storage bucket (private, 50 MB, `audio/mpeg, audio/mp4`).
- Non-destructive — rollback-safe.

### T2 — Backfill script (one-shot)
**File:** ad-hoc SQL run through Supabase MCP
**Depends on:** T1
**Acceptance:** Existing `campaigns` rows get `tts_model` (from `platform_settings.default_tts_model`), `agent_status='pending'`, `sync_version=0`. `voice_id` stays NULL (user must pick via Spec B before Quick Call works). `external_ref` auto-populated by default. No EL agents created yet. Existing campaigns will show "needs voice" until the user opens the picker — this is intentional and matches Spec B's flow.

### T3 — New file: `voiceagent-saas/elevenlabs-tools-adapter.js`
**Depends on:** none (reads `tools.js`)
**Acceptance:** Exports `buildElevenLabsClientTools()` returning EL client-tool array. `tools.js` itself is NOT modified beyond removing the Gemini schema export in T10. Unit tests: every tool in `tools.js` produces a valid EL schema.

### T4 — New file: `voiceagent-saas/elevenlabs-session.js`
**Depends on:** T3
**Acceptance criteria:**
- `class ElevenLabsSession extends EventEmitter` with exact public interface in §4.1.
- Implementation follows **Appendix A protocol pinning verbatim** — endpoint, auth header, all client→server / server→client message shapes, audio format assertion.
- Events emitted: `agent_audio`, `user_transcript`, `agent_response`, `tool_call` (with `reply` fn), `conversation_id`, `error`, `closed`.
- **10-minute hard kill switch timer** per session: on expiry, emit `error` with reason `max_duration_exceeded`, close WS, call-bridge finalizes the call row with `failure_reason='max_duration_exceeded'` (NOT `janitor_finalized`).
- Tool results returned ONLY via per-event `reply()` callback. Internal `Map<tool_call_id, replyCallback>` ensures one reply per call; warn if reply is called twice or never (the latter blocks the conversation indefinitely on a "blocking" tool).

### T5 — New file: `voiceagent-saas/live-turn-writer.js`
**Depends on:** T1
**Acceptance:**
- **Process-wide singleton** initialized at boot.
- Single shared `postgres-js` pool (size 10) against `SUPABASE_DIRECT_DB_URL` (Supavisor transaction mode).
- Flush every 500ms (NOT 200ms) OR ≥20 turns OR final OR `flushAndClose(callId)`.
- **Cross-call batching:** every tick flushes ALL pending calls in one multi-row insert.
- **Monotonic `turn_index`** from in-memory per-call counter assigned at enqueue time (never from EL timestamps).
- **Writes ONLY `call_turns`.** NEVER writes `call_tool_invocations` — webhook is canonical.
- Queue overflow >500 turns → disk fallback `/var/log/voiceagent-saas/turn-fallback.jsonl`, `queue_overflow` warning, never blocks call audio.
- On flush failure: log + retry once, never blocks call.

### T6 — New file: `voiceagent-saas/agent-sync-processor.js`
**Depends on:** T1
**Acceptance:**
- BullMQ worker on `agent-sync-jobs`, concurrency 5, retries 3 exp backoff.
- `jobId = "agent-sync:${campaignId}"`, `delay: 2000ms` debounce.
- Flow per §4.2: read snapshot incl. `sync_version`, set `provisioning`, dispatch create/update/delete to EL REST.
- `create`: uses `external_ref` as EL idempotency header.
- `update`: `If-Match: el_etag`; on 412 refetch + retry once.
- **CAS write-back (critical):** `UPDATE campaigns SET agent_status='ready', el_etag=$1, agent_synced_at=now() WHERE id=$2 AND sync_version=$3`. If 0 rows affected → log "stale sync" and exit clean, do not overwrite.
- On final failure sets `agent_status='failed'`, `agent_sync_error`.

### T7 — New file: `voiceagent-saas/audio-archive-processor.js`
**Depends on:** T1
**Acceptance:** BullMQ worker on `audio-archive-jobs`, concurrency 10, retries 5 exp. Downloads signed URL (60s timeout, 50 MB cap, streaming), uploads to `call-recordings/{tenant_id}/{call_id}.mp3` (deterministic, overwrite-safe), `UPDATE calls SET audio_storage_path, audio_archive_status='archived'`. On final failure: `audio_archive_status='failed'`.

### T8 — New file: `voiceagent-saas/janitor.js`
**Depends on:** T1
**Acceptance:**
- 60s timer.
- Stuck-call sweep: `SELECT … FROM calls WHERE started_at < now() - interval '15 minutes' AND ended_at IS NULL FOR UPDATE SKIP LOCKED`. Finalize with `failure_reason='janitor_finalized'`, write `call_metric`.
- **Orphan audio-archive sweep:** `SELECT … WHERE audio_archive_status='pending' AND webhook_processed_at < now() - interval '10 minutes' FOR UPDATE SKIP LOCKED` → re-enqueue `audio-archive-jobs`.
- `webhook_events` cleanup >30 days; `call_metrics` >90 days.

### T9 — New file: webhook handler
**File:** `apps/dashboard/app/api/webhooks/elevenlabs/conversation-ended/route.ts`
**Depends on:** T1
**Acceptance criteria (critical ordering):**
- **Step 0 pre-checks BEFORE raw insert:** reject `Content-Length > 256 KB` with 413; reject missing EL timestamp header with 400.
- Step 1: insert raw row into `webhook_events` before verification (forensic record).
- Step 2: HMAC-SHA256 verify with `ELEVENLABS_WEBHOOK_SECRET` + timestamp within 5-min skew; on failure set `processing_error='invalid_signature'` return 401.
- Step 4: lookup by `elevenlabs_conversation_id`; missing → 200 no-op.
- **Step 5 atomic idempotent UPDATE:** single statement with `WHERE elevenlabs_conversation_id=$ AND webhook_processed_at IS NULL`. 0 rows affected → already processed, return 200.
- Step 6: canonical insert of `call_tool_invocations` using `INSERT … ON CONFLICT DO NOTHING` on `UNIQUE (call_id, name, started_at)`. **Sole writer.**
- Step 7: enqueue `audio-archive-jobs` (async; NOT inline download).
- Step 8: `webhook_events.processed_at = now()`; return 200.

### T10 — Modified: `voiceagent-saas/tools.js`
**Depends on:** T3
**Acceptance:** Remove Gemini-specific schema export. Implementations unchanged. Stays vendor-clean.

### T11 — Modified: `voiceagent-saas/call-processor.js`
**Depends on:** T1, T6
**Acceptance criteria:**
- **Snapshots `agent_id_used` + `sync_version_used`** from `campaigns` into the call job payload at enqueue time (TOCTOU guard, §4.4 step 2).
- Refreshes snapshot one final time at dequeue to shrink deploy-race window.
- **Sole writer** of `campaign_contacts.daily_retry_count` and `last_retry_day`.
- DST-correct retry SQL uses `(now() at time zone 'Asia/Jerusalem')::date` exactly per §5.2.
- Max 3 retries/day; backoff 15m→1h→4h.
- **`agent_version_mismatch` does NOT increment `daily_retry_count`** — auto-retry only.
- Retryable reasons: `voicenter_busy`, `el_ws_connect_failed`, `no_answer`, `network_error`, `agent_not_ready`.
- Non-retryable: `dnc_listed`, `invalid_number`, `compliance_block`.

### T12 — Rewritten: `voiceagent-saas/call-bridge.js`
**Depends on:** T4, T5, T10, T11
**Acceptance:**
- Reads `agent_id_used` / `sync_version_used` from job payload (no lookup).
- Asserts `campaigns.elevenlabs_agent_id == agent_id_used && sync_version == sync_version_used && agent_status='ready'`. Mismatch → hang up with `failure_reason='agent_version_mismatch'`, no retry increment.
- Opens ExternalMedia slin16 → `ElevenLabsSession` → pipes audio → routes transcripts to `live-turn-writer` → tool calls dispatched via `tools.executeTool` and replied through event channel.
- `StasisEnd` handler ALWAYS finalizes `calls` row (`ended_at`, `failure_reason` if any) and calls `liveTurnWriter.flushAndClose(callId)`, even if EL never opened.
- Writes `call_metrics` row once at StasisEnd (primary key insert, not upsert).
- **Read-only** on `campaign_contacts.daily_retry_count`.

### T13 — Modified: `voiceagent-saas/server.js`
**Depends on:** T5, T6, T7, T8, T12
**Acceptance:** Wires `live-turn-writer` singleton init, starts `agent-sync-processor`, `audio-archive-processor`, `janitor` in-process alongside existing `call-processor`. Registers new BullMQ queues.

### T14 — Deletions
**Depends on:** T12
**Files:** `voiceagent-saas/gemini-session.js`, `voiceagent-saas/audio-utils.js`. Also remove Gemini schema export already handled in T10. `GEMINI_API_KEY` env var deletion deferred to rollout Step 9.

### T15 — Tests (§6.1)
**Depends on:** T3–T14
**Unit tests:** adapter shape; `live-turn-writer` monotonic + batching + fallback; `agent-sync` CAS stale → no-op, ETag 412 retry, `external_ref` on create; webhook signature+timestamp (valid/stale/tampered); DST retry spring-forward; `call-bridge` version-mismatch rejection; webhook idempotency replay; audio-archive timeout/oversize/success.
**Integration tests:** `elevenlabs-session` against sandbox/mock; signed webhook fixture end-to-end; audio-archive real signed URL; 10-job race on same campaign → exactly one PATCH lands, no orphan EL agents.

## Verification Gates — 13 manual end-to-end steps (§6.1)

Execute on a real Hebrew phone call before marking PR ready. Each is a named gate:

- **G1** Fresh campaign created with `voice_id=NULL` and Quick Call blocked. Manually set `voice_id` via SQL (Spec A has no UI) — agent provisions on next save/sync.
- **G2** `agent_status`: pending → provisioning → ready within ~5s.
- **G3** Own phone added as contact; Quick Call triggers.
- **G4** 30s Hebrew conversation invokes at least one tool ("אני מעוניין, תקבע לי פגישה").
- **G5** Hang up.
- **G6** Within ~10s: `calls.transcript_full`, `summary`, `sentiment`, `webhook_processed_at` populated; `audio_archive_status` pending → archived.
- **G7** `call-recordings/{tenant_id}/{call_id}.mp3` exists.
- **G8** `call_tool_invocations` has row with non-null `latency_ms`.
- **G9** `call_turns` rows have monotonic `turn_index`.
- **G10** Edit campaign prompt → `sync_version` bump → sync fires → `agent_synced_at` updates → NO duplicate EL agents.
- **G11** Garbage `ELEVENLABS_API_KEY` → `failure_reason='el_ws_connect_failed'` → retries with backoff → after 3 fails contact → `needs_attention`.
- **G12** `kill -9` mid-call → restart → janitor finalizes stuck row within 60s with `janitor_finalized`.
- **G13** Replay captured webhook → second hit returns 200, no double-write.

## Rollout — 9 steps (§6.2, order is load-bearing)

1. **Step 0** Encryption gate — PASSED (documented above).
2. **Step 1** Apply SQL migration via Supabase MCP; create Storage bucket.
3. **Step 2** Run backfill script (T2).
4. **Step 3** Pre-cutover safety net: `git tag pre-elevenlabs`, DO droplet snapshot, keep `GEMINI_API_KEY` for 72h, **rehearse rollback on staging with a real Hebrew call, sign off in writing**.
5. **Step 4** Deploy dashboard to Railway (webhook endpoint + job-payload snapshot path). Env: `ELEVENLABS_WEBHOOK_SECRET` only.
6. **Step 5** Configure EL dashboard webhook URL → Railway endpoint; copy secret; send test webhook; verify `webhook_events` row. **MUST happen BEFORE Step 6.**
7. **Step 6** Deploy voice engine to droplet (scp + `systemctl restart`). New files + rewritten `call-bridge.js` + deletions. Env: `ELEVENLABS_API_KEY`, `SUPABASE_DIRECT_DB_URL`. (No `ELEVENLABS_WORKSPACE_ID` — confirmed not required.)
8. **Step 7** Smoke test on single test campaign — run G1–G13, sign off in writing.
9. **Step 8** Cutover — real customer calls flow through EL.
10. **Step 9** 72-hour watch (`tts_first_byte_ms` p95, `el_ws_open_ms` p95, webhook success, `audio_archive_status='failed'` rate, `call_failure_reason_t` distribution). After stable: remove `GEMINI_API_KEY` from droplet + Railway.

## Resolved decisions (from product)

1. **Default voice:** No default. `campaigns.voice_id` is created NULL; Quick Call is blocked until the user picks a voice via Spec B's voice picker (or admin SQL override). The `BEFORE INSERT` trigger only fills `tts_model`, not `voice_id`. **The `platform_settings` seed must NOT seed `default_voice_id`.**
2. **10-minute kill switch failure reason:** Add `max_duration_exceeded` to the `call_failure_reason_t` enum. Use this (not `janitor_finalized`) when the in-process timer fires.
3. **`ELEVENLABS_WORKSPACE_ID`:** Not required. ElevenLabs auth is `xi-api-key` header only. Drop from env var lists.
4. **EL WebSocket protocol:** Pinned in Appendix A below. Implementer follows the appendix; no live doc lookup needed for T4.
5. **`tenants.feature_flags jsonb`:** Fold into Spec A's migration (T1) so Spec B can ship without a follow-up migration.

## Open questions

None remaining. Ready for implementation.

---

## Appendix A — ElevenLabs Conversational AI WebSocket Protocol (pinned)

Source: ElevenLabs official docs as of 2026-04-07. Implementer of T4 follows this appendix verbatim.

### Endpoint & auth

```
wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<agent_id>
Header: xi-api-key: <ELEVENLABS_API_KEY>
```

### First message (client → server)

`conversation_initiation_client_data` — sent immediately after connection opens.

```json
{
  "type": "conversation_initiation_client_data",
  "conversation_config_override": {
    "agent": {
      "prompt": { "prompt": "...", "llm": "gpt-4" },
      "first_message": "...",
      "language": "he"
    },
    "tts": {
      "voice_id": "<voice_id>",
      "speed": 1.0,
      "stability": 0.5,
      "similarity_boost": 0.75
    }
  },
  "custom_llm_extra_body": { "temperature": 0.7, "max_tokens": 150 },
  "dynamic_variables": {
    "contact_name": "...",
    "business_name": "...",
    "...": "..."
  }
}
```

> **Note for T4 + T6:** for Spec A, prompt + voice + tools live on the EL agent itself (created/managed by `agent-sync-processor.js`). The first message in `call-bridge.js` should be minimal — only `dynamic_variables` (contact name, business name, custom fields) and `conversation_config_override.agent.first_message` if needed for personalization. Do NOT override the prompt at call time — it's already on the agent.

### Client → server message types

| `type` | Purpose |
|---|---|
| `conversation_initiation_client_data` | First message (above) |
| `user_audio_chunk` | Base64-encoded PCM 16k audio frame from user |
| `pong` | Response to server `ping`, echoing `event_id` |
| `client_tool_result` | Result of an executed client tool |
| `contextual_update` | Free-form context to inject into conversation state |
| `user_message` | Text message from user (we don't use — voice only) |
| `user_activity` | User activity signal (we don't use) |

### Server → client message types

| `type` | Purpose |
|---|---|
| `conversation_initiation_metadata` | Sent right after connect; carries `conversation_id` + `agent_output_audio_format` |
| `audio` | Base64 PCM 16k audio frame from agent |
| `user_transcript` | User speech transcription (tentative or final) |
| `agent_response` | Agent's text response (final) |
| `agent_response_correction` | Corrected response after interruption |
| `interruption` | Notification an event was interrupted |
| `client_tool_call` | Request to execute a client tool |
| `ping` | Latency measurement; echo with `pong` + same `event_id` |
| `vad_score` | Voice activity detection (0–1); informational |
| `internal_tentative_agent_response` | Preliminary agent response (informational) |
| `contextual_update` | Server-side context injection |

### Audio format

- Encoding: base64 PCM signed 16-bit little-endian
- Sample rate: confirmed via `conversation_initiation_metadata.agent_output_audio_format` field — expect `"pcm_16000"`
- Direction matches Asterisk slin16. **No resampling needed.**

### Server → client message JSON shapes (verbatim)

**`conversation_initiation_metadata`**
```json
{
  "type": "conversation_initiation_metadata",
  "conversation_initiation_metadata_event": {
    "conversation_id": "conv_abc123xyz",
    "agent_output_audio_format": "pcm_16000"
  }
}
```
→ T4: emit `conversation_id` event with the string. Assert `agent_output_audio_format === "pcm_16000"`; if not, fail-fast (no resampling code path exists).

**`audio`**
```json
{
  "type": "audio",
  "audio_event": {
    "audio_base_64": "<b64 PCM 16k>",
    "event_id": 123
  }
}
```
→ T4: decode base64, emit `agent_audio` event with the raw Buffer.

**`user_transcript`**
```json
{
  "type": "user_transcript",
  "user_transcription_event": {
    "user_transcript": "Hello, how are you?",
    "is_final": true
  }
}
```
→ T4: emit `user_transcript` event with `{ text, isFinal, ts: Date.now() }`. T5 enqueues the row.

**`agent_response`**
```json
{
  "type": "agent_response",
  "agent_response_event": {
    "agent_response": "I'm doing well, thank you for asking!"
  }
}
```
→ T4: emit `agent_response` event with `{ text, isFinal: true, ts: Date.now() }`. T5 enqueues the row.

**`agent_response_correction`** — same shape as `agent_response`. T4 emits as a correction event; T5 may need to overwrite the last agent turn rather than append (decision deferred to T5 implementation, document either way).

**`client_tool_call`**
```json
{
  "type": "client_tool_call",
  "client_tool_call": {
    "tool_name": "displayMessage",
    "tool_call_id": "unique_call_id_123",
    "parameters": { "text": "Hello from the agent!" }
  }
}
```
→ T4: emit `tool_call` event with `{ name, args, callId, reply }` where `reply(result)` sends back `client_tool_result` (see below).

**`ping`**
```json
{
  "type": "ping",
  "ping_event": { "event_id": 456, "ping_ms": 42 }
}
```
→ T4: respond immediately with `pong` carrying same `event_id`. Track `ping_ms` for the `tts_first_byte_ms` metric (or use it for connection health).

**`interruption`** → T4: emit informational `interruption` event; the live writer may need to mark the last agent turn as truncated. Implementation detail for T5.

**`vad_score`** → T4: ignored for v1 (informational only).

### Client → server message JSON shapes

**`conversation_initiation_client_data`** — see "First message" above.

**`user_audio_chunk`**
```json
{
  "type": "user_audio_chunk",
  "user_audio_chunk": "<b64 PCM 16k>"
}
```
→ T4 `sendAudio(buffer)`: base64-encode the buffer and send.

**`pong`**
```json
{
  "type": "pong",
  "event_id": 456
}
```
→ T4: sent in response to server `ping` with the matching `event_id`.

**`client_tool_result`**
```json
{
  "type": "client_tool_result",
  "tool_call_id": "unique_call_id_123",
  "result": "Message displayed successfully",
  "is_error": false
}
```
→ T4: the `reply()` callback on `tool_call` events constructs and sends this. On thrown exceptions in `tools.executeTool()`, send with `is_error: true` and `result: <error message>` so the agent can recover the conversation.

### Tool definition (when creating an agent in T6)

When `agent-sync-processor.js` creates the EL agent via REST, the `tools` array must use this shape (one entry per `tools.js` tool):

```json
{
  "tool_name": "score_lead",
  "description": "Score the lead's qualification on a 0-100 scale",
  "parameters": {
    "score": { "type": "integer", "description": "0-100" },
    "reason": { "type": "string", "description": "..." }
  }
}
```

> **Important:** all client tools must be marked as **"blocking conversation"** in the agent config (so the agent waits for the result before continuing). For Spec A's tools (`score_lead`, `book_meeting`, `mark_dnc`, `send_whatsapp`) every one is side-effect-bearing, so all must block. Set this flag in the create-agent payload.

### `elevenlabs-tools-adapter.js` (T3) responsibility

Convert `tools.js` definitions to the EL `tool_name` / `description` / `parameters` shape above. The adapter is the ONLY file that touches this shape; `tools.js` stays vendor-clean.

### Notes for T4 `ElevenLabsSession` implementation

- WebSocket library: `ws` (already in voice engine `package.json`)
- On connect: send `conversation_initiation_client_data` immediately, do not wait for any server hello
- On `conversation_initiation_metadata`: emit `conversation_id`, validate audio format
- 10-minute kill timer starts at connect; on fire, emit `error` with `max_duration_exceeded` reason and close WS
- 20s heartbeat: rely on server `ping`/`pong` flow above; if no `ping` for 30s, treat as dropped → emit `error`
- Tool result reply path: keep a small in-memory `Map<tool_call_id, replyCallback>` so reply can be called once per call; warn if reply called twice or never

## Critical files for implementation

- `supabase/migrations/2026-04-07_elevenlabs_runtime_swap.sql` (new)
- `voiceagent-saas/elevenlabs-session.js` (new)
- `voiceagent-saas/elevenlabs-tools-adapter.js` (new)
- `voiceagent-saas/agent-sync-processor.js` (new)
- `voiceagent-saas/audio-archive-processor.js` (new)
- `voiceagent-saas/live-turn-writer.js` (new)
- `voiceagent-saas/janitor.js` (new)
- `voiceagent-saas/call-bridge.js` (rewritten)
- `voiceagent-saas/call-processor.js` (modified)
- `voiceagent-saas/tools.js` (modified)
- `voiceagent-saas/server.js` (modified)
- `apps/dashboard/app/api/webhooks/elevenlabs/conversation-ended/route.ts` (new)
- Deletions: `voiceagent-saas/gemini-session.js`, `voiceagent-saas/audio-utils.js`
