// apps/voice-engine/src/audio-utils.ts

/**
 * RMS energy threshold for speech detection (16-bit PCM, range 0-32768).
 * Typical speech ~500-3000, telephony noise ~200-400.
 */
export const SPEECH_RMS_THRESHOLD = Number(
  process.env.GEMINI_SPEECH_RMS_THRESHOLD || 450
);

/**
 * Compute RMS energy of a 16-bit signed little-endian PCM audio buffer.
 * Used for watchdog speech detection — determines if the caller is
 * actively speaking vs silence/background noise.
 *
 * Ported from flyingcarpet/voice-agent/call-bridge.js computeRms().
 */
export function computeRms(buf: Buffer): number {
  const usableLength = buf.length & ~1; // Round down to even for 16-bit samples
  const samples = usableLength / 2;
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < usableLength; i += 2) {
    const sample = buf.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Compute RMS from a base64-encoded PCM audio chunk.
 * Convenience wrapper for audio arriving over WebSocket as base64.
 */
export function computeRmsBase64(base64Audio: string): number {
  return computeRms(Buffer.from(base64Audio, "base64"));
}

/**
 * Create an all-zero PCM silence buffer for the given duration.
 * Used to inject silence after lifting the caller audio gate,
 * resetting Gemini's VAD baseline so it sees a clean silence-to-speech
 * transition.
 *
 * @param durationMs - Duration in milliseconds
 * @param sampleRate - Sample rate in Hz (default 16000 for telephony input)
 * @returns Buffer of 16-bit PCM silence
 */
export function createSilenceBuffer(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.floor(sampleRate * (durationMs / 1000));
  return Buffer.alloc(samples * 2); // 2 bytes per 16-bit sample
}
