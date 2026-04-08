# Turn Latency VAD (Supersedes §3.2 of the 2026-04-08 Call Latency Spec) — Design Spec

**Date:** 2026-04-08
**Status:** Approved, ready for implementation plan
**Author:** Claude + Tom
**Supersedes:** §3.2, §4.2, §4.3 (turn-latency portions) of [2026-04-08 Call Latency Instrumentation](./2026-04-08-call-latency-instrumentation-design.md)
**Consulted:** Gemini (external review of the VAD state machine)

## 1. Problem

The original call latency instrumentation (shipped 2026-04-08) computes turn latency using EL's `user_transcript` event with `isFinal: true` as the "user stopped speaking" anchor. A live verification call proved this assumption wrong: on the current agent config, **every single `user_transcript` event fires with `is_final: false`**, even at natural utterance boundaries. Across a 32-turn Hebrew conversation, not one `isFinal: true` event was emitted. Result: `turn_count: 0` in `call_metrics`, zero turn-latency samples recorded — the instrumentation shipped clean but measured nothing.

We need an anchor that does not depend on EL marking user turns as final.

## 2. Goal

Replace the turn-latency anchor with a client-side RMS-based voice activity detector (VAD) on inbound caller audio, cross-checked against EL's `user_transcript` timestamps as a fallback for the noisy-environment failure case. All other latency metrics (`greeting_latency_ms`, `audio_plumbing_ms`, `tts_first_byte_ms`, `el_ws_open_ms`) from the original spec remain unchanged and continue to work.

Non-goals: tuning the latency itself, running our own ASR, filtering non-speech sounds beyond raw RMS, rewriting the original spec's migration / greeting logic / upsert fix. This spec is purely a surgical swap of the turn-latency signal source.

## 3. Rejected Approaches

| Option | Why rejected |
|---|---|
| Continue gating on EL `isFinal: true` | Empirically never fires on this agent config. Instrumentation measures nothing. |
| Use EL `agent_response` as the reciprocal anchor | Still depends on EL's internal processing pipeline timing (`isFinal` adjacent), same failure class. |
| Use EL's last partial `user_transcript` timestamp as the primary anchor | Systematically under-estimates true latency because EL's partials are delayed by its own VAD + ASR processing — the measurement erases EL's internal listening latency from the number, which is exactly what we want to measure. Acceptable only as a fallback. |
| Track RTP timestamps directly instead of Node `Date.now()` | Adds complexity for sub-10ms jitter improvement. `Date.now()` is sufficient for ±200ms–2000ms latency measurements on a stable droplet. |

## 4. Design — Hybrid RMS VAD with EL-Partial Fallback

### 4.1 Signal sources

Two independent anchors:

- **Primary: `userStoppedAt_rms`** — the wall-clock time our local RMS VAD detected the start of a silence gap that persisted for ≥`VAD_SILENCE_DEBOUNCE_MS`. Backdated to the moment the silence *began*, not when the debounce fulfilled.
- **Fallback: `lastPartialTranscriptAt`** — the wall-clock time we received the most recent `user_transcript` event from EL (any `isFinal`, partial or final). Updated on EVERY `user_transcript` event.

### 4.2 Anchor selection (sanity-gap hybrid)

At turn resolution time (when `agent_audio` arrives for a new agent response), pick `userStoppedAt` using this rule:

```
if userStoppedAt_rms != null && lastPartial != null:
  if userStoppedAt_rms - lastPartial > VAD_SANITY_GAP_MS:
    # RMS VAD was too lenient — noise held it above threshold long
    # after EL already saw the user stop. Trust EL's partial.
    userStoppedAt = lastPartial
    source = "el_partial_fallback"
    vadFallbackCount += 1
  else:
    userStoppedAt = userStoppedAt_rms
    source = "rms_vad"
else if userStoppedAt_rms != null:
  userStoppedAt = userStoppedAt_rms
  source = "rms_vad"
else if lastPartial != null:
  userStoppedAt = lastPartial
  source = "el_partial_fallback"
  vadFallbackCount += 1
else:
  userStoppedAt = null  # no anchor — skip the turn (no sample)
```

**Under healthy conditions**, `lastPartial` lands *later* than `userStoppedAt_rms` (EL's partials are delayed by its own pipeline). That is NOT a fallback trigger. The fallback triggers only when RMS VAD is *more than `VAD_SANITY_GAP_MS` later* than EL's last partial, which indicates the RMS threshold was held up by background noise after real speech ended.

### 4.3 Tunable constants

Read from environment at module load with hardcoded fallbacks:

```js
const VAD_RMS_THRESHOLD      = Number(process.env.VAD_RMS_THRESHOLD      || 500);
const VAD_SILENCE_DEBOUNCE_MS = Number(process.env.VAD_SILENCE_DEBOUNCE_MS || 600);
const VAD_SANITY_GAP_MS      = Number(process.env.VAD_SANITY_GAP_MS      || 1500);
```

Defaults chosen based on:
- **RMS 500** out of 32767 ≈ -36 dBFS. Typical PSTN noise floor is -40 to -45 dBFS; speech is -20 to -10 dBFS. 500 sits in the gap. Tunable upward on noisy lines.
- **Debounce 600ms** covers natural inter-word pauses and stop consonants without triggering mid-sentence. 200ms (originally considered) is too short.
- **Sanity gap 1500ms** is longer than any realistic EL-internal processing delay and shorter than any plausible legitimate speech pause.

All three are env-var tunable so we can adjust from real call data without a code change.

### 4.4 The VAD module — `voiceagent-saas/vad.js` (new file)

Factory `createSilenceDetector({ threshold, debounceMs })` returns:

| Method | Purpose |
|---|---|
| `pushChunk(buffer, now)` | Compute RMS from a slin16 PCM16 LE buffer. Update the state machine. No-op on zero-length or odd-length buffers. |
| `resolvePending(now)` | If currently mid-debounce, force-resolve to `silenceStartAt`. Called by CallBridge when `agent_audio` arrives — EL responding IS confirmation that the user stopped, so we don't need to wait for our own debounce. Idempotent. |
| `getUserStoppedAt()` | Return the finalized `userStoppedAt` or `null`. |
| `reset()` | Clear state after a turn is recorded, ready for the next turn. |

Internal state:

```js
{
  threshold,
  debounceMs,
  isSpeaking: false,      // flips true on first non-silent chunk
  silenceStartAt: null,   // wall-clock at the moment silence began
  userStoppedAt: null,    // locked-in backdated silence-start once debounce fulfills
}
```

State machine on `pushChunk(buffer, now)`:

```
rms = sqrt(sum(sample^2) / sampleCount)
if rms >= threshold:
  isSpeaking = true
  silenceStartAt = null
  userStoppedAt = null   # reset any prior silence — user is speaking again
else:
  if isSpeaking:
    # transition: speech → silence
    silenceStartAt = now
    isSpeaking = false
  else if silenceStartAt != null && userStoppedAt == null:
    # still in silence, check debounce
    if now - silenceStartAt >= debounceMs:
      userStoppedAt = silenceStartAt   # backdated to silence start
```

`resolvePending(now)` behavior:
```
if userStoppedAt == null && silenceStartAt != null:
  userStoppedAt = silenceStartAt
# else: already resolved or never had silence — no-op
```

### 4.5 CallBridge changes

**Constructor additions:**

```js
this.vad = createSilenceDetector({
  threshold: VAD_RMS_THRESHOLD,
  debounceMs: VAD_SILENCE_DEBOUNCE_MS,
});
// Extends existing this.latency tracker:
this.latency.lastPartialTranscriptAt = null;
this.latency.vadFallbackCount = 0;
```

Remove `pendingUserFinalAt` from the tracker — no longer used. Keep `pendingUserFinalIsBarge` (barge detection still uses it).

**`handleCallerAudio(buffer)` additions:**

After the existing `session.sendAudio(buffer)` call (hot path preserved), add:

```js
try {
  this.vad.pushChunk(buffer, Date.now());
} catch (err) {
  this.log.error({ err }, "vad.pushChunk threw");
}
```

**`user_transcript` handler rewrite:**

Remove the `isFinal === true` gate. Always update `lastPartialTranscriptAt`:

```js
session.on("user_transcript", ({ text, isFinal, ts }) => {
  this.latency.lastPartialTranscriptAt = Date.now();
  this.turnCount += 1;
  enqueueTurn({ callId: this.callId, tenantId: this.tenantId, role: "user", text, isFinal, ts });
});
```

**`interruption` handler update:**

Old rule was "set barge flag only if `pendingUserFinalAt != null`." New rule: "set barge flag only if at least one anchor is available":

```js
session.on("interruption", () => {
  if (this.vad.getUserStoppedAt() != null || this.latency.lastPartialTranscriptAt != null) {
    this.latency.pendingUserFinalIsBarge = true;
  }
});
```

**`_recordAgentAudioLatency` turn path rewrite:**

Replace the `pendingUserFinalAt` branch with the VAD + fallback selection. Sketch (full code in the implementation plan):

```js
// Turn path (after greeting path)
this.vad.resolvePending(receivedAt);
const userStoppedAtRms = this.vad.getUserStoppedAt();
const lastPartial = this.latency.lastPartialTranscriptAt;

let userStoppedAt = null;
let source = null;
if (userStoppedAtRms != null && lastPartial != null) {
  if (userStoppedAtRms - lastPartial > VAD_SANITY_GAP_MS) {
    userStoppedAt = lastPartial;
    source = "el_partial_fallback";
    this.latency.vadFallbackCount += 1;
  } else {
    userStoppedAt = userStoppedAtRms;
    source = "rms_vad";
  }
} else if (userStoppedAtRms != null) {
  userStoppedAt = userStoppedAtRms;
  source = "rms_vad";
} else if (lastPartial != null) {
  userStoppedAt = lastPartial;
  source = "el_partial_fallback";
  this.latency.vadFallbackCount += 1;
}

if (userStoppedAt == null) {
  // No anchor — skip the sample entirely. Clear state and return.
  this.vad.reset();
  this.latency.pendingUserFinalIsBarge = false;
  return;
}

if (this.latency.pendingUserFinalIsBarge) {
  this.log.info({ event: "turn_latency_skipped_barge", call_id: this.callId }, "turn latency discarded (barge)");
  this.vad.reset();
  this.latency.pendingUserFinalIsBarge = false;
  return;
}

const tl = clampNonNegative(receivedAt - userStoppedAt);
this.latency.turnLatenciesMs.push(tl);
if (sentAt != null) {
  this.latency.audioPlumbingSamplesMs.push(clampNonNegative(sentAt - receivedAt));
}
this.log.info(
  {
    event: "turn_latency",
    call_id: this.callId,
    turn_index: this.latency.turnLatenciesMs.length,
    user_stopped_at: userStoppedAt,
    agent_audio_at: receivedAt,
    turn_latency_ms: tl,
    source,
  },
  "turn latency measured",
);
this.vad.reset();
```

### 4.6 Finalize changes

In `_persistFinalState`, extend `latencyFields` with `vad_fallback_count`:

```js
latencyFields = {
  greeting_latency_ms: ...,
  avg_turn_latency_ms: ...,
  p95_turn_latency_ms: ...,
  audio_plumbing_ms:   ...,
  turn_latencies_ms:   ...,
  vad_fallback_count:  this.latency.vadFallbackCount || 0,
};
```

Extend the `call_latency_summary` log to include `vad_fallback_count`.

### 4.7 Schema migration — `2026-04-08b_call_metrics_vad_fallback.sql`

```sql
-- 2026-04-08b_call_metrics_vad_fallback.sql
-- Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md
--
-- Adds a single aggregate column tracking how many turns in a call fell
-- back to EL's partial-transcript anchor because the local RMS VAD
-- was unreliable. Primary signal for "is the hybrid working?" — if this
-- is >50% of turns across many calls, the RMS threshold needs tuning.
--
-- Non-destructive, idempotent, inherits tenant_id RLS.

begin;

alter table public.call_metrics
  add column if not exists vad_fallback_count int;

alter table public.call_metrics
  add constraint call_metrics_vad_fallback_nonneg
    check (vad_fallback_count is null or vad_fallback_count >= 0);

commit;
```

## 5. Error handling

The VAD code is observability — it must never impact audio forwarding or break a call. Three layers of containment:

1. `this.vad.pushChunk()` call in `handleCallerAudio` wrapped in try/catch. A VAD throw cannot stop `session.sendAudio` (which ran first) or trip the bridge.
2. `_recordAgentAudioLatency`'s outer try/catch (already in place from the original spec) catches any throw from the turn path rewrite.
3. The finalize-time aggregation's existing try/catch catches a throw during `vad_fallback_count` persistence.

The `vad.js` module has no I/O, no async, no external deps. The only realistic failure mode is a zero-length or odd-length buffer, guarded by a length check that falls through to "no update."

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Continuous speech, no silence gaps, turn ends because EL decided to respond | `userStoppedAt_rms` is null. Fallback to `lastPartialTranscriptAt` (which fired during speech). `vad_fallback_count += 1`. Measurement is correct. |
| Pure silence from call start (user never speaks, never gets partials) | Both anchors null. Turn sample skipped entirely. No row poisoning. |
| Short gap within a sentence (<debounce) | `silenceStartAt` set, debounce never fulfills, next audio chunk resets silence state. No false turn boundary. |
| Long background noise burst while user actually stopped | RMS VAD stays "speaking", `userStoppedAt_rms` never sets. When partial fires + agent audio arrives, we have only `lastPartial`. Fallback path. |
| RMS said user stopped 3s ago but EL sent a partial 200ms ago | `userStoppedAt_rms - lastPartial ≈ -2800ms`, not greater than `VAD_SANITY_GAP_MS` → RMS is trusted. Correct. |
| RMS said user stopped just now but EL sent a partial 5s ago (noise) | `userStoppedAt_rms - lastPartial ≈ +5000ms` > `VAD_SANITY_GAP_MS` → fallback. Correct. |
| `agent_audio` arrives mid-debounce (silence started 300ms ago, debounce needs 600ms) | `resolvePending` force-resolves to `silenceStartAt`. EL responding IS the "user stopped" confirmation. Correct. |
| Barge-in (interruption during agent speech) | `interruption` handler sets barge flag if any anchor exists. Next `agent_audio` discards the sample. |
| `vad.pushChunk` throws (e.g., corrupt buffer) | Caught in handler's try/catch, logged, audio forwarding unaffected. |
| Negative computed `turn_latency_ms` (clock skew) | `clampNonNegative` returns 0. Sample recorded, not silently dropped. |

## 7. Testing

### 7.1 `voiceagent-saas/tests/vad.test.js` (new file)

Pure unit tests for the silence detector in isolation:

1. Pure silence across many chunks → after debounce fulfills, `getUserStoppedAt()` returns the backdated silence-start timestamp
2. Continuous speech (RMS above threshold) → `getUserStoppedAt()` stays null
3. Speech → silence → speech before debounce fulfills → silence state cleared, `getUserStoppedAt()` stays null
4. Speech → silence → debounce fulfills → `getUserStoppedAt()` returns silence start; a second call returns the same value (idempotent)
5. `resolvePending` during mid-debounce (silence started but debounce not fulfilled) → forces `userStoppedAt = silenceStartAt`
6. `resolvePending` when already resolved → no change
7. `resolvePending` when no silence ever seen → no-op
8. `reset()` clears all state; subsequent pushChunk starts fresh
9. Zero-length buffer → no throw, no state change
10. Odd-length buffer (not multiple of 2) → no throw, no state change (sample count protects against this)
11. RMS calculation: all-zero buffer → RMS is 0 → treated as silent
12. RMS calculation: constant-amplitude square wave of value 1000 → RMS exactly 1000 → above threshold 500 → treated as speaking
13. RMS threshold boundary: RMS exactly at 499 → silence; exactly at 500 → speech (`>=` semantic)

### 7.2 `voiceagent-saas/tests/call-bridge-latency.test.js` (append)

New tests for the hybrid anchor selection and integration:

14. **`user_transcript` isFinal=false DOES update `lastPartialTranscriptAt`** — reversed from the shipped Task 6 behavior. Requires removing the opposite assertion from the old test and replacing it.
15. Turn latency uses `rms_vad` source when VAD fulfills normally and RMS anchor is close to partial timestamp
16. Turn latency uses `el_partial_fallback` source when RMS VAD produced no anchor (continuous non-silent audio) but a partial is available
17. Turn latency uses `el_partial_fallback` when RMS anchor is more than `VAD_SANITY_GAP_MS` later than partial (simulating noisy-background failure)
18. Turn sample skipped entirely when both anchors are null (log emitted, no push to arrays)
19. `vad_fallback_count` increments only when the partial-fallback path is taken, not when RMS succeeds
20. `vad_fallback_count` persisted to `call_metrics` upsert at finalize
21. `interruption` with RMS anchor present sets barge flag (updated condition)
22. `interruption` with only partial anchor present sets barge flag
23. `interruption` with no anchors is a no-op

### 7.3 Existing tests to update or remove

- Task 6 tests that asserted `isFinal: false` does NOT set `pendingUserFinalAt` must be removed (that field no longer exists).
- Task 6 tests that asserted "most recent isFinal wins" become "most recent partial wins" (replacing the anchor name).
- Task 7 barge tests must be updated for the new barge condition.
- Greeting latency, audio plumbing, helper, migration, and finalize tests from Tasks 3, 4, 5, 8 all remain green with no changes — the new code is additive in those paths.

## 8. Deployment

1. Apply migration via `mcp__supabase__apply_migration`.
2. Add env vars to `/opt/voiceagent-saas/.env` on the droplet:
   ```
   VAD_RMS_THRESHOLD=500
   VAD_SILENCE_DEBOUNCE_MS=600
   VAD_SANITY_GAP_MS=1500
   ```
3. `scp voiceagent-saas/vad.js voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/`
4. `ssh root@188.166.166.234 "systemctl restart voiceagent-saas"`
5. Verify clean boot in journalctl.
6. Place one test call with a ≥3-turn Hebrew exchange including at least one barge.
7. Read `turn_latency` log lines — they now include `source: "rms_vad"` or `"el_partial_fallback"`.
8. Query `call_metrics`:
   ```sql
   select greeting_latency_ms, avg_turn_latency_ms, p95_turn_latency_ms,
          audio_plumbing_ms, turn_latencies_ms, vad_fallback_count
   from call_metrics where call_id = '<id>';
   ```
9. Interpret:
   - `avg_turn_latency_ms` populated and reasonable (say <2000ms) → hybrid works
   - `vad_fallback_count` small proportion of turns → RMS VAD carrying most of the load, hybrid healthy
   - `vad_fallback_count` >50% of turns → RMS threshold too high for this call's audio, tune `VAD_RMS_THRESHOLD` downward via env var and re-test (no code change needed)

## 9. Rollback

Code: revert the commit, `scp voiceagent-saas/call-bridge.js voiceagent-saas/vad.js root@188.166.166.234:/opt/voiceagent-saas/`, restart. The old call-bridge.js won't reference the new `vad_fallback_count` column, which is fine — Postgres silently ignores missing fields on insert.

Schema: additive, no rollback needed.

Env vars: removing them reverts to hardcoded defaults, which are the same values.

## 10. What this does not do

- Does not tune any latency. That's separate work after we know the numbers.
- Does not run our own ASR.
- Does not add per-turn source persistence — only the aggregate `vad_fallback_count`.
- Does not change `greeting_latency_ms`, `audio_plumbing_ms`, `tts_first_byte_ms`, or `el_ws_open_ms` — they're all unaffected.
- Does not rename misleading-but-still-useful `tts_first_byte_ms` — documented in the migration comment, not renamed.
- Does not persist the per-turn `source` label. Debug info lives in journalctl only.
