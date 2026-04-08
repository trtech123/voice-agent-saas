// voiceagent-saas/vad.js
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.4
//
// Stateful RMS-based silence detector. Fed 20ms slin16 (PCM16 LE, 16 kHz
// mono, 320 samples / 640 bytes) frames. Detects silence transitions
// with a consecutive-silent-frames guard, backdates silenceStartAt to
// the start of the silent run, and fulfills a debounce before locking
// in userStoppedAt. Provides setMuted() so CallBridge can blind the
// detector during agent audio playback (echo gating).
//
// All methods are synchronous and single-instance. No I/O.

const FRAME_DURATION_MS = 20;

export function createSilenceDetector({
  threshold,
  debounceMs,
  consecutiveSilentFrames,
}) {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`createSilenceDetector: invalid threshold ${threshold}`);
  }
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new Error(`createSilenceDetector: invalid debounceMs ${debounceMs}`);
  }
  if (!Number.isInteger(consecutiveSilentFrames) || consecutiveSilentFrames < 1) {
    throw new Error(
      `createSilenceDetector: invalid consecutiveSilentFrames ${consecutiveSilentFrames}`,
    );
  }

  let muted = false;
  let isSpeaking = false;
  let consecutiveSilent = 0;
  let silenceStartAt = null;
  let userStoppedAt = null;

  function computeRms(buffer) {
    const sampleCount = buffer.length / 2;
    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = buffer.readInt16LE(i * 2); // signed — critical for correctness
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / sampleCount);
  }

  function pushChunk(buffer, now) {
    if (muted) return;
    if (!buffer || buffer.length === 0) return;
    if (buffer.length % 2 !== 0) return;

    const rms = computeRms(buffer);

    if (rms >= threshold) {
      // Speaking.
      isSpeaking = true;
      consecutiveSilent = 0;
      silenceStartAt = null;
      userStoppedAt = null;
      return;
    }

    // Below threshold: silent frame.
    consecutiveSilent += 1;
    if (isSpeaking) {
      if (consecutiveSilent >= consecutiveSilentFrames) {
        // Speech → silence transition. Backdate silenceStartAt to the
        // first frame of the silent run: now - (N-1) * 20ms.
        silenceStartAt = now - (consecutiveSilentFrames - 1) * FRAME_DURATION_MS;
        isSpeaking = false;
      }
      return;
    }

    // Already in silence. Check debounce.
    if (silenceStartAt != null && userStoppedAt == null) {
      if (now - silenceStartAt >= debounceMs) {
        userStoppedAt = silenceStartAt;
      }
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
  }

  function getMuted() {
    return muted;
  }

  function resolvePending(/* now */) {
    if (userStoppedAt == null && silenceStartAt != null) {
      userStoppedAt = silenceStartAt;
    }
  }

  function getUserStoppedAt() {
    return userStoppedAt;
  }

  function reset() {
    isSpeaking = false;
    consecutiveSilent = 0;
    silenceStartAt = null;
    userStoppedAt = null;
    // muted deliberately NOT reset — CallBridge owns that.
  }

  return { pushChunk, setMuted, getMuted, resolvePending, getUserStoppedAt, reset };
}
