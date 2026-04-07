# Spec A — ElevenLabs Voice Provider Runtime Swap

**Status:** Draft for review
**Date:** 2026-04-07
**Companion spec:** `2026-04-07-elevenlabs-dashboard-ui-design.md` (Spec B — UI v1, ships after this is stable)
**Supersedes:** `2026-04-07-elevenlabs-migration-design.md` (split into A + B)

This spec covers the **backend runtime cutover** from Google Gemini Live to ElevenLabs Conversational AI. It is the high-risk piece and must ship and stabilize before Spec B (dashboard UI) is deployed. It owns the **entire database migration** (including columns Spec B will consume) so there is one and only one schema change.

## 1. Goals & Non-Goals

### Goals
- Replace Gemini Live with ElevenLabs Conversational AI as the brain + voice for all calls (Hebrew agents).
- Lowest-latency audio path: PCM 16 kHz both ways, zero resampling.
- Production-grade transcripts: live (during call) + post-call (canonical) with audio archived in Supabase Storage.
- Per-campaign agent lifecycle managed asynchronously via BullMQ with race-safe semantics.
- Smart retry on failures (max 3/contact/day, DST-correct) with persistent failures surfaced via the existing `tab-failed.tsx`.
- Own the complete database migration so Spec B is purely additive UI on top of a finished schema.
- A viable, rehearsed rollback path.

### Non-Goals
- Dashboard UI changes — voice picker, LLM dropdown, live transcript page, post-call view upgrade. **All in Spec B.**
- Provider abstraction or multi-provider runtime support — hard swap; Gemini code is deleted.
- Mid-call WebSocket reconnection — fail fast instead.
- English-language agents or the US-customer pivot — Hebrew only.
- Migrating in-flight Gemini calls — cutover applies to new calls only.
- Grafana / PagerDuty / audio retention lifecycle / RLS hardening — separate follow-up specs.

## 2. Architecture

```
Dashboard (Next.js, Railway)  -- unchanged in this spec; UI work in Spec B
  └── Existing campaign create/edit + Quick Call paths
        │  (Spec B will add: voice picker, LLM dropdown, live transcript UI)
        ▼
BullMQ (Railway Redis)
  ├── call-jobs        (existing)
  ├── agent-sync-jobs  (NEW)
  └── audio-archive-jobs (NEW)
        │
        ▼
voiceagent-saas (DO droplet) — workers in same process
  ├── call-processor.js          (existing, modified)
  ├── agent-sync-processor.js    (NEW)
  ├── audio-archive-processor.js (NEW)
  └── janitor.js                 (NEW — sweeps stale calls)
        │
        ▼
Asterisk ARI originate → Voicenter SIP → phone
        │
        ▼
ExternalMedia (slin16, 16 kHz PCM) — unchanged
        │
        ▼
call-bridge.js (rewritten, slimmer — one instance per call)
  ├── elevenlabs-session.js   (NEW, replaces gemini-session.js)
  ├── elevenlabs-tools-adapter.js (NEW — keeps tools.js provider-clean)
  ├── tools.js                (unchanged implementations)
  ├── compliance.js           (unchanged)
  └── whatsapp-client.js      (unchanged)

live-turn-writer.js  (NEW, process-wide singleton — peer of call-bridge.js, shared across all calls)

Dashboard webhook endpoint (NEW, backend-only in this spec):
  POST /api/webhooks/elevenlabs/conversation-ended
  - HMAC + timestamp verify (5-minute skew window)
  - Persist transcript/analysis/tool-log immediately, return 200
  - Enqueue audio-archive-jobs for the recording download
  - Idempotent via webhook_processed_at column
```

### Single-purpose units

| Unit | Purpose | Depends on |
|---|---|---|
| `elevenlabs-session.js` | One EL conversation WebSocket per call | `ws`, audio in/out, tool callback |
| `elevenlabs-tools-adapter.js` | Convert `tools.js` JSON schemas → EL client-tool format | `tools.js` (read-only) |
| `agent-sync-processor.js` | Reconcile a campaign row → an EL agent, race-safely | EL REST API, Supabase, sync_version CAS |
| `audio-archive-processor.js` | Download EL recording → Supabase Storage | EL signed URL, Supabase service client |
| `live-turn-writer.js` | Process-wide singleton; cross-call batched inserts to `call_turns` | shared `postgres-js` pool |
| `janitor.js` | Periodic sweep of stuck `calls` rows past TTL; finalize and emit metric | Supabase, EL session registry |
| `call-bridge.js` (rewritten) | Wire Asterisk media ↔ EL session ↔ live writer ↔ tools | All of the above |
| Webhook handler (dashboard) | Persist post-call analysis, enqueue audio archive, idempotent | Supabase, EL signature secret, BullMQ |

### Files deleted
- `voiceagent-saas/gemini-session.js`
- `voiceagent-saas/audio-utils.js` (no resampling needed)
- Gemini-specific paths in `voiceagent-saas/tools.js` (the schema export, not the implementations)
- `GEMINI_API_KEY` removed from droplet `.env` **after the 72-hour rollback window** (see §6.3)

## 3. Data Model Changes

This spec owns the **entire** migration. Spec B does not add columns.

### New columns on `campaigns`

| Column | Type | Notes |
|---|---|---|
| `elevenlabs_agent_id` | text, nullable | Set by agent-sync-processor after successful create |
| `external_ref` | uuid, default `gen_random_uuid()` | Write-ahead idempotency token sent on create so retries don't double-create |
| `agent_status` | enum `agent_status_t` (`pending`, `provisioning`, `ready`, `failed`) | Drives UI button state and Spec B status pill |
| `agent_sync_error` | text, nullable | Last error message when status=failed |
| `agent_synced_at` | timestamptz, nullable | Last successful sync (used to detect stale agents on prompt edit) |
| `sync_version` | bigint, default 0, not null | Bumped on every campaign edit; CAS guard for processor writes |
| `voice_id` | text, not null | EL voice ID; default sourced from `platform_settings` (see below) |
| `tts_model` | text, not null | Default sourced from `platform_settings` |
| `el_etag` | text, nullable | EL agent object ETag for optimistic concurrency on PATCH |

### New columns on `tenants`

| Column | Type | Notes |
|---|---|---|
| `llm_provider` | enum `llm_provider_t` (`bundled`, `gpt-4o`, `claude-sonnet-4.5`), default `bundled` | Tenant-level so rotation is one row, not N |
| `llm_api_key_encrypted` | bytea, nullable | Only set when `llm_provider != 'bundled'`. Encrypted via existing `packages/database` helper — see §3.1 verification gate |
| `llm_api_key_last4` | text, nullable | For UI display in Spec B |
| `llm_api_key_validated_at` | timestamptz, nullable | Set after validation roundtrip succeeds |

> **Why tenant-level not campaign-level:** the original spec put this on `campaigns` and the architect flagged it as duplication + rotation pain. Tenant-level is correct.

### New columns on `calls`

| Column | Type | Notes |
|---|---|---|
| `elevenlabs_conversation_id` | text, nullable, **unique** | EL conversation ID; idempotency anchor |
| `transcript_full` | jsonb, nullable | Canonical post-call transcript from EL webhook |
| `summary` | text, nullable | EL conversation summary |
| `sentiment` | text, nullable | EL sentiment classification |
| `success_evaluation` | jsonb, nullable | EL success/failure analysis |
| `audio_storage_path` | text, nullable | Set by `audio-archive-processor` after upload |
| `audio_archive_status` | enum `audio_archive_status_t` (`pending`, `archived`, `failed`) | Decoupled from webhook receipt |
| `failure_reason` | enum `call_failure_reason_t` (see §5.1), nullable | Replaces text+check |
| `retry_count` | int, default 0 | Increment per retry; max 3/day enforced via `last_retry_day` |
| `last_retry_day` | date, nullable | DST-correct: `(now() at time zone 'Asia/Jerusalem')::date` at write time |
| `webhook_processed_at` | timestamptz, nullable | Idempotency key for webhook handler; UPDATE...WHERE webhook_processed_at IS NULL |
| `started_at` | timestamptz, nullable | Migration MUST `ADD COLUMN IF NOT EXISTS started_at timestamptz` (deterministic; no schema-inspection conditional) |
| `ended_at` | timestamptz, nullable | Migration MUST `ADD COLUMN IF NOT EXISTS ended_at timestamptz` (deterministic; no schema-inspection conditional) |
| `agent_id_used` | text, nullable | Snapshot of `campaigns.elevenlabs_agent_id` at call enqueue time (TOCTOU guard) |
| `sync_version_used` | bigint, nullable | Snapshot of `campaigns.sync_version` at call enqueue time |

### New columns on `campaign_contacts`

| Column | Type | Notes |
|---|---|---|
| `last_retry_day` | date, nullable | DST-correct daily reset key |
| `daily_retry_count` | int, default 0 | Reset to 0 when `last_retry_day` rolls over |

### New table `call_turns`

```sql
create table call_turns (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid not null references calls(id) on delete cascade,
  tenant_id   uuid not null references tenants(id),  -- denormalized for RLS; ON DELETE CASCADE only on call_id FK
  turn_index  bigint not null,
  role        text not null check (role in ('user', 'agent')),
  text        text not null,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  created_at  timestamptz not null default now(),
  unique (call_id, turn_index)
);

create index call_turns_call_id_turn_idx on call_turns (call_id, turn_index);
create index call_turns_tenant_id_idx on call_turns (tenant_id);
alter table call_turns enable row level security;
-- policy mirrors existing tenant-scoped patterns
```

`turn_index` is assigned by `live-turn-writer.js` from a monotonic in-memory counter per call (NOT derived from EL event timestamp), so flush-on-final racing flush-on-timer cannot reorder rows.

### New table `call_tool_invocations`

```sql
create table call_tool_invocations (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid not null references calls(id) on delete cascade,
  tenant_id   uuid not null references tenants(id),
  name        text not null,
  args        jsonb not null,
  result      jsonb,
  error       text,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  latency_ms  int generated always as (
                extract(epoch from (ended_at - started_at)) * 1000
              ) stored,
  unique (call_id, name, started_at)
);
-- generated latency_ms is safe: webhook handler (canonical writer, see §4.6) supplies both timestamps from the EL payload in the same insert.

create index on call_tool_invocations (tenant_id, name, started_at desc);
create index on call_tool_invocations (call_id);
alter table call_tool_invocations enable row level security;
```

> **Why a table, not jsonb:** the §5.3 metrics (per-tool p95 latency, invocation counts) need queryability. Backend reviewer flagged jsonb-only as a blocker for that.

### New table `webhook_events`

```sql
create table webhook_events (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,                  -- 'elevenlabs'
  event_type    text not null,                  -- 'conversation.ended'
  external_id   text,                           -- el conversation_id
  raw_body      jsonb not null,
  signature     text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  processing_error text,
  check (octet_length(raw_body::text) <= 262144)  -- belt-and-suspenders cap; primary 256 KB rejection happens at the route, see §4.6 step 0
);
create index on webhook_events (source, external_id);
create index on webhook_events (received_at desc) where processed_at is null;
-- Cheap "have we processed this EL conversation already?" lookup. Purely additive; does not interact with insert-before-verify logic.
create unique index on webhook_events (source, external_id) where external_id is not null;
```

Logs every EL webhook hit raw, before any processing. Lifesaver when EL changes payload shapes. Retention: 30 days (cleaned by janitor).

### New table `platform_settings`

```sql
create table platform_settings (
  key   text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into platform_settings (key, value) values
  ('default_voice_id',  '"<VETTED_HEBREW_VOICE_ID>"'::jsonb),
  ('default_tts_model', '"eleven_turbo_v2_5"'::jsonb);
```

Defaults for `campaigns.voice_id` and `campaigns.tts_model` are sourced from this table at row insert time via a `BEFORE INSERT` trigger on `campaigns` that fills `voice_id` and `tts_model` from `platform_settings` if NULL. App-layer fetch is rejected because it can be bypassed by future code paths. Swappable without code deploy.

### New Postgres enum types

```sql
create type agent_status_t          as enum ('pending', 'provisioning', 'ready', 'failed');
create type llm_provider_t          as enum ('bundled', 'gpt-4o', 'claude-sonnet-4.5');
create type audio_archive_status_t  as enum ('pending', 'archived', 'failed');
create type call_failure_reason_t   as enum (
  'voicenter_busy', 'el_ws_connect_failed', 'el_ws_dropped',
  'agent_not_ready', 'agent_version_mismatch',
  'no_answer', 'network_error', 'dnc_listed',
  'invalid_number', 'compliance_block', 'abandoned_by_callee', 'janitor_finalized',
  'webhook_timeout', 'el_quota_exceeded'
);
```

### New Supabase Storage bucket
- **Name:** `call-recordings`
- **Path pattern:** `{tenant_id}/{call_id}.mp3` (deterministic, overwrite-safe)
- **Access:** private; signed URLs generated by dashboard (Spec B) on demand
- **Bucket-level limits:** max file size 50 MB, allowed mime types `audio/mpeg, audio/mp4`
- **Lifecycle (deferred to follow-up spec):** delete after 90 days

### New BullMQ queues

| Queue | Concurrency | Retries | Notes |
|---|---|---|---|
| `agent-sync-jobs` | 5 | 3, exp backoff | `jobId = "agent-sync:${campaignId}"` for dedup; `delay: 2000ms` debounce |
| `audio-archive-jobs` | 10 | 5, exp backoff | `jobId = "audio:${callId}"`; long-running OK |

### Migration ordering

Single SQL migration: `supabase/migrations/2026-04-07_elevenlabs_runtime_swap.sql`. New columns are nullable / safe-defaulted. Enums and tables created idempotently with `if not exists` where supported.

#### 3.2 Migration ordering inside the SQL file

`campaigns.voice_id` and `campaigns.tts_model` are declared `not null`, but a `BEFORE INSERT` trigger does NOT fire on `ALTER TABLE`, so existing rows would violate `NOT NULL` if added directly. The SQL file MUST, in a single transaction:

1. `ADD COLUMN voice_id text` (nullable) and `ADD COLUMN tts_model text` (nullable).
2. Backfill both columns on existing rows from `platform_settings` (`default_voice_id`, `default_tts_model`).
3. `ALTER COLUMN ... SET NOT NULL` on both columns.
4. Create the `BEFORE INSERT` trigger so subsequent inserts auto-fill.

### 3.1 Encryption verification gate (BLOCKING — must pass before code starts)

The original spec assumed `packages/database` already has a real encryption helper for `llm_api_key_encrypted`. Backend reviewer flagged this. Before implementation, **verify** (placeholder path: `packages/database/src/encryption.ts` — verify this file exists and is real, replace with actual path if different):
- The existing helper uses pgsodium / Supabase Vault / KMS envelope encryption — NOT app-layer AES with a static env secret.
- If it does not exist or is insufficient, the implementation plan must include building it (likely pgsodium-based) as a prerequisite step, blocking everything else.
- **Owner of verification:** backend lead (see §6.2 Step 0 acceptance criteria).

## 4. Component Design

### 4.1 `elevenlabs-session.js` (replaces `gemini-session.js`)

**Purpose:** Own one ElevenLabs Conversational AI WebSocket per active call. Translate Asterisk PCM frames ↔ EL WS protocol. Surface tool calls via an event channel (no private-method-from-outside).

**Public interface:**
```js
class ElevenLabsSession extends EventEmitter {
  constructor({ agentId, conversationConfig, logger })
  async connect()
  sendAudio(pcm16kBuffer)
  // Tool result is returned via the tool_call event's reply channel:
  //   session.on('tool_call', ({ name, args, callId, reply }) => {
  //     reply({ result: ..., error: ... })
  //   })
  async close(reason)
}
```

**Events emitted:**
- `agent_audio` (Buffer pcm16k)
- `user_transcript` ({ text, isFinal, ts })
- `agent_response` ({ text, isFinal, ts })
- `tool_call` ({ name, args, callId, reply: fn })
- `conversation_id` (string)
- `error` (Error)
- `closed` ({ reason })

**WS protocol:**
- Endpoint: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agentId}`
- Auth: `xi-api-key` header
- First message: `conversation_initiation_client_data` with dynamic vars + optional prompt overrides
- Audio in/out: PCM 16k base64
- Heartbeat: ping/pong every 20s
- No reconnect — fail-fast per design
- **Max-call-duration kill switch:** hard 10-minute timer per session. On expiry, close the WS, finalize the `calls` row with `failure_reason='janitor_finalized'` (or a dedicated reason if added later), and emit a metric. Defense-in-depth ahead of janitor's 15-minute sweep.

### 4.2 `agent-sync-processor.js` (NEW, race-safe)

**Purpose:** Reconcile a `campaigns` row to an EL agent without race conditions.

**Origin:** Agent-sync REST API calls originate from the **droplet worker, never the dashboard.** The droplet holds `ELEVENLABS_API_KEY`; the dashboard does not need it.

**Race-safety mechanism (CAS via `sync_version`):**
1. Job pickup. Read `(sync_version, agent_status, external_ref, el_etag, prompt, voice_id, ...)` from `campaigns`.
2. Set `agent_status='provisioning'` only if it isn't already.
3. Action dispatch:
   - `create`: POST `/v1/convai/agents/create` with `external_ref` as the EL idempotency header. Store returned `agent_id`, `el_etag`.
   - `update`: PATCH `/v1/convai/agents/{id}` with `If-Match: el_etag`. On 412 (etag mismatch), refetch and retry once.
   - `delete`: DELETE `/v1/convai/agents/{id}`. Null out `elevenlabs_agent_id`.
4. **CAS write back:** `UPDATE campaigns SET agent_status='ready', el_etag=$1, agent_synced_at=now() WHERE id=$2 AND sync_version=$3`. If 0 rows affected → a newer edit happened during the API call; do not overwrite, log "stale sync, newer job will reconcile" and exit clean.
5. The newer job (already enqueued via the same `jobId`, BullMQ collapses) will run with the latest `sync_version`.

**Dedup:** `jobId = "agent-sync:${campaignId}"` + `delay: 2000ms` debounces rapid edits. BullMQ collapses duplicate jobIds within the delay window.

**Drift reconciliation (deferred to follow-up spec):** nightly job that lists EL agents, compares against `campaigns.elevenlabs_agent_id`, flags drift in `agent_sync_error`. Spec A only mentions it; not built.

### 4.3 `live-turn-writer.js` (NEW, shared singleton)

**Purpose:** Cross-call batched inserts to `call_turns` from a single shared `postgres-js` pool, not per-call PostgREST. **`call_tool_invocations` is NOT written here** — it is written ONLY by the webhook handler (canonical, see §4.6 step 6). The live writer's sole table is `call_turns`.

**Behavior:**
- One module-level singleton, initialized at process boot
- One shared `postgres-js` connection pool (size 10) against Supabase Postgres direct connection — NOT PostgREST
- In-memory queue keyed by `call_id` with `{ turns: [], lastFlushAt }` (no tools — see purpose above)
- Flush trigger: 500 ms timer (was 200 ms — backend reviewer adjusted) OR ≥20 turns buffered for any call OR `final` flag OR `flushAndClose(callId)` from call-bridge
- **Cross-call batching:** every 500 ms tick, flush ALL pending calls' turns in a single multi-row insert
- **Monotonic turn_index:** assigned by the writer from an in-memory counter per call_id at the moment a turn is enqueued, NEVER from EL event ordering. Guarantees no reorder.
- On flush failure: log + retry once. Never blocks the call. Webhook is canonical.

**Why 500 ms not 200 ms:** at 100 concurrent calls, 200 ms flushes = 500 writes/sec sustained, burns Supabase connection slots. 500 ms cross-call batched halves the rate and Realtime propagation is ~100–300 ms anyway, invisible to users.

#### 4.3.1 postgres-js connection pool sizing

- **Pool size:** 10 per droplet.
- **Target:** Supavisor in **transaction mode** (NOT session mode) — required so the small pool can multiplex across many concurrent flushes.
- **Connection string env var:** `SUPABASE_DIRECT_DB_URL` (separate from the PostgREST/anon URL used by the dashboard).
- **Pool exhausted behavior:** flush stalls but never blocks the call audio path — the in-memory buffer queue absorbs the delay, and the webhook is the canonical source for transcripts anyway.
- **Max queue depth:** if any call's buffered turns exceed 500 entries, drop new turns to a disk-log fallback (`/var/log/voiceagent-saas/turn-fallback.jsonl`) and log a `queue_overflow` warning. Webhook reconciliation will fill the gap.

### 4.4 `call-bridge.js` (rewritten, slimmer, TOCTOU-safe)

**Purpose:** Wire Asterisk media stream ↔ EL session ↔ live writer ↔ tool dispatcher.

**Lifecycle per call:**
1. Receive `StasisStart` from ARI.
2. Read `agent_id_used` and `sync_version_used` from the **call job payload** (snapshotted at enqueue time, NOT looked up now). **No TOCTOU.** Before step 4, `call-processor` refreshes the snapshot from `campaigns` one final time **at dequeue** (not enqueue) to shrink the deploy-race window.
3. Refetch `campaigns` row; assert `elevenlabs_agent_id == agent_id_used && sync_version == sync_version_used && agent_status='ready'`. If mismatched, hang up with `failure_reason='agent_version_mismatch'`. No retry (the new version will be tried on next scheduled call).
4. Open ExternalMedia channel (slin16, 16 kHz).
5. Construct `ElevenLabsSession` with `agentId`, dynamic vars (contact_name, business_name, custom fields).
6. `session.connect()`.
7. On `conversation_id` → write to `calls.elevenlabs_conversation_id`.
8. RTP frames ↔ `session.sendAudio()` / `agent_audio`.
9. Transcript events → `live-turn-writer.enqueue(callId, ...)`.
10. Tool events → execute via `tools.js`, write to `call_tool_invocations`, call `reply({ result })` on the event channel.
11. On `error` / `closed` → finalize `calls` row (`ended_at`, `failure_reason` if any), call `liveTurnWriter.flushAndClose(callId)`, exit clean.

**Crash protection:** the `StasisEnd` ARI handler is wired to ALWAYS finalize the `calls` row and call `flushAndClose`, even if the EL session never opened. Janitor (§4.7) is the second line of defense.

### 4.5 `elevenlabs-tools-adapter.js` (NEW)

**Purpose:** Keep `tools.js` provider-clean. The architect flagged that putting `toElevenLabsSchema()` inside `tools.js` couples implementations to a vendor.

**Interface:**
```js
const { toolDefinitions } = require('./tools')
function buildElevenLabsClientTools()  // returns EL-shaped client tool array
module.exports = { buildElevenLabsClientTools }
```

`tools.js` stays vendor-agnostic — it exports raw definitions and `executeTool(name, args, ctx)`. Adapter is the only file that knows EL's schema shape.

### 4.6 Webhook handler (dashboard, NEW)

**Route:** `apps/dashboard/app/api/webhooks/elevenlabs/conversation-ended/route.ts`

**Handler steps:**
0. **Pre-checks (no DB writes).** Reject `Content-Length > 256 KB` with HTTP 413. Require the EL timestamp header to be present; reject HTTP 400 if missing. These run before step 1 to keep the DoS surface small.
1. Read raw body. **First**, insert into `webhook_events` (raw payload, signature, headers). This happens before any verification so we have a forensic record even of forged attempts. (The `webhook_events.raw_body` size constraint in §3 is a belt-and-suspenders cap.)
2. Verify HMAC-SHA256 with `ELEVENLABS_WEBHOOK_SECRET`. **Verify timestamp header within 5-minute skew**. On failure → `processing_error='invalid_signature'`, return 401.
3. Parse `conversation_id`, `transcript`, `analysis`, `audio_url`, `duration_seconds`, `tool_calls`.
4. Look up `calls` row by `elevenlabs_conversation_id`. If missing → `processing_error='no_matching_call'`, return 200 (idempotent no-op, no EL retry storm).
5. **Atomic update** via single statement:
    ```sql
    UPDATE calls SET
      transcript_full = $1, summary = $2, sentiment = $3,
      success_evaluation = $4, ended_at = coalesce(ended_at, $5),
      webhook_processed_at = now(),
      audio_archive_status = 'pending'
    WHERE elevenlabs_conversation_id = $6
      AND webhook_processed_at IS NULL
    ```
   - If 0 rows affected → already processed, return 200.
   - If 1 row affected → continue.
6. **Insert tool invocations** into `call_tool_invocations`. The webhook handler is the **canonical and only writer** for this table (live-turn-writer does not touch it — see §4.3). Idempotency is enforced by the `UNIQUE (call_id, name, started_at)` constraint declared in §3 via `INSERT ... ON CONFLICT DO NOTHING`.
7. **Enqueue audio archive job**: `audio-archive-jobs.add({ callId, signedUrl: audio_url }, { jobId: "audio:${callId}" })`. Audio download happens async — webhook stays fast.
8. Update `webhook_events.processed_at = now()`.
9. Return 200.

**Why this fixes the BLOCKERs from review:**
- Idempotency key is `webhook_processed_at IS NULL`, not `audio_storage_path IS NULL`. Decouples webhook receipt from audio archive entirely.
- Audio download is in a separate job, not in the webhook critical path. No 10-second timeout risk.
- Raw payload logged even on signature failure → debugging + replay.
- Timestamp skew check prevents replay attacks.

### 4.7 `audio-archive-processor.js` (NEW)

**Purpose:** Download EL recording → upload to Supabase Storage → update `calls.audio_storage_path` and `audio_archive_status`.

**Behavior:**
- Job payload: `{ callId, signedUrl }`
- Download with 60s timeout, 50 MB max, streaming to temp file
- Upload to `call-recordings/{tenant_id}/{call_id}.mp3` (deterministic, overwrite-safe)
- `UPDATE calls SET audio_storage_path=$1, audio_archive_status='archived' WHERE id=$2`
- On final failure (5 retries): `audio_archive_status='failed'`. Transcript still preserved. Surfaced in Spec B's failed-calls view.

### 4.8 `janitor.js` (NEW)

**Purpose:** Sweep stuck `calls` rows where the worker crashed mid-call.

**Behavior:**
- Periodic timer (every 60s)
- Find `calls` where `started_at < now() - interval '15 minutes' AND ended_at IS NULL`. The SELECT MUST use `FOR UPDATE SKIP LOCKED` to be safe under janitor scale-out (multiple droplets / multiple janitor instances).
- For each: set `ended_at=now()`, `failure_reason='janitor_finalized'`, emit `call_metric` row, log warning
- **Orphaned audio-archive sweep:** also find `calls` where `audio_archive_status='pending' AND webhook_processed_at < now() - interval '10 minutes'` (also `FOR UPDATE SKIP LOCKED`) and re-enqueue the `audio-archive-jobs` job. This recovers from the case where the webhook handler committed the row but the BullMQ enqueue failed (Redis blip between commit and enqueue).
- Also cleans `webhook_events` older than 30 days

## 5. Error Handling, Retries & Observability

### 5.1 Failure modes & responses

| Failure | Where | `failure_reason` enum | Retry? |
|---|---|---|---|
| EL agent create fails (4xx) | agent-sync-processor | n/a (campaign-level) | 3× exp backoff → `agent_status='failed'` |
| EL agent create fails (5xx/network) | agent-sync-processor | n/a | Same |
| Call attempted with `agent_status != 'ready'` | call-processor | `agent_not_ready` | Yes (timing — sync will resolve; auto-delay) |
| live-turn-writer postgres pool exhausted | live-turn-writer | n/a | Log + queue depth metric; turn drops to disk-log fallback; never blocks call |
| Call payload `sync_version` doesn't match current | call-bridge | `agent_version_mismatch` | No (stale snapshot) |
| EL WS fails to open at call start | call-bridge | `el_ws_connect_failed` | Yes, daily cap |
| EL WS drops mid-call | call-bridge | `el_ws_dropped` | No |
| Tool execution throws | tool dispatcher | n/a (per-tool) | `error` field returned via reply channel; conversation continues |
| Live turn write fails | live-turn-writer | n/a | Log + retry once; never blocks call |
| Webhook arrives but `calls` row missing | webhook | n/a | 200 no-op |
| Webhook signature/timestamp invalid | webhook | n/a | 401 + log |
| Audio download from EL fails | audio-archive-processor | n/a | 5 retries → `audio_archive_status='failed'` |
| Asterisk channel hangs up before EL responds | call-bridge | `abandoned_by_callee` | No |
| Voicenter SIP busy/unreachable | ARI originate | `voicenter_busy` | Yes, daily cap |
| Worker crashes mid-call | janitor | `janitor_finalized` | No (call already happened or didn't) |

### 5.2 Retry policy (DST-correct)

Enforced in `call-processor.js`, per `campaign_contacts` row:
- Max **3 retries / contact / calendar day**, where "day" = `(now() at time zone 'Asia/Jerusalem')::date`
- On every retry attempt:
  ```sql
  UPDATE campaign_contacts
  SET daily_retry_count = CASE
        WHEN last_retry_day = (now() at time zone 'Asia/Jerusalem')::date
          THEN daily_retry_count + 1
        ELSE 1
      END,
      last_retry_day = (now() at time zone 'Asia/Jerusalem')::date
  WHERE id = $1
  RETURNING daily_retry_count
  ```
- If returned `daily_retry_count > 3` → `status='needs_attention'`, do not enqueue
- Backoff: 15 min → 1 h → 4 h
- Retryable failure reasons: `voicenter_busy`, `el_ws_connect_failed`, `no_answer`, `network_error`, `agent_not_ready` (timing issue, auto-delay until sync completes)
- Non-retryable (manual only): `dnc_listed`, `invalid_number`, `compliance_block`
- **Special case — `agent_version_mismatch`:** auto-retried but does **NOT** count toward the daily cap. It's a deploy-race, not a real failure. `call-processor` must skip the `daily_retry_count` increment for this reason.

**Writer ownership for `campaign_contacts.daily_retry_count` and `last_retry_day`:**
- **Only `call-processor.js` writes** these columns, at enqueue time.
- `call-bridge.js` is **read-only** on these columns.
- This avoids dual-writer races.

> **Why this fixes DST:** day boundaries are computed in Israel local time at write time, stored as a `date`, and compared as `date`. Spring-forward 23h day and fall-back 25h day both work correctly because we never compare timestamps, only dates.

### 5.3 Observability

**Structured logs (existing pino, extended):**
- Each call gets a `call_id` log context threading through all components
- New fields: `el_conversation_id`, `el_agent_id`, `el_ws_state`, `tts_first_byte_ms`, `tool_call_count`, `sync_version_used`
- Errors include `failure_reason` for greppability

**Metrics — `call_metrics` table:**
```sql
create table call_metrics (
  call_id     uuid primary key references calls(id) on delete cascade,
  tenant_id   uuid not null,
  tts_first_byte_ms      int,
  el_ws_open_ms          int,
  call_duration_seconds  int,
  transcript_turn_count  int,
  tool_call_count        int,
  created_at  timestamptz not null default now()
);
create index on call_metrics (tenant_id, created_at desc);
```

`call_metrics.call_id` is `PRIMARY KEY`: written **once at call finalization in `call-bridge.js`'s StasisEnd handler. Not upserted.**

Per-tool latency p95 derived from `call_tool_invocations.latency_ms` GROUP BY `name`. No need for a separate metric table.

**Retention:** `call_metrics` and `webhook_events` cleaned by janitor (90 days for metrics, 30 for webhook_events). Documented even though enforcement is later.

**Failed calls visibility:** existing `tab-failed.tsx` (already in `apps/dashboard/src/components/campaign-detail/`) is wired to read `campaign_contacts.status='needs_attention'`. Spec B will polish it; this spec just makes sure the data flows correctly.

## 6. Testing & Rollout

### 6.1 Testing strategy (backend only — frontend tests are Spec B)

**Unit tests (`apps/voice-engine/` test suite):**
- `elevenlabs-tools-adapter.js`: produces valid EL client-tool format for every tool in `tools.js`
- `live-turn-writer.js`: monotonic turn_index never reorders; cross-call batching; flush triggers; failure recovery
- `agent-sync-processor.js`: CAS write back is no-op when `sync_version` is stale; ETag mismatch retry; `external_ref` sent on create
- Webhook signature + timestamp verification: valid sig + fresh timestamp passes; valid sig + stale timestamp fails; tampered body fails
- Retry policy: DST boundary case (simulate clock at 02:00 on spring-forward day), `last_retry_day` rollover resets `daily_retry_count`
- `call-bridge.js`: `agent_version_mismatch` rejection when call payload sync_version doesn't match DB
- Webhook idempotency: replayed webhook → 200, no double-write
- `audio-archive-processor.js`: timeout, oversize, success path

**Integration tests:**
- `elevenlabs-session.js` against EL sandbox (or recorded WS mock): full lifecycle including tool_call reply channel
- Webhook endpoint with signed payload fixture → all `calls` columns populated, `webhook_events` row written, `audio-archive-jobs` enqueued, raw body logged
- `audio-archive-processor.js` with a real EL signed URL fixture → file in test bucket
- Agent-sync race: enqueue 10 jobs for same campaign in 100ms → exactly one PATCH lands, final state is correct, no orphaned EL agents

**Manual end-to-end test plan (Hebrew, real phone — the only thing that matters):**
1. Create a fresh campaign in dashboard. (Spec A: campaign uses default voice from `platform_settings`.)
2. Verify `agent_status` transitions: pending → provisioning → ready (within ~5s).
3. Add own phone as contact, trigger Quick Call.
4. 30-second Hebrew conversation that triggers at least one tool ("אני מעוניין, תקבע לי פגישה").
5. Hang up.
6. Within ~10s: `calls.transcript_full`, `summary`, `sentiment`, `webhook_processed_at` all populated. `audio_archive_status='pending'` then `'archived'` shortly after.
7. `call-recordings/{tenant_id}/{call_id}.mp3` exists in Storage.
8. `call_tool_invocations` has the tool row with non-null `latency_ms`.
9. `call_turns` has rows with monotonic `turn_index`.
10. Edit campaign prompt → `sync_version` increments → agent-sync update fires → `agent_synced_at` updates → no duplicate EL agents created.
11. Force EL down (garbage `ELEVENLABS_API_KEY`) → call → `failure_reason='el_ws_connect_failed'` → retries fire with backoff → after 3 fails contact moves to `needs_attention`.
12. Crash worker mid-call (`kill -9` the Node process during a live call) → restart → janitor finalizes the stuck row within 60s with `failure_reason='janitor_finalized'`.
13. Replay a captured EL webhook payload → second hit returns 200 without re-writing.

### 6.2 Rollout sequence

**Step 0 — Encryption verification (BLOCKING gate, see §3.1)**
- Confirm `packages/database` encryption helper is real before any other work.

**Step 1 — Database migration**
- Apply `2026-04-07_elevenlabs_runtime_swap.sql` via Supabase MCP
- All new columns nullable / safe-defaulted
- `platform_settings` seeded with vetted Hebrew voice + `eleven_turbo_v2_5`
- Create `call-recordings` Storage bucket with file size + mime restrictions

**Step 2 — Backfill existing campaigns**
- One-time script: set `voice_id` and `tts_model` from `platform_settings`, `agent_status='pending'`, `sync_version=0`. (`external_ref` is omitted from the script — the column has `default gen_random_uuid()` and will populate automatically.)
- Do NOT auto-create EL agents — wait for user save (which fires sync), or admin "Provision Agents" button (built in Spec B)

**Step 3 — Pre-cutover safety net**
- `git tag pre-elevenlabs` on the last Gemini commit
- Snapshot the DO droplet (DO snapshot UI)
- Keep `GEMINI_API_KEY` in droplet `.env` and Railway env vars for **72 hours after cutover**
- Rehearse the rollback once on a staging copy: `git revert <merge>`, redeploy droplet, place a Hebrew test call. **Sign off in writing before proceeding.**

**Step 4 — Deploy dashboard (Railway)**
- Webhook endpoint live (no UI changes — that's Spec B)
- Call enqueue path snapshots `agent_id_used` + `sync_version_used` into the job payload
- New env vars: `ELEVENLABS_WEBHOOK_SECRET` only. The dashboard does NOT need `ELEVENLABS_API_KEY` — agent-sync REST originates on the droplet (see §4.2).

**Step 5 — Configure EL webhook**
- In ElevenLabs dashboard, set conversation-ended webhook URL → dashboard endpoint (now live from Step 4)
- Copy webhook secret into Railway env vars
- Send a test webhook from EL dashboard → verify `webhook_events` row
- **Webhook MUST be configured before the droplet cutover** so the first real EL call has a destination for its post-call payload.

**Step 6 — Deploy voice engine (droplet)**
- New `elevenlabs-session.js`, `elevenlabs-tools-adapter.js`, `agent-sync-processor.js`, `audio-archive-processor.js`, `live-turn-writer.js`, `janitor.js`
- Rewritten `call-bridge.js`
- `gemini-session.js` and `audio-utils.js` deleted in this commit
- New env vars on droplet: `ELEVENLABS_API_KEY`, `ELEVENLABS_WORKSPACE_ID` (if EL requires), `SUPABASE_DIRECT_DB_URL` for the postgres-js pool (see §4.3.1)

**Step 7 — Smoke test on a single test campaign**
- Run the manual test plan above before any real customer call
- Sign off in writing

**Step 8 — Cutover**
- Real customer calls flow through ElevenLabs

**Step 9 — 72-hour watch + Gemini deprecation**
- Watch metrics: `tts_first_byte_ms` p95, `el_ws_open_ms` p95, webhook success rate, `audio_archive_status='failed'` rate
- After 72 hours stable: remove `GEMINI_API_KEY` from droplet + Railway, document deprecation in commit message

### 6.3 Rollback plan (rehearsed)

If anything blows up in the first 72 hours:
1. **Code rollback:** `git revert` the merge commit + redeploy both services. The pre-cutover rehearsal in Step 3 is what makes this viable.
2. **Droplet:** if redeploy is broken, restore the DO snapshot from Step 3.
3. **Database:** the migration is non-destructive (all new columns nullable, no drops). Schema additions stay even after rollback — they're harmless.
4. **EL agents:** can stay; they're free to hold. Optional cleanup later via the EL dashboard.
5. **Storage:** `call-recordings` bucket can stay; future recordings just won't land there.

After 72h stable: write the post-mortem (or non-mortem), remove Gemini env vars, commit the deletion of any leftover compatibility code.

### 6.4 Out of scope (explicit follow-up specs)

- **Spec B** — dashboard UI v1 (voice picker, LLM dropdown, agent status pill, live transcript page, post-call view upgrade with audio player, polished failed-calls tab, frontend test strategy)
- Nightly drift reconcile job for EL agent objects
- Grafana dashboards / PagerDuty alerts
- 90-day audio retention enforcement
- Multi-language / English agents
- Voice cloning per tenant
- A/B testing infrastructure
- RLS re-enable hardening pass
- LLM API key rotation UI/automation

## 7. Open Questions

None at time of writing. All design decisions confirmed in brainstorming + reviewer feedback addressed.
