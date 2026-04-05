// voiceagent-saas/audio-utils.js

/**
 * Audio utilities for slin16 (PCM16 16kHz) mode.
 *
 * Input path:  Asterisk slin16 → Gemini (no transcoding, pass through as base64)
 * Output path: Gemini PCM16 24kHz → downsample to 16kHz → Asterisk slin16
 */

const SPEECH_RMS_THRESHOLD = Number(process.env.GEMINI_SPEECH_RMS_THRESHOLD || 450);

function clampPcm16(sample) {
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample;
}

/**
 * Compute RMS energy of a PCM16 LE buffer.
 * Used for watchdog speech detection.
 */
function computeRms(buf) {
  const usableLength = buf.length & ~1;
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
 * Create an all-zero PCM silence buffer.
 */
function createSilenceBuffer(durationMs, sampleRate = 16000) {
  return Buffer.alloc(Math.floor(sampleRate * (durationMs / 1000)) * 2);
}

/**
 * Downsample Gemini's 24kHz PCM16 output to 16kHz for Asterisk slin16.
 * Uses linear interpolation (24k→16k ratio is 3:2).
 * Applies 0.86x gain to prevent clipping.
 */
function downsample24kTo16k(pcm24kBase64) {
  const pcmBuffer = Buffer.from(pcm24kBase64, "base64");
  const sampleCount = pcmBuffer.length / 2;
  const outSamples = Math.floor(sampleCount * 2 / 3);
  const output = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * 3 / 2;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = pcmBuffer.readInt16LE(Math.min(srcIdx, sampleCount - 1) * 2);
    const s1 = pcmBuffer.readInt16LE(Math.min(srcIdx + 1, sampleCount - 1) * 2);
    const interpolated = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clampPcm16(Math.round(interpolated * 0.86)), i * 2);
  }

  return output.toString("base64");
}

/**
 * slin16 PCM16 16kHz pass-through for Gemini input.
 * Applies 0.92x gain for headroom.
 */
function slin16ToGeminiPcm(pcm16kBase64) {
  const buf = Buffer.from(pcm16kBase64, "base64");
  const samples = buf.length / 2;
  const output = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const sample = buf.readInt16LE(i * 2);
    output.writeInt16LE(clampPcm16(Math.round(sample * 0.92)), i * 2);
  }
  return output.toString("base64");
}

export {
  SPEECH_RMS_THRESHOLD,
  computeRms,
  createSilenceBuffer,
  downsample24kTo16k,
  slin16ToGeminiPcm,
};
