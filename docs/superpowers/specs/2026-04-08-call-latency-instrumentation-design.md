# Call Latency Instrumentation — Design Spec

**Date:** 2026-04-08
**Status:** Approved (revised post-review), ready for implementation plan
**Author:** Claude + Tom
**Related:** [2026-04-08 EL session lifecycle fix](./2026-04-08-el-session-lifecycle-fix-design.md)
**Reviewers:** Software Architect, Backend Architect (2026-04-08)

## 1. Problem

After shipping the EL session lifecycle fix (2026-04-08), live calls work end-to-end but perceived latency is too high. Before tuning anything, we need to measure **where** the latency is actually coming from: EL server-side processing, our audio plumbing, or network.

Today, `call-bridge.js` tracks `ttsFirstByteMs` (from WS-open, not from pickup) and `elWsOpenMs`. Neither answers the two questions users actually care about:

1. From the moment I answered, how long until Dani started speaking?
2. From the moment I stopped speaking, how long until Dani responded?

And neither tells us whether the delay lives in EL's servers or in our own audio plumbing.

`call_metrics` has no per-turn latency data, and `elevenlabs-session.js` has no turn-latency instrumentation at all.

## 2. Goal

Add diagnostic and persistent latency instrumentation to CallBridge so that a single test call gives us enough data to decide what to tune next, AND so we can track latency regressions over time on every production call. The metrics must let us attribute latency to EL vs. our code.

Non-goals: tuning the latency itself (separate work after this lands), building dashboards, per-turn persistence to a new dedicated table.

## 3. Metrics

Four latencies are defined, three aggregate metrics persisted per call, plus the raw per-turn sample array.

### 3.1 `greeting_latency_ms`
Time from the customer answering the phone to the first outbound agent audio chunk.

- **Start:** `handleCustomerAnswered()` invocation on CallBridge (our clock, driven by ARI `ChannelStateChange → Up` on the customer channel). Chosen over "first inbound caller audio" because the user's subjective experience starts at pickup regardless of whether they speak first.
- **End:** first `agent_audio` event emitted by `ElevenLabsSession` after `customerAnsweredAt` is set.
- **Nullable:** stays `null` if customer never answered or call ended before greeting.
- **Covers pre-warming race:** `handleCustomerAnswered()` stamps `customerAnsweredAt` unconditionally at method entry, so the value is correct even when the customer answered during `pre_warming` and the pickup was queued via `_pendingCustomerAnswered` (see `call-bridge.js:462`).

### 3.2 `avg_turn_latency_ms`, `p95_turn_latency_ms`
Aggregated per-turn response latency across the call.

- **Per-turn start:** `user_transcript` event with `isFinal: true`. EL's server-side VAD has finalized the user turn — this isolates EL processing time (finalization → response generation → TTS first byte) from network and VAD debounce. Chosen over "last inbound audio chunk" because (a) the signal is cleaner, (b) we already have it without heuristics, (c) if this number is low but users still perceive lag, we know to investigate VAD/network on top.
- **Per-turn end:** next `agent_audio` event.
- **Aggregation:** mean and 95th percentile over `turnLatenciesMs[]` at finalize time.
- **Nullable:** both stay `null` if the array is empty.

### 3.3 `audio_plumbing_ms`
Time inside our own code between receiving an `agent_audio` event from EL and writing the first slin16 frame to the Asterisk media WebSocket.

- **Start:** entry of the `agent_audio` handler in `call-bridge.js` (before `sendToAsterisk` runs).
- **End:** return from the `sendToAsterisk(...)` call for that chunk.
- **Sample scope:** measured on the **first chunk of each turn** only (i.e., when `pendingUserFinalAt` was non-null just before — indicating this is the leading edge of an agent response). Not measured on every chunk. Also measured on the greeting's first chunk (first agent_audio after `customerAnsweredAt`).
- **Aggregation:** `audio_plumbing_ms` persisted as the **average** over those first-chunk samples. Nullable if no samples.
- **Rationale:** this is the one delay fully inside our control. Without it, we cannot tell "EL is slow" from "our downsample/ring buffer is slow." If this number is consistently <5ms, we know the problem is upstream.

### 3.4 `turn_latencies_ms int[]` (raw samples)
Per-call array of every turn latency. Persisted on `call_metrics` so future queries can recompute distributions across calls (per-call p95 is not re-aggregatable — you cannot average p95s). Enables questions like "show me the distribution of turn latencies for tenant X last week" with `unnest()`. Worst case ~240 bytes/call.

### 3.5 Non-persisted (known blind spots)
The spec explicitly does not attempt to measure:
- **EL server-side CPU time** alone — no client-observable signal without EL telemetry.
- **EL VAD debounce** (time from actual silence to `user_transcript isFinal`) — would require tracking last inbound RTP packet times. Logged informationally during diagnostic calls (see §4.6) but not persisted.

These are acknowledged limits, not bugs to fix later.

## 4. Architecture

Changes to `voiceagent-saas/call-bridge.js`, one migration for `call_metrics`, one pre-existing-bug fix in the upsert path. No changes to `elevenlabs-session.js` — it already emits the events we need.

### 4.1 Latency tracker

A plain object `this.latency` initialized in the `CallBridge` constructor:

```js
this.latency = {
  customerAnsweredAt: null,        // Date.now() when handleCustomerAnswered() fires
  greetingLatencyMs: null,         // computed on first agent_audio after answer
  pendingUserFinalAt: null,        // Date.now() of latest user_transcript isFinal
  pendingUserFinalIsBarge: false,  // true if an 'interruption' event fired while pending
  turnLatenciesMs: [],             // every computed turn latency pushed here
  audioPlumbingSamplesMs: [],      // plumbing samples: first chunk of each turn + greeting
};
```

### 4.2 Event hooks (all inside CallBridge, wired in `_wireSessionEvents`)

**`handleCustomerAnswered()`:**
- At the top of the method (before any state-check early-returns), stamp `this.latency.customerAnsweredAt = Date.now()` if still null. This ensures the stamp is captured even when the method is called during `pre_warming` and queued via `_pendingCustomerAnswered`.

**`agent_audio` handler:**
The order of operations is critical: **audio dispatch happens first, latency measurement second**, so instrumentation can never slow the hot path.

```js
session.on("agent_audio", (buffer) => {
  const receivedAt = Date.now();
  this.outboundAudioChunks += 1;
  if (!this.firstAudioReceivedAt) {
    this.firstAudioReceivedAt = receivedAt;
    this.ttsFirstByteMs = receivedAt - this.elWsOpenedAt;
  }

  // Hot path: dispatch audio first, always.
  let sentAt = null;
  if (this.sendToAsterisk) {
    try {
      this.sendToAsterisk(buffer.toString("base64"));
      sentAt = Date.now();
    } catch (err) {
      this.log.error({ err }, "sendToAsterisk threw");
    }
  }

  // Observability (best-effort, wrapped):
  try {
    this._recordAgentAudioLatency(receivedAt, sentAt);
  } catch (err) {
    this.log.error({ err }, "latency recording threw");
  }
});
```

**`_recordAgentAudioLatency(receivedAt, sentAt)`:** new private method.
- **Greeting path:** if `greetingLatencyMs == null` and `customerAnsweredAt != null`, compute `greetingLatencyMs = clampNonNegative(receivedAt - customerAnsweredAt)` and log. Also record `sentAt - receivedAt` into `audioPlumbingSamplesMs` if `sentAt != null`.
- **Defensive warning:** if `greetingLatencyMs == null` and `customerAnsweredAt == null` on a chunk that is clearly post-answer (state is `live`), log a warning and skip — should not happen post-lifecycle-fix.
- **Turn path:** if `pendingUserFinalAt != null`:
  - If `pendingUserFinalIsBarge === true`: discard the sample (do not push), clear both fields, log `{event: "turn_latency_skipped_barge"}`. See §6 for rationale.
  - Else compute `turnLatencyMs = clampNonNegative(receivedAt - pendingUserFinalAt)`, push to `turnLatenciesMs`, record `sentAt - receivedAt` into `audioPlumbingSamplesMs` if `sentAt != null`, log `{event: "turn_latency", turn_index: turnLatenciesMs.length, user_final_at, agent_audio_at, turn_latency_ms}`, clear `pendingUserFinalAt` and `pendingUserFinalIsBarge`.

**`user_transcript` handler:**
- If `isFinal === true`: set `pendingUserFinalAt = Date.now()` and `pendingUserFinalIsBarge = false`. Overwrites any prior pending — only the most recent isFinal counts.
- If `isFinal === false`: no-op.

**`interruption` handler (new):** `elevenlabs-session.js:320` already emits this. Wire a listener in `_wireSessionEvents`:
- If `pendingUserFinalAt != null`: set `pendingUserFinalIsBarge = true`. This flags that the next `agent_audio` after the current pending isFinal is the continuation of an interrupted turn, not a fresh response. The sample will be discarded.

### 4.3 Finalization (`_persistFinalState`)

Wrap the whole latency-aggregation block in its own try/catch so a bad computation can't poison the `call_metrics` write for the other fields:

```js
let latencyFields = {};
try {
  const turns = this.latency.turnLatenciesMs;
  const plumbing = this.latency.audioPlumbingSamplesMs;
  latencyFields = {
    greeting_latency_ms: this.latency.greetingLatencyMs,
    avg_turn_latency_ms: turns.length ? Math.round(mean(turns)) : null,
    p95_turn_latency_ms: turns.length ? percentile(turns, 0.95) : null,
    audio_plumbing_ms: plumbing.length ? Math.round(mean(plumbing)) : null,
    turn_latencies_ms: turns.length ? turns : null,
  };
} catch (err) {
  this.log.error({ err }, "latency aggregation threw");
  latencyFields = {};
}

const metricsRow = {
  call_id: this.callId,
  tenant_id: this.tenantId,
  call_duration_seconds: ...,
  transcript_turn_count: this.turnCount,
  tool_call_count: this.toolCallCount,
  tts_first_byte_ms: this.ttsFirstByteMs,
  el_ws_open_ms: this.elWsOpenMs,
  ...latencyFields,
};
```

Emit one end-of-call summary log line `{event: "call_latency_summary", greeting_latency_ms, turn_count, avg_turn_latency_ms, p95_turn_latency_ms, audio_plumbing_ms}`.

### 4.4 Helpers (in-file, no new file)

```js
function clampNonNegative(n) {
  return typeof n === "number" && n >= 0 ? n : 0;
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
```

**Clock source:** `Date.now()` throughout, consistent with existing usage (`elWsOpenedAt`, `firstAudioReceivedAt`, `callStartedAt`). `performance.now()` would be more rigorous against NTP slew but mixing clocks is risky and NTP adjustments during a 60s call are not a realistic concern on a stable droplet. The `clampNonNegative` helper protects against the rare case of a measurable backward jump.

### 4.5 Schema migration

New file: `supabase/migrations/2026-04-08_call_metrics_latency_columns.sql`. Matches the date-prefix convention of `2026-04-07_elevenlabs_runtime_swap.sql`.

```sql
-- 2026-04-08_call_metrics_latency_columns.sql
-- Spec: docs/superpowers/specs/2026-04-08-call-latency-instrumentation-design.md
--
-- Adds per-call latency metrics to call_metrics. Non-destructive, idempotent.
-- Columns nullable so existing rows remain valid. New columns inherit the
-- existing tenant_id RLS policy on call_metrics automatically.
--
-- Note: tts_first_byte_ms remains in place but its semantics ("from WS open")
-- are now misleading post-lifecycle-fix. greeting_latency_ms is the correct
-- user-perspective metric going forward.

begin;

alter table public.call_metrics
  add column if not exists greeting_latency_ms int,
  add column if not exists avg_turn_latency_ms int,
  add column if not exists p95_turn_latency_ms int,
  add column if not exists audio_plumbing_ms  int,
  add column if not exists turn_latencies_ms  int[];

-- Non-negative guards. Plain inline CHECK — all existing rows have NULL in
-- the new columns so validation is instant; no need for the `not valid` +
-- validate dance.
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
```

Applied via `mcp__supabase__apply_migration`. Existing `idx_call_metrics_tenant_created` index covers time-series regression queries — no new index needed. RLS inherited automatically.

### 4.6 Pre-existing upsert race fix (bridge path only)

`call-bridge.js:589` currently uses `{ onConflict: "call_id", ignoreDuplicates: true }`. That means if the janitor wrote a sparse minimal row first (duration only), the bridge's richer `_persistFinalState` — including the new latency data — is silently dropped. This is a pre-existing bug the spec inherits and fixes **only for the bridge writer**:

**Change (bridge only, `call-bridge.js:589`):** switch to `{ onConflict: "call_id", ignoreDuplicates: false }`. Bridge becomes last-writer-wins relative to the janitor.

**Janitor stays unchanged (`janitor.js:112`):** keeps `{ ignoreDuplicates: true }`. Reviewer concern was "what if janitor fires after bridge and overwrites latency with NULLs?" — that cannot happen because the janitor still no-ops when a row already exists. The asymmetry is deliberate:

| Order of writes | Bridge row | Janitor row | Final state |
|---|---|---|---|
| Bridge first, janitor second | rich (latency, etc.) | no-op (ignoreDuplicates: true) | rich — correct |
| Janitor first, bridge second | rich, overwrites sparse | sparse (duration only) | rich — correct (new behavior) |
| Janitor only (bridge crashed) | n/a | sparse | sparse — acceptable |
| Bridge only (never stuck) | rich | n/a | rich — correct |

All four orderings yield the richest available data with no silent drops. The change is the second row ("janitor first, bridge second"), which today drops latency data and after this change preserves it.

The implementation plan must NOT touch the janitor's upsert — a test in §8 locks the janitor path's `ignoreDuplicates: true` behavior to prevent future accidental flips that would reintroduce the NULL-overwrite risk.

Log the change explicitly in the commit so it's not hidden inside "latency work."

## 5. Data flow

```
customer answers phone
  → ARI ChannelStateChange Up
  → server.js → bridge.handleCustomerAnswered()
     └─ latency.customerAnsweredAt = now  (stamped even if queued during pre_warming)
     └─ state: pre_warmed → live
     └─ session.startConversation()

EL processes greeting
  → session emits agent_audio (first chunk)
     ├─ [hot path] sendToAsterisk(buffer)  ← runs first
     └─ [observability]
         ├─ greetingLatencyMs = clamp(sentAt_or_receivedAt - customerAnsweredAt)
         ├─ audioPlumbingSamplesMs.push(sentAt - receivedAt)
         └─ log { event: "greeting_latency", ... }

user speaks, stops
  → session emits user_transcript { isFinal: true }
     └─ latency.pendingUserFinalAt = now
     └─ latency.pendingUserFinalIsBarge = false

(user barges in during agent speech)
  → session emits interruption
     └─ if pendingUserFinalAt != null: pendingUserFinalIsBarge = true

EL processes turn
  → session emits agent_audio (first chunk of response)
     ├─ [hot path] sendToAsterisk(buffer)  ← runs first
     └─ [observability]
         ├─ if pendingUserFinalIsBarge: discard sample, log skipped_barge
         ├─ else: turnLatencyMs = clamp(receivedAt - pendingUserFinalAt)
         │         turnLatenciesMs.push(turnLatencyMs)
         │         audioPlumbingSamplesMs.push(sentAt - receivedAt)
         │         log { event: "turn_latency", turn_index, ... }
         └─ clear pendingUserFinalAt + pendingUserFinalIsBarge

call ends
  → _persistFinalState
     ├─ try { aggregate latency fields } catch { empty fields, log error }
     ├─ upsert call_metrics { ..., greeting_latency_ms, avg_turn_latency_ms,
     │    p95_turn_latency_ms, audio_plumbing_ms, turn_latencies_ms }
     │    with ignoreDuplicates: false  ← pre-existing race fix
     └─ log { event: "call_latency_summary", ... }
```

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Customer never answers (hangup during ring) | `customerAnsweredAt` null; `greeting_latency_ms` persisted as null |
| Agent speaks first, user never talks | `turnLatenciesMs` empty; avg/p95 persisted as null |
| `user_transcript` isFinal without subsequent `agent_audio` (user hung up mid-turn) | `pendingUserFinalAt` discarded at finalize; not counted |
| Multiple isFinal transcripts before one `agent_audio` (EL segmentation) | Only the most recent counts — earlier isFinal overwritten, avoiding double-counting |
| **User barges in mid-agent-speech** (reviewer §5) | `interruption` event sets `pendingUserFinalIsBarge = true`; the next `agent_audio` sample is discarded because measuring "continuation of interrupted speech" as turn latency is nonsense |
| First `agent_audio` before `customer_answered` (defensive) | `greeting_latency_ms` not computed; warning logged |
| Customer answered during `pre_warming` (race, queued via `_pendingCustomerAnswered`) | `customerAnsweredAt` stamped on the initial call to `handleCustomerAnswered` regardless of state — the subsequent `ws_open`-driven transition to `live` does not re-stamp |
| Negative computed latency (clock jumped backward on NTP slew) | `clampNonNegative` returns 0; sample still recorded to avoid silent data loss |
| p95 with n=1 | Returns the single value |
| p95 with n=0 | Returns null |
| Latency aggregation throws in `_persistFinalState` | Outer try/catch swallows, logs error, writes `call_metrics` with other fields intact |
| Janitor-finalize race | `ignoreDuplicates: false` means StasisEnd row wins if it lands second — no silent data loss |

## 7. Error handling

Latency tracking is best-effort observability. Every field is nullable. The `agent_audio` handler's latency block is wrapped so a failure never impacts audio dispatch. The finalize-time aggregation is wrapped so a failure never impacts the `call_metrics` write for other fields. No new failure paths are introduced.

## 8. Testing

New file: `apps/voice-engine/test/call-bridge-latency.test.ts` (vitest).

**Harness verification first (test prerequisite):** the existing `apps/voice-engine/test/call-bridge.test.ts` (from the lifecycle fix) imports the runtime code from `voiceagent-saas/call-bridge.js` directly. The new test file must use the same import path. If the existing test uses a TS mirror instead, the implementation plan must first confirm the harness actually exercises droplet code before adding new tests — otherwise we test a ghost.

**Test cases:**

1. `greeting_latency_ms` computed correctly when `handleCustomerAnswered` fires before first `agent_audio`
2. `greeting_latency_ms` stays null if customer never answered
3. **`customerAnsweredAt` stamped correctly when `handleCustomerAnswered` is called during `pre_warming`** (queued via `_pendingCustomerAnswered`) — verifies §6 pre_warming race case
4. `turn_latency_ms` computed on `user_transcript` isFinal → `agent_audio` sequence
5. Multiple `user_transcript` isFinal events before one `agent_audio` → only the most recent final counted
6. `user_transcript` with `isFinal: false` does not set `pendingUserFinalAt`
7. **`interruption` event between isFinal and next `agent_audio` causes the sample to be discarded** (barge-in case)
8. `audio_plumbing_ms` averages first-chunk samples across turns correctly
9. Empty turn array → `avgTurnLatencyMs`, `p95TurnLatencyMs`, `audio_plumbing_ms` all null (not NaN, not 0)
10. `turn_latencies_ms` array persisted when turns present, null when empty
11. `percentile` helper: correct for n=1 (returns single value), n=2 (returns sorted[1] — i.e., p95 degenerates to max at small n — lock this behavior so a future "fix" doesn't accidentally change it), n=5, n=20
14. Janitor path upsert locks `ignoreDuplicates: true` — regression guard that prevents an accidental flip that would reintroduce the NULL-overwrite risk described in §4.6
12. `clampNonNegative` returns 0 for negative input (simulates backward clock jump)
13. Latency aggregation throw in finalize is caught and does not break `call_metrics` row construction

Tests use a mock `ElevenLabsSession` (same pattern as existing lifecycle tests) so they run in isolation with no real WebSocket.

## 9. Deployment

1. Apply schema migration via `mcp__supabase__apply_migration`. Additive and non-breaking.
2. `scp voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/`
3. `ssh root@188.166.166.234 "systemctl restart voiceagent-saas"`
4. Verify boot clean in `journalctl -u voiceagent-saas -f`.
5. Place one test call with a short Hebrew exchange (≥3 turns, including one where you interrupt Dani mid-sentence to exercise the barge path).
6. Read `greeting_latency`, `turn_latency`, and `call_latency_summary` log lines from journalctl.
7. Query the `call_metrics` row for persisted values:
   ```sql
   select greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms,
          audio_plumbing_ms, turn_latencies_ms
   from call_metrics where call_id = '<id>';
   ```

**Rollback:** revert the code commit, scp the reverted `call-bridge.js`, restart. Schema migration is additive; no rollback needed. Queries that use the new columns should filter `WHERE greeting_latency_ms IS NOT NULL` — existing rows from before the migration will stay NULL and must not be averaged naively.

## 10. What this does not do

- Does not tune any latency. That's separate work after we know the numbers.
- Does not instrument `elevenlabs-session.js`. All measurement happens at the CallBridge layer using events EL already emits.
- Does not expose latency in the dashboard UI. Data is queryable via SQL for now.
- Does not add a dedicated per-turn table. Raw samples live in `turn_latencies_ms int[]` on `call_metrics` — good enough for unnest-based queries and avoids a new table's write path.
- Does not measure EL VAD debounce or EL server-side CPU time (see §3.5).
- Does not rename the misleading-but-still-useful `tts_first_byte_ms` field — documented in the migration comment instead.
