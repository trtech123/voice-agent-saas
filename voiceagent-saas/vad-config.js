// voiceagent-saas/vad-config.js
// Spec: docs/superpowers/specs/2026-04-08-turn-latency-vad-design.md §4.3
//
// Loads 5 env-var-tunable VAD constants at module init. Uses a guarded
// helper so a typo'd .env value (e.g., "60o") falls back to the default
// instead of silently becoming NaN. Emits a single boot-time log line
// so the resolved values are visible in journalctl.

function numEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vad-config] ${name}=${raw} is not a finite number, falling back to ${defaultValue}`,
    );
    return defaultValue;
  }
  return n;
}

export const VAD_RMS_THRESHOLD             = numEnv("VAD_RMS_THRESHOLD",             800);
export const VAD_SILENCE_DEBOUNCE_MS       = numEnv("VAD_SILENCE_DEBOUNCE_MS",       700);
export const VAD_SANITY_GAP_MS             = numEnv("VAD_SANITY_GAP_MS",             2000);
export const VAD_CONSECUTIVE_SILENT_FRAMES = numEnv("VAD_CONSECUTIVE_SILENT_FRAMES", 3);
export const VAD_AGENT_AUDIO_TAIL_MS       = numEnv("VAD_AGENT_AUDIO_TAIL_MS",       200);

// Boot-time log so /etc/voiceagent-saas.env typos are visible at startup.
// eslint-disable-next-line no-console
console.info(
  JSON.stringify({
    event: "vad_config_resolved",
    VAD_RMS_THRESHOLD,
    VAD_SILENCE_DEBOUNCE_MS,
    VAD_SANITY_GAP_MS,
    VAD_CONSECUTIVE_SILENT_FRAMES,
    VAD_AGENT_AUDIO_TAIL_MS,
  }),
);
