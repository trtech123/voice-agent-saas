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

// ─── ulaw ↔ Gemini PCM transcoding (ported from FlyingCarpet) ─��───

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mu = ~i & 0xff;
  const sign = mu & 0x80 ? -1 : 1;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  MULAW_DECODE[i] = sign * ((mantissa * 2 + 33) * (1 << exponent) - 33);
}

function pcmToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let i = 0; i < 8; i++) {
    if (sample < (1 << (i + 8))) {
      exponent = i;
      break;
    }
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function clampPcm16(sample: number): number {
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample;
}

function applyGain(sample: number, gain: number): number {
  return clampPcm16(Math.round(sample * gain));
}

function lowPassAverage3(a: number, b: number, c: number): number {
  return clampPcm16(Math.round((a + b + c) / 3));
}

/**
 * Convert ulaw 8kHz base64 (from Asterisk) → PCM16 16kHz base64 (for Gemini input).
 * Decodes ulaw → PCM 8kHz, then upsamples 8k→16k with linear interpolation.
 */
export function ulawToGeminiPcm(mulawBase64: string): string {
  const mulawBytes = Buffer.from(mulawBase64, "base64");
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = applyGain(MULAW_DECODE[mulawBytes[i]], 0.9);
  }
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length - 1; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = (pcm8k[i] + pcm8k[i + 1]) >> 1;
  }
  if (pcm8k.length > 0) {
    const last = pcm8k.length - 1;
    pcm16k[last * 2] = pcm8k[last];
    pcm16k[last * 2 + 1] = pcm8k[last];
  }
  const buffer = Buffer.alloc(pcm16k.length * 2);
  for (let i = 0; i < pcm16k.length; i++) {
    buffer.writeInt16LE(pcm16k[i], i * 2);
  }
  return buffer.toString("base64");
}

/**
 * Convert Gemini PCM16 24kHz base64 → ulaw 8kHz base64 (for Asterisk output).
 * Downsamples 24k→8k with 3-sample averaging, then encodes to ulaw.
 */
export function geminiPcmToUlaw(pcmBase64: string): string {
  const pcmBuffer = Buffer.from(pcmBase64, "base64");
  const sampleCount = pcmBuffer.length / 2;
  const pcm24k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm24k[i] = pcmBuffer.readInt16LE(i * 2);
  }
  const pcm8k = new Int16Array(Math.floor(sampleCount / 3));
  for (let i = 0; i < pcm8k.length; i++) {
    const offset = i * 3;
    pcm8k[i] = applyGain(
      lowPassAverage3(pcm24k[offset], pcm24k[offset + 1], pcm24k[offset + 2]),
      0.78,
    );
  }
  const mulaw = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulaw[i] = pcmToMulaw(pcm8k[i]);
  }
  return mulaw.toString("base64");
}
