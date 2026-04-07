# ElevenLabs Conversational AI Migration — Design

**Status:** Draft for review
**Author:** brainstormed with Claude
**Date:** 2026-04-07
**Supersedes (partially):** `2026-04-04-voice-agent-saas-design.md` (voice provider section)

## 1. Goals & Non-Goals

### Goals
- Replace Gemini Live with ElevenLabs Conversational AI as the brain + voice for all calls (Hebrew agents).
- Lowest-latency audio path: PCM 16 kHz both ways, zero resampling.
- Production-grade transcripts: live (during call) + post-call (canonical) with audio archived in Supabase Storage.
- Per-campaign agent lifecycle managed asynchronously via BullMQ.
- Full dashboard UI v1: voice picker, LLM provider picker, agent status, live transcript, post-call review.
- Smart retry on failures (max 3/contact/day) with persistent failures surfaced in the dashboard.

### Non-Goals
- Provider abstraction or multi-provider runtime support — this is a hard swap; Gemini code is deleted.
- Mid-call WebSocket reconnection — fail fast instead.
- English-language agents or the US-customer pivot — Hebrew only.
- Migrating in-flight Gemini calls — cutover applies to new calls only.
- Changes to Asterisk/Voicenter/BullMQ/dashboard auth layers — untouched.
- Grafana dashboards, PagerDuty, audio retention lifecycle, RLS hardening — separate follow-up specs.

## 2. Architecture

```
Dashboard (Next.js, Railway)
  ├── Campaign create/edit  → write campaigns row + enqueue agent-sync job
  └── Quick Call / scheduled call → enqueue call job (only when agent_status='ready')
                              │
                              ▼
                    BullMQ (Railway Redis)
                    ├── call-jobs (existing)
                    └── agent-sync-jobs (NEW)
                              │
                              ▼
       voiceagent-saas (DO droplet) — two workers in same process
       ├── call-processor.js (existing, modified)
       └── agent-sync-processor.js (NEW)
                              │
                              ▼
       Asterisk ARI originate → Voicenter SIP → phone
                              │
                              ▼
       ExternalMedia (slin16, 16 kHz PCM) — unchanged
                              │
                              ▼
       call-bridge.js (rewritten, slimmer)
       ├── elevenlabs-session.js (NEW, replaces gemini-session.js)
       ├── live-turn-writer.js   (NEW)
       ├── tools.js              (ported, unchanged implementations)
       ├── compliance.js         (unchanged)
       └── whatsapp-client.js    (unchanged)

Dashboard webhook endpoint (NEW):
  POST /api/webhooks/elevenlabs/conversation-ended
  - HMAC verify, download audio → Supabase Storage,
    update calls row, idempotent on conversation_id.

Supabase Realtime (NEW): dashboard subscribes to call_turns inserts
  for the live transcript view.
```

### Single-purpose units

| Unit | Purpose | Depends on |
|---|---|---|
| `elevenlabs-session.js` | Manage one EL conversation WebSocket per call | `ws`, audio in/out, tool dispatcher callback |
| `agent-sync-processor.js` | Reconcile a campaign row → an EL agent | EL REST API, Supabase |
| `live-turn-writer.js` | Batch + write turn events to `call_turns` | Supabase service client |
| `call-bridge.js` (rewritten) | Wire Asterisk media ↔ EL session ↔ live writer ↔ tools | All of the above |
| Webhook handler (dashboard) | Persist post-call analysis + archive audio | Supabase, EL signature secret |

### Files deleted in this migration
- `voiceagent-saas/gemini-session.js`
- `voiceagent-saas/audio-utils.js` (no resampling needed — both ends are 16 kHz)
- Gemini-specific code paths in `voiceagent-saas/tools.js`
- `GEMINI_API_KEY` env var on droplet

## 3. Data Model Changes

### New columns on `campaigns`

| Column | Type | Notes |
|---|---|---|
| `elevenlabs_agent_id` | text, nullable | Set by agent-sync-processor after successful create |
| `agent_status` | enum (`pending`, `provisioning`, `ready`, `failed`) | Drives UI button state and status pill |
| `agent_sync_error` | text, nullable | Last error message when status=failed |
| `agent_synced_at` | timestamptz, nullable | Last successful sync (used to detect stale agents on prompt edit) |
| `voice_id` | text, not null | EL voice ID; defaults to a vetted Hebrew-friendly voice |
| `llm_provider` | enum (`bundled`, `gpt-4o`, `claude-sonnet-4.5`) | Default `bundled` |
| `llm_api_key_encrypted` | bytea, nullable | Only set when `llm_provider != 'bundled'`. Encrypted via existing `packages/database` helper |
| `tts_model` | text, default `eleven_turbo_v2_5` | Future-proof; not in v1 UI but stored |

### New columns on `calls`

| Column | Type | Notes |
|---|---|---|
| `elevenlabs_conversation_id` | text, nullable, unique | EL's conversation ID; idempotency key for webhook |
| `transcript_full` | jsonb, nullable | Canonical post-call transcript from EL webhook |
| `summary` | text, nullable | EL conversation summary |
| `sentiment` | text, nullable | EL sentiment classification |
| `success_evaluation` | jsonb, nullable | EL success/failure analysis |
| `audio_storage_path` | text, nullable | Supabase Storage path after archive |
| `tool_calls_log` | jsonb, nullable | Array of `{name, args, result, ts}` |
| `failure_reason` | text, nullable | `el_ws_error`, `voicenter_busy`, etc. |
| `retry_count` | int, default 0 | Increment per retry; max 3/day enforced in processor |

### New table `call_turns`

```sql
create table call_turns (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid not null references calls(id) on delete cascade,
  tenant_id   uuid not null references tenants(id),
  turn_index  int not null,
  role        text not null check (role in ('user', 'agent')),
  text        text not null,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  created_at  timestamptz not null default now(),
  unique (call_id, turn_index)
);

create index on call_turns (call_id, turn_index);
alter table call_turns enable row level security;
-- policy mirrors existing tenant-scoped patterns: tenant_id = auth.jwt() -> tenant_id
```

### New Supabase Storage bucket
- **Name:** `call-recordings`
- **Path pattern:** `{tenant_id}/{call_id}.mp3`
- **Access:** private; signed URLs generated by the dashboard on demand.
- **Lifecycle (deferred):** delete after 90 days — separate spec.

### New BullMQ queue
- **Name:** `agent-sync-jobs`
- **Payload:** `{ campaignId, action: 'create' | 'update' | 'delete' }`
- **Concurrency:** 5
- **Retries:** 3 with exponential backoff
- **Final-failure handler:** writes `agent_sync_error`, sets `agent_status='failed'`.

### Migration ordering
Single SQL migration: `supabase/migrations/2026-04-07_elevenlabs_migration.sql`. RLS policies match existing tenant-scoped patterns.

## 4. Component Design

### 4.1 `elevenlabs-session.js` (replaces `gemini-session.js`)

**Purpose:** Own one ElevenLabs Conversational AI WebSocket per active call. Translate between Asterisk PCM frames and EL's WS protocol. Dispatch tool calls to a callback.

**Public interface:**
```js
class ElevenLabsSession extends EventEmitter {
  constructor({ agentId, conversationConfig, toolHandler, logger })
  async connect()                  // opens WS, sends conversation_initiation
  sendAudio(pcm16kBuffer)          // forwards user audio frame
  async close(reason)              // graceful shutdown
}
```

**Events emitted:**
- `agent_audio` (Buffer pcm16k) → forwarded to Asterisk
- `user_transcript` ({ text, isFinal, ts }) → live writer
- `agent_response` ({ text, isFinal, ts }) → live writer
- `tool_call` ({ name, args, callId }) → handled by call-bridge; result returned via internal `_sendToolResult`
- `conversation_id` (string) → stored on `calls` row immediately
- `error` (Error) → triggers fail-fast in call-bridge
- `closed` ({ reason })

**WebSocket protocol details:**
- Endpoint: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agentId}`
- Auth: `xi-api-key` header
- First message: `conversation_initiation_client_data` with dynamic variables (contact name, lead context) plus optional prompt overrides.
- Audio in: `user_audio_chunk` events with base64 PCM 16k
- Audio out: `audio` events with base64 PCM 16k → emit `agent_audio`
- Heartbeat: ping/pong every 20 s
- No reconnection logic (fail-fast per design).

### 4.2 `agent-sync-processor.js` (new BullMQ worker)

**Purpose:** Reconcile a `campaigns` row to an ElevenLabs agent.

**Job actions:**
- `create` → `POST /v1/convai/agents/create` with prompt, voice, tools schema, language `he`. Store returned `agent_id`. Set `agent_status='ready'`.
- `update` → `PATCH /v1/convai/agents/{id}` with new prompt/voice/llm. Bump `agent_synced_at`.
- `delete` → `DELETE /v1/convai/agents/{id}`. Null out `elevenlabs_agent_id`.

On job pickup, immediately set `agent_status='provisioning'` so the dashboard pill updates.

**Tool schema generation:** reuses `tools.js` definitions via a new `toElevenLabsSchema()` exporter that converts existing JSON schemas to EL's client-tool format.

### 4.3 `live-turn-writer.js` (new)

**Purpose:** Buffer transcript events and batch-write to `call_turns` to avoid hammering Supabase mid-call.

**Behavior:**
- In-memory queue per call.
- Flush trigger: 200 ms timer OR 10 turns buffered OR `final` flag on a turn.
- Single `insert` per flush (Supabase service role).
- On flush failure: log + retry once. Never blocks the call. (The post-call webhook is the canonical source.)

### 4.4 `call-bridge.js` (rewritten, slimmer)

**Purpose:** Wire Asterisk media stream ↔ ElevenLabs session ↔ live writer ↔ tool dispatcher.

**Lifecycle per call:**
1. Receive `StasisStart` from ARI.
2. Look up `campaigns.elevenlabs_agent_id` (must be ready or call fails immediately with `agent_not_ready`).
3. Open ExternalMedia channel (slin16, 16 kHz).
4. Construct `ElevenLabsSession` with `agentId`, dynamic variables (contact_name, business_name, custom fields), tool handler.
5. `session.connect()`.
6. On `conversation_id` event → write to `calls` row.
7. Pipe RTP frames → `session.sendAudio()`.
8. Pipe `agent_audio` events → RTP frames out.
9. Pipe transcript events → `live-turn-writer`.
10. Pipe `tool_call` events → execute via `tools.js` → `_sendToolResult`.
11. On `error` or `closed` → hang up channel, mark call status, exit cleanly.

Removed from current `call-bridge.js`: all Gemini Live setup, audio resampling, prompt construction (now happens at agent-creation time, not per call).

### 4.5 Tool dispatcher (`tools.js`, ported)

- Add `toElevenLabsSchema()` export — returns array of `{ name, description, parameters }` in EL's client-tool format.
- Tool implementations (Supabase / Green API calls) are unchanged.
- New top-level `executeTool(name, args, context)` switchboard called by call-bridge on `tool_call` events.

### 4.6 Webhook endpoint (dashboard, new)

**Route:** `apps/dashboard/app/api/webhooks/elevenlabs/conversation-ended/route.ts`

**Behavior:**
1. Read raw body, verify HMAC-SHA256 with `ELEVENLABS_WEBHOOK_SECRET` env var.
2. Parse `conversation_id`, `transcript`, `analysis`, `audio_url`, `duration_seconds`, `tool_calls`.
3. Look up `calls` row by `elevenlabs_conversation_id`.
4. **Idempotency:** if `audio_storage_path` already set → return 200 immediately.
5. Download audio from EL's signed URL → upload to `call-recordings/{tenant_id}/{call_id}.mp3`.
6. Update `calls` row with all post-call fields in one transaction.
7. Return 200.

**Failure modes:** invalid signature → 401; audio download fails → 500 (EL retries); Supabase write fails → 500 (EL retries).

### 4.7 Dashboard UI changes (full v1)

**Campaign create/edit form additions:**
- **Voice picker modal** — fetches EL voice library via server action `/api/elevenlabs/voices`, filtered to multilingual-capable voices, with inline preview player (HTML5 `<audio>` playing EL's sample URL).
- **LLM provider dropdown** — Bundled / GPT-4o / Claude Sonnet 4.5. Conditional API key input (encrypted on save via existing helper).
- **Agent status pill** at top of campaign card — Provisioning / Ready / Sync Failed (with error tooltip).
- **Quick Call button** disabled with tooltip "Agent provisioning…" while `agent_status != 'ready'`.

**New live transcript view:**
- Page: `/campaigns/[id]/calls/[callId]/live`
- Subscribes to `call_turns` via Supabase Realtime channel filtered by `call_id`.
- Auto-scroll to latest turn, role-colored bubbles (user vs agent).
- "Call ended" indicator when `calls.ended_at` becomes non-null.

**Upgraded post-call view:**
- Existing call detail page extended with:
  - Audio player (waveform via `wavesurfer.js`, source = signed URL to Supabase Storage).
  - Full transcript (read from `transcript_full`, fallback to `call_turns` if webhook hasn't fired yet).
  - Summary, sentiment badge, success-evaluation badge.
  - Tool call timeline (collapsible).

**New env vars:**
- `ELEVENLABS_API_KEY` (droplet + dashboard)
- `ELEVENLABS_WEBHOOK_SECRET` (dashboard)

## 5. Error Handling, Retries & Observability

### 5.1 Failure modes & responses

| Failure | Where | Response |
|---|---|---|
| EL agent create fails (4xx) | agent-sync-processor | Retry up to 3× with exp backoff. Final fail → `agent_status='failed'`, surface in dashboard. |
| EL agent create fails (5xx/network) | agent-sync-processor | Same as above; BullMQ handles backoff. |
| Call attempted with `agent_status != 'ready'` | call-processor | Reject job, mark `failure_reason='agent_not_ready'`, no retry. |
| EL WS fails to open at call start | call-bridge | Hang up channel before audio path opens, mark `failure_reason='el_ws_connect_failed'`, increment `retry_count`, BullMQ requeues per backoff if `retry_count < 3`. |
| EL WS drops mid-call | call-bridge | Hang up channel, mark `failure_reason='el_ws_dropped'`, **no retry** (caller already heard silence). |
| Tool execution throws | tool dispatcher | Send `tool_result` with `error` field back to EL so the agent can recover. Log the exception. Do not crash the call. |
| Live turn write fails | live-turn-writer | Log + retry once. Never blocks the call. |
| Webhook arrives but `calls` row missing | webhook handler | Return 200 (idempotent no-op), log warning. |
| Webhook signature invalid | webhook handler | Return 401, log security event. |
| Audio download from EL fails | webhook handler | Return 500 → EL retries. |
| Asterisk channel hangs up before EL responds | call-bridge | Send `close` to EL WS, mark `status='abandoned_by_callee'`, no retry. |
| Voicenter SIP busy/unreachable | ARI originate | Existing path, mark `failure_reason='voicenter_busy'`, BullMQ retry with backoff. |

### 5.2 Retry policy

Enforced in `call-processor.js`, per `campaign_contacts` row:
- Max **3 retries / contact / calendar day** (Israel timezone).
- Backoff schedule: 15 min → 1 h → 4 h.
- After 3rd failure same day: mark `campaign_contacts.status='needs_attention'`, surface in dashboard "Failed Calls" tab.
- Retryable failure reasons: `voicenter_busy`, `el_ws_connect_failed`, `no_answer`, `network_error`.
- Non-retryable (manual only): `dnc_listed`, `agent_not_ready`, `invalid_number`, `compliance_block`.

### 5.3 Observability

**Structured logs (existing pino logger, extended):**
- Each call gets a `call_id` log context that threads through all components.
- New fields: `el_conversation_id`, `el_agent_id`, `el_ws_state`, `tts_first_byte_ms`, `tool_call_count`.
- Error logs include `failure_reason`.

**Metrics (lightweight, written to a `call_metrics` table for now — Grafana later):**
- `tts_first_byte_ms` — user stops talking → first agent audio frame (latency KPI).
- `el_ws_open_ms` — `session.connect()` → ready.
- `tool_call_latency_ms` — per-tool execution time.
- `call_duration_seconds`.
- `transcript_turn_count`.

**Dashboard "Failed Calls" tab:**
- Page: `/campaigns/[id]/failures`.
- Lists `campaign_contacts` with `status='needs_attention'`, last `failure_reason`, timestamp.
- Manual retry button per row (resets `retry_count` and re-enqueues).

**Alerting (deferred):** PagerDuty/email when `agent_sync` failure rate > 10% over 1 h, or `tts_first_byte_ms` p95 > 1500 ms.

## 6. Testing & Rollout

### 6.1 Testing strategy

**Unit tests (`apps/voice-engine/` test suite):**
- `tools.js → toElevenLabsSchema()` produces valid EL client-tool format for every tool.
- `live-turn-writer.js` flush logic — buffer fills, timer fires, batch insert called with correct shape.
- `agent-sync-processor.js` — given a campaign row, produces correct EL create/update/delete payload (mock HTTP client).
- Webhook signature verification — valid sig passes, tampered body fails.
- Retry policy — given `failure_reason` X and `retry_count` Y, decide retry vs `needs_attention`.

**Integration tests:**
- `elevenlabs-session.js` against EL sandbox or recorded WS mock: connect → send PCM → receive `agent_audio` + `user_transcript` → tool_call dispatch → tool_result roundtrip → close.
- Webhook endpoint with a real signed payload fixture → verify all `calls` columns populated + audio uploaded to a test Storage bucket.
- Agent-sync end-to-end: insert a campaign row → enqueue job → run processor against EL sandbox → assert `elevenlabs_agent_id` and `agent_status='ready'`.

**Manual end-to-end test plan:**
1. Create a fresh campaign in dashboard, pick a Hebrew voice, leave LLM=bundled.
2. Verify `agent_status` transitions: pending → provisioning → ready (within ~5 s).
3. Verify Quick Call button enables when ready.
4. Add one contact (own phone), click Quick Call.
5. Phone rings, answer, hold a 30-second Hebrew conversation that triggers at least one tool (e.g., "אני מעוניין, תקבע לי פגישה").
6. Open live transcript page in another tab during the call → verify turns appear within ~500 ms of speech.
7. Hang up.
8. Within ~10 s, verify post-call view shows: full transcript, audio player works, summary populated, sentiment populated, tool call shown in timeline.
9. Verify audio file exists in Supabase Storage at `{tenant_id}/{call_id}.mp3`.
10. Edit campaign prompt → verify update job fires and `agent_synced_at` updates.
11. Force a failure: temporarily set `ELEVENLABS_API_KEY` to garbage → attempt call → verify `failure_reason='el_ws_connect_failed'`, retries fire on schedule, after 3 fails contact moves to `needs_attention`.
12. Manual retry from Failed Calls tab → verify `retry_count` resets and call re-attempts.

### 6.2 Rollout sequence

**Step 1 — Database migration (no code yet)**
- Apply `2026-04-07_elevenlabs_migration.sql` via Supabase MCP.
- All new columns nullable / safe defaults.
- Create `call-recordings` Storage bucket (private).

**Step 2 — Backfill existing campaigns**
- One-time script: set `voice_id` to default vetted Hebrew voice, `llm_provider='bundled'`, `agent_status='pending'`, `tts_model='eleven_turbo_v2_5'`.
- Do NOT auto-create EL agents — wait for user save (which fires the sync job) OR provide an admin "Provision Agents" button.

**Step 3 — Deploy dashboard (Railway, push to main)**
- New campaign form fields, voice picker, status pill.
- Webhook endpoint live (no calls flowing yet).
- Live transcript page + upgraded post-call page.
- Quick Call button respects `agent_status`.
- Existing campaigns show "Needs provisioning" until edited.

**Step 4 — Deploy voice engine (droplet, scp + systemctl)**
- New `elevenlabs-session.js`, `agent-sync-processor.js`, `live-turn-writer.js`.
- Rewritten `call-bridge.js`.
- New env vars: `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`.
- Both queues active.
- **Delete `gemini-session.js` and `audio-utils.js` in this commit.**
- Remove `GEMINI_API_KEY` from droplet `.env`.

**Step 5 — Smoke test**
- Run the manual test plan on a single test campaign before any real customer call.

**Step 6 — Configure EL webhook**
- In ElevenLabs dashboard, set conversation-ended webhook URL to `https://dashboard-production-5c3b.up.railway.app/api/webhooks/elevenlabs/conversation-ended`.
- Copy webhook secret into Railway env vars.

### 6.3 Rollback plan

- Gemini code is deleted from the repo, so rollback = `git revert` the merge commit + redeploy both services.
- DB schema additions are non-destructive; nullable columns are harmless even on rollback.
- `call-recordings` bucket can stay.

### 6.4 Out of scope (explicit follow-up specs)

- Grafana dashboards / PagerDuty alerts for new metrics.
- 90-day audio retention lifecycle policy.
- Multi-language support (English agents).
- Voice cloning per tenant.
- A/B testing infrastructure for prompts.
- Re-enabling RLS (separate hardening pass).

## 7. Open Questions

None at time of writing. All design decisions confirmed in brainstorming session.
