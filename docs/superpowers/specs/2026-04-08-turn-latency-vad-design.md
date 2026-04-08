# Turn Latency VAD (Supersedes §3.2 of the 2026-04-08 Call Latency Spec) — Design Spec

**Date:** 2026-04-08
**Status:** Approved (revised post-review), ready for implementation plan
**Author:** Claude + Tom
**Supersedes:** §3.2, §4.2, §4.3 (turn-latency portions) of [2026-04-08 Call Latency Instrumentation](./2026-04-08-call-latency-instrumentation-design.md)
**Consulted:** Gemini (external review of the VAD state machine)
**Reviewers:** Software Architect, Backend Architect, DSP/Audio review (2026-04-08)

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

- **Primary: `userStoppedAt_rms`** — the wall-clock time our local RMS VAD detected the start of a silence run that persisted for ≥`VAD_SILENCE_DEBOUNCE_MS`. Backdated to the moment the run *began* (after the consecutive-silent-frames guard fires), not when the debounce fulfilled.
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

Read from environment via a guarded helper at module load:

```js
function numEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[vad-config] ${name}=${raw} is not a finite number, falling back to ${defaultValue}`);
    return defaultValue;
  }
  return n;
}

export const VAD_RMS_THRESHOLD       = numEnv("VAD_RMS_THRESHOLD",       800);
export const VAD_SILENCE_DEBOUNCE_MS = numEnv("VAD_SILENCE_DEBOUNCE_MS", 700);
export const VAD_SANITY_GAP_MS       = numEnv("VAD_SANITY_GAP_MS",       2000);
export const VAD_CONSECUTIVE_SILENT_FRAMES = numEnv("VAD_CONSECUTIVE_SILENT_FRAMES", 3);
export const VAD_AGENT_AUDIO_TAIL_MS = numEnv("VAD_AGENT_AUDIO_TAIL_MS", 200);
```

These constants live in a small new module `voiceagent-saas/vad-config.js`. Both `vad.js` and `call-bridge.js` import from it. At module load, `vad-config.js` also emits a single info log with the resolved values so a typo'd .env is visible at boot:

```js
console.info({
  event: "vad_config_resolved",
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_DEBOUNCE_MS,
  VAD_SANITY_GAP_MS,
  VAD_CONSECUTIVE_SILENT_FRAMES,
  VAD_AGENT_AUDIO_TAIL_MS,
}, "vad config resolved");
```

**Default rationale (revised after DSP review):**

- **RMS 800** out of 32767 ≈ -32 dBFS. Voicenter→Israeli mobile + G.711 CNG (comfort noise generation) decodes to comfort-noise floor around -32 to -38 dBFS. The original 500 (-36 dBFS) sits IN that range and would classify CNG as speech, starving the RMS anchor and forcing fallback for healthy calls. 800 sits cleanly above the CNG floor while still well below normal speech (-15 to -20 dBFS post-AGC). **Tunable upward via env on noisier lines, downward on quiet lines.**
- **Debounce 700ms** matches industry conventions for outbound voice agents (LiveKit 500, Vapi 700, Retell 800, Deepgram 700). Outbound cold-call leads pause longer than inbound ("uhh… let me think"). 700 is the median of the conventional range.
- **Sanity gap 2000ms** revised up from 1500ms after DSP review. Long Hebrew sentences with mid-sentence ASR buffering have been observed at 1.2-1.4s partial lag in the wild. 1500ms would mislabel healthy turns as fallback, corrupting the very metric (`vad_fallback_count`) we use to evaluate the hybrid. 2000ms is the safer margin.
- **Consecutive silent frames N=3** (60ms at 20ms/frame) — guards against single-frame mid-word dips during stop consonants and fricative tails. See §4.4.
- **Agent audio tail 200ms** — see §4.5 echo gating.

All five are env-var tunable so we can adjust from real call data without a code change.

### 4.4 The VAD module — `voiceagent-saas/vad.js` (new file)

Factory `createSilenceDetector({ threshold, debounceMs, consecutiveSilentFrames })` returns a stateful detector. Constructor injection lets tests override module-scope defaults without `vi.resetModules()` gymnastics.

| Method | Purpose |
|---|---|
| `pushChunk(buffer, now)` | Compute RMS from a slin16 PCM16 LE buffer using `Buffer.readInt16LE`. Update the state machine. No-op on zero-length, odd-length, or muted state. |
| `setMuted(muted)` | Mute/unmute the detector. While muted, `pushChunk` is a no-op (does NOT update state) — used by CallBridge to gate the VAD during agent audio playback so echo doesn't poison the silence detection. See §4.5. |
| `resolvePending(now)` | If currently mid-debounce, force-resolve to `silenceStartAt`. Called by CallBridge when `agent_audio` arrives — EL responding IS confirmation that the user stopped, so we don't need to wait for our own debounce. Idempotent. |
| `getUserStoppedAt()` | Return the finalized `userStoppedAt` or `null`. |
| `reset()` | Clear state after a turn is recorded, ready for the next turn. Also implicitly clears `consecutiveSilentFrames`. |

**Audio invariant:** `handleCallerAudio` receives raw slin16 (signed PCM16 LE, 16 kHz mono, 320 samples = 640 bytes per 20ms frame) directly from Asterisk's ExternalMedia via the media-bridge WebSocket. The VAD reads samples with `buffer.readInt16LE(i * 2)` to handle sign-extension correctly. The implementation MUST NOT do naïve byte arithmetic.

**Internal state:**

```js
{
  threshold,
  debounceMs,
  consecutiveSilentFramesRequired,
  muted: false,
  isSpeaking: false,           // flips true on first non-silent chunk after construction or reset
  consecutiveSilentFrames: 0,  // counter; only flips isSpeaking false at threshold
  silenceStartAt: null,        // wall-clock at the moment the silence run began (backdated)
  userStoppedAt: null,         // locked-in silence-start once debounce fulfills
}
```

**State machine on `pushChunk(buffer, now)`:**

```
if muted: return  // gated during agent playback
if buffer.length === 0 || buffer.length % 2 !== 0: return

sampleCount = buffer.length / 2
sumSq = 0
for i in 0 .. sampleCount-1:
  s = buffer.readInt16LE(i * 2)  // signed
  sumSq += s * s
rms = sqrt(sumSq / sampleCount)

if rms >= threshold:
  isSpeaking = true
  consecutiveSilentFrames = 0
  silenceStartAt = null
  userStoppedAt = null  // user is speaking again — clear any pending silence
else:
  consecutiveSilentFrames += 1
  if isSpeaking:
    if consecutiveSilentFrames >= consecutiveSilentFramesRequired:
      # transition: speech → silence
      # backdate silenceStartAt to the START of the silent run, not now:
      silenceStartAt = now - (consecutiveSilentFramesRequired - 1) * 20  # ms
      isSpeaking = false
  else if silenceStartAt != null && userStoppedAt == null:
    # already in silence, check debounce
    if now - silenceStartAt >= debounceMs:
      userStoppedAt = silenceStartAt   # backdated to silence start
```

**Why the consecutive-silent-frames guard:** a single 20ms dip during a voiced stop, fricative tail, or inter-word glottal pause would otherwise pin `silenceStartAt` to mid-word and bias the measurement low. Requiring 3 consecutive sub-threshold frames (60ms) before transitioning to silence eliminates phoneme-scale false positives while keeping the backdating semantics — the detector still acts as if the user stopped at the first frame of the run, not the moment we became confident.

**`resolvePending(now)` behavior:**
```
if userStoppedAt == null && silenceStartAt != null:
  userStoppedAt = silenceStartAt
# else: already resolved or never had silence — no-op
```

**`reset()` behavior:** clears `isSpeaking`, `consecutiveSilentFrames`, `silenceStartAt`, `userStoppedAt`. Does NOT touch `muted` (a turn ending while muted should remain muted until CallBridge un-mutes).

### 4.5 CallBridge changes

**Constructor additions:**

```js
import { createSilenceDetector } from "./vad.js";
import {
  VAD_RMS_THRESHOLD,
  VAD_SILENCE_DEBOUNCE_MS,
  VAD_SANITY_GAP_MS,
  VAD_CONSECUTIVE_SILENT_FRAMES,
  VAD_AGENT_AUDIO_TAIL_MS,
} from "./vad-config.js";

// in constructor:
this.vad = createSilenceDetector({
  threshold: VAD_RMS_THRESHOLD,
  debounceMs: VAD_SILENCE_DEBOUNCE_MS,
  consecutiveSilentFrames: VAD_CONSECUTIVE_SILENT_FRAMES,
});

// New tail-mute timer for echo gating
this._vadUnmuteTimer = null;

// Extends existing this.latency tracker:
this.latency.lastPartialTranscriptAt = null;
this.latency.vadFallbackCount = 0;
```

**Remove** `pendingUserFinalAt` from the tracker — no longer used. **Keep** `pendingUserFinalIsBarge` (barge detection still uses it, with updated lifecycle below).

**`handleCallerAudio(buffer)` additions:**

The existing method already drops frames unless `state === "live"` (defensive guard). The VAD therefore only ever sees post-`live` audio — that invariant is preserved and **MUST be preserved** by any future refactor of `handleCallerAudio`. After the existing `session.sendAudio(buffer)` call (hot path preserved), add:

```js
try {
  this.vad.pushChunk(buffer, Date.now());
} catch (err) {
  this.log.error({ err }, "vad.pushChunk threw");
}
```

**Echo gating in `agent_audio` handler (NEW — DSP review fix):**

Voicenter→Israeli mobile does not provide reliable echo cancellation on the inbound leg. When Dani is speaking, his TTS audio bleeds back through the PSTN loop and arrives on `handleCallerAudio` as "user speech," resetting `userStoppedAt = null` and blinding the VAD during agent playback. To prevent this, mute the VAD during agent audio playback plus a 200ms tail.

In the existing `agent_audio` handler (after `sendToAsterisk` runs and AFTER `_recordAgentAudioLatency`):

```js
// Echo gating: mute VAD while agent is speaking and for VAD_AGENT_AUDIO_TAIL_MS after.
this.vad.setMuted(true);
if (this._vadUnmuteTimer) clearTimeout(this._vadUnmuteTimer);
this._vadUnmuteTimer = setTimeout(() => {
  this._vadUnmuteTimer = null;
  this.vad.setMuted(false);
}, VAD_AGENT_AUDIO_TAIL_MS);
```

The mute is renewed on every outbound chunk, so as long as agent audio is flowing the VAD stays muted. When agent audio stops, the timer fires once after `VAD_AGENT_AUDIO_TAIL_MS` and unmutes the VAD. Cleanup the timer on `_finalizeAndResolve` so a stale timer can't fire after the bridge ends:

```js
// in _finalizeAndResolve, before activeBridges.delete:
if (this._vadUnmuteTimer) {
  clearTimeout(this._vadUnmuteTimer);
  this._vadUnmuteTimer = null;
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

Replace the `pendingUserFinalAt` branch with the VAD + fallback selection. Full code:

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
this.latency.pendingUserFinalIsBarge = false; // success path also clears the flag (SW review fix)
```

The barge flag is now cleared on **all three exit paths** (skip-no-anchor, skip-barge, success), eliminating the cross-turn leak risk.

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
-- Canonical fallback-rate query:
--   select call_id,
--          vad_fallback_count::float
--            / nullif(array_length(turn_latencies_ms, 1), 0) as fallback_rate
--   from call_metrics
--   where vad_fallback_count is not null;
--
-- The denominator is array_length(turn_latencies_ms, 1) — that's the
-- exact set of turns where an anchor resolved (not transcript_turn_count,
-- which includes skipped null-anchor turns). DO NOT persist a separate
-- denominator column; turn_latencies_ms is the canonical source.
--
-- NULL semantics:
--   - Pre-migration rows: NULL (correctly represents "not instrumented")
--   - Janitor-finalized rows (bridge crashed): NULL
--   - Bridge-finalized rows: 0 or positive
-- Dashboards must filter `vad_fallback_count IS NOT NULL` for averages.
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

The VAD code is observability — it must never impact audio forwarding or break a call. Four layers of containment:

1. `this.vad.pushChunk()` call in `handleCallerAudio` wrapped in try/catch. A VAD throw cannot stop `session.sendAudio` (which ran first) or trip the bridge.
2. `_recordAgentAudioLatency`'s outer try/catch (already in place from the original spec) catches any throw from the turn path rewrite.
3. The finalize-time aggregation's existing try/catch catches a throw during `vad_fallback_count` persistence.
4. The `_vadUnmuteTimer` is cleared in `_finalizeAndResolve` so a stale timer cannot fire after the bridge ends.

The `vad.js` module has no I/O, no async, no external deps. The only realistic failure modes are zero-length, odd-length, or corrupt buffers — all guarded by length checks that fall through to "no update."

**Audio invariant:** The VAD only sees post-`live` audio because `handleCallerAudio` already drops frames unless `state === "live"`. This is preserved by current code; future refactors of `handleCallerAudio` MUST preserve it (otherwise pre-answer ringback / early-media frames would corrupt the VAD state).

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Continuous speech, no silence gaps, turn ends because EL decided to respond | `userStoppedAt_rms` is null. Fallback to `lastPartialTranscriptAt` (which fired during speech). `vad_fallback_count += 1`. Measurement is correct. |
| Pure silence from call start (user never speaks, never gets partials) | Both anchors null. Turn sample skipped entirely. No row poisoning. |
| Short gap within a sentence (<3 frames sub-threshold) | `consecutiveSilentFrames` resets on the next speech frame; `silenceStartAt` never set. No false turn boundary. |
| Stop consonant or fricative tail (1-2 quiet frames mid-word) | `consecutiveSilentFrames` increments to 1 or 2 then resets when speech resumes. `isSpeaking` stays true. Correct. |
| Long silence gap (≥3 quiet frames + ≥debounce ms) | `silenceStartAt` backdated to start of run; debounce fulfills; `userStoppedAt` set to silence-start. |
| Long background noise burst while user actually stopped | RMS VAD stays "speaking", `userStoppedAt_rms` never sets. When partial fires + agent audio arrives, we have only `lastPartial`. Fallback path. |
| RMS said user stopped 3s ago but EL sent a partial 200ms ago | `userStoppedAt_rms - lastPartial ≈ -2800ms`, not greater than `VAD_SANITY_GAP_MS` → RMS is trusted. Correct. |
| RMS said user stopped just now but EL sent a partial 5s ago (noise) | `userStoppedAt_rms - lastPartial ≈ +5000ms` > `VAD_SANITY_GAP_MS` → fallback. Correct. |
| `agent_audio` arrives mid-debounce (silence started 300ms ago, debounce needs 700ms) | `resolvePending` force-resolves to `silenceStartAt`. EL responding IS the "user stopped" confirmation. Correct. |
| Barge-in (interruption during agent speech) | `interruption` handler sets barge flag if any anchor exists. Next `agent_audio` discards the sample. Flag cleared on success and skip paths. |
| `vad.pushChunk` throws (e.g., corrupt buffer) | Caught in handler's try/catch, logged, audio forwarding unaffected. |
| Negative computed `turn_latency_ms` (clock skew) | `clampNonNegative` returns 0. Sample recorded, not silently dropped. |
| **Echo from agent TTS bleeding back into inbound (DSP review)** | VAD muted via `setMuted(true)` at every outbound `agent_audio` chunk plus a `VAD_AGENT_AUDIO_TAIL_MS` tail (default 200ms). VAD is blind during agent playback by design. |
| **DTMF tones during call** | RMS ≈ 8000-15000, classified as continuous speech → `userStoppedAt_rms` never fires for the duration of DTMF → forced fallback to `lastPartialTranscriptAt`. Acceptable. |
| **Music-on-hold / hold transfer** | Continuous pseudo-speech RMS → same as DTMF, forces fallback. Acceptable. |
| **Carrier comfort noise (CNG) between speech** | RMS sits around -32 to -38 dBFS depending on carrier. Default threshold of 800 (~-32 dBFS) sits above the CNG floor for typical Voicenter→Israeli mobile audio. Tunable up if specific lines are noisier. |

## 7. Testing

### 7.1 `voiceagent-saas/tests/vad.test.js` (new file)

Pure unit tests for the silence detector in isolation. Tests construct the detector with explicit `{threshold, debounceMs, consecutiveSilentFrames}` to avoid touching env vars.

1. Pure silence across many chunks → after `consecutiveSilentFrames` + debounce fulfills, `getUserStoppedAt()` returns the backdated silence-start timestamp
2. Continuous speech (RMS above threshold) → `getUserStoppedAt()` stays null
3. Speech → 1 quiet frame → speech → `silenceStartAt` never set, `consecutiveSilentFrames` reset
4. Speech → 2 quiet frames → speech → same, no silence transition
5. Speech → 3 quiet frames → silence transition; `silenceStartAt` backdated to `now - 2*20ms`
6. Speech → 3 quiet frames → debounce fulfills → `getUserStoppedAt()` returns the backdated silence-start; second call returns the same value (idempotent)
7. `resolvePending` during mid-debounce (silence started but debounce not fulfilled) → forces `userStoppedAt = silenceStartAt`
8. `resolvePending` when already resolved → no change
9. `resolvePending` when no silence ever seen → no-op
10. `reset()` clears `isSpeaking`, `consecutiveSilentFrames`, `silenceStartAt`, `userStoppedAt` but does NOT touch `muted`
11. `setMuted(true)` causes `pushChunk` to no-op (no state change even with above-threshold audio)
12. `setMuted(false)` re-enables `pushChunk` from a clean state
13. Zero-length buffer → no throw, no state change
14. Odd-length buffer (not multiple of 2) → no throw, no state change
15. RMS calculation: all-zero buffer → RMS is 0 → treated as silent
16. RMS calculation: constant-amplitude square wave of value 1000 (PCM16 LE encoded) → RMS exactly 1000 → above threshold 800 → treated as speaking
17. RMS calculation: constant-amplitude square wave of value 700 → RMS 700 → below threshold 800 → treated as silent
18. RMS threshold boundary: RMS exactly at 799 → silence; exactly at 800 → speech (`>=` semantic)
19. Sign extension: a buffer with sample value -10000 (PCM16 LE bytes `0xF0 0xD8`) reads as -10000, RMS = 10000 (not 55536 from a naïve unsigned read)

### 7.2 `voiceagent-saas/tests/call-bridge-latency.test.js` (append + targeted updates)

Existing tests to update or remove (Tasks 6 + 7 from the original plan):
- Tests asserting `isFinal === false` does NOT set `pendingUserFinalAt` are removed (the field no longer exists)
- Tests asserting "most recent isFinal wins" become "most recent partial wins"
- Existing barge tests are updated for the new "any anchor present" condition

New tests:

20. `user_transcript` with `isFinal: false` DOES update `lastPartialTranscriptAt` (reversed from old shipped behavior)
21. `user_transcript` with `isFinal: true` ALSO updates `lastPartialTranscriptAt` (no gating)
22. Turn latency uses `rms_vad` source when VAD fulfills normally and RMS anchor is close to partial timestamp
23. Turn latency uses `el_partial_fallback` source when RMS VAD produced no anchor (continuous non-silent audio) but a partial is available
24. Turn latency uses `el_partial_fallback` when RMS anchor is more than `VAD_SANITY_GAP_MS` later than partial (simulating noisy-background failure)
25. Turn sample skipped entirely when both anchors are null (no push to arrays)
26. `vad_fallback_count` increments only when the partial-fallback path is taken, not when RMS succeeds
27. `vad_fallback_count` persisted to `call_metrics` upsert at finalize
28. `interruption` with RMS anchor present sets barge flag (updated condition)
29. `interruption` with only partial anchor present sets barge flag
30. `interruption` with no anchors is a no-op
31. Barge flag cleared on success path (after a non-barge turn measurement)
32. Echo gating: an outbound `agent_audio` chunk calls `vad.setMuted(true)` and schedules a `VAD_AGENT_AUDIO_TAIL_MS` unmute timer
33. Echo gating: subsequent agent audio chunks renew the timer (verified by checking the mute state stays true across multiple chunks)
34. Echo gating: after agent audio stops, the unmute timer fires and `vad.setMuted(false)` is called
35. Echo gating: `_finalizeAndResolve` clears the unmute timer (no leak)

### 7.3 Existing tests that remain green with no changes

Greeting latency, audio plumbing, helper functions, migration, finalize aggregation, janitor lock — all from Tasks 3, 4, 5, 8, 10 of the original plan.

## 8. Deployment

1. Apply migration via `mcp__supabase__apply_migration`.
2. Add env vars to `/opt/voiceagent-saas/.env` on the droplet:
   ```
   VAD_RMS_THRESHOLD=800
   VAD_SILENCE_DEBOUNCE_MS=700
   VAD_SANITY_GAP_MS=2000
   VAD_CONSECUTIVE_SILENT_FRAMES=3
   VAD_AGENT_AUDIO_TAIL_MS=200
   ```
3. `scp voiceagent-saas/vad-config.js voiceagent-saas/vad.js voiceagent-saas/call-bridge.js root@188.166.166.234:/opt/voiceagent-saas/`
4. `ssh root@188.166.166.234 "systemctl restart voiceagent-saas"`
5. Verify clean boot in journalctl AND verify the `vad_config_resolved` log line shows the expected constants (catches typo'd .env at boot).
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
   - `vad_fallback_count` small proportion of turns (use the canonical query in §4.7) → RMS VAD carrying most of the load, hybrid healthy
   - `vad_fallback_count` >50% of turns → RMS threshold likely too high for this call's audio, tune `VAD_RMS_THRESHOLD` downward via env var and re-test (no code change needed)
   - `vad_fallback_count` IS NULL → this call was finalized by the janitor, not the bridge — VAD never ran. Filter these out of dashboards.

## 9. Rollback

Code: revert the commit, `scp voiceagent-saas/call-bridge.js voiceagent-saas/vad.js voiceagent-saas/vad-config.js root@188.166.166.234:/opt/voiceagent-saas/`, restart. The reverted call-bridge.js won't reference the new `vad_fallback_count` column, which is fine — Postgres silently ignores missing fields on insert.

Schema: additive, no rollback needed.

Env vars: removing them reverts to hardcoded defaults, which are the same values.

## 10. NULL semantics and operational notes

`vad_fallback_count` is nullable. Three sources of NULL:
- **Pre-migration rows** — historical calls before this spec. Correctly represents "not instrumented; we don't know."
- **Janitor-finalized rows** — calls where the bridge crashed and the janitor wrote a sparse row. The VAD never ran. Correctly represents "no measurement available."
- **Bridge-finalized rows where the latency aggregation try/catch failed** — should be vanishingly rare. Logged as `latency aggregation threw`.

Bridge-finalized successful rows should always have `vad_fallback_count >= 0` (never NULL). A `0` means RMS VAD carried every turn — the ideal state.

**Dashboards MUST coalesce or filter:**
- `WHERE vad_fallback_count IS NOT NULL` for any aggregate
- `COALESCE(vad_fallback_count, 0)` if presenting per-call

**Why no upper-bound CHECK:** a 30-minute call at ~32 turns/3min ≈ 320 turns max. A `<= 1000` constraint adds noise without protection — if the counter ran away to 1000+, the bug would be elsewhere and a CHECK constraint wouldn't catch it earlier than the bridge would.

## 11. What this does not do

- Does not tune any latency. That's separate work after we know the numbers.
- Does not run our own ASR.
- Does not add per-turn source persistence — only the aggregate `vad_fallback_count`. Per-turn `turn_latency_sources text[]` rejected as YAGNI; can be added later if the aggregate signal needs drilling.
- Does not change `greeting_latency_ms`, `audio_plumbing_ms`, `tts_first_byte_ms`, or `el_ws_open_ms` — they're all unaffected.
- Does not rename misleading-but-still-useful `tts_first_byte_ms` — documented in the prior migration comment, not renamed.
- Does not persist the per-turn `source` label. Debug info lives in journalctl only.
- Does not implement a true acoustic echo canceller. We mute the VAD during agent playback as a coarse but reliable workaround. A proper AEC is out of scope.
