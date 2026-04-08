# Call Latency Instrumentation — Design Spec

**Date:** 2026-04-08
**Status:** Approved, ready for implementation plan
**Author:** Claude + Tom
**Related:** [2026-04-08 EL session lifecycle fix](./2026-04-08-el-session-lifecycle-fix-design.md)

## 1. Problem

After shipping the EL session lifecycle fix (2026-04-08), live calls work end-to-end but perceived latency is too high. Before tuning anything, we need to measure **where** the latency is actually coming from: EL server-side processing, our audio plumbing, or network.

Today, `call-bridge.js` tracks `ttsFirstByteMs` (from WS-open, not from pickup) and `elWsOpenMs`. Neither answers the two questions users actually care about:

1. From the moment I answered, how long until Dani started speaking?
2. From the moment I stopped speaking, how long until Dani responded?

`call_metrics` has no per-turn latency data, and `elevenlabs-session.js` has no turn-latency instrumentation at all.

## 2. Goal

Add diagnostic and persistent latency instrumentation to CallBridge so that a single test call gives us enough data to decide what to tune next, AND so we can track latency regressions over time on every production call.

Non-goals: tuning the latency itself (separate work after this lands), building dashboards, per-turn persistence to a new table.

## 3. Metrics

Three new latencies are defined and persisted per call:

### 3.1 `greeting_latency_ms`
Time from the customer answering the phone to the first outbound agent audio chunk.

- **Start:** `handleCustomerAnswered()` invocation on CallBridge (our clock, driven by ARI `ChannelStateChange → Up` on the customer channel). Chosen over "first inbound caller audio" because the user's subjective experience starts at pickup regardless of whether they speak first.
- **End:** first `agent_audio` event emitted by `ElevenLabsSession` after `customerAnsweredAt` is set.
- **Nullable:** stays `null` if customer never answered or call ended before greeting.

### 3.2 `avg_turn_latency_ms`, `p95_turn_latency_ms`
Aggregated per-turn response latency across the call.

- **Per-turn start:** `user_transcript` event with `isFinal: true`. EL's server-side VAD has finalized the user turn — this isolates EL processing time (finalization → response generation → TTS first byte) from network and VAD debounce. Chosen over "last inbound audio chunk" because (a) the signal is cleaner, (b) we already have it without heuristics, (c) if this number is low but users still perceive lag, we know to investigate VAD/network on top.
- **Per-turn end:** next `agent_audio` event.
- **Aggregation:** mean and 95th percentile over `turnLatenciesMs[]` at finalize time.
- **Nullable:** both stay `null` if the array is empty.

## 4. Architecture

Two small additions to `voiceagent-saas/call-bridge.js`, one migration for `call_metrics`. No changes to `elevenlabs-session.js` — it already emits the events we need.

### 4.1 Latency tracker

A plain object `this.latency` initialized in the `CallBridge` constructor:

```js
this.latency = {
  customerAnsweredAt: null,   // Date.now() when handleCustomerAnswered() fires
  greetingLatencyMs: null,    // computed on first agent_audio after answer
  pendingUserFinalAt: null,   // Date.now() of latest user_transcript isFinal
  turnLatenciesMs: [],        // every computed turn latency pushed here
};
```

### 4.2 Event hooks (all inside CallBridge, wired in `_wireSessionEvents`)

**`handleCustomerAnswered()`:**
- Set `this.latency.customerAnsweredAt = Date.now()` at the top of the method, before the state transition.

**`agent_audio` handler (first-chunk branch, where `firstAudioReceivedAt` is already set today):**
- If `greetingLatencyMs == null` and `customerAnsweredAt != null`:
  - `greetingLatencyMs = now - customerAnsweredAt`
  - Log `{ event: "greeting_latency", greeting_latency_ms }`.
- If `greetingLatencyMs == null` and `customerAnsweredAt == null`: log a warning (defensive — shouldn't happen post-lifecycle-fix) and skip.

**`agent_audio` handler (every chunk, not just the first):**
- If `pendingUserFinalAt != null`:
  - `turnLatencyMs = now - pendingUserFinalAt`
  - Push to `turnLatenciesMs`.
  - Log `{ event: "turn_latency", turn_index, user_final_at, agent_audio_at, turn_latency_ms }` where `turn_index` is `turnLatenciesMs.length` after push.
  - Set `pendingUserFinalAt = null`.

**`user_transcript` handler:**
- If `isFinal === true`: set `pendingUserFinalAt = Date.now()`. Overwrites any prior pending — only the most recent isFinal counts.
- If `isFinal === false`: no-op.

### 4.3 Finalization (`_persistFinalState`)

Compute `avgTurnLatencyMs` and `p95TurnLatencyMs` from `turnLatenciesMs[]`. Both `null` if the array is empty. Include in the `call_metrics` upsert alongside existing fields. Emit one summary log line:

```js
log.info({
  event: "call_latency_summary",
  greeting_latency_ms,
  turn_count: turnLatenciesMs.length,
  avg_turn_latency_ms,
  p95_turn_latency_ms,
}, "call latency summary");
```

### 4.4 p95 helper

Simple in-file helper:

```js
function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
```

Nearest-rank method. Good enough for per-call aggregation where n is typically 5–30.

### 4.5 Schema migration

New file `supabase/migrations/<timestamp>_call_metrics_latency_columns.sql`:

```sql
alter table call_metrics
  add column greeting_latency_ms integer,
  add column avg_turn_latency_ms integer,
  add column p95_turn_latency_ms integer;
```

Nullable so existing rows remain valid. Applied via `mcp__supabase__apply_migration`.

## 5. Data flow

```
customer answers phone
  → ARI ChannelStateChange Up
  → server.js → bridge.handleCustomerAnswered()
     └─ latency.customerAnsweredAt = now
     └─ state: pre_warmed → live
     └─ session.startConversation()

EL processes greeting
  → session emits agent_audio (first chunk)
     └─ greetingLatencyMs = now - customerAnsweredAt
     └─ log { event: "greeting_latency", ... }

user speaks, stops
  → session emits user_transcript { isFinal: true }
     └─ latency.pendingUserFinalAt = now

EL processes turn
  → session emits agent_audio (first chunk of response)
     └─ turnLatencyMs = now - pendingUserFinalAt
     └─ turnLatenciesMs.push(turnLatencyMs)
     └─ log { event: "turn_latency", ... }
     └─ pendingUserFinalAt = null

call ends
  → _persistFinalState
     └─ avg = mean(turnLatenciesMs)
     └─ p95 = percentile(turnLatenciesMs, 0.95)
     └─ upsert call_metrics { greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms, ... }
     └─ log { event: "call_latency_summary", ... }
```

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Customer never answers (hangup during ring) | `customerAnsweredAt` stays null; `greeting_latency_ms` persisted as null |
| Agent speaks first, user never talks | `turnLatenciesMs` empty; avg/p95 persisted as null |
| `user_transcript` isFinal without subsequent `agent_audio` (user hung up mid-turn) | `pendingUserFinalAt` discarded at finalize; not counted |
| Multiple isFinal transcripts before one agent_audio (EL segmentation) | Only the most recent counts — earlier isFinal overwritten, avoiding double-counting |
| First `agent_audio` arrives before `customer_answered` (defensive — shouldn't happen post-lifecycle-fix) | `greeting_latency_ms` not computed; warning logged |
| p95 with n=1 | Returns the single value |
| p95 with n=0 | Returns null |

## 7. Error handling

Latency tracking is best-effort observability. Every field is nullable. Every computation happens in existing try-paths or is trivially safe (arithmetic on numbers). A failure in latency code must never impact the call or the existing metrics write. No new failure paths are introduced.

## 8. Testing

New file: `apps/voice-engine/test/call-bridge-latency.test.ts` (vitest, same harness as the lifecycle fix tests at `apps/voice-engine/test/call-bridge.test.ts`).

Test cases:

1. `greeting_latency_ms` computed correctly when `handleCustomerAnswered` fires before first `agent_audio`
2. `greeting_latency_ms` stays null if customer never answered (no `handleCustomerAnswered` call)
3. `turn_latency_ms` computed on `user_transcript` isFinal → `agent_audio` sequence
4. Multiple `user_transcript` isFinal events before one `agent_audio` → only the most recent final counted
5. `user_transcript` with `isFinal: false` does not set `pendingUserFinalAt`
6. Empty turn array → `avgTurnLatencyMs` and `p95TurnLatencyMs` are null (not NaN, not 0)
7. `percentile` helper: correct for n=1, n=5, n=20

Tests use a mock `ElevenLabsSession` (same pattern as existing lifecycle tests) so they run in isolation with no real WebSocket.

## 9. Deployment

1. Apply schema migration via `mcp__supabase__apply_migration`.
2. `scp voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/`
3. `ssh root@188.166.166.234 "systemctl restart voiceagent-saas"`
4. Verify boot clean in `journalctl -u voiceagent-saas -f`.
5. Place one test call with a short Hebrew exchange (≥3 turns).
6. Read `greeting_latency` and `turn_latency` log lines from journalctl.
7. Query `call_metrics` row for persisted values.

Rollback: revert the commit, scp the reverted `call-bridge.js`, restart. Schema migration is additive and non-breaking — no rollback needed.

## 10. What this does not do

- Does not tune any latency. That's separate work after we know the numbers.
- Does not add per-turn persistence to a new table. Array in memory + aggregates in `call_metrics` is enough for today's diagnostic and tomorrow's regression tracking.
- Does not instrument `elevenlabs-session.js`. All measurement happens at the CallBridge layer using events EL already emits.
- Does not expose latency in the dashboard UI. Data is queryable via SQL for now.
