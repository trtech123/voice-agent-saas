# EL Session Lifecycle Fix — Pre-warm WS, Start Conversation on Pickup

**Status:** Draft for review
**Date:** 2026-04-08
**Depends on:** Spec A (2026-04-07-elevenlabs-runtime-swap-design.md), deployed and running
**Root cause:** `CallBridge.start()` sends `conversation_initiation_client_data` to ElevenLabs the moment the WebSocket opens — which is immediately after `StasisStart`, i.e. while the customer leg is still **ringing**. The agent greets nobody, burns turn timeouts during ring, and by the time the customer answers, the agent is in a stale "are you still there?" state. Field-verified in live test calls on 2026-04-07.

## 1. Goals & Non-Goals

### Goals
1. **Zero wasted ElevenLabs agent state during ring.** EL's conversation clock does not start until the customer has picked up. No greeting into the void, no stale "are you still there?" turns during ringing.
2. **Snappy pickup latency.** WebSocket transport (TCP/TLS/HTTP upgrade) is pre-warmed during ring. The only latency the customer perceives between "hello" and the agent's first audible byte is EL's v3 TTS first-byte time (~500–1500 ms), not WS handshake + TTS + transport.
3. **Explicit, testable lifecycle.** `CallBridge` gets a new public method `handleCustomerAnswered()`. Server.js ARI event handler is the single caller.
4. **Correct failure-mode behavior** for all five identified edge cases. No orphaned sessions, no stuck rows, no silent data loss, no retries burning EL credits for broken states.

### Non-Goals
- No change to the call-placement / dial path (Voicenter, Asterisk ARI originate, media-bridge attach).
- No change to the EL agent configuration — `conversation_initiation_client_data` payload stays the same, only the timing changes.
- No change to the audio forwarding hot path (byte encoding, `user_audio_chunk` format, `agent_audio` decode).
- No change to event sourcing or server.js ARI subscription. We use events that already arrive; we route one more of them into the bridge.
- No "early media" audio path (ringback, carrier tones). Those frames are dropped at `handleCallerAudio()` until answered.
- No touching Spec B (dashboard UI).
- No schema migrations — `call_failure_reason_t` already has every enum value we need.

## 2. Call-Bridge State Machine

### States

```
      ┌──────────┐
      │  CREATED │   Constructor ran. Nothing opened yet.
      └────┬─────┘
           │  .start() called
           ▼
      ┌──────────────┐
      │  PRE_WARMING │   WS opening. Inbound audio (ringback) dropped.
      └────┬─────────┘
           │  EL WS 'open' event received
           ▼
      ┌──────────────┐
      │  PRE_WARMED  │   WS open + idle. conversation_initiation NOT sent.
      └────┬─────────┘   Inbound audio still dropped.
           │
           │  handleCustomerAnswered() called
           ▼
      ┌──────────────┐
      │  LIVE        │   conversation_initiation_client_data sent.
      └────┬─────────┘   Inbound audio forwarded to EL. Agent starts speaking.
           │
           │  StasisEnd / error / max-duration / customer hangup
           ▼
      ┌──────────────┐
      │  FINALIZED   │   Terminal. Row persisted. All I/O drained.
      └──────────────┘
```

### Valid transitions

| From | Event | To | Side effects |
|---|---|---|---|
| CREATED | `.start()` | PRE_WARMING | Open WS, start max-duration timer |
| PRE_WARMING | WS `open` | PRE_WARMED | Log `el_ws_open_ms`, do NOT send initiation |
| PRE_WARMING | WS `error` | FINALIZED | `failure_reason_t='el_ws_connect_failed'`, drop Asterisk channel |
| PRE_WARMED | `handleCustomerAnswered()` | LIVE | Send `conversation_initiation_client_data`, enable audio forwarding |
| PRE_WARMED | StasisEnd (no-answer) | FINALIZED | Close WS cleanly, `failure_reason_t='no_answer'` |
| PRE_WARMED | WS `close` (EL dropped) | FINALIZED | `failure_reason_t='el_ws_dropped'`, drop Asterisk channel |
| LIVE | StasisEnd / hangup | FINALIZED | Close WS cleanly, `failure_reason_t=null` (natural end) |
| LIVE | WS `error` / EL session error | FINALIZED | Map error code → `failure_reason_t`, drop Asterisk channel |
| LIVE | 10-min kill switch | FINALIZED | `failure_reason_t='max_duration_exceeded'` |
| any | `handleCustomerAnswered()` called twice | (no-op) | Log warn, ignore second call (idempotent) |
| FINALIZED | any event | (no-op) | Log warn, ignore |

### Storage of state

Single private field: `this._state = 'created' | 'pre_warming' | 'pre_warmed' | 'live' | 'finalized'`.

The existing `this.finalized` boolean becomes a derived getter (`this._state === 'finalized'`) for backward compatibility with existing reads.

### Rationale for not extracting state machine to a separate class

YAGNI. Five states, one owner (`CallBridge`), every transition triggered by an already-existing event source. An explicit enum field plus a `_transition(target)` helper method that logs and validates is enough. No reducer, no pattern-match framework, no external state-machine library.

## 3. Component Changes

Three files change. Everything else is unaffected.

### 3.1 `voiceagent-saas/elevenlabs-session.js`

**One new public method; `connect()` splits responsibilities.**

**Before:** `connect()` opens the WS AND sends `conversation_initiation_client_data` in the `ws.on('open')` handler via `_sendInitiation()`.

**After:**
- `connect()` opens the WS only. On `ws.on('open')`, it emits a new event `ws_open` and does NOT send the initiation payload.
- New public method `startConversation()` sends `conversation_initiation_client_data` using the same `_sendInitiation()` helper. Idempotent — a second call logs a warning and no-ops. Throws if called before `ws_open` fires (WS not ready yet).
- `sendAudio()` adds a guard: if `startConversation()` hasn't been called yet, the frame is silently dropped with no warning (ringback path — expected).

The `ws_open` event is emitted up to call-bridge, which transitions its own state from PRE_WARMING → PRE_WARMED.

**No protocol change to EL.** From EL's perspective, the WS opens, sits silent for a few hundred ms to ~30 s, then receives `conversation_initiation_client_data` and starts normally. Clients are free to delay the first message.

### 3.2 `voiceagent-saas/call-bridge.js`

Four concrete changes:

1. **Add `_state` field + `_transition(target, reason)` helper.** Helper logs every transition at `info` level with `{callId, from, to, reason, elapsed_ms_since_start}`. Rejects invalid transitions with a loud error (never throws — logs and stays in the source state).

2. **Split `start()` into two phases.**
   - Phase A: CAS assertion (unchanged), construct `ElevenLabsSession`, wire events (now including `ws_open`), call `session.connect()`. Transition CREATED → PRE_WARMING. No await beyond this.
   - `ws_open` handler: transition PRE_WARMING → PRE_WARMED. Persist `el_ws_open_ms` metric. Check `_pendingCustomerAnswered` flag — if true, proceed directly to LIVE via the same path as `handleCustomerAnswered()`.

3. **New public method `handleCustomerAnswered()`.**

   ```js
   handleCustomerAnswered() {
     if (this._state === 'live') {
       this.log.warn('handleCustomerAnswered called twice — ignoring');
       return;
     }
     if (this._state === 'finalized') {
       this.log.warn('handleCustomerAnswered after finalize — ignoring');
       return;
     }
     if (this._state === 'pre_warming') {
       // Race: customer answered before WS finished opening.
       // Queue the transition — the ws_open handler will pick it up.
       this._pendingCustomerAnswered = true;
       return;
     }
     if (this._state !== 'pre_warmed') {
       this.log.error({ state: this._state }, 'handleCustomerAnswered in unexpected state');
       return;
     }
     this._transition('live', 'customer_answered');
     this.session.startConversation();
   }
   ```

4. **`handleCallerAudio()` gets a state guard.**

   ```js
   handleCallerAudio(audioBuffer) {
     if (this._state !== 'live') return;  // drop ringback during pre_warming / pre_warmed
     this.inboundAudioChunks += 1;
     this.session.sendAudio(audioBuffer);
   }
   ```

### 3.3 `voiceagent-saas/server.js`

One new event branch plus one call into the bridge.

Server.js already subscribes to ARI events and dispatches `StasisStart` / `ChannelStateChange` / `ChannelHangupRequest` for both media and customer channels. Add one branch:

```
On ChannelStateChange for a CUSTOMER channel:
  if channel.state === 'Up':
    bridge = activeBridges.get(sipCallId)
    if bridge: bridge.handleCustomerAnswered()
```

Important: the customer-leg state goes `Ringing → Up`. We trigger on the `Up` transition only. Not on `StasisStart` for the customer leg (fires before pickup). Not on the first audio frame (heuristic, rejected — early media can false-trigger).

The bridge lookup by `sipCallId` uses the existing `activeBridges` map.

Nothing else in server.js changes. Existing StasisStart handler (attaches customer leg to bridge) and ChannelHangupRequest handler (drives cleanup) remain as-is.

### Files NOT changing

- `media-bridge.js` — still blindly forwards Asterisk audio to `bridge.handleCallerAudio()`. The drop happens inside the bridge.
- `agent-sync-processor.js`, `live-turn-writer.js`, `janitor.js`, webhook handler — all unrelated.
- Migrations, schema — no changes. `call_failure_reason_t` already covers all cases.
- `tools.js`, `elevenlabs-tools-adapter.js` — no changes.
- The 10-minute max-duration timer starts on WS open, same as today. Includes the ring window, which is fine because ring is at most ~60 s and the kill switch is 10 minutes.

## 4. Error Handling, Metrics, Logging

### 4.1 Failure-mode matrix

| Scenario | Current state | Resulting state | `failure_reason_t` | Retry? |
|---|---|---|---|---|
| WS fails to open (DNS, TLS, 401, 5xx) | PRE_WARMING | FINALIZED | `el_ws_connect_failed` | Yes (call-processor retry policy) |
| WS opens then drops during ring | PRE_WARMED | FINALIZED | `el_ws_dropped` | No (stale connection) |
| Customer never answers (Voicenter no-answer) | PRE_WARMED | FINALIZED | `no_answer` | Yes (daily cap applies) |
| Customer answers before WS is open (race) | PRE_WARMING | (queued → LIVE on ws_open) | n/a | n/a |
| Customer answers, WS open, `startConversation()` throws | PRE_WARMED | FINALIZED | `el_ws_protocol_error` (via existing `mapErrorCodeToFailureReason`) | No |

### 4.2 Unchanged failure paths

All paths that work today keep working:

- `agent_version_mismatch` (CAS fail at start) — no retry burn, doesn't touch daily_retry_count
- `max_duration_exceeded` (10-min kill switch) — timer starts at WS open, unchanged semantics
- `asterisk_disconnect` — LIVE → FINALIZED, `failure_reason=null` (natural end)
- Tool execution errors — existing per-event `reply({ isError: true })` path
- `voicenter_busy` and other ARI originate failures — happen before `.start()` is called

### 4.3 Metrics

**In scope for this spec:** structured log lines at every state transition, sufficient to reconstruct call timelines during incident debugging.

Each transition emits:
```
{
  event: 'call_bridge_state_transition',
  call_id,
  from,                     // 'pre_warming'
  to,                       // 'pre_warmed'
  elapsed_ms_since_start,   // time in the source state
  reason                    // 'ws_open' / 'customer_answered' / 'ws_error' / ...
}
```

**Out of scope (follow-up spec):** adding queryable `ring_to_answer_ms` and `answer_to_first_byte_ms` columns to `call_metrics`. The logs-only approach is sufficient for this fix; columns can be added later when alerting thresholds are defined.

### 4.4 Alarms

Out of scope. The metrics work above enables alerting thresholds later.

## 5. Testing & Rollout

### 5.1 Unit tests

New tests in `apps/voice-engine/` test suite:

1. **State machine transitions.** Pure-function test of `_transition()` — every valid `(from, event) → to` pair, every invalid transition logs and stays in source, every call from FINALIZED is a no-op.
2. **`handleCallerAudio` drops audio in every non-LIVE state.** Assert `sendAudio` is not called when state is PRE_WARMING / PRE_WARMED / FINALIZED. Assert it IS called when LIVE.
3. **`handleCustomerAnswered` idempotency.** Twice → warn + no-op. After FINALIZED → warn + no-op. Before PRE_WARMED → sets `_pendingCustomerAnswered`; `ws_open` consumes flag, transitions to LIVE exactly once.
4. **`elevenlabs-session.js` split.** `connect()` opens WS but doesn't send initiation. `startConversation()` sends the payload. Calling `startConversation()` before WS open throws. Calling it twice is warn + no-op.
5. **Audio drop on ring-side sendAudio.** `ElevenLabsSession.sendAudio()` called before `startConversation()` drops the frame silently.

### 5.2 Integration tests

Against wired bridge with mocked EL WS:

6. **Happy path.** Mock EL WS. Mock `server.js` dispatching ChannelStateChange events in order. Assert: WS open during ring, zero agent audio emitted, customer-answered fires, `conversation_initiation_client_data` goes over the WS, agent audio flows, StasisEnd finalizes cleanly.
7. **No-answer path.** Customer leg never goes Up. ChannelHangupRequest fires after 30 s. Assert: PRE_WARMED → FINALIZED, `failure_reason_t='no_answer'`, WS close clean, row persisted.
8. **WS fails mid-ring.** Mock EL WS close while ringing. Assert: PRE_WARMED → FINALIZED, `failure_reason_t='el_ws_dropped'`, Asterisk channel torn down.
9. **Customer answers faster than WS handshake.** Fire ChannelStateChange → Up before WS `open`. Assert: `_pendingCustomerAnswered` set, `ws_open` fires, transition to LIVE via flag, `startConversation()` called exactly once.

### 5.3 Manual regression tests (real phone)

10. **Normal answered call.** Place call to an answering phone. Verify agent speaks its greeting within ~1–2 s of pickup (not during ring), and user speech is transcribed correctly. This also validates the empty-transcript bug is resolved.
11. **No-answer call.** Place call to a phone that doesn't answer. Verify the call ends as `no_answer`, no EL TTS credits burned (check EL dashboard), no orphaned row.
12. **Hang up during greeting.** Place call to a phone that answers then hangs up during the greeting. Verify clean finalize, no stuck state.

### 5.4 Rollout sequence

Single-droplet single-instance. No staged rollout possible.

1. Write tests first (TDD). Unit tests 1–5, then integration tests 6–9. Get them green locally.
2. Implement the changes per §3. Tests stay green.
3. Commit + push to main.
4. Deploy to droplet: `scp` changed files → `systemctl restart voiceagent-saas` → watch `journalctl` for boot errors.
5. Run manual tests 10–12 in that order. Each one is a real phone call.
6. If any manual test fails: roll back immediately via `git revert` + redeploy, diagnose, fix forward.

### 5.5 Rollback plan

Single-file rollback is trivial because the change is narrow:

- **State machine broken (stuck in PRE_WARMED forever):** `git revert` the commit, redeploy — old behavior (open + initiate simultaneously) restored in one step.
- **EL protocol rejects delayed-initiation pattern** (highly unlikely): same revert.
- **No database state affected** — runtime logic only. No migration to reverse.

### 5.6 Out of scope (explicit follow-ups)

- Queryable metric columns (`ring_to_answer_ms`, `answer_to_first_byte_ms`) — follow-up migration + spec.
- Alerting thresholds on those metrics.
- Shared EL WS mock fixture library for integration tests.
- **Separate empty-transcript investigation.** Strong hypothesis: this fix also resolves it (ASR was running against ringback-contaminated leading silence, and turn_timeout firing before pickup poisoned session state). If manual test 10 still shows empty transcripts with this fix in place, it's a separate root cause and gets its own spec.

## 6. Open Questions

None. All decisions confirmed in brainstorming.
